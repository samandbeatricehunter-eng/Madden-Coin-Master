import {
  Client, TextChannel, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, teamSeasonStatsTable,
  seasonStatTierConfigsTable, pendingEosPayoutsTable,
  playerSeasonStatsTable, franchiseScheduleTable,
} from "@workspace/db";
import { eq, and, ne, desc, isNotNull } from "drizzle-orm";
import { STAT_CATEGORIES, evaluateTier } from "./stat-categories.js";
import { getPayoutValue, PAYOUT_KEYS } from "./payout-config.js";
import { PRIMARY_GUILD_ID, getGuildChannel, CHANNEL_KEYS } from "./db-helpers.js";

// Positions considered QB or RB for YPA / YPC calculations
const QB_POSITIONS = new Set(["QB"]);
const RB_POSITIONS = new Set(["HB", "RB", "FB"]);

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
  guildId: string = PRIMARY_GUILD_ID,
): Promise<{ posted: number; skipped: number; errors: number }> {

  // ── 1. Load all registered users for this guild only ─────────────────────────
  const allUsers = await db.select({
    discordId:         usersTable.discordId,
    team:              usersTable.team,
    playoffSeed:       usersTable.playoffSeed,
    playoffConference: usersTable.playoffConference,
  }).from(usersTable)
    .where(and(
      eq(usersTable.guildId, guildId),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
    ));

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

  // ── 3b. Pre-compute schedule-based score fallbacks ────────────────────────────
  // Used when MCA didn't export offPtsPerGame / defTDs (points allowed).
  const teamIdToDiscordId = new Map<number, string>();
  for (const s of allTeamStats) {
    if (s.discordId) teamIdToDiscordId.set(s.teamId, s.discordId);
  }

  const scheduleRows = await db.select({
    homeTeamId: franchiseScheduleTable.homeTeamId,
    awayTeamId: franchiseScheduleTable.awayTeamId,
    homeScore:  franchiseScheduleTable.homeScore,
    awayScore:  franchiseScheduleTable.awayScore,
  }).from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, seasonId),
      isNotNull(franchiseScheduleTable.homeScore),
      isNotNull(franchiseScheduleTable.awayScore),
    ));

  const schedScoreMap = new Map<string, { ptsFor: number; ptsAllowed: number; games: number }>();
  for (const g of scheduleRows) {
    if (g.homeScore == null || g.awayScore == null) continue;
    const homeDid = teamIdToDiscordId.get(g.homeTeamId);
    const awayDid = teamIdToDiscordId.get(g.awayTeamId);
    if (homeDid) {
      const cur = schedScoreMap.get(homeDid) ?? { ptsFor: 0, ptsAllowed: 0, games: 0 };
      schedScoreMap.set(homeDid, { ptsFor: cur.ptsFor + g.homeScore, ptsAllowed: cur.ptsAllowed + g.awayScore, games: cur.games + 1 });
    }
    if (awayDid) {
      const cur = schedScoreMap.get(awayDid) ?? { ptsFor: 0, ptsAllowed: 0, games: 0 };
      schedScoreMap.set(awayDid, { ptsFor: cur.ptsFor + g.awayScore, ptsAllowed: cur.ptsAllowed + g.homeScore, games: cur.games + 1 });
    }
  }

  // ── 4. Load admin-configurable attempt minimums and bonus thresholds ──────────
  const [minQbAtt, minRbAtt, minQbYpa, minRbYpc, minDbInts, qbBonusAmt, rbBonusAmt, dbBonusAmt, missedPlayoffsAmt] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.EOS_QB_MIN_ATT),
    getPayoutValue(PAYOUT_KEYS.EOS_RB_MIN_ATT),
    getPayoutValue(PAYOUT_KEYS.EOS_QB_MIN_YPA),
    getPayoutValue(PAYOUT_KEYS.EOS_RB_MIN_YPC),
    getPayoutValue(PAYOUT_KEYS.EOS_DB_MIN_INTS),
    getPayoutValue(PAYOUT_KEYS.EOS_QB_YPA_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_RB_YPC_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_DB_INT_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_MISSED_PLAYOFFS),
  ]);

  // ── 5. Get commissioner channel ───────────────────────────────────────────────
  let commChannel: TextChannel | null = null;
  // EOS approval embeds are pending — send to transaction log.
  const commChannelId =
    await getGuildChannel(guildId, CHANNEL_KEYS.TRANSACTION_LOG)
    ?? await getGuildChannel(guildId, CHANNEL_KEYS.TRANSACTIONS)
    ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER);
  if (commChannelId) {
    try {
      const ch = await client.channels.fetch(commChannelId);
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

        const schedStats = schedScoreMap.get(user.discordId);

        // PPG — tier 1: MCA offPtsPerGame; tier 2: offTDs (ptsFor) / games; tier 3: schedule scores / 17 (ceil)
        const games = (teamStats.wins ?? 0) + (teamStats.losses ?? 0);
        const schedPpg = schedStats && schedStats.games > 0 ? Math.ceil(schedStats.ptsFor / 17) : 0;
        const computedPpg = (teamStats.offTDs ?? 0) > 0 && games > 0
          ? (teamStats.offTDs ?? 0) / games
          : schedPpg;
        const resolvedPpg = (teamStats.offPtsPerGame ?? 0) > 0
          ? (teamStats.offPtsPerGame ?? 0)
          : computedPpg;

        // Points Allowed — tier 1: MCA defTDs (ptsAgainst); tier 2: sum of opponent scores from schedule
        const resolvedPtsAllowed = (teamStats.defTDs ?? 0) > 0
          ? (teamStats.defTDs ?? 0)
          : (schedStats?.ptsAllowed ?? 0);

        // Sacks / INTs — prefer MCA team total; fall back to summing player rows
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
          defPtsAllowed: resolvedPtsAllowed,
          turnoverDiff:  teamStats.turnoverDiff,
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

      // ── QB YPA (flat bonus) ───────────────────────────────────────────────────
      // QB must meet minQbAtt attempts AND average minQbYpa YPA (×10) to earn flat bonus.
      const qualifyingQbs = playerRows
        .filter(p => QB_POSITIONS.has(p.position.toUpperCase()) && p.passAtt >= minQbAtt)
        .map(p => ({ ...p, ypaScaled: Math.round((p.passYds / p.passAtt) * 10) }))
        .filter(p => p.ypaScaled >= minQbYpa);

      if (qualifyingQbs.length > 0) {
        // Award the bonus once per team (for the best qualifying QB)
        const topQb = qualifyingQbs.sort((a, b) => b.ypaScaled - a.ypaScaled)[0];
        const playerLabel = `${topQb.firstName} ${topQb.lastName}`.trim() || "QB";
        const ypaStr = (topQb.passYds / topQb.passAtt).toFixed(1);
        displayLines.push(
          `• **QB YPA Bonus (${playerLabel})**: ${ypaStr} YPA (${topQb.passAtt} att, min ${minQbAtt} att + ${(minQbYpa / 10).toFixed(1)} YPA) → +${qbBonusAmt.toLocaleString()} coins`,
        );
        breakdown.push({ label: `QB YPA Bonus (${playerLabel})`, statValue: topQb.ypaScaled, unit: "YPA×10", tier: 1, coins: qbBonusAmt });
        totalCoins += qbBonusAmt;
        hasStats = true;
      } else {
        const anyQb = playerRows.find(p => QB_POSITIONS.has(p.position.toUpperCase()));
        if (anyQb) {
          const attNote = anyQb.passAtt < minQbAtt
            ? `only ${anyQb.passAtt} attempts (min ${minQbAtt})`
            : `${(anyQb.passYds / anyQb.passAtt).toFixed(1)} YPA (min ${(minQbYpa / 10).toFixed(1)})`;
          displayLines.push(`• **QB YPA Bonus**: ${anyQb.firstName} ${anyQb.lastName} — ${attNote} — does not qualify`);
        }
      }

      // ── RB YPC (flat bonus per qualifying RB — mirrors DB INT bonus) ────────────
      // Every RB meeting minRbAtt carries AND minRbYpc YPC earns the bonus independently.
      const allRbs = playerRows
        .filter(p => RB_POSITIONS.has(p.position.toUpperCase()) && p.rushAtt > 0)
        .sort((a, b) => b.rushAtt - a.rushAtt);  // lead RB first for display
      const qualifyingRbs = allRbs
        .filter(p => p.rushAtt >= minRbAtt)
        .map(p => ({ ...p, ypcScaled: Math.round((p.rushYds / p.rushAtt) * 10) }))
        .filter(p => p.ypcScaled >= minRbYpc);

      if (qualifyingRbs.length > 0) {
        for (const rb of qualifyingRbs) {
          const playerLabel = `${rb.firstName} ${rb.lastName}`.trim() || "RB";
          const ypcStr = (rb.rushYds / rb.rushAtt).toFixed(1);
          displayLines.push(
            `• **RB YPC Bonus (${playerLabel})**: ${ypcStr} YPC (${rb.rushAtt} carries, min ${minRbAtt} carries + ${(minRbYpc / 10).toFixed(1)} YPC) → +${rbBonusAmt.toLocaleString()} coins`,
          );
          breakdown.push({ label: `RB YPC Bonus (${playerLabel})`, statValue: rb.ypcScaled, unit: "YPC×10", tier: 1, coins: rbBonusAmt });
          totalCoins += rbBonusAmt;
        }
        hasStats = true;
      } else {
        // Show the lead RB (most carries) for transparency — not just the first found
        const leadRb = allRbs[0];
        if (leadRb) {
          const carryNote = leadRb.rushAtt < minRbAtt
            ? `only ${leadRb.rushAtt} carries (min ${minRbAtt})`
            : `${(leadRb.rushYds / leadRb.rushAtt).toFixed(1)} YPC (min ${(minRbYpc / 10).toFixed(1)})`;
          displayLines.push(`• **RB YPC Bonus**: ${leadRb.firstName} ${leadRb.lastName} — ${carryNote} — does not qualify`);
        }
      }

      // ── DB INT Bonus (flat bonus per qualifying player) ───────────────────────
      // Any defensive player with minDbInts or more INTs earns the bonus per player.
      const intPlayers = playerRows.filter(p => (p.defInts ?? 0) >= minDbInts);
      if (intPlayers.length > 0) {
        for (const p of intPlayers) {
          const playerLabel = `${p.firstName} ${p.lastName}`.trim() || p.position;
          displayLines.push(
            `• **DB INT Bonus (${playerLabel})**: ${p.defInts} INTs (min ${minDbInts}) → +${dbBonusAmt.toLocaleString()} coins`,
          );
          breakdown.push({ label: `DB INT Bonus (${playerLabel})`, statValue: p.defInts ?? 0, unit: "INTs", tier: 1, coins: dbBonusAmt });
          totalCoins += dbBonusAmt;
        }
        hasStats = true;
      }

      // ── Missed-playoffs welfare bonus ─────────────────────────────────────────
      // A user "missed the playoffs" when playoffSeed is 0 or null.
      // Seed is auto-set from standings when advancing Week 18 → Wildcard.
      // If seeds have not been set at all
      // (every user is 0/null), we skip the bonus entirely to avoid giving
      // everyone consolation coins by mistake — this guards against running EOS
      // before seeds are entered.
      const anySeeded = allUsers.some(u => (u.playoffSeed ?? 0) > 0);
      if (anySeeded && missedPlayoffsAmt > 0) {
        const madePlayoffs = (user.playoffSeed ?? 0) > 0;
        if (!madePlayoffs) {
          displayLines.push(
            `• **Missed Playoffs Consolation**: Did not qualify → +${missedPlayoffsAmt.toLocaleString()} coins`,
          );
          breakdown.push({
            label:     "Missed Playoffs Consolation",
            statValue: 0,
            unit:      "consolation",
            tier:      0,
            coins:     missedPlayoffsAmt,
          });
          totalCoins += missedPlayoffsAmt;
          hasStats = true;
        } else {
          displayLines.push(
            `• **Missed Playoffs Consolation**: Made playoffs (${user.playoffConference ?? "?"} Seed ${user.playoffSeed}) → N/A`,
          );
        }
      } else if (!anySeeded) {
        displayLines.push(
          `• **Missed Playoffs Consolation**: ⚠️ No playoff seeds set — run \`/admin_ea_export standings\` or \`/admin-playoffs set*seeds\` first`,
        );
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
