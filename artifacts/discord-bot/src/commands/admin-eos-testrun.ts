/**
 * /admin-eos-testrun
 *
 * Read-only dry run of the full end-of-season payout calculation.
 * Mirrors the logic that fires automatically when advancing to Wildcard week,
 * but performs zero DB writes and sends all output back to the invoking admin.
 *
 * Sources (same as the real auto-post):
 *  - Team stat tier bonuses  → teamSeasonStatsTable + seasonStatTierConfigsTable
 *  - QB YPA / RB YPC bonuses → playerSeasonStatsTable
 *  - DB INT bonuses          → playerSeasonStatsTable
 *  - PR bonuses              → getSeasonRecords() (same data as /seasonpr)
 *  - Missed playoffs         → getArticleStandings() (same data as /standings)
 *  - GOTY award bonuses      → flagged as manual (cannot be auto-detected)
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable,
  teamSeasonStatsTable,
  seasonStatTierConfigsTable,
  playerSeasonStatsTable,
  franchiseScheduleTable,
  playerStatWeekProcessedTable,
} from "@workspace/db";
import { eq, and, ne, desc, isNotNull } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { STAT_CATEGORIES, evaluateTier } from "../lib/stat-categories.js";
import { getPayoutValue, getAllPayoutConfig, PAYOUT_KEYS } from "../lib/payout-config.js";
import { getSeasonRecords, getArticleStandings, type ArticleStanding } from "../lib/gcs-fallback.js";

const QB_POSITIONS = new Set(["QB"]);
const RB_POSITIONS = new Set(["HB", "RB", "FB"]);

function calcPRScore(wins: number, losses: number, pointDiff: number): number {
  return 0.6 * (wins - losses) + 0.4 * pointDiff;
}

const PR_PAYOUT_KEYS = [
  PAYOUT_KEYS.SEASON_PR_1,
  PAYOUT_KEYS.SEASON_PR_2,
  PAYOUT_KEYS.SEASON_PR_3_6,
  PAYOUT_KEYS.SEASON_PR_7_8,
  PAYOUT_KEYS.SEASON_PR_9_10,
] as const;

function rankToPrBonus(rank: number, payouts: number[]): number {
  if (rank === 1)              return payouts[0]!;
  if (rank === 2)              return payouts[1]!;
  if (rank >= 3 && rank <= 6)  return payouts[2]!;
  if (rank >= 7 && rank <= 8)  return payouts[3]!;
  if (rank >= 9 && rank <= 10) return payouts[4]!;
  return 0;
}

// ── Playoff seed computation (mirrors standings.ts) ────────────────────────────
function computePlayoffSeeds(confTeams: ArticleStanding[]): ArticleStanding[] {
  const DIVISIONS = ["East", "North", "South", "West"] as const;

  const divLeaders = new Map<string, ArticleStanding>();
  for (const div of DIVISIONS) {
    const sorted = confTeams
      .filter(t => t.division === div)
      .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
    if (sorted[0]) divLeaders.set(div, sorted[0]);
  }

  const divWinnerSet = new Set([...divLeaders.values()].map(t => t.teamName));
  const sortedWinners = [...divLeaders.values()].sort(
    (a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential,
  );
  const wildCards = confTeams
    .filter(t => !divWinnerSet.has(t.teamName))
    .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);

  return [...sortedWinners, ...wildCards].slice(0, 7);
}

// ── Command definition ─────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("admin-eos-testrun")
  .setDescription("Preview all EOS payouts (read-only — no coins awarded, no DB writes)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(o => o
    .setName("season_id")
    .setDescription("Season ID to preview (defaults to active season)")
    .setRequired(false)
    .setMinValue(1),
  );

// ── Shared context type (allows slash command + button handler to call the same logic) ──
export interface EosRunContext {
  guildId:          string;
  seasonIdOverride: number | null;
  deferReply: (opts: { ephemeral: boolean }) => Promise<unknown>;
  editReply:  (data: object) => Promise<unknown>;
  followUp:   (data: object) => Promise<unknown>;
}

export async function runEosTestRun(ctx: EosRunContext): Promise<void> {
  await ctx.deferReply({ ephemeral: true });

  // ── 1. Resolve season ────────────────────────────────────────────────────────
  const activeSeason = await getOrCreateActiveSeason(ctx.guildId);
  const seasonId     = ctx.seasonIdOverride ?? activeSeason.id;
  const seasonNum    = seasonId === activeSeason.id ? activeSeason.seasonNumber : seasonId;

  // ── 2. Load all registered users ─────────────────────────────────────────────
  const allUsers = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  }).from(usersTable).where(and(
    eq(usersTable.guildId, ctx.guildId),
    isNotNull(usersTable.team),
    ne(usersTable.team, ""),
  ));

  if (allUsers.length === 0) {
    await ctx.editReply({ content: "❌ No registered users found." });
    return;
  }

  // ── 3. Load tier configs ──────────────────────────────────────────────────────
  const allTierRows = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(eq(seasonStatTierConfigsTable.seasonId, seasonId));

  const tiersByCategory = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const row of allTierRows) {
    let arr = tiersByCategory.get(row.statCategory);
    if (!arr) { arr = []; tiersByCategory.set(row.statCategory, arr); }
    arr.push({ tier: row.tier, threshold: row.threshold, payout: row.payout });
  }

  // ── 4. Load all team season stats ────────────────────────────────────────────
  const allTeamStats = await db.select().from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, seasonId));
  const statsMap = new Map(allTeamStats.filter(s => s.discordId).map(s => [s.discordId!, s]));

  // ── 4b. Pre-compute schedule-based score fallbacks ────────────────────────────
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

  // ── 4c. Check how many weeks of player stats have been imported ───────────────
  const weekProcessedRows = await db.select({
    statType: playerStatWeekProcessedTable.statType,
  }).from(playerStatWeekProcessedTable)
    .where(eq(playerStatWeekProcessedTable.seasonId, seasonId));

  const passingWeeksImported = weekProcessedRows.filter(w => w.statType === "passing").length;
  const rushingWeeksImported = weekProcessedRows.filter(w => w.statType === "rushing").length;

  // ── 5. Load payout configuration ─────────────────────────────────────────────
  const payoutConfig = await getAllPayoutConfig();
  const get = (key: typeof PAYOUT_KEYS[keyof typeof PAYOUT_KEYS]) =>
    payoutConfig.get(key) ?? 0;

  const minQbAtt   = get(PAYOUT_KEYS.EOS_QB_MIN_ATT);
  const minRbAtt   = get(PAYOUT_KEYS.EOS_RB_MIN_ATT);
  const minQbYpa   = get(PAYOUT_KEYS.EOS_QB_MIN_YPA);
  const minRbYpc   = get(PAYOUT_KEYS.EOS_RB_MIN_YPC);
  const minDbInts  = get(PAYOUT_KEYS.EOS_DB_MIN_INTS);
  const qbBonusAmt = get(PAYOUT_KEYS.EOS_QB_YPA_BONUS);
  const rbBonusAmt = get(PAYOUT_KEYS.EOS_RB_YPC_BONUS);
  const dbBonusAmt = get(PAYOUT_KEYS.EOS_DB_INT_BONUS);
  const missedPlayoffsAmt = get(PAYOUT_KEYS.EOS_MISSED_PLAYOFFS);
  const awardBonusAmt     = get(PAYOUT_KEYS.AWARD_WIN_BONUS);

  const prPayouts = await Promise.all(PR_PAYOUT_KEYS.map(k => getPayoutValue(k)));

  // ── 6. Compute PR rankings (same source as /seasonpr) ────────────────────────
  const { records: prRecords, source: prSource } = await getSeasonRecords(seasonId);
  const prRankMap = new Map<string, { rank: number; score: number; bonus: number }>();
  let prDataAvailable = false;

  if (prRecords.length > 0) {
    prDataAvailable = true;
    const ranked = prRecords
      .map(r => ({ ...r, score: calcPRScore(r.wins, r.losses, r.pointDifferential) }))
      .sort((a, b) => b.score - a.score);

    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i]!;
      const rank  = i + 1;
      const bonus = rankToPrBonus(rank, prPayouts);
      prRankMap.set(r.discordId, { rank, score: r.score, bonus });
    }
  }

  // ── 7. Compute playoff picture (same source as /standings) ───────────────────
  const allStandings = await getArticleStandings(seasonId, 18);
  const playoffDiscordIds = new Set<string>();
  let standingsDataAvailable = false;

  if (allStandings.length > 0) {
    standingsDataAvailable = true;

    // Build discordUsername → discordId map
    const usernameToId = new Map(allUsers.map(u => [u.discordUsername, u.discordId]));

    for (const conf of ["AFC", "NFC"] as const) {
      const confTeams = allStandings.filter(t => t.conference === conf);
      const seeds     = computePlayoffSeeds(confTeams);
      for (const seed of seeds) {
        if (seed.discordUsername) {
          const discordId = usernameToId.get(seed.discordUsername);
          if (discordId) playoffDiscordIds.add(discordId);
        }
      }
    }

    // Also check: any user whose team name appears in the playoff picture
    // (fallback if discordUsername isn't set in standings)
    for (const conf of ["AFC", "NFC"] as const) {
      const confTeams = allStandings.filter(t => t.conference === conf);
      const seeds     = computePlayoffSeeds(confTeams);
      const playoffTeamNames = new Set(seeds.map(s => s.teamName.toLowerCase()));
      for (const u of allUsers) {
        if (u.team && playoffTeamNames.has(u.team.toLowerCase())) {
          playoffDiscordIds.add(u.discordId);
        }
      }
    }
  }

  // ── 8. Identify missing tier categories ──────────────────────────────────────
  const missingCategories: string[] = [];
  for (const cat of STAT_CATEGORIES) {
    if (cat.key === "qb_ypa" || cat.key === "rb_ypc") continue;
    const tiers = tiersByCategory.get(cat.key) ?? [];
    if (tiers.length === 0) missingCategories.push(cat.label);
  }

  // ── 9. Build warning list ─────────────────────────────────────────────────────
  const warnings: string[] = [];
  warnings.push("⚠️ **GOTY Award Bonuses** — cannot be auto-detected. Apply manually with `/admin-addcoins`.");
  if (passingWeeksImported < 18) {
    warnings.push(
      `⚠️ **QB/RB Stats May Be Incomplete** — only **${passingWeeksImported}/18** regular season weeks of passing stats and **${rushingWeeksImported}/18** weeks of rushing stats have been imported. QB YPA attempt counts and RB YPC carry counts may reflect less than a full season. Import all 18 regular season weeks for accurate totals.`,
    );
  }
  if (!prDataAvailable) {
    warnings.push(`⚠️ **PR Bonuses** — no records data found (source: ${prSource}). PR bonuses cannot be calculated.`);
  } else if (prSource === "gcs") {
    warnings.push("ℹ️ **PR Bonuses** — using GCS/MCA fallback data (no DB records yet for this season).");
  }
  if (!standingsDataAvailable) {
    warnings.push("⚠️ **Missed Playoffs Bonus** — no standings data found. Cannot determine who missed the playoffs.");
  }
  if (missingCategories.length > 0) {
    warnings.push(`⚠️ **Stat Tier Bonuses** — tier configs missing for: ${missingCategories.join(", ")}. Run \`/admin-stat-tiers\` to seed.`);
  }

  // ── 10. Process each user ─────────────────────────────────────────────────────
  type UserResult = {
    discordId:    string;
    label:        string;
    displayLines: string[];
    totalCoins:   number;
    hasStats:     boolean;
  };
  const results: UserResult[] = [];
  const usersWithNoStats: string[] = [];

  for (const user of allUsers) {
    const displayLines: string[] = [];
    let totalCoins = 0;
    let hasStats   = false;

    // ── Player rows for this user ──────────────────────────────────────────────
    const playerRows = await db
      .select()
      .from(playerSeasonStatsTable)
      .where(and(
        eq(playerSeasonStatsTable.seasonId, seasonId),
        eq(playerSeasonStatsTable.discordId, user.discordId),
      ))
      .orderBy(desc(playerSeasonStatsTable.passYds));

    const computedSacks = playerRows.reduce((s, p) => s + (p.sacks    ?? 0), 0);
    const computedInts  = playerRows.reduce((s, p) => s + (p.defInts  ?? 0), 0);

    const teamStats = statsMap.get(user.discordId);

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
        if (cat.key === "qb_ypa" || cat.key === "rb_ypc") continue;
        let statValue: number | null = null;
        for (const field of cat.jsonFields) {
          const v = statsObj[field];
          if (v != null && !isNaN(v)) { statValue = v; break; }
        }
        if (statValue == null) continue;
        const tiers = tiersByCategory.get(cat.key) ?? [];
        if (tiers.length === 0) continue;
        const result = evaluateTier(tiers, statValue, cat.direction);
        if (result) {
          displayLines.push(`• **${cat.label}**: ${statValue.toLocaleString()} ${cat.unit} → Tier ${result.tier} (+${result.payout.toLocaleString()} 🪙)`);
          totalCoins += result.payout;
        } else {
          displayLines.push(`• **${cat.label}**: ${statValue.toLocaleString()} ${cat.unit} → No qualifying tier`);
        }
      }
    } else if (playerRows.length === 0) {
      usersWithNoStats.push(`<@${user.discordId}>`);
    }

    // ── QB YPA Bonus ──────────────────────────────────────────────────────────
    const qualifyingQbs = playerRows
      .filter(p => QB_POSITIONS.has(p.position.toUpperCase()) && p.passAtt >= minQbAtt)
      .map(p => ({ ...p, ypaScaled: Math.round((p.passYds / p.passAtt) * 10) }))
      .filter(p => p.ypaScaled >= minQbYpa);

    if (qualifyingQbs.length > 0) {
      const topQb  = qualifyingQbs.sort((a, b) => b.ypaScaled - a.ypaScaled)[0]!;
      const label  = `${topQb.firstName} ${topQb.lastName}`.trim() || "QB";
      const ypaStr = (topQb.passYds / topQb.passAtt).toFixed(1);
      displayLines.push(`• **QB YPA Bonus (${label})**: ${ypaStr} YPA, ${topQb.passAtt} att → +${qbBonusAmt.toLocaleString()} 🪙`);
      totalCoins += qbBonusAmt;
      hasStats = true;
    } else {
      const anyQb = playerRows.find(p => QB_POSITIONS.has(p.position.toUpperCase()));
      if (anyQb && anyQb.passAtt > 0) {
        const note = anyQb.passAtt < minQbAtt
          ? `${anyQb.passAtt} att (min ${minQbAtt})`
          : `${(anyQb.passYds / anyQb.passAtt).toFixed(1)} YPA (min ${(minQbYpa / 10).toFixed(1)})`;
        displayLines.push(`• **QB YPA Bonus**: ${anyQb.firstName} ${anyQb.lastName} — ${note} — does not qualify`);
      }
    }

    // ── RB YPC Bonus (per qualifying RB — mirrors DB INT bonus) ──────────────
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
        const label  = `${rb.firstName} ${rb.lastName}`.trim() || "RB";
        const ypcStr = (rb.rushYds / rb.rushAtt).toFixed(1);
        displayLines.push(`• **RB YPC Bonus (${label})**: ${ypcStr} YPC, ${rb.rushAtt} carries → +${rbBonusAmt.toLocaleString()} 🪙`);
        totalCoins += rbBonusAmt;
      }
      hasStats = true;
    } else {
      // Show the lead RB (most carries) so the user knows who was checked
      const leadRb = allRbs[0];
      if (leadRb) {
        const note = leadRb.rushAtt < minRbAtt
          ? `${leadRb.rushAtt} carries (min ${minRbAtt})`
          : `${(leadRb.rushYds / leadRb.rushAtt).toFixed(1)} YPC (min ${(minRbYpc / 10).toFixed(1)})`;
        displayLines.push(`• **RB YPC Bonus**: ${leadRb.firstName} ${leadRb.lastName} — ${note} — does not qualify`);
      }
    }

    // ── DB INT Bonus ──────────────────────────────────────────────────────────
    const intPlayers = playerRows.filter(p => (p.defInts ?? 0) >= minDbInts);
    if (intPlayers.length > 0) {
      for (const p of intPlayers) {
        const label = `${p.firstName} ${p.lastName}`.trim() || p.position;
        displayLines.push(`• **DB INT Bonus (${label})**: ${p.defInts} INTs → +${dbBonusAmt.toLocaleString()} 🪙`);
        totalCoins += dbBonusAmt;
      }
      hasStats = true;
    }

    // ── PR Bonus ──────────────────────────────────────────────────────────────
    if (prDataAvailable) {
      const prInfo = prRankMap.get(user.discordId);
      if (prInfo) {
        if (prInfo.bonus > 0) {
          displayLines.push(`• **Season PR Bonus**: #${prInfo.rank} ranked (PR: ${prInfo.score.toFixed(1)}) → +${prInfo.bonus.toLocaleString()} 🪙`);
          totalCoins += prInfo.bonus;
          hasStats = true;
        } else {
          displayLines.push(`• **Season PR Bonus**: #${prInfo.rank} ranked — outside top 10, no bonus`);
        }
      } else {
        displayLines.push("• **Season PR Bonus**: No season record found — no bonus");
      }
    } else {
      displayLines.push("• **Season PR Bonus**: ⚠️ No PR data available");
    }

    // ── Missed Playoffs Bonus ─────────────────────────────────────────────────
    if (standingsDataAvailable) {
      const madePlayoffs = playoffDiscordIds.has(user.discordId);
      if (!madePlayoffs) {
        displayLines.push(`• **Missed Playoffs Consolation** → +${missedPlayoffsAmt.toLocaleString()} 🪙`);
        totalCoins += missedPlayoffsAmt;
        hasStats = true;
      } else {
        displayLines.push("• **Missed Playoffs Consolation**: Made playoffs — not eligible");
      }
    } else {
      displayLines.push("• **Missed Playoffs Consolation**: ⚠️ No standings data available");
    }

    // ── GOTY Award (always flagged) ───────────────────────────────────────────
    displayLines.push(`• **GOTY Award Bonus**: ⚠️ Manual — ${awardBonusAmt} 🪙 per in-game award winner (cannot auto-detect)`);

    const label = user.team ? `${user.team} (<@${user.discordId}>)` : `<@${user.discordId}>`;
    results.push({ discordId: user.discordId, label, displayLines, totalCoins, hasStats });
  }

  // ── 11. Build embeds ──────────────────────────────────────────────────────────
  const embeds: EmbedBuilder[] = [];

  // ── Header embed ──────────────────────────────────────────────────────────────
  const totalCoinsIfApproved = results.reduce((s, r) => s + r.totalCoins, 0);
  const headerEmbed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle(`🧪 EOS Payout Test Run — Season ${seasonNum}`)
    .setDescription(
      `**${allUsers.length} users** | Auto-calculable total: **${totalCoinsIfApproved.toLocaleString()} coins** *(excludes GOTY awards)*\n\n` +
      (warnings.length > 0 ? `**Warnings & Notes:**\n${warnings.join("\n")}` : "✅ All data sources available."),
    )
    .addFields(
      { name: "PR Data Source",       value: prSource,                                                               inline: true },
      { name: "Standings Available",  value: standingsDataAvailable ? "✅ Yes" : "❌ No",                            inline: true },
      { name: "Tier Configs",         value: missingCategories.length === 0 ? "✅ All seeded" : `⚠️ ${missingCategories.length} missing`, inline: true },
    )
    .setFooter({ text: "Read-only — no coins awarded, no records created • Use the real EOS auto-post when ready" })
    .setTimestamp();

  if (usersWithNoStats.length > 0) {
    headerEmbed.addFields({
      name: "⚠️ No Stats Found For",
      value: usersWithNoStats.join(", "),
      inline: false,
    });
  }
  embeds.push(headerEmbed);

  // ── Per-user embeds ───────────────────────────────────────────────────────────
  for (const r of results) {
    const color = r.totalCoins > 0 ? Colors.Green : Colors.Grey;
    const description = r.hasStats
      ? r.displayLines.join("\n")
      : "*No team stats or player stats found for this user this season.*";

    // Discord embed description max is 4096 chars — split if needed
    const chunks: string[][] = [];
    let current: string[] = [];
    let len = 0;
    for (const line of r.displayLines) {
      if (len + line.length + 1 > 3800) {
        chunks.push(current);
        current = [];
        len = 0;
      }
      current.push(line);
      len += line.length + 1;
    }
    if (current.length > 0) chunks.push(current);

    const firstChunk = chunks[0] ?? ["*No stats calculated.*"];
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`📊 ${r.label}`)
      .setDescription(firstChunk.join("\n"))
      .addFields({ name: "Auto-Calculated Total", value: `**${r.totalCoins.toLocaleString()} 🪙**`, inline: true });
    embeds.push(embed);

    // Extra chunks if description was too long
    for (let i = 1; i < chunks.length; i++) {
      embeds.push(
        new EmbedBuilder()
          .setColor(color)
          .setDescription(chunks[i]!.join("\n")),
      );
    }
  }

  // ── Summary embed ─────────────────────────────────────────────────────────────
  const summaryLines = results
    .sort((a, b) => b.totalCoins - a.totalCoins)
    .map(r => `• **${r.label}**: ${r.totalCoins.toLocaleString()} 🪙`);

  // Split summary into chunks if needed
  const summaryChunks: string[] = [];
  let summaryBuf = "";
  for (const line of summaryLines) {
    if (summaryBuf.length + line.length + 1 > 3800) {
      summaryChunks.push(summaryBuf);
      summaryBuf = "";
    }
    summaryBuf += (summaryBuf ? "\n" : "") + line;
  }
  if (summaryBuf) summaryChunks.push(summaryBuf);

  for (let i = 0; i < summaryChunks.length; i++) {
    const summaryEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(i === 0 ? "📋 Payout Summary (ranked by coins)" : "📋 Payout Summary (continued)")
      .setDescription(summaryChunks[i]!)
      .setFooter({ text: `Season ${seasonNum} • Excludes GOTY award bonuses` });
    embeds.push(summaryEmbed);
  }

  // ── 12. Send in batches — max 10 embeds and 6000 total chars per message ───────
  const batches = batchEmbeds(embeds);
  const [firstBatch, ...restBatches] = batches;

  await ctx.editReply({ embeds: firstBatch });

  for (const batch of restBatches) {
    await ctx.followUp({ embeds: batch, ephemeral: true });
  }
}

// ── Execute (slash command entrypoint) ────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  await runEosTestRun({
    guildId:          interaction.guildId!,
    seasonIdOverride: interaction.options.getInteger("season_id"),
    deferReply: opts => interaction.deferReply(opts),
    editReply:  data => interaction.editReply(data),
    followUp:   data => interaction.followUp(data as any),
  });
}

/** Approximate the character count Discord uses for a single embed. */
function embedCharCount(e: EmbedBuilder): number {
  const d = e.toJSON();
  let n = 0;
  if (d.title)            n += d.title.length;
  if (d.description)      n += d.description.length;
  if (d.footer?.text)     n += d.footer.text.length;
  if (d.author?.name)     n += d.author.name.length;
  for (const f of d.fields ?? []) n += f.name.length + f.value.length;
  return n;
}

/**
 * Split embeds into message batches, each with at most 10 embeds
 * and at most 6000 total characters.
 */
function batchEmbeds(embeds: EmbedBuilder[]): EmbedBuilder[][] {
  const MAX_EMBEDS = 10;
  const MAX_CHARS  = 5900; // slight safety margin below 6000
  const out: EmbedBuilder[][] = [];
  let current: EmbedBuilder[] = [];
  let currentChars = 0;

  for (const e of embeds) {
    const size = embedCharCount(e);
    if (current.length > 0 && (current.length >= MAX_EMBEDS || currentChars + size > MAX_CHARS)) {
      out.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(e);
    currentChars += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}
