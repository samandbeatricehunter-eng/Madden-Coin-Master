import {
  Client, TextChannel, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, teamSeasonStatsTable,
  seasonStatTierConfigsTable, pendingEosPayoutsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { STAT_CATEGORIES, evaluateTier } from "./stat-categories.js";
import { getPayoutValue, PAYOUT_KEYS } from "./payout-config.js";

const COMMISSIONER_CHANNEL_ID = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";

type BreakdownRow = { label: string; statValue: number; unit: string; tier: number; coins: number };

/**
 * Runs at end-of-regular-season (when advancing to Wildcard).
 * For every registered user:
 *  1. Pulls their teamSeasonStats and calculates any qualifying stat tiers.
 *  2. Inserts a pending_eos_payouts record (even if 0 coins).
 *  3. Posts one embed per user to the commissioner channel with Approve + Edit buttons.
 *
 * Stats that aren't stored in teamSeasonStatsTable (sacks, INTs, PPG) will
 * not auto-calculate — the commissioner can use the Edit Amount button to set them.
 */
export async function runEosAutoPost(
  client: Client,
  seasonId: number,
): Promise<{ posted: number; skipped: number; errors: number }> {

  // ── 1. Load all registered users ──────────────────────────────────────────────
  const allUsers = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  }).from(usersTable);

  if (allUsers.length === 0) {
    return { posted: 0, skipped: 0, errors: 0 };
  }

  // ── 2. Load tier configs for this season ──────────────────────────────────────
  const allTierRows = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(eq(seasonStatTierConfigsTable.seasonId, seasonId));

  const tiersByCategory = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const row of allTierRows) {
    let arr = tiersByCategory.get(row.statCategory);
    if (!arr) { arr = []; tiersByCategory.set(row.statCategory, arr); }
    arr.push({ tier: row.tier, threshold: row.threshold, payout: row.payout });
  }

  // ── 3. Load all team season stats for this season ─────────────────────────────
  const allTeamStats = await db.select()
    .from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, seasonId));

  const statsMap = new Map<string, typeof allTeamStats[0]>();
  for (const s of allTeamStats) {
    if (s.discordId) statsMap.set(s.discordId, s);
  }

  // ── 4. Load individual bonus amounts ──────────────────────────────────────────
  // (These are never auto-calculated from DB — commissioner manually edits if applicable.)

  // ── 5. Get commissioner channel ───────────────────────────────────────────────
  let commChannel: TextChannel | null = null;
  if (COMMISSIONER_CHANNEL_ID) {
    try {
      const ch = await client.channels.fetch(COMMISSIONER_CHANNEL_ID);
      if (ch?.isTextBased()) commChannel = ch as TextChannel;
    } catch (err) {
      console.error("[eos-auto-post] Failed to fetch commissioner channel:", err);
    }
  }

  // ── 6. Check for already-existing pending payouts this season ─────────────────
  const existingPayouts = await db.select({ discordId: pendingEosPayoutsTable.discordId })
    .from(pendingEosPayoutsTable)
    .where(eq(pendingEosPayoutsTable.seasonId, seasonId));
  const alreadyPosted = new Set(existingPayouts.map(r => r.discordId));

  // ── 7. Process each user ──────────────────────────────────────────────────────
  let posted  = 0;
  let skipped = 0;
  let errors  = 0;

  for (const user of allUsers) {
    // Skip users who already have a payout record this season
    if (alreadyPosted.has(user.discordId)) {
      skipped++;
      continue;
    }

    try {
      const teamStats = statsMap.get(user.discordId);

      const breakdown: BreakdownRow[] = [];
      const displayLines: string[] = [];
      let totalCoins = 0;
      let hasStats = false;

      if (teamStats) {
        hasStats = true;

        // Map the teamSeasonStatsTable columns to the field names used by STAT_CATEGORIES.jsonFields
        // Some stats (sacks, INTs, PPG) are not stored in this table — they won't match.
        const statsObj: Record<string, number> = {
          offPassYds:   teamStats.offPassYds,
          offRushYds:   teamStats.offRushYds,
          offRedZonePct: teamStats.offRedZonePct,
          defPassYds:   teamStats.defPassYds,
          defRushYds:   teamStats.defRushYds,
          defPtsAllowed: teamStats.defTDs,   // defTDs stores season points allowed
          defFumblesRec: teamStats.defFumblesRec,
          defRedZonePct: teamStats.defRedZonePct,
        };

        for (const cat of STAT_CATEGORIES) {
          // Try each alias to find the stat value
          let statValue: number | null = null;
          for (const field of cat.jsonFields) {
            const v = statsObj[field];
            if (v != null && !isNaN(v)) { statValue = v; break; }
          }
          if (statValue == null) continue;  // stat not available in DB (PPG, sacks, INTs)

          const tiers = tiersByCategory.get(cat.key) ?? [];
          if (tiers.length === 0) continue; // tiers not seeded yet

          const result = evaluateTier(tiers, statValue, cat.direction);
          if (result) {
            displayLines.push(`• **${cat.label}**: ${statValue.toLocaleString()} ${cat.unit} → Tier ${result.tier} (+${result.payout.toLocaleString()} coins)`);
            breakdown.push({ label: cat.label, statValue, unit: cat.unit, tier: result.tier, coins: result.payout });
            totalCoins += result.payout;
          } else {
            displayLines.push(`• **${cat.label}**: ${statValue.toLocaleString()} ${cat.unit} → No qualifying tier`);
          }
        }
      }

      // ── Insert pending payout record ───────────────────────────────────────────
      const [pending] = await db.insert(pendingEosPayoutsTable).values({
        discordId:     user.discordId,
        teamName:      user.team ?? null,
        seasonId,
        statBreakdown: breakdown,
        totalCoins,
        status:        "pending",
      }).returning();

      if (!pending) { errors++; continue; }

      // ── Build commissioner embed ───────────────────────────────────────────────
      let descBody: string;
      if (!hasStats) {
        descBody = "*No team stats found in the database for this season.*\nSacks, INTs, PPG, and individual bonuses must be entered manually via **Edit Amount**.";
      } else if (displayLines.length === 0) {
        descBody = "*Stats were found but no tiers could be evaluated (tiers may not be seeded yet).*";
      } else {
        const missingStats = [
          "PPG (points per game)",
          "Sacks",
          "Interceptions",
        ];
        descBody =
          displayLines.join("\n") +
          `\n\n*⚠️ The following stats are **not auto-loaded** from MCA and must be manually adjusted via Edit Amount if applicable:*\n` +
          missingStats.map(s => `• ${s}`).join("\n");
      }

      const commEmbed = new EmbedBuilder()
        .setColor(totalCoins > 0 ? Colors.Gold : Colors.Grey)
        .setTitle("🏆 End-of-Season Payout — Pending Approval")
        .setDescription(
          `**Team:** <@${user.discordId}>${user.team ? ` (${user.team})` : ""}\n\n${descBody}`,
        )
        .addFields(
          { name: "Season",      value: `Season ${seasonId}`,                           inline: true },
          { name: "Auto-Calc'd", value: `**${totalCoins.toLocaleString()} coins**`,     inline: true },
          { name: "Status",      value: "⏳ Pending commissioner approval",               inline: false },
        )
        .setFooter({ text: `Payout ID: ${pending.id} • Auto-generated at end of regular season` })
        .setTimestamp();

      const commRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`eos_approve:${pending.id}:${user.discordId}`)
          .setLabel(`✅ Approve (${totalCoins.toLocaleString()} coins)`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`eos_edit:${pending.id}`)
          .setLabel("✏️ Edit Amount")
          .setStyle(ButtonStyle.Secondary),
      );

      // ── Post to commissioner channel ───────────────────────────────────────────
      if (commChannel) {
        try {
          const msg = await commChannel.send({ embeds: [commEmbed], components: [commRow] });
          await db.update(pendingEosPayoutsTable)
            .set({ commissionerMessageId: msg.id })
            .where(eq(pendingEosPayoutsTable.id, pending.id));
        } catch (err) {
          console.error(`[eos-auto-post] Failed to post commissioner embed for ${user.discordId}:`, err);
          errors++;
          continue;
        }
      }

      posted++;
    } catch (err) {
      console.error(`[eos-auto-post] Error processing user ${user.discordId}:`, err);
      errors++;
    }
  }

  return { posted, skipped, errors };
}
