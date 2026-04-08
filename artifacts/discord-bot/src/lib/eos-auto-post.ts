import {
  Client, TextChannel, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, teamSeasonStatsTable,
  seasonStatTierConfigsTable, pendingEosPayoutsTable,
  playerSeasonStatsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { STAT_CATEGORIES, evaluateTier } from "./stat-categories.js";
import { getPayoutValue, PAYOUT_KEYS } from "./payout-config.js";

// Positions considered QB or RB for YPA / YPC calculations
const QB_POSITIONS = new Set(["QB"]);
const RB_POSITIONS = new Set(["HB", "RB", "FB"]);

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

  // ── 4. Load admin-configurable attempt minimums ───────────────────────────────
  const [minQbAtt, minRbAtt] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.EOS_QB_MIN_ATT),
    getPayoutValue(PAYOUT_KEYS.EOS_RB_MIN_ATT),
  ]);

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

      // ── Query player rows first — used both for YPA/YPC and to derive team sacks/INTs ─
      const playerRows = await db
        .select()
        .from(playerSeasonStatsTable)
        .where(and(
          eq(playerSeasonStatsTable.seasonId, seasonId),
          eq(playerSeasonStatsTable.discordId, user.discordId),
        ))
        .orderBy(desc(playerSeasonStatsTable.passYds));

      // Compute team totals from player rows (used as fallback when MCA doesn't export them)
      const computedSacks = playerRows.reduce((sum, p) => sum + (p.sacks ?? 0), 0);
      const computedInts  = playerRows.reduce((sum, p) => sum + (p.defInts ?? 0), 0);

      if (teamStats) {
        hasStats = true;

        // Determine PPG — use MCA-imported value if non-zero, otherwise compute from total pts / games
        const games = (teamStats.wins ?? 0) + (teamStats.losses ?? 0);
        const computedPpg = games > 0 ? (teamStats.offTDs ?? 0) / games : 0;
        const resolvedPpg = (teamStats.offPtsPerGame ?? 0) > 0
          ? (teamStats.offPtsPerGame ?? 0)
          : computedPpg;

        // Map columns → STAT_CATEGORIES.jsonFields aliases.
        // sacks/INTs: prefer MCA-imported value from DB; fall back to summing all player rows.
        const resolvedSacks = (teamStats.teamSacks ?? 0) > 0 ? (teamStats.teamSacks ?? 0) : computedSacks;
        const resolvedInts  = (teamStats.teamInts  ?? 0) > 0 ? (teamStats.teamInts  ?? 0) : computedInts;

        const statsObj: Record<string, number> = {
          offPassYds:    teamStats.offPassYds,
          offRushYds:    teamStats.offRushYds,
          offRedZonePct: teamStats.offRedZonePct,
          offPtsPerGame: resolvedPpg,
          ptsPerGame:    resolvedPpg,
          pointsPerGame: resolvedPpg,
          defPassYds:    teamStats.defPassYds,
          defRushYds:    teamStats.defRushYds,
          defPtsAllowed: teamStats.defTDs,   // defTDs stores season points allowed
          defFumblesRec: teamStats.defFumblesRec,
          defRedZonePct: teamStats.defRedZonePct,
          defSacks:      resolvedSacks,
          totalSacks:    resolvedSacks,
          sacks:         resolvedSacks,
          defInts:       resolvedInts,
          totalInts:     resolvedInts,
          interceptions: resolvedInts,
        };

        for (const cat of STAT_CATEGORIES) {
          // Skip player-level categories — handled separately below
          if (cat.key === "qb_ypa" || cat.key === "rb_ypc") continue;

          // Try each alias to find the stat value
          let statValue: number | null = null;
          for (const field of cat.jsonFields) {
            const v = statsObj[field];
            if (v != null && !isNaN(v)) { statValue = v; break; }
          }
          if (statValue == null) continue;

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

      // ── QB YPA ────────────────────────────────────────────────────────────────
      const qbYpaTiers = tiersByCategory.get("qb_ypa") ?? [];
      if (qbYpaTiers.length > 0) {
        // Best QB: highest passYds among QBs with passAtt >= minQbAtt
        const topQb = playerRows
          .filter(p => QB_POSITIONS.has(p.position.toUpperCase()) && p.passAtt >= minQbAtt)
          .sort((a, b) => b.passYds - a.passYds)[0] ?? null;

        if (topQb) {
          const ypa     = topQb.passYds / topQb.passAtt;          // float
          const ypaScaled = Math.round(ypa * 10);                 // integer × 10 to match threshold
          const result  = evaluateTier(qbYpaTiers, ypaScaled, "higher");
          const ypaStr  = ypa.toFixed(1);
          const playerLabel = `${topQb.firstName} ${topQb.lastName}`.trim() || "QB";
          if (result) {
            displayLines.push(
              `• **QB YPA (${playerLabel})**: ${ypaStr} YPA (${topQb.passAtt} att, min ${minQbAtt}) → Tier ${result.tier} (+${result.payout.toLocaleString()} coins)`,
            );
            breakdown.push({ label: `QB YPA (${playerLabel})`, statValue: ypaScaled, unit: "YPA×10", tier: result.tier, coins: result.payout });
            totalCoins += result.payout;
          } else {
            displayLines.push(
              `• **QB YPA (${playerLabel})**: ${ypaStr} YPA (${topQb.passAtt} att, min ${minQbAtt}) → No qualifying tier`,
            );
          }
          hasStats = true;
        } else {
          // User has no QB with enough attempts — note it for the commissioner
          const anyQb = playerRows.find(p => QB_POSITIONS.has(p.position.toUpperCase()));
          if (anyQb) {
            displayLines.push(
              `• **QB YPA**: ${anyQb.firstName} ${anyQb.lastName} has only ${anyQb.passAtt} pass attempts (minimum: ${minQbAtt}) — does not qualify`,
            );
          }
        }
      }

      // ── RB YPC ────────────────────────────────────────────────────────────────
      const rbYpcTiers = tiersByCategory.get("rb_ypc") ?? [];
      if (rbYpcTiers.length > 0) {
        // Best RB: highest rushYds among HB/RB/FB with rushAtt >= minRbAtt
        const topRb = playerRows
          .filter(p => RB_POSITIONS.has(p.position.toUpperCase()) && p.rushAtt >= minRbAtt)
          .sort((a, b) => b.rushYds - a.rushYds)[0] ?? null;

        if (topRb) {
          const ypc      = topRb.rushYds / topRb.rushAtt;
          const ypcScaled = Math.round(ypc * 10);
          const result   = evaluateTier(rbYpcTiers, ypcScaled, "higher");
          const ypcStr   = ypc.toFixed(1);
          const playerLabel = `${topRb.firstName} ${topRb.lastName}`.trim() || "RB";
          if (result) {
            displayLines.push(
              `• **RB YPC (${playerLabel})**: ${ypcStr} YPC (${topRb.rushAtt} carries, min ${minRbAtt}) → Tier ${result.tier} (+${result.payout.toLocaleString()} coins)`,
            );
            breakdown.push({ label: `RB YPC (${playerLabel})`, statValue: ypcScaled, unit: "YPC×10", tier: result.tier, coins: result.payout });
            totalCoins += result.payout;
          } else {
            displayLines.push(
              `• **RB YPC (${playerLabel})**: ${ypcStr} YPC (${topRb.rushAtt} carries, min ${minRbAtt}) → No qualifying tier`,
            );
          }
          hasStats = true;
        } else {
          const anyRb = playerRows.find(p => RB_POSITIONS.has(p.position.toUpperCase()));
          if (anyRb) {
            displayLines.push(
              `• **RB YPC**: ${anyRb.firstName} ${anyRb.lastName} has only ${anyRb.rushAtt} carries (minimum: ${minRbAtt}) — does not qualify`,
            );
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
        descBody = "*No team stats or player stats found in the database for this season.*\n" +
          "Use **Edit Amount** to manually set the payout if applicable.";
      } else if (displayLines.length === 0) {
        descBody = "*Stats were found but no tiers could be evaluated (tiers may not be seeded yet).*";
      } else {
        descBody = displayLines.join("\n");
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
