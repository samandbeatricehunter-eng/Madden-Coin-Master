import { db } from "@workspace/db";
import {
  usersTable,
  seasonsTable,
  userRecordsTable,
  coinTransactionsTable,
  gameLogTable,
  h2hMatchupRecordsTable,
  franchiseScheduleTable,
  franchiseProcessedGamesTable,
  franchiseGameParticipantsTable,
  franchiseMcaTeamsTable,
  franchiseRostersTable,
  franchiseDraftPicksTable,
  teamSeasonStatsTable,
  playerSeasonStatsTable,
  playerStatWeekProcessedTable,
  rosterTransactionsTable,
  leagueNewsTable,
} from "@workspace/db";
import { eq, and, sql, inArray, isNotNull } from "drizzle-orm";
import {
  detectH2HBlowout,
  detectCpuScoreAnomaly,
  detectPlayerStatViolations,
  type ViolationRecord,
} from "./stat-padding-detector.js";

// ── Coin payouts (mirrors discord-bot/franchise-update.ts) ────────────────────
const H2H_WIN_PAYOUT  = 50;
const H2H_LOSS_PAYOUT = 20;
const CPU_WIN_PAYOUT  = 20;
const MIN_COMPLETED_STATUS = 2;

// ── Win milestones ─────────────────────────────────────────────────────────────
const H2H_MILESTONES = [
  { tier: 4, wins: 50, bonus: 1000, label: "50 All-Time Wins" },
  { tier: 3, wins: 25, bonus: 500,  label: "25 All-Time Wins" },
  { tier: 2, wins: 12, bonus: 250,  label: "12 All-Time Wins" },
  { tier: 1, wins: 5,  bonus: 100,  label:  "5 All-Time Wins" },
] as const;

function checkMilestone(totalWins: number, currentTier: number) {
  for (const m of H2H_MILESTONES) {
    if (totalWins >= m.wins && currentTier < m.tier) return m;
  }
  return null;
}

// ── Duplicated DB helpers (keeps API server free of discord.js dependency) ────

async function addBalance(discordId: string, amount: number): Promise<void> {
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, discordId));
}

async function logTransaction(
  discordId: string,
  amount: number,
  type: "addcoins" | "removecoins",
  description: string,
): Promise<void> {
  await db.insert(coinTransactionsTable).values({
    discordId, amount,
    type,
    description,
    relatedUserId: null,
  });
}

async function upsertH2HRecord(
  discordId: string,
  seasonId: number,
  won: boolean,
  pointSpread: number,
): Promise<void> {
  const userInfo = await db.select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
  if (!userInfo[0]) return;

  const existing = await db.select({ id: userRecordsTable.id })
    .from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, seasonId)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userRecordsTable).set({
      wins:              won  ? sql`${userRecordsTable.wins}   + 1` : userRecordsTable.wins,
      losses:            !won ? sql`${userRecordsTable.losses} + 1` : userRecordsTable.losses,
      pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointSpread}`,
      updatedAt: new Date(),
    }).where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, seasonId)));
  } else {
    await db.insert(userRecordsTable).values({
      discordId,
      discordUsername: userInfo[0].discordUsername,
      team:            userInfo[0].team ?? null,
      seasonId,
      wins:              won ? 1 : 0,
      losses:            won ? 0 : 1,
      pointDifferential: pointSpread,
    });
  }
}

async function appendGameLog(
  discordId: string,
  seasonId: number,
  result: "win" | "loss",
  pointSpread: number,
  opponentLabel: string,
  opponentDiscordId?: string,
): Promise<void> {
  await db.insert(gameLogTable).values({
    discordId, seasonId, result, pointSpread, opponentLabel,
    opponentDiscordId: opponentDiscordId ?? null,
    gameType: "regular_season",
  });
}

// Upsert per-opponent H2H matchup record.
// Pair is stored in canonical (alphabetically ascending) order.
async function upsertH2HMatchup(winnerId: string, loserId: string): Promise<void> {
  const [id1, id2] = winnerId < loserId ? [winnerId, loserId] : [loserId, winnerId];
  const winnerIsId1 = winnerId === id1;
  await db.insert(h2hMatchupRecordsTable)
    .values({
      discordId1: id1, discordId2: id2,
      wins1: winnerIsId1 ? 1 : 0,
      wins2: winnerIsId1 ? 0 : 1,
    })
    .onConflictDoUpdate({
      target: [h2hMatchupRecordsTable.discordId1, h2hMatchupRecordsTable.discordId2],
      set: winnerIsId1
        ? { wins1: sql`${h2hMatchupRecordsTable.wins1} + 1`, updatedAt: new Date() }
        : { wins2: sql`${h2hMatchupRecordsTable.wins2} + 1`, updatedAt: new Date() },
    });
}

export async function getOrCreateActiveSeason() {
  const existing = await db.select().from(seasonsTable).where(eq(seasonsTable.isActive, true)).limit(1);
  if (existing[0]) return existing[0]!;
  const [s] = await db.insert(seasonsTable).values({ seasonNumber: 1, isActive: true }).returning();
  return s!;
}

// ── Helpers for numeric field extraction ──────────────────────────────────────

function getN(obj: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

function extractList(data: any, ...wrapperKeys: string[]): any[] {
  if (!data) return [];
  for (const key of wrapperKeys) {
    const val = data[key];
    if (Array.isArray(val)) return val;
  }
  if (Array.isArray(data)) return data;
  return [];
}

// ── Result object returned from processing functions ─────────────────────────

export interface ProcessResult {
  ok: boolean;
  message: string;
  details?: Record<string, any>;
  violations?: ViolationRecord[];
}

// ── /leagueteams → populate franchiseMcaTeamsTable ───────────────────────────

export async function processLeagueTeams(body: unknown): Promise<ProcessResult> {
  try {
    const season = await getOrCreateActiveSeason();
    const teams = extractList(body, "leagueTeamInfoList", "teamInfoList", "teams");
    if (teams.length === 0) {
      return { ok: false, message: "No teams found in payload — expected leagueTeamInfoList" };
    }

    const registeredUsers = await db.select({
      discordId: usersTable.discordId,
      team: usersTable.team,
    }).from(usersTable);

    const teamToUser = new Map<string, string>();
    for (const u of registeredUsers) {
      if (u.team) teamToUser.set(u.team.toLowerCase().trim(), u.discordId);
    }

    // Madden CFM uses abbreviated / custom team names that differ from what
    // users register with in Discord.  Both the full MCA name (city + nick)
    // and the standalone nick are checked against this map.
    // Add entries here whenever the league renames a team.
    const MCA_ALIASES: Record<string, string[]> = {
      // ── NFC West ──────────────────────────────────────────────────────────────
      "niners":                   ["49ers", "san francisco 49ers"],
      "san francisco niners":     ["san francisco 49ers", "49ers"],
      "rams":                     ["rams", "los angeles rams"],
      // ── NFC East ─────────────────────────────────────────────────────────────
      "g-men":                    ["giants", "new york giants"],
      "new york g-men":           ["new york giants", "giants"],
      "big blue":                 ["giants", "new york giants"],
      // ── NFC North ────────────────────────────────────────────────────────────
      "pack":                     ["packers", "green bay packers"],
      "green bay pack":           ["green bay packers", "packers"],
      "vikes":                    ["vikings", "minnesota vikings"],
      "minnesota vikes":          ["minnesota vikings", "vikings"],
      // ── NFC South ────────────────────────────────────────────────────────────
      "bucs":                     ["buccaneers", "tampa bay buccaneers"],
      "tampa bay bucs":           ["tampa bay buccaneers", "buccaneers"],
      "aints":                    ["saints", "new orleans saints"],
      // ── AFC East ─────────────────────────────────────────────────────────────
      "phins":                    ["dolphins", "miami dolphins"],
      "miami phins":              ["miami dolphins", "dolphins"],
      "fins":                     ["dolphins", "miami dolphins"],
      "miami fins":               ["miami dolphins", "dolphins"],
      "pats":                     ["patriots", "new england patriots"],
      "new england pats":         ["new england patriots", "patriots"],
      // ── AFC South ────────────────────────────────────────────────────────────
      "jags":                     ["jaguars", "jacksonville jaguars"],
      "jacksonville jags":        ["jacksonville jaguars", "jaguars"],
      // ── AFC West ─────────────────────────────────────────────────────────────
      "bolts":                    ["chargers", "los angeles chargers"],
      "los angeles bolts":        ["los angeles chargers", "chargers"],
      "la bolts":                 ["los angeles chargers", "chargers"],
      "sd bolts":                 ["los angeles chargers", "chargers"],
      "silver and black":         ["raiders", "las vegas raiders"],
      // Additional short-form nicks users might register with
      "chiefs":                   ["chiefs", "kansas city chiefs"],
      "bears":                    ["bears", "chicago bears"],
      "lions":                    ["lions", "detroit lions"],
      "falcons":                  ["falcons", "atlanta falcons"],
      "panthers":                 ["panthers", "carolina panthers"],
      "saints":                   ["saints", "new orleans saints"],
      "seahawks":                 ["seahawks", "seattle seahawks"],
      "cardinals":                ["cardinals", "arizona cardinals"],
      "cowboys":                  ["cowboys", "dallas cowboys"],
      "eagles":                   ["eagles", "philadelphia eagles"],
      "commanders":               ["commanders", "washington commanders"],
      "redskins":                 ["commanders", "washington commanders"],
      "bengals":                  ["bengals", "cincinnati bengals"],
      "ravens":                   ["ravens", "baltimore ravens"],
      "browns":                   ["browns", "cleveland browns"],
      "steelers":                 ["steelers", "pittsburgh steelers"],
      "texans":                   ["texans", "houston texans"],
      "colts":                    ["colts", "indianapolis colts"],
      "titans":                   ["titans", "tennessee titans"],
      "broncos":                  ["broncos", "denver broncos"],
      "bills":                    ["bills", "buffalo bills"],
      "jets":                     ["jets", "new york jets"],
    };

    function findDiscordId(fullName: string, nick: string): string | null {
      const fn = fullName.toLowerCase().trim();
      const nk = nick.toLowerCase().trim();

      // 1. Direct match on full name or nick
      const direct = teamToUser.get(fn) ?? teamToUser.get(nk);
      if (direct) return direct;

      // 2. Alias lookup — check both the combined full name and the standalone nick
      for (const key of [fn, nk]) {
        for (const alias of MCA_ALIASES[key] ?? []) {
          const via = teamToUser.get(alias.toLowerCase().trim());
          if (via) return via;
        }
      }

      // 3. Fuzzy city fallback — if city matches exactly and we have only one
      //    user with that city prefix, use them (handles "Kansas City Chiefs" → "Chiefs")
      const city = fn.includes(" ") ? fn.split(" ").slice(0, -1).join(" ") : "";
      if (city) {
        const cityMatches = [...teamToUser.entries()].filter(([k]) => k.startsWith(city));
        if (cityMatches.length === 1) return cityMatches[0]![1];
      }

      return null;
    }

    let upserted = 0;
    const ops: Promise<any>[] = [];
    for (const t of teams) {
      const teamId = Number(t?.teamId ?? t?.teamIndex ?? -1);
      if (teamId < 0 || isNaN(teamId)) continue;

      const nick     = String(t?.nickName ?? t?.teamName ?? "").trim();
      const city     = String(t?.cityName ?? "").trim();
      const fullName = [city, nick].filter(Boolean).join(" ").trim();
      if (!fullName) continue;

      const userName = String(t?.userName ?? "CPU").trim();
      const isHuman  = userName !== "CPU" && userName !== "" && userName !== "0";
      const discordId = isHuman ? findDiscordId(fullName, nick) : null;

      ops.push(
        db.insert(franchiseMcaTeamsTable)
          .values({ seasonId: season.id, teamId, fullName, nickName: nick, userName, isHuman, discordId, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [franchiseMcaTeamsTable.seasonId, franchiseMcaTeamsTable.teamId],
            set: { fullName, nickName: nick, userName, isHuman, discordId, updatedAt: new Date() },
          })
      );
      upserted++;
    }
    await Promise.all(ops);
    console.log(`[mca/leagueteams] Upserted ${upserted} teams for season ${season.id}`);

    // ── Cascade discordId to any existing roster rows ─────────────────────────
    // When /leagueteams is re-imported after rosters already exist, update the
    // discordId on roster rows so autocomplete and viewroster commands work.
    const linkedTeams = await db.select({ teamId: franchiseMcaTeamsTable.teamId, discordId: franchiseMcaTeamsTable.discordId })
      .from(franchiseMcaTeamsTable)
      .where(and(
        eq(franchiseMcaTeamsTable.seasonId, season.id),
        isNotNull(franchiseMcaTeamsTable.discordId),
      ));
    if (linkedTeams.length > 0) {
      const cascadeOps = linkedTeams.map(({ teamId, discordId }) =>
        db.update(franchiseRostersTable)
          .set({ discordId })
          .where(and(
            eq(franchiseRostersTable.seasonId, season.id),
            eq(franchiseRostersTable.teamId, teamId),
          ))
      );
      await Promise.all(cascadeOps);
      console.log(`[mca/leagueteams] Cascaded discordId to roster rows for ${linkedTeams.length} linked teams`);
    }

    return { ok: true, message: `${upserted} teams imported`, details: { seasonId: season.id, teamCount: upserted } };
  } catch (err) {
    console.error("[mca/leagueteams] Error:", err);
    return { ok: false, message: String(err) };
  }
}

// ── /teamstats → update teamSeasonStatsTable ─────────────────────────────────

export async function processTeamStats(body: unknown): Promise<ProcessResult> {
  try {
    const season = await getOrCreateActiveSeason();
    const stats  = extractList(body, "teamStatInfoList", "teamStatsInfoList", "teamStats");
    if (stats.length === 0) {
      return { ok: false, message: "No team stats found in payload — expected teamStatInfoList" };
    }

    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

    const getOffPassYds = (t: any): number =>
      getN(t, "offPassYds","offensivePassYards","passYds","passingYards","passingYardsTotal");
    const getOffRushYds = (t: any): number =>
      getN(t, "offRushYds","offensiveRushYards","rushYds","rushingYards","rushingYardsTotal");
    const getOffYds = (t: any): number => {
      const pass = getOffPassYds(t);
      const rush = getOffRushYds(t);
      if (pass + rush > 0) return pass + rush;
      return getN(t, "offTotalYds","totalOffYards","offYards","totalOffensiveYards");
    };
    const getOffTDs = (t: any): number =>
      getN(t, "ptsFor","ptsScored","pointsFor","pointsScored","totalPoints");
    const getDefPassYds = (t: any): number =>
      getN(t, "defPassYds","defPassYards","passingYardsAllowed","defPassingYards");
    const getDefRushYds = (t: any): number =>
      getN(t, "defRushYds","defRushYards","rushingYardsAllowed","defRushingYards");
    const getDefTDs = (t: any): number =>
      getN(t, "ptsAgainst","pointsAgainst","defPtsAllowed","ptsAllowed","totalPtsAllowed","pointsAllowed","defPts");
    const getOffRedZonePct = (t: any): number =>
      getN(t, "offRedZonePct","offensiveRedZonePct","redZonePct","offRZPct","offensiveRedzonePct","offRedzonePct","offenseRedZonePct");
    const getDefRedZonePct = (t: any): number =>
      getN(t, "defRedZonePct","defensiveRedZonePct","defRedZoneAllowedPct","defRZPct","defenseRedZonePct","defRedzonePct");
    const getDefFumblesRec = (t: any): number =>
      getN(t, "defFumblesRec","fumblesRecovered","fumRec","fumRecovered","totalFumRec","defensiveFumblesRec","recoveredFumbles","fumbleRecoveries");
    const getTeamSacks = (t: any): number =>
      getN(t, "defSacks","totalSacks","sacks","teamSacks","sacksTotal","defTotalSacks","sacksFor","sacksAllowed","numSacks");
    const getTeamInts = (t: any): number =>
      getN(t, "defInterceptions","totalInts","ints","teamInts","defTotalInts","interceptionsFor","numInterceptions","defInts","interceptions");
    const getOffPpg = (t: any): number =>
      getN(t, "ptsPerGame","pointsPerGame","offPtsPerGame","ppg","avgPointsScored","avgPtsFor","pointsPerGameFor","offPpg");
    const getTurnoverDiff = (t: any): number => {
      // EA sends "tODiff" (capital O) — must be first in the list
      const direct = getN(t, "tODiff","turnOverDiff","turnoverDiff","turnoverDifferential","turnoverMargin","toMargin","toDiff","turnoversMargin","turnoversNet","tOMargin");
      if (direct !== 0) return direct;
      // Component fallback: EA sends "tOTakeaways" / "tOGiveaways"
      const defTO = getN(t, "tOTakeaways","defTurnovers","defensiveTurnovers","defTO","takeaways","turnoversForced","turnoversGained","defTotalTO");
      const offTO = getN(t, "tOGiveaways","offTurnovers","offensiveTurnovers","offTO","giveaways","turnoversCommitted","turnoversLost","offTotalTO");
      if (defTO !== 0 || offTO !== 0) return defTO - offTO;
      return 0;
    };

    const ops: Promise<any>[] = [];
    let upserted = 0;
    for (const t of stats) {
      const teamId = Number(t?.teamId ?? t?.teamIndex ?? -1);
      if (teamId < 0 || isNaN(teamId)) continue;

      const teamEntry = teamMap.get(teamId);
      if (!teamEntry) continue;

      const offPassYds    = getOffPassYds(t);
      const offRushYds    = getOffRushYds(t);
      const offYds        = offPassYds + offRushYds > 0 ? offPassYds + offRushYds : getOffYds(t);
      const offTDs        = getOffTDs(t);
      const defPassYds    = getDefPassYds(t);
      const defRushYds    = getDefRushYds(t);
      const defTDs        = getDefTDs(t);
      const offRedZonePct = getOffRedZonePct(t);
      const defRedZonePct = getDefRedZonePct(t);
      const defFumblesRec = getDefFumblesRec(t);
      const teamSacks     = getTeamSacks(t);
      const teamInts      = getTeamInts(t);
      const offPtsPerGame = getOffPpg(t);
      const turnoverDiff  = getTurnoverDiff(t);
      const wins          = getN(t, "wins","totalWins","seasonWins");
      const losses        = getN(t, "losses","totalLosses","seasonLosses");
      const updatedAt     = new Date();
      const insertVals: typeof teamSeasonStatsTable.$inferInsert = {
        seasonId: season.id, teamId, discordId: teamEntry.discordId ?? null,
        teamName: teamEntry.fullName, offYds, offPassYds, offRushYds,
        offTDs, offPtsPerGame, defPassYds, defRushYds, defTDs,
        teamSacks, teamInts, offRedZonePct, defRedZonePct, defFumblesRec,
        turnoverDiff, wins, losses, updatedAt,
      };
      ops.push(
        db.insert(teamSeasonStatsTable)
          .values(insertVals)
          .onConflictDoUpdate({
            target: [teamSeasonStatsTable.seasonId, teamSeasonStatsTable.teamId],
            set: {
              discordId: teamEntry.discordId ?? null, teamName: teamEntry.fullName,
              offYds, offPassYds, offRushYds, offTDs, offPtsPerGame,
              defPassYds, defRushYds, defTDs, teamSacks, teamInts,
              offRedZonePct, defRedZonePct, defFumblesRec,
              turnoverDiff, wins, losses, updatedAt,
            },
          })
      );
      upserted++;
    }
    await Promise.all(ops);
    console.log(`[mca/teamstats] Upserted ${upserted} team stat rows`);
    return { ok: true, message: `${upserted} team stats updated`, details: { seasonId: season.id } };
  } catch (err) {
    console.error("[mca/teamstats] Error:", err);
    return { ok: false, message: String(err) };
  }
}

// ── /week/:weekType/:weekNum/team → accumulate teamSeasonStatsTable week-over-week ──
// MCA sends per-game stats (not cumulative) for only the teams that played that week.
// We accumulate with dedup so re-exporting the same week doesn't double-count.
export async function processTeamWeekStats(
  body: unknown,
  weekType: string,
  weekNum: number,
): Promise<ProcessResult> {
  // Preseason stats don't count toward season totals
  if (weekType === "pre") {
    console.log(`[mca/week${weekNum}/team] Skipping preseason team stats — not accumulated into season totals`);
    return { ok: true, message: `Preseason Week ${weekNum} team stats — skipped (preseason stats not tracked)` };
  }

  try {
    const season = await getOrCreateActiveSeason();
    const stats  = extractList(body, "teamStatInfoList", "teamStatsInfoList", "teamStats");
    if (stats.length === 0) {
      return { ok: true, message: "No team stats in payload" };
    }

    // ── Dedup: skip if this week's team stats already processed ───────────────
    const alreadyDone = await db.select({ id: playerStatWeekProcessedTable.id })
      .from(playerStatWeekProcessedTable)
      .where(and(
        eq(playerStatWeekProcessedTable.seasonId, season.id),
        eq(playerStatWeekProcessedTable.weekType,  weekType),
        eq(playerStatWeekProcessedTable.weekNum,   weekNum),
        eq(playerStatWeekProcessedTable.statType,  "team"),
      ))
      .limit(1);

    if (alreadyDone.length > 0) {
      console.log(`[mca/week${weekNum}/team] Already processed — skipping`);
      return { ok: true, message: `Week ${weekNum} team stats already recorded — skipped` };
    }

    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

    const getOffPassYds = (t: any): number =>
      getN(t, "offPassYds","offensivePassYards","passYds","passingYards","passingYardsTotal");
    const getOffRushYds = (t: any): number =>
      getN(t, "offRushYds","offensiveRushYards","rushYds","rushingYards","rushingYardsTotal");
    const getOffYds = (t: any): number => {
      const pass = getOffPassYds(t); const rush = getOffRushYds(t);
      if (pass + rush > 0) return pass + rush;
      return getN(t, "offTotalYds","totalOffYards","offYards","totalOffensiveYards");
    };
    const getOffTDs = (t: any): number =>
      getN(t, "ptsFor","ptsScored","pointsFor","pointsScored","totalPoints");
    const getDefPassYds = (t: any): number =>
      getN(t, "defPassYds","defPassYards","passingYardsAllowed","defPassingYards");
    const getDefRushYds = (t: any): number =>
      getN(t, "defRushYds","defRushYards","rushingYardsAllowed","defRushingYards");
    const getDefTDs = (t: any): number =>
      getN(t, "ptsAgainst","pointsAgainst","defPtsAllowed","ptsAllowed","totalPtsAllowed","pointsAllowed","defPts");
    const getOffRedZonePct = (t: any): number =>
      getN(t, "offRedZonePct","offensiveRedZonePct","redZonePct","offRZPct","offensiveRedzonePct","offRedzonePct","offenseRedZonePct");
    const getDefRedZonePct = (t: any): number =>
      getN(t, "defRedZonePct","defensiveRedZonePct","defRedZoneAllowedPct","defRZPct","defenseRedZonePct","defRedzonePct");
    const getDefFumblesRec = (t: any): number =>
      getN(t, "defFumblesRec","fumblesRecovered","fumRec","fumRecovered","totalFumRec","defensiveFumblesRec","recoveredFumbles","fumbleRecoveries");
    const getTurnoverDiff = (t: any): number => {
      // EA sends "tODiff" (capital O) — must be first in the list
      const direct = getN(t, "tODiff","turnOverDiff","turnoverDiff","turnoverDifferential","turnoverMargin","toMargin","toDiff","turnoversMargin","turnoversNet","tOMargin");
      if (direct !== 0) return direct;
      // Component fallback: EA sends "tOTakeaways" / "tOGiveaways"
      const defTO = getN(t, "tOTakeaways","defTurnovers","defensiveTurnovers","defTO","takeaways","turnoversForced","turnoversGained","defTotalTO");
      const offTO = getN(t, "tOGiveaways","offTurnovers","offensiveTurnovers","offTO","giveaways","turnoversCommitted","turnoversLost","offTotalTO");
      if (defTO !== 0 || offTO !== 0) return defTO - offTO;
      return 0;
    };

    // ── Debug: log the first team's raw keys so we can see what EA sends ────────
    let loggedTeamSample = false;

    const ops: Promise<any>[] = [];
    let upserted = 0;

    for (const t of stats) {
      const teamId = Number(t?.teamId ?? t?.teamIndex ?? -1);
      if (teamId < 0 || isNaN(teamId)) continue;
      const teamEntry = teamMap.get(teamId);
      if (!teamEntry) continue;

      if (!loggedTeamSample) {
        const keys = Object.keys(t as object).join(", ");
        const toFields: Record<string, any> = {};
        for (const f of ["turnOverDiff","turnoverDiff","tOMargin","defTurnovers","offTurnovers",
          "defTO","offTO","takeaways","giveaways","turnoversForced","turnoversCommitted"]) {
          if ((t as any)[f] != null) toFields[f] = (t as any)[f];
        }
        console.log(`[team/week] Sample keys: ${keys}`);
        console.log(`[team/week] Turnover-related fields:`, JSON.stringify(toFields));
        loggedTeamSample = true;
      }

      const offPassYds    = getOffPassYds(t);
      const offRushYds    = getOffRushYds(t);
      const offYds        = offPassYds + offRushYds > 0 ? offPassYds + offRushYds : getOffYds(t);
      const offTDs        = getOffTDs(t);
      const defPassYds    = getDefPassYds(t);
      const defRushYds    = getDefRushYds(t);
      const defTDs        = getDefTDs(t);
      const offRedZonePct = getOffRedZonePct(t);
      const defRedZonePct = getDefRedZonePct(t);
      const defFumblesRec = getDefFumblesRec(t);
      const turnoverDiff  = getTurnoverDiff(t);
      const wins          = getN(t, "wins","totalWins","seasonWins");
      const losses        = getN(t, "losses","totalLosses","seasonLosses");

      ops.push(
        db.insert(teamSeasonStatsTable)
          .values({
            seasonId: season.id, teamId,
            discordId: teamEntry.discordId ?? null,
            teamName: teamEntry.fullName,
            offYds, offPassYds, offRushYds, offTDs,
            defPassYds, defRushYds, defTDs,
            offRedZonePct, defRedZonePct, defFumblesRec,
            turnoverDiff, wins, losses,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [teamSeasonStatsTable.seasonId, teamSeasonStatsTable.teamId],
            set: {
              discordId:  teamEntry.discordId ?? null,
              teamName:   teamEntry.fullName,
              // Counts: accumulate week-over-week (MCA sends per-game totals)
              offYds:        sql`${teamSeasonStatsTable.offYds}        + ${offYds}`,
              offPassYds:    sql`${teamSeasonStatsTable.offPassYds}    + ${offPassYds}`,
              offRushYds:    sql`${teamSeasonStatsTable.offRushYds}    + ${offRushYds}`,
              offTDs:        sql`${teamSeasonStatsTable.offTDs}        + ${offTDs}`,
              defPassYds:    sql`${teamSeasonStatsTable.defPassYds}    + ${defPassYds}`,
              defRushYds:    sql`${teamSeasonStatsTable.defRushYds}    + ${defRushYds}`,
              defTDs:        sql`${teamSeasonStatsTable.defTDs}        + ${defTDs}`,
              defFumblesRec: sql`${teamSeasonStatsTable.defFumblesRec} + ${defFumblesRec}`,
              // Turnover diff accumulates each week's +/- (can be negative)
              turnoverDiff:  sql`${teamSeasonStatsTable.turnoverDiff}  + ${turnoverDiff}`,
              wins:          sql`${teamSeasonStatsTable.wins}          + ${wins}`,
              losses:        sql`${teamSeasonStatsTable.losses}        + ${losses}`,
              // Percentages: overwrite with latest export value (running avg, not additive)
              ...(offRedZonePct > 0 ? { offRedZonePct } : {}),
              ...(defRedZonePct > 0 ? { defRedZonePct } : {}),
              updatedAt:  new Date(),
            },
          })
      );
      upserted++;
    }

    await Promise.all(ops);

    await db.insert(playerStatWeekProcessedTable).values({
      seasonId: season.id, weekType, weekNum,
      statType: "team", recordCount: upserted,
    });

    console.log(`[mca/week${weekNum}/team] Accumulated ${upserted} team stat rows, marked processed`);

    // Auto-seed playoffs if EA included conferenceRank data in this payload
    // (EA consistently sends this on all regular-season team exports; the function
    //  is a no-op if the field isn't present.)
    if (weekType === "reg") {
      void processPlayoffSeedings(body).then(r => {
        if (!r.ok) console.warn("[mca/week/team] Playoff seeding auto-update failed:", r.message);
        else if (r.message.includes("applied")) console.log("[mca/week/team] Playoff seedings:", r.message);
      });
    }

    return { ok: true, message: `week ${weekNum} team stats: accumulated ${upserted} teams`, details: { upserted } };
  } catch (err) {
    console.error("[mca/week/team] Error:", err);
    return { ok: false, message: String(err) };
  }
}

// ── Seed playoffs from MCA teamStandingInfoList (standings.json format) ───────
//
// The MCA standings push uses a different shape than the weekly team stats export:
//   teamStandingInfoList[].seed          → conference rank 1–16 (1–7 = playoff)
//   teamStandingInfoList[].conferenceName → "AFC" | "NFC"
//   teamStandingInfoList[].teamId
//
// This function is called by the /reseed-from-standings endpoint which reads
// mca/standings.json from GCS without needing a new EA export.

export async function processStandingsSeedings(body: unknown): Promise<ProcessResult> {
  try {
    const season   = await getOrCreateActiveSeason();
    const standings: any[] = (body as any)?.teamStandingInfoList ?? [];
    if (standings.length === 0) {
      return { ok: false, message: "No teamStandingInfoList entries in payload" };
    }

    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

    let applied = 0;
    const ops: Promise<any>[] = [];

    for (const t of standings) {
      const teamId = Number(t?.teamId ?? -1);
      if (teamId < 0 || isNaN(teamId)) continue;

      const confSeed = Number(t?.seed ?? 0);
      if (confSeed < 1 || confSeed > 7) continue; // not a playoff team

      const conferenceName: string | undefined = t?.conferenceName;
      if (conferenceName !== "AFC" && conferenceName !== "NFC") {
        console.warn(`[standings-seedings] Unknown conferenceName="${conferenceName}" for teamId=${teamId} — skipping`);
        continue;
      }

      const teamEntry = teamMap.get(teamId);
      if (!teamEntry?.discordId) continue; // CPU team — no Discord user

      console.log(`[standings-seedings] → ${teamEntry.fullName} (discord ${teamEntry.discordId}): ${conferenceName} Seed ${confSeed}`);
      ops.push(
        db.update(usersTable)
          .set({ playoffSeed: confSeed, playoffConference: conferenceName, updatedAt: new Date() })
          .where(eq(usersTable.discordId, teamEntry.discordId)),
      );
      applied++;
    }

    await Promise.all(ops);
    console.log(`[standings-seedings] Applied playoff seeds to ${applied} human teams`);
    return { ok: true, message: `Playoff seeds applied to ${applied} human teams from standings`, details: { applied } };
  } catch (err) {
    console.error("[standings-seedings] Error:", err);
    return { ok: false, message: String(err) };
  }
}

// ── Auto-seed playoffs from conference rank fields in EA teamStats ─────────────
//
// EA sends conferenceRank (1–7 = playoff teams) and conferenceId (0=AFC, 1=NFC)
// in the team stats payload. We read those here and write playoffSeed /
// playoffConference to usersTable so the historical channel and other systems
// can use them without manual /admin-playoffs setnfcseeds commands.
//
// Field name aliases tried (widest net, first non-zero wins):
//   conferenceRank | confRank | conferencestanding | confStanding | confPlace
//   conferenceId   | confId

export async function processPlayoffSeedings(body: unknown): Promise<ProcessResult> {
  try {
    const season = await getOrCreateActiveSeason();
    const stats  = extractList(body, "teamStatInfoList", "teamStatsInfoList", "teamStats");
    if (stats.length === 0) {
      return { ok: true, message: "No team stat entries — nothing to seed" };
    }

    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

    const getConfRank = (t: any): number =>
      Number(t?.conferenceRank ?? t?.confRank ?? t?.conferencestanding
        ?? t?.confStanding ?? t?.confPlace ?? 0);

    const getConfId = (t: any): number | null => {
      const v = t?.conferenceId ?? t?.confId;
      if (v == null) return null;
      return Number(v);
    };

    // Log raw conference data from first entry so we can validate the mapping
    const firstWithRank = stats.find((t: any) => getConfRank(t) > 0);
    if (firstWithRank) {
      console.log(`[seedings] Sample conferenceRank=${getConfRank(firstWithRank)} conferenceId=${getConfId(firstWithRank)} teamId=${(firstWithRank as any).teamId}`);
    } else {
      return { ok: true, message: "No conferenceRank fields found in payload — seeds unchanged" };
    }

    let applied = 0;
    const ops: Promise<any>[] = [];

    for (const t of stats) {
      const teamId   = Number(t?.teamId ?? t?.teamIndex ?? -1);
      if (teamId < 0 || isNaN(teamId)) continue;
      const teamEntry = teamMap.get(teamId);
      if (!teamEntry?.discordId) continue; // skip CPU teams

      const confRank = getConfRank(t);
      if (confRank < 1 || confRank > 7) continue; // not a playoff team

      const confId   = getConfId(t);
      // conferenceId 0=AFC, 1=NFC (same convention as wildcard-automation / awards)
      const conference = confId === 0 ? "AFC" : confId === 1 ? "NFC" : null;
      if (!conference) {
        console.warn(`[seedings] Unknown conferenceId=${confId} for teamId=${teamId} — skipping`);
        continue;
      }

      console.log(`[seedings] → ${teamEntry.fullName} (discord ${teamEntry.discordId}): ${conference} Seed ${confRank}`);
      ops.push(
        db.update(usersTable)
          .set({ playoffSeed: confRank, playoffConference: conference, updatedAt: new Date() })
          .where(eq(usersTable.discordId, teamEntry.discordId)),
      );
      applied++;
    }

    await Promise.all(ops);
    console.log(`[seedings] Applied playoff seeds to ${applied} human teams`);
    return { ok: true, message: `Playoff seeds applied to ${applied} human teams`, details: { applied } };
  } catch (err) {
    console.error("[seedings] Error:", err);
    return { ok: false, message: String(err) };
  }
}

// ── /week/:weekType/:weekNum/{passing|rushing|receiving|defense|kicking|punting|kickreturn|puntreturn} ──
export type WeekStatType = "passing" | "rushing" | "receiving" | "defense" | "kicking" | "punting" | "kickreturn" | "kickreturning" | "puntreturn" | "puntreturning";

// "playerStatInfoList" is included last for every type as a generic EA fallback —
// some EA WAL endpoints wrap all player records under this key regardless of stat category.
const STAT_LIST_KEYS: Record<WeekStatType, string[]> = {
  passing:       ["playerPassingStatInfoList",   "playerPassStatInfoList",   "playerPassingStatsInfoList",   "passingStats",   "playerStatInfoList"],
  rushing:       ["playerRushingStatInfoList",   "playerRushStatInfoList",   "playerRushingStatsInfoList",   "rushingStats",   "playerStatInfoList"],
  receiving:     ["playerReceivingStatInfoList", "playerRecStatInfoList",    "playerReceivingStatsInfoList",  "receivingStats", "playerStatInfoList"],
  defense:       [
    "playerDefensiveStatInfoList",   // most common MCA / EA key
    "playerDefenseStatInfoList",     // alternate spelling
    "playerDefStatInfoList",         // short form
    "playerDefensiveStatsInfoList",  // plural variant
    "playerDefenceStatInfoList",     // British spelling
    "playerDefenseStatsInfoList",    // plural alternate
    "playerDefenciveStatInfoList",   // typo variant seen in some proxies
    "defensiveStatInfoList",         // no-player prefix
    "defenseStatInfoList",           // no-player prefix alt
    "defStatInfoList",               // short no-prefix
    "playerStatInfoList",            // generic EA WAL fallback
  ],
  kicking:       ["playerKickingStatInfoList",   "playerKickStatInfoList",   "kickingStatInfoList",     "kickingStats",     "playerStatInfoList"],
  punting:       ["playerPuntingStatInfoList",   "playerPuntStatInfoList",   "puntingStatInfoList",     "puntingStats",     "playerStatInfoList"],
  kickreturn:    ["playerKickReturnStatInfoList","kickReturnStatInfoList",   "krStatInfoList",          "kickReturnStats",  "playerStatInfoList"],
  kickreturning: ["playerKickReturnStatInfoList","kickReturnStatInfoList",   "krStatInfoList",          "kickReturnStats",  "playerStatInfoList"],
  puntreturn:    ["playerPuntReturnStatInfoList","puntReturnStatInfoList",   "prStatInfoList",          "puntReturnStats",  "playerStatInfoList"],
  puntreturning: ["playerPuntReturnStatInfoList","puntReturnStatInfoList",   "prStatInfoList",          "puntReturnStats",  "playerStatInfoList"],
};

export async function processPlayerWeekStats(
  body: unknown,
  statType: WeekStatType,
  weekType: string,
  weekNum: number,
): Promise<ProcessResult> {
  // Preseason stats don't count toward season totals
  if (weekType === "pre") {
    console.log(`[mca/week${weekNum}/${statType}] Skipping preseason data — not accumulated into season stats`);
    return { ok: true, message: `Preseason Week ${weekNum} ${statType} — skipped (preseason stats not tracked)` };
  }

  try {
    const season  = await getOrCreateActiveSeason();
    const listKeys = STAT_LIST_KEYS[statType];
    const players = extractList(body, ...listKeys);

    if (!players.length) {
      // Log everything we need to diagnose a key-name mismatch:
      //   1. All top-level keys in the payload
      //   2. First 600 chars of raw JSON so structure is visible
      const topKeys = body && typeof body === "object" ? Object.keys(body as object).join(", ") : String(body);
      const rawSnippet = JSON.stringify(body).slice(0, 600);
      console.warn(
        `[mca/week${weekNum}/${statType}] ⚠️ No records found.\n` +
        `  Tried keys : [${listKeys.join(", ")}]\n` +
        `  Actual keys: ${topKeys || "(empty)"}\n` +
        `  Payload    : ${rawSnippet}`,
      );
      return { ok: true, message: `No ${statType} records in payload — tried keys: ${listKeys.join(", ")}` };
    }

    // ── Dedup check: skip if this week/stat combo has already been processed ──
    const alreadyDone = await db.select({ id: playerStatWeekProcessedTable.id })
      .from(playerStatWeekProcessedTable)
      .where(and(
        eq(playerStatWeekProcessedTable.seasonId, season.id),
        eq(playerStatWeekProcessedTable.weekType,  weekType),
        eq(playerStatWeekProcessedTable.weekNum,   weekNum),
        eq(playerStatWeekProcessedTable.statType,  statType),
      ))
      .limit(1);

    if (alreadyDone.length > 0) {
      console.log(`[mca/week${weekNum}/${statType}] Already processed — skipping to prevent double-count`);
      return { ok: true, message: `Week ${weekNum} ${statType} already recorded — skipped` };
    }

    const [mcaTeams, rosterRows] = await Promise.all([
      db.select().from(franchiseMcaTeamsTable)
        .where(eq(franchiseMcaTeamsTable.seasonId, season.id)),
      db.select({
        playerId:  franchiseRostersTable.playerId,
        firstName: franchiseRostersTable.firstName,
        lastName:  franchiseRostersTable.lastName,
        position:  franchiseRostersTable.position,
      }).from(franchiseRostersTable)
        .where(eq(franchiseRostersTable.seasonId, season.id)),
    ]);

    const teamMap   = new Map(mcaTeams.map(t => [t.teamId, t]));
    // Roster map: playerId → name/position (MCA stats don't include names, only roster IDs)
    const rosterMap = new Map(rosterRows.map(r => [r.playerId, r]));

    const ops: Promise<any>[] = [];
    let upserted = 0;
    let loggedSample = false;
    const statViolations: ViolationRecord[] = [];
    const wkLabel = weekType === "reg" ? `Week ${weekNum}` : `Playoff ${weekNum}`;

    for (const p of players) {
      // ── Debug: log first player's raw keys so we can verify MCA field names ──
      if (!loggedSample) {
        console.log(`[mca/week${weekNum}/${statType}] Sample player keys:`, Object.keys(p as object).join(", "));
        console.log(`[mca/week${weekNum}/${statType}] Sample player data:`, JSON.stringify(p).slice(0, 500));
        if (statType === "defense") {
          // Extra detail for defense so we can pin down the exact field names
          const defFields = ["sacks","defSacks","sack","defInts","interceptions","defInterceptions","ints",
            "totalTackles","defTotalTackles","tackleTotal","tackles",
            "tackleSolo","defTackleSolo","soloTackles","tackleAssist","defTackleAssist","assistTackles"];
          const found: Record<string,any> = {};
          for (const f of defFields) if ((p as any)[f] != null) found[f] = (p as any)[f];
          console.log(`[mca/week${weekNum}/defense] Defensive field values found:`, JSON.stringify(found));
        }
        loggedSample = true;
      }

      const playerId = getN(p, "rosterId", "playerId", "rosterid", "playerid");
      if (!playerId) continue;

      const teamId    = getN(p, "teamId", "teamid");
      const mcaTeam   = teamMap.get(teamId);
      const teamName  = mcaTeam?.fullName ?? String(p.teamName ?? p.teamname ?? "");
      const discordId = mcaTeam?.discordId ?? null;

      // MCA stat payloads typically only include the rosterId, not the player's name.
      // Cross-reference with the franchise roster table (populated by /franchiseupdate)
      // and fall back to any name fields the MCA payload might happen to include.
      const rosterEntry = rosterMap.get(playerId);
      const firstName = rosterEntry?.firstName
        || String(p.firstName ?? p.firstname ?? p.first_name ?? p.playerFirstName ?? "");
      const lastName  = rosterEntry?.lastName
        || String(p.lastName  ?? p.lastname  ?? p.last_name  ?? p.playerLastName  ?? "");
      const position  = rosterEntry?.position
        || String(p.position  ?? p.pos       ?? p.playerPosition ?? "");

      // MCA sends per-week stats (not cumulative season totals), so we ACCUMULATE
      // each week's export on top of the existing season total.
      // The dedup check above ensures the same week is never double-counted.
      let insertFields: Partial<typeof playerSeasonStatsTable.$inferInsert> = {};
      let accumSet:     Record<string, any> = {};

      if (statType === "passing") {
        const passYds    = getN(p, "passYds",     "passingYards",    "passyds");
        const passTDs    = getN(p, "passTDs",     "passingTds",      "passtds");
        const passAtt    = getN(p, "passAtt",     "passAttempts",    "passattempts",  "passatt",  "attempts");
        const passComp   = getN(p, "passComp",    "passCompletions", "completions",   "passcomp", "completionAttempts");
        const passInts   = getN(p, "passInts",    "passingInts",     "interceptions", "passInt",  "passingInterceptions", "intsThrown");
        const timesSacked = getN(p, "passSacks", "sackYdsLost","timesSacked",     "sacksRec",      "sacksAllowed", "sacksReceived", "qbSacks");
        insertFields = { passYds, passTDs, passAtt, passComp, passInts, timesSacked };
        accumSet     = {
          passYds:     sql`${playerSeasonStatsTable.passYds}     + ${passYds}`,
          passTDs:     sql`${playerSeasonStatsTable.passTDs}     + ${passTDs}`,
          passAtt:     sql`${playerSeasonStatsTable.passAtt}     + ${passAtt}`,
          passComp:    sql`${playerSeasonStatsTable.passComp}    + ${passComp}`,
          passInts:    sql`${playerSeasonStatsTable.passInts}    + ${passInts}`,
          timesSacked: sql`${playerSeasonStatsTable.timesSacked} + ${timesSacked}`,
        };
        const pViolations = detectPlayerStatViolations(
          `${firstName} ${lastName}`.trim(), position, teamName,
          { passYds: Number(passYds), passTDs: Number(passTDs) }, wkLabel,
        );
        statViolations.push(...pViolations);
      } else if (statType === "rushing") {
        const rushYds = getN(p, "rushYds", "rushingYards",    "rushyds");
        const rushTDs = getN(p, "rushTDs", "rushingTds",      "rushtds");
        const rushAtt = getN(p, "rushAtt", "rushAttempts",    "rushattempts", "rushatt", "carries", "rushCarries");
        const fumbles = getN(p, "rushFum", "fumbles",         "fumLost",      "fumblesLost", "offFumbles", "fumTotal", "fum");
        insertFields = { rushYds, rushTDs, rushAtt, fumbles };
        accumSet     = {
          rushYds: sql`${playerSeasonStatsTable.rushYds} + ${rushYds}`,
          rushTDs: sql`${playerSeasonStatsTable.rushTDs} + ${rushTDs}`,
          rushAtt: sql`${playerSeasonStatsTable.rushAtt} + ${rushAtt}`,
          fumbles: sql`${playerSeasonStatsTable.fumbles} + ${fumbles}`,
        };
        const rViolations = detectPlayerStatViolations(
          `${firstName} ${lastName}`.trim(), position, teamName,
          { rushYds: Number(rushYds) }, wkLabel,
        );
        statViolations.push(...rViolations);
      } else if (statType === "receiving") {
        const recYds = getN(p, "recYds", "receivingYards", "recyds");
        const recTDs = getN(p, "recTDs", "receivingTds",   "rectds");
        const recRec = getN(p, "recRec", "receptions",     "catches", "receptionsTotal", "recCatches");
        insertFields = { recYds, recTDs, recRec };
        accumSet     = {
          recYds: sql`${playerSeasonStatsTable.recYds} + ${recYds}`,
          recTDs: sql`${playerSeasonStatsTable.recTDs} + ${recTDs}`,
          recRec: sql`${playerSeasonStatsTable.recRec} + ${recRec}`,
        };
        const recViolations = detectPlayerStatViolations(
          `${firstName} ${lastName}`.trim(), position, teamName,
          { recYds: Number(recYds) }, wkLabel,
        );
        statViolations.push(...recViolations);
      } else if (statType === "defense") {
        const sacks          = getN(p, "defSacks",           "sacks",             "sack");
        const defInts        = getN(p, "defInts",            "defInterceptions",  "interceptions", "ints");
        const totalTackles   = getN(p, "defTotalTackles",    "totalTackles",      "tackleTotal", "tackles");
        const tackleSolo     = getN(p, "defTackleSolo",      "tackleSolo",        "soloTackles");
        const tackleAssist   = getN(p, "defTackleAssist",    "tackleAssist",      "assistTackles");
        const defFumblesRec  = getN(p, "defFumblesRec",      "fumblesRecovered",  "fumRec", "fumbleRecoveries", "fumbleRec", "fumbRec");
        const forcedFumbles  = getN(p, "defForcedFumbles",   "forcedFumbles",     "ffum", "fumForced", "defFF", "defForcedFum");
        const tacklesForLoss = getN(p, "defTacklesForLoss",  "tacklesForLoss",    "tfl", "defTFL", "tackleForLoss", "defTackleForLoss");
        const defTDs         = getN(p, "defTDs",             "defTouchdowns",     "defTD", "defensiveTDs", "defTdsTotal");
        insertFields = { sacks, defInts, totalTackles, tackleSolo, tackleAssist, defFumblesRec, forcedFumbles, tacklesForLoss, defTDs };
        accumSet     = {
          sacks:          sql`${playerSeasonStatsTable.sacks}          + ${sacks}`,
          defInts:        sql`${playerSeasonStatsTable.defInts}        + ${defInts}`,
          totalTackles:   sql`${playerSeasonStatsTable.totalTackles}   + ${totalTackles}`,
          tackleSolo:     sql`${playerSeasonStatsTable.tackleSolo}     + ${tackleSolo}`,
          tackleAssist:   sql`${playerSeasonStatsTable.tackleAssist}   + ${tackleAssist}`,
          defFumblesRec:  sql`${playerSeasonStatsTable.defFumblesRec}  + ${defFumblesRec}`,
          forcedFumbles:  sql`${playerSeasonStatsTable.forcedFumbles}  + ${forcedFumbles}`,
          tacklesForLoss: sql`${playerSeasonStatsTable.tacklesForLoss} + ${tacklesForLoss}`,
          defTDs:         sql`${playerSeasonStatsTable.defTDs}         + ${defTDs}`,
        };
      } else if (statType === "kicking") {
        const fgMade = getN(p, "fgMade", "fgm",  "fieldGoalsMade",    "fg_made");
        const fgAtt  = getN(p, "fgAtt",  "fga",  "fieldGoalAttempts", "fg_att", "fgAttempts");
        const fgLong = getN(p, "fgLong", "fglg", "fgLng",             "fgLongestMade", "fg_long");
        const xpMade = getN(p, "xpMade", "xpm",  "extraPointsMade",   "epMade", "xp_made");
        const xpAtt  = getN(p, "xpAtt",  "xpa",  "extraPointAttempts","epAtt",  "xp_att", "xpAttempts");
        insertFields = { fgMade, fgAtt, fgLong, xpMade, xpAtt };
        accumSet     = {
          fgMade: sql`${playerSeasonStatsTable.fgMade} + ${fgMade}`,
          fgAtt:  sql`${playerSeasonStatsTable.fgAtt}  + ${fgAtt}`,
          fgLong: sql`GREATEST(${playerSeasonStatsTable.fgLong}, ${fgLong})`,
          xpMade: sql`${playerSeasonStatsTable.xpMade} + ${xpMade}`,
          xpAtt:  sql`${playerSeasonStatsTable.xpAtt}  + ${xpAtt}`,
        };
      } else if (statType === "punting") {
        const puntAtt        = getN(p, "puntAtt",       "punts",       "puntCount",      "puntAttempts", "punt_att");
        const puntYds        = getN(p, "puntYds",       "puntingYds",  "puntYdsTotal",   "punt_yds");
        const puntLong       = getN(p, "puntLong",      "puntLng",     "puntLongest",    "punt_long");
        const puntIn20       = getN(p, "puntIn20",      "puntsIn20",   "puntInsideTwenty","punt_in_20");
        const puntTouchbacks = getN(p, "puntTouchbacks","puntTBs",     "puntTouchback",  "punt_touchbacks");
        insertFields = { puntAtt, puntYds, puntLong, puntIn20, puntTouchbacks };
        accumSet     = {
          puntAtt:        sql`${playerSeasonStatsTable.puntAtt}        + ${puntAtt}`,
          puntYds:        sql`${playerSeasonStatsTable.puntYds}        + ${puntYds}`,
          puntLong:       sql`GREATEST(${playerSeasonStatsTable.puntLong}, ${puntLong})`,
          puntIn20:       sql`${playerSeasonStatsTable.puntIn20}       + ${puntIn20}`,
          puntTouchbacks: sql`${playerSeasonStatsTable.puntTouchbacks} + ${puntTouchbacks}`,
        };
      } else if (statType === "kickreturn" || statType === "kickreturning") {
        const krAtt = getN(p, "krAtt", "kickReturnAtt",  "krReturns",   "kickReturnAttempts", "kr_att");
        const krYds = getN(p, "krYds", "kickReturnYds",  "kickRetYds",  "kr_yds");
        const krTDs = getN(p, "krTDs", "kickReturnTDs",  "kickRetTDs",  "krTouchdowns", "kr_tds");
        insertFields = { krAtt, krYds, krTDs };
        accumSet     = {
          krAtt: sql`${playerSeasonStatsTable.krAtt} + ${krAtt}`,
          krYds: sql`${playerSeasonStatsTable.krYds} + ${krYds}`,
          krTDs: sql`${playerSeasonStatsTable.krTDs} + ${krTDs}`,
        };
      } else if (statType === "puntreturn" || statType === "puntreturning") {
        const prAtt = getN(p, "prAtt", "puntReturnAtt",  "prReturns",   "puntReturnAttempts", "pr_att");
        const prYds = getN(p, "prYds", "puntReturnYds",  "puntRetYds",  "pr_yds");
        const prTDs = getN(p, "prTDs", "puntReturnTDs",  "puntRetTDs",  "prTouchdowns", "pr_tds");
        insertFields = { prAtt, prYds, prTDs };
        accumSet     = {
          prAtt: sql`${playerSeasonStatsTable.prAtt} + ${prAtt}`,
          prYds: sql`${playerSeasonStatsTable.prYds} + ${prYds}`,
          prTDs: sql`${playerSeasonStatsTable.prTDs} + ${prTDs}`,
        };
      }

      ops.push(
        db.insert(playerSeasonStatsTable)
          .values({
            seasonId: season.id,
            playerId, teamId, teamName, discordId, firstName, lastName, position,
            ...insertFields,
          })
          .onConflictDoUpdate({
            target: [playerSeasonStatsTable.seasonId, playerSeasonStatsTable.playerId],
            set: {
              // Team fields always update (player may switch teams mid-season)
              teamId, teamName, discordId,
              // Only overwrite name/position if we actually have a value — never blank out a good name
              ...(firstName ? { firstName } : {}),
              ...(lastName  ? { lastName  } : {}),
              ...(position  ? { position  } : {}),
              // Stat fields accumulate week over week
              ...accumSet,
              updatedAt: new Date(),
            },
          })
      );
      upserted++;
    }

    await Promise.all(ops);

    // ── Mark this week/stat combo as processed so re-exports are skipped ──────
    await db.insert(playerStatWeekProcessedTable).values({
      seasonId: season.id,
      weekType,
      weekNum,
      statType,
      recordCount: upserted,
    });

    console.log(`[mca/week${weekNum}/${statType}] Upserted ${upserted} records, ${statViolations.length} violations`);
    return { ok: true, message: `${statType} week ${weekNum}: upserted ${upserted} records`, details: { upserted }, violations: statViolations };
  } catch (err) {
    console.error(`[mca/${statType}] Error:`, err);
    return { ok: false, message: String(err) };
  }
}

// ── /schedules → sync franchiseScheduleTable ─────────────────────────────────

export async function processSchedules(body: unknown): Promise<ProcessResult> {
  try {
    const season = await getOrCreateActiveSeason();
    const games  = extractList(body, "scheduleInfoList", "gameScheduleInfoList", "schedules");
    if (games.length === 0) {
      return { ok: false, message: "No schedule data found — expected scheduleInfoList" };
    }

    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

    // No delete — use upsert so previously-recorded completed scores are never lost.
    // If MCA sends /schedules before or after /week/N/schedules, whichever has the
    // higher status wins: GREATEST(existing.status, incoming.status).
    // Scores are only written when the incoming row is completed (status >= 2).

    type SchedEntry = {
      hId: number; aId: number; weekIdx: number;
      hTeamName: string; aTeamName: string;
      hScore: number | null; aScore: number | null; status: number;
    };
    const schedMap = new Map<string, SchedEntry>();

    for (const g of games) {
      if (!g || typeof g !== "object") continue;
      const hId = Number(g.homeTeamId ?? -1);
      const aId = Number(g.awayTeamId ?? -1);
      if (hId < 0 || aId < 0) continue;

      const rawWeekIdx = Number(g.weekIndex ?? g.week ?? -1);
      if (rawWeekIdx < 0) continue;

      const weekType = Number(g.weekType ?? 1);
      // Regular season = weekType 1. Playoffs use weekType 2+ (Wild Card, Divisional, etc.).
      // Offset playoff weekIndex by 1000 so they never collide with reg-season rows.
      const weekIdx = weekType !== 1 ? 1000 + rawWeekIdx : rawWeekIdx;

      const hData  = teamMap.get(hId);
      const aData  = teamMap.get(aId);
      const hName  = hData?.fullName ?? `Team${hId}`;
      const aName  = aData?.fullName ?? `Team${aId}`;
      const hScore = g.homeScore != null ? Number(g.homeScore) : null;
      const aScore = g.awayScore != null ? Number(g.awayScore) : null;
      const status = Number(g.scheduleStatus ?? g.status ?? 0);

      const key      = `${weekIdx}-${hId}-${aId}`;
      const existing = schedMap.get(key);
      if (!existing || (status >= MIN_COMPLETED_STATUS && existing.status < MIN_COMPLETED_STATUS)) {
        schedMap.set(key, { hId, aId, weekIdx, hTeamName: hName, aTeamName: aName, hScore, aScore, status });
      }
    }

    const upserts: Promise<any>[] = [];
    for (const e of schedMap.values()) {
      upserts.push(
        db.insert(franchiseScheduleTable)
          .values({
            seasonId:     season.id,
            weekIndex:    e.weekIdx,
            homeTeamId:   e.hId,
            awayTeamId:   e.aId,
            homeTeamName: e.hTeamName,
            awayTeamName: e.aTeamName,
            homeScore:    e.hScore,
            awayScore:    e.aScore,
            status:       e.status,
            importedAt:   new Date(),
          })
          .onConflictDoUpdate({
            target: [
              franchiseScheduleTable.seasonId,
              franchiseScheduleTable.weekIndex,
              franchiseScheduleTable.homeTeamId,
              franchiseScheduleTable.awayTeamId,
            ],
            set: {
              // Always refresh team names in case of relocation
              homeTeamName: sql`excluded.home_team_name`,
              awayTeamName: sql`excluded.away_team_name`,
              // Only write scores/status when the incoming data is completed.
              // GREATEST preserves completed status if DB already has it.
              homeScore: sql`CASE WHEN excluded.status >= ${MIN_COMPLETED_STATUS} THEN excluded.home_score ELSE ${franchiseScheduleTable.homeScore} END`,
              awayScore: sql`CASE WHEN excluded.status >= ${MIN_COMPLETED_STATUS} THEN excluded.away_score ELSE ${franchiseScheduleTable.awayScore} END`,
              status:    sql`GREATEST(${franchiseScheduleTable.status}, excluded.status)`,
              importedAt: new Date(),
            },
          })
      );
    }
    await Promise.all(upserts);
    console.log(`[mca/schedules] Synced ${schedMap.size} schedule entries for season ${season.id}`);
    return { ok: true, message: `${schedMap.size} schedule entries synced`, details: { seasonId: season.id } };
  } catch (err) {
    console.error("[mca/schedules] Error:", err);
    return { ok: false, message: String(err) };
  }
}

// ── /week/:weekType/:weekNum/scores → game payouts ───────────────────────────

export interface WeekScoresResult {
  ok: boolean;
  message: string;
  gamesProcessed: number;
  gamesDuplicate: number;
  gamesCpuVsCpu: number;
  gamesUnregistered: number;
  payoutLines: string[];
  milestoneLines: string[];
  resultLines: string[];        // all completed games (scored), including unregistered
  unregisteredLines: string[];  // human teams with no Discord link
  weekNum: number;
  seasonId: number;
  catchupMode: boolean;         // true when catchup mode is active (no payouts/notifications)
  violations: ViolationRecord[]; // stat-padding / blowout flags for commissioner review
}

/**
 * Normalizes a (weekType, weekNum) pair from MCA into the canonical playoff
 * weekIndex used throughout the app (1018/1019/1020/1022).
 *
 * MCA may send playoff data in two formats:
 *   Format A — weekType="reg",  weekNum=19-23  (continuous numbering)
 *     Wild Card=19→1018, Divisional=20→1019, Conference=21→1020, SB=23→1022
 *   Format B — weekType="post", weekNum=1-5   (post-season numbering)
 *     Wild Card=1→1018, Divisional=2→1019, Conference=3→1020, Pro Bowl=4→1021, SB=5→1022
 *
 * Returns null for regular-season weeks (should not call for weekType=reg and weekNum<19).
 */
export function resolvePlayoffWeekIndex(weekType: string, weekNum: number): number {
  if (weekType === "reg") {
    // Format A: weekNum is a continuous 1-based count (19 = Wild Card, etc.)
    return 1000 + weekNum - 1;
  }
  // Format B: weekType is "post" (or any non-"reg") with 1-based post-season numbering
  const POST_MAP: Record<number, number> = {
    1: 1018,  // Wild Card
    2: 1019,  // Divisional
    3: 1020,  // Conference Championship
    4: 1021,  // Pro Bowl (skipped in most CFM leagues; harmless if present)
    5: 1022,  // Super Bowl
  };
  return POST_MAP[weekNum] ?? (1000 + weekNum - 1);
}

const PLAYOFF_ROUND_LABELS: Record<number, string> = {
  1018: "Wild Card",
  1019: "Divisional Round",
  1020: "Conference Championship",
  1022: "Super Bowl",
};

/**
 * Syncs completed game scores from a /week/N/schedules MCA payload into
 * franchiseScheduleTable. Called before processWeekScores so that results
 * appear in /seasonschedule immediately, regardless of the order in which
 * MCA sends /schedules vs /week/N/schedules.
 */
export async function syncWeekScoresToSchedule(
  body: unknown,
  weekNum: number,
  weekType = "reg",
): Promise<void> {
  // Preseason games don't count toward records or schedule display
  if (weekType === "pre") {
    console.log(`[syncWeekScores] Skipping preseason week ${weekNum} — preseason games not tracked`);
    return;
  }

  try {
    const season = await getOrCreateActiveSeason();

    // MCA may send playoff rounds as weekType="reg" weekNum>=19 (Format A) OR
    // weekType="post" weekNum=1-5 (Format B). resolvePlayoffWeekIndex normalises
    // both into the canonical 1018/1019/1020/1022 values used throughout the app.
    const isPlayoff = weekType !== "reg" || weekNum >= 19;
    const weekIndex = isPlayoff ? resolvePlayoffWeekIndex(weekType, weekNum) : weekNum - 1;

    const games = extractList(body, "gameScheduleInfoList", "scheduleInfoList", "games");

    // Load team name map so we can write readable team names into the schedule table.
    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

    const upserts: Promise<any>[] = [];
    for (const g of games) {
      if (!g || typeof g !== "object") continue;

      const hId = Number(g.homeTeamId ?? -1);
      const aId = Number(g.awayTeamId ?? -1);
      if (hId < 0 || aId < 0) continue;

      const status    = Number(g.scheduleStatus ?? g.status ?? 0);
      const hName     = teamMap.get(hId)?.fullName ?? `Team${hId}`;
      const aName     = teamMap.get(aId)?.fullName ?? `Team${aId}`;
      const homeScore = status >= MIN_COMPLETED_STATUS ? Number(g.homeScore ?? 0) : null;
      const awayScore = status >= MIN_COMPLETED_STATUS ? Number(g.awayScore ?? 0) : null;

      // Upsert: creates the row if it doesn't exist yet (schedule not pre-imported),
      // or updates scores/status when the game is completed.
      upserts.push(
        db.insert(franchiseScheduleTable)
          .values({
            seasonId:     season.id,
            weekIndex,
            homeTeamId:   hId,
            awayTeamId:   aId,
            homeTeamName: hName,
            awayTeamName: aName,
            homeScore,
            awayScore,
            status,
            importedAt:   new Date(),
          })
          .onConflictDoUpdate({
            target: [
              franchiseScheduleTable.seasonId,
              franchiseScheduleTable.weekIndex,
              franchiseScheduleTable.homeTeamId,
              franchiseScheduleTable.awayTeamId,
            ],
            set: {
              homeTeamName: sql`excluded.home_team_name`,
              awayTeamName: sql`excluded.away_team_name`,
              homeScore:    sql`CASE WHEN excluded.status >= ${MIN_COMPLETED_STATUS} THEN excluded.home_score ELSE ${franchiseScheduleTable.homeScore} END`,
              awayScore:    sql`CASE WHEN excluded.status >= ${MIN_COMPLETED_STATUS} THEN excluded.away_score ELSE ${franchiseScheduleTable.awayScore} END`,
              status:       sql`GREATEST(${franchiseScheduleTable.status}, excluded.status)`,
              importedAt:   new Date(),
            },
          })
      );
    }

    await Promise.all(upserts);
    console.log(`[syncWeekScores] Upserted ${upserts.length} schedule entries for season ${season.id} week ${weekNum} (weekIndex=${weekIndex}, playoff=${isPlayoff})`);
  } catch (err) {
    console.error("[syncWeekScores] Error:", err);
  }
}

export async function processWeekScores(
  body: unknown,
  weekNum: number,
  weekType = "reg",
): Promise<WeekScoresResult> {
  const zero: WeekScoresResult = {
    ok: false, message: "", gamesProcessed: 0, gamesDuplicate: 0,
    gamesCpuVsCpu: 0, gamesUnregistered: 0, payoutLines: [], milestoneLines: [],
    resultLines: [], unregisteredLines: [],
    weekNum, seasonId: 0, catchupMode: false, violations: [],
  };

  // Preseason games don't count for records, payouts, or coin rewards
  if (weekType === "pre") {
    console.log(`[processWeekScores] Skipping preseason week ${weekNum} — preseason games not tracked`);
    return { ...zero, ok: true, message: `Preseason Week ${weekNum} — skipped (preseason games do not count for records or payouts)` };
  }

  try {
    const season = await getOrCreateActiveSeason();
    zero.seasonId = season.id;

    const games = extractList(body, "gameScheduleInfoList", "scheduleInfoList", "games");
    if (games.length === 0) {
      return { ...zero, ok: false, message: "No game data found — expected gameScheduleInfoList" };
    }

    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap  = new Map(mcaTeams.map(t => [t.teamId, t]));

    const allProcessed = await db.select({ gameId: franchiseProcessedGamesTable.gameId })
      .from(franchiseProcessedGamesTable);
    const processedSet = new Set(allProcessed.map(r => r.gameId));

    // MCA may send playoff rounds as weekType="reg" weekNum>=19 (Format A) OR
    // weekType="post" weekNum=1-5 (Format B). resolvePlayoffWeekIndex normalises
    // both into the canonical 1018/1019/1020/1022 values used throughout the app.
    const isPlayoff       = weekType !== "reg" || weekNum >= 19;
    const weekIndexTarget = isPlayoff ? resolvePlayoffWeekIndex(weekType, weekNum) : weekNum - 1;

    let gamesProcessed    = 0;
    let gamesDuplicate    = 0;
    let gamesCpuVsCpu     = 0;
    let gamesUnregistered = 0;
    const payoutLines:       string[] = [];
    const milestoneLines:    string[] = [];
    const resultLines:       string[] = [];
    const unregisteredLines: string[] = [];
    const violations:        ViolationRecord[] = [];
    const seenKeys = new Set<string>();
    const roundLabel = isPlayoff
      ? (PLAYOFF_ROUND_LABELS[weekIndexTarget] ?? `Playoff Round ${weekNum}`)
      : `Week ${weekNum}`;

    for (const g of games) {
      if (!g || typeof g !== "object") continue;
      if (Number(g.scheduleStatus ?? g.status ?? 0) < MIN_COMPLETED_STATUS) continue;

      const hId = Number(g.homeTeamId ?? -1);
      const aId = Number(g.awayTeamId ?? -1);
      if (hId < 0 || aId < 0) continue;

      const runKey = `${hId}-${aId}`;
      if (seenKeys.has(runKey)) { gamesDuplicate++; continue; }
      seenKeys.add(runKey);

      const homeScore = Number(g.homeScore ?? 0);
      const awayScore = Number(g.awayScore ?? 0);

      const rawId  = g.scheduleId ?? g.gameId ?? null;
      // Include weekType in fallback ID so playoff week 1 never collides with reg week 1
      const gameId = rawId != null
        ? String(rawId)
        : `s${season.id}-${weekType}-w${weekNum}-h${hId}-a${aId}-${homeScore}-${awayScore}`;

      if (processedSet.has(gameId)) { gamesDuplicate++; continue; }

      const hData = teamMap.get(hId);
      const aData = teamMap.get(aId);
      if (!hData || !aData) continue;

      if (!hData.isHuman && !aData.isHuman) { gamesCpuVsCpu++; continue; }

      const homeIsHuman = hData.isHuman;
      const awayIsHuman = aData.isHuman;

      if ((homeIsHuman && !hData.discordId) || (awayIsHuman && !aData.discordId)) {
        gamesUnregistered++;
        const hiScore = Math.max(homeScore, awayScore);
        const loScore = Math.min(homeScore, awayScore);
        const unregTeams: string[] = [];
        if (homeIsHuman && !hData.discordId) unregTeams.push(`**${hData.fullName}** (userName: \`${hData.userName}\`)`);
        if (awayIsHuman && !aData.discordId) unregTeams.push(`**${aData.fullName}** (userName: \`${aData.userName}\`)`);
        unregisteredLines.push(`⚠️ ${unregTeams.join(" & ")} — not linked to Discord *(${hiScore}–${loScore})*`);
        resultLines.push(`⚠️ **${hData.fullName}** ${homeScore} — ${awayScore} **${aData.fullName}** *(unregistered)*`);
        continue;
      }

      const isTie   = homeScore === awayScore;
      const homeWon = homeScore > awayScore;
      const status  = Number(g.scheduleStatus ?? g.status ?? 2);
      const bothReg = homeIsHuman && awayIsHuman;

      // Detect force/autopilot games via explicit MCA fields.
      // NOTE: Madden 24/25 MCA sends scheduleStatus=2 for ALL completed games
      // (both legit H2H and simulated), so status alone cannot reliably
      // distinguish them. Prefer explicit force fields when present.
      const hasForceFlag = !!(
        g.isForceWin        || g.isForced        || g.forceWin    ||
        g.homeForceWin      || g.awayForceWin    ||
        g.homeAutoPilot     || g.awayAutoPilot   ||
        g.isSimulated       || g.wasSimulated     || g.isAutopilot  ||
        g.homeIsForceWin    || g.awayIsForceWin
      );

      // Log status + force fields to help diagnose mismatches
      if (bothReg) {
        console.log(
          `[h2h-detect] ${hData.fullName} vs ${aData.fullName}` +
          ` status=${status} hasForceFlag=${hasForceFlag}` +
          ` keys=[${Object.keys(g as Record<string,unknown>).join(",")}]`
        );
      }

      // When both teams are registered humans, default to H2H unless an
      // explicit force indicator is present on the game object.
      const isTrueH2H   = bothReg && !hasForceFlag;
      const isForcedCPU = bothReg && hasForceFlag;

      // ── Catchup mode: log result + mark processed, skip all payouts/coins ──
      if (season.catchupMode) {
        const hiScore    = Math.max(homeScore, awayScore);
        const loScore    = Math.min(homeScore, awayScore);
        const winnerName = homeWon ? hData.fullName : aData.fullName;
        const loserName  = homeWon ? aData.fullName : hData.fullName;
        resultLines.push(isTie
          ? `🤝 **${hData.fullName}** ${homeScore} — ${awayScore} **${aData.fullName}** *(tie)*`
          : `📋 **${winnerName}** ${hiScore} — ${loScore} **${loserName}**`
        );
        await db.insert(franchiseProcessedGamesTable)
          .values({
            gameId, payoutType: "catchup",
            seasonIdRef: season.id, weekIndexRef: weekIndexTarget,
            homeTeamRef: hData.fullName.toLowerCase(),
            awayTeamRef: aData.fullName.toLowerCase(),
          })
          .onConflictDoNothing();
        processedSet.add(gameId);
        gamesProcessed++;
        continue;
      }

      // Payout metadata — populated in each branch, saved to DB for admin-correctpayout reversals
      let payoutMeta: {
        payoutType: string;
        winnerDiscordId?: string | null;
        loserDiscordId?: string | null;
        winnerCoins?: number | null;
        loserCoins?: number | null;
        appliedPointDiff?: number | null;
        milestoneBonus?: number | null;
        milestonePrevTier?: number | null;
      } = { payoutType: "none" };

      if (isTrueH2H) {
        if (!isTie) {
          const winnerId   = homeWon ? hData.discordId!  : aData.discordId!;
          const loserId    = homeWon ? aData.discordId!  : hData.discordId!;
          const winnerTeam = homeWon ? hData.fullName    : aData.fullName;
          const loserTeam  = homeWon ? aData.fullName    : hData.fullName;
          const hiScore    = Math.max(homeScore, awayScore);
          const loScore    = Math.min(homeScore, awayScore);
          const spread     = hiScore - loScore;

          const gameRoundLabel = isPlayoff
            ? ` (Playoff Round ${weekNum})`
            : ` (Week ${weekNum})`;

          // ── Blowout detection ──────────────────────────────────────────────
          const blowoutFlag = detectH2HBlowout(winnerTeam, loserTeam, hiScore, loScore, roundLabel, winnerId);
          if (blowoutFlag) violations.push(blowoutFlag);

          await addBalance(winnerId, H2H_WIN_PAYOUT);
          await logTransaction(winnerId, H2H_WIN_PAYOUT, "addcoins",
            `MCA webhook: ${isPlayoff ? "Playoff" : "H2H"} win vs ${loserTeam} (${hiScore}–${loScore})${gameRoundLabel}`);
          await addBalance(loserId, H2H_LOSS_PAYOUT);
          await logTransaction(loserId, H2H_LOSS_PAYOUT, "addcoins",
            `MCA webhook: ${isPlayoff ? "Playoff" : "H2H"} loss vs ${winnerTeam} (${loScore}–${hiScore})${gameRoundLabel}`);

          const resultPrefix = isPlayoff ? "🏆🏈" : "🏆";
          payoutLines.push(`${resultPrefix} **${winnerTeam}** +${H2H_WIN_PAYOUT} | 🎮 **${loserTeam}** +${H2H_LOSS_PAYOUT} *(${hiScore}–${loScore})*`);
          resultLines.push(`${resultPrefix} **${winnerTeam}** ${hiScore} — ${loScore} **${loserTeam}**`);

          await upsertH2HRecord(winnerId, season.id, true,    spread);
          await upsertH2HRecord(loserId,  season.id, false, -spread);
          await appendGameLog(winnerId, season.id, "win",  spread,  loserTeam,   loserId);
          await appendGameLog(loserId,  season.id, "loss", -spread, winnerTeam,  winnerId);

          await db.update(usersTable)
            .set({ allTimeH2HWins: sql`${usersTable.allTimeH2HWins} + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, winnerId));
          await db.update(usersTable)
            .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, loserId));
          await upsertH2HMatchup(winnerId, loserId);

          // Track playoff wins/losses separately in userRecordsTable
          if (isPlayoff) {
            await db.update(userRecordsTable)
              .set({ playoffWins: sql`${userRecordsTable.playoffWins} + 1` })
              .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)));
            await db.update(userRecordsTable)
              .set({ playoffLosses: sql`${userRecordsTable.playoffLosses} + 1` })
              .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)));

            // Super Bowl: also credit superbowlWins / superbowlLosses and all-time SB wins
            if (weekIndexTarget === 1022) {
              await db.update(userRecordsTable)
                .set({ superbowlWins: sql`${userRecordsTable.superbowlWins} + 1` })
                .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)));
              await db.update(userRecordsTable)
                .set({ superbowlLosses: sql`${userRecordsTable.superbowlLosses} + 1` })
                .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)));
              await db.update(usersTable)
                .set({ allTimeSuperbowlWins: sql`${usersTable.allTimeSuperbowlWins} + 1`, updatedAt: new Date() })
                .where(eq(usersTable.discordId, winnerId));
            }
          }

          const winnerRow = await db.select({ allTimeH2HWins: usersTable.allTimeH2HWins, milestoneTierAwarded: usersTable.milestoneTierAwarded })
            .from(usersTable).where(eq(usersTable.discordId, winnerId)).limit(1);
          const prevMilestoneTier = winnerRow[0]?.milestoneTierAwarded ?? 0;
          const milestone = checkMilestone(winnerRow[0]?.allTimeH2HWins ?? 0, prevMilestoneTier);
          let milestoneBonusAwarded: number | null = null;
          if (milestone) {
            await addBalance(winnerId, milestone.bonus);
            await logTransaction(winnerId, milestone.bonus, "addcoins", `Career milestone: ${milestone.label} (MCA webhook)`);
            await db.update(usersTable)
              .set({ milestoneTierAwarded: milestone.tier, updatedAt: new Date() })
              .where(eq(usersTable.discordId, winnerId));
            milestoneLines.push(`🎯 **${winnerTeam}** hit **${milestone.label}** → +${milestone.bonus} coins`);
            milestoneBonusAwarded = milestone.bonus;
          }

          payoutMeta = {
            payoutType: isPlayoff ? "playoff" : "h2h",
            winnerDiscordId: winnerId, loserDiscordId: loserId,
            winnerCoins: H2H_WIN_PAYOUT, loserCoins: H2H_LOSS_PAYOUT,
            appliedPointDiff: spread,
            milestoneBonus:    milestoneBonusAwarded,
            milestonePrevTier: milestoneBonusAwarded !== null ? prevMilestoneTier : null,
          };
          await db.insert(franchiseGameParticipantsTable)
            .values([
              { seasonId: season.id, week: String(weekNum), discordId: winnerId, gameType: "h2h" },
              { seasonId: season.id, week: String(weekNum), discordId: loserId,  gameType: "h2h" },
            ]).onConflictDoNothing();

        } else {
          await appendGameLog(hData.discordId!, season.id, "loss", 0, aData.fullName);
          await appendGameLog(aData.discordId!, season.id, "loss", 0, hData.fullName);
          payoutLines.push(`🤝 **${hData.fullName}** vs **${aData.fullName}** — Tie *(no payout)*`);
          resultLines.push(`🤝 **${hData.fullName}** ${homeScore} — ${awayScore} **${aData.fullName}** *(tie)*`);
        }

      } else if (isForcedCPU) {
        const hiScore    = Math.max(homeScore, awayScore);
        const loScore    = Math.min(homeScore, awayScore);
        const winnerId   = homeWon ? hData.discordId! : aData.discordId!;
        const winnerTeam = homeWon ? hData.fullName   : aData.fullName;
        const loserTeam  = homeWon ? aData.fullName   : hData.fullName;
        const spread     = Math.abs(homeScore - awayScore);

        if (!isTie) {
          await addBalance(winnerId, CPU_WIN_PAYOUT);
          await logTransaction(winnerId, CPU_WIN_PAYOUT, "addcoins",
            `MCA webhook: CPU win vs ${loserTeam} (${hiScore}–${loScore})`);
          payoutLines.push(`🤖 **${winnerTeam}** +${CPU_WIN_PAYOUT} *(force/autopilot vs ${loserTeam} ${hiScore}–${loScore})*`);
          resultLines.push(`🤖 **${winnerTeam}** ${hiScore} — ${loScore} **${loserTeam}** *(force/autopilot)*`);
          await appendGameLog(winnerId, season.id, "win", spread, `[CPU] ${loserTeam}`);
          payoutMeta = {
            payoutType: "cpu",
            winnerDiscordId: winnerId, loserDiscordId: null,
            winnerCoins: CPU_WIN_PAYOUT, loserCoins: 0,
            appliedPointDiff: spread,
          };
          for (const uid of [hData.discordId!, aData.discordId!]) {
            await db.insert(franchiseGameParticipantsTable)
              .values({ seasonId: season.id, week: String(weekNum), discordId: uid, gameType: "cpu" })
              .onConflictDoNothing();
          }
        } else {
          payoutLines.push(`🤖 **${hData.fullName}** vs **${aData.fullName}** — Tie *(force/autopilot, no payout)*`);
          resultLines.push(`🤖 **${hData.fullName}** ${homeScore} — ${awayScore} **${aData.fullName}** *(force/autopilot tie)*`);
        }

      } else {
        const humanData  = homeIsHuman ? hData : aData;
        const cpuData    = homeIsHuman ? aData : hData;
        const humanScore = homeIsHuman ? homeScore : awayScore;
        const cpuScore   = homeIsHuman ? awayScore : homeScore;
        const humanWon   = humanScore > cpuScore && !isTie;
        const spread     = humanScore - cpuScore;

        // ── CPU score anomaly detection ────────────────────────────────────
        const cpuFlag = detectCpuScoreAnomaly(humanData.fullName, cpuData.fullName, humanScore, cpuScore, roundLabel, humanData.discordId ?? undefined);
        if (cpuFlag) violations.push(cpuFlag);

        if (humanWon) {
          await addBalance(humanData.discordId!, CPU_WIN_PAYOUT);
          await logTransaction(humanData.discordId!, CPU_WIN_PAYOUT, "addcoins",
            `MCA webhook: CPU win vs ${cpuData.fullName} (${humanScore}–${cpuScore})`);
          payoutLines.push(`🤖 **${humanData.fullName}** +${CPU_WIN_PAYOUT} *(CPU win vs ${cpuData.fullName} ${humanScore}–${cpuScore})*`);
          resultLines.push(`🤖 **${humanData.fullName}** ${humanScore} — ${cpuScore} **${cpuData.fullName}** *(CPU)*`);
          payoutMeta = {
            payoutType: "cpu",
            winnerDiscordId: humanData.discordId!, loserDiscordId: null,
            winnerCoins: CPU_WIN_PAYOUT, loserCoins: 0,
            appliedPointDiff: Math.abs(spread),
          };
        } else {
          resultLines.push(`❌ **${humanData.fullName}** ${humanScore} — ${cpuScore} **${cpuData.fullName}** *(CPU loss)*`);
        }
        await appendGameLog(humanData.discordId!, season.id, humanWon ? "win" : "loss", spread, `[CPU] ${cpuData.fullName}`);
        await db.insert(franchiseGameParticipantsTable)
          .values({ seasonId: season.id, week: String(weekNum), discordId: humanData.discordId!, gameType: "cpu" })
          .onConflictDoNothing();
      }

      await db.insert(franchiseProcessedGamesTable)
        .values({
          gameId,
          ...payoutMeta,
          seasonIdRef: season.id,
          weekIndexRef: weekIndexTarget,
          homeTeamRef: hData.fullName.toLowerCase(),
          awayTeamRef: aData.fullName.toLowerCase(),
        })
        .onConflictDoNothing();
      processedSet.add(gameId);

      await db.update(franchiseScheduleTable)
        .set({ processedGameId: gameId })
        .where(and(
          eq(franchiseScheduleTable.seasonId,   season.id),
          eq(franchiseScheduleTable.weekIndex,  weekIndexTarget),
          eq(franchiseScheduleTable.homeTeamId, hId),
          eq(franchiseScheduleTable.awayTeamId, aId),
        ));

      gamesProcessed++;
    }

    console.log(`[mca/week${weekNum}/schedules] Processed: ${gamesProcessed} games, ${gamesDuplicate} dupes, ${gamesCpuVsCpu} cpu-vs-cpu, ${gamesUnregistered} unregistered, ${violations.length} violations`);
    return {
      ok: true,
      message: `Week ${weekNum}: ${gamesProcessed} game(s) processed${season.catchupMode ? " [CATCHUP MODE — no payouts]" : ""}`,
      gamesProcessed, gamesDuplicate, gamesCpuVsCpu, gamesUnregistered,
      payoutLines, milestoneLines, resultLines, unregisteredLines, violations,
      weekNum, seasonId: season.id, catchupMode: season.catchupMode,
    };
  } catch (err) {
    console.error(`[mca/week${weekNum}/scores] Error:`, err);
    return { ...zero, ok: false, message: String(err) };
  }
}

// ── Roster import helpers ─────────────────────────────────────────────────────

const ROSTER_POS_NUM: Record<number, string> = {
  0: "QB",  1: "HB",  2: "FB",  3: "WR",  4: "TE",
  5: "LT",  6: "LG",  7: "C",   8: "RG",  9: "RT",
  10: "LE", 11: "RE", 12: "DT", 13: "LOLB", 14: "MLB", 15: "ROLB",
  16: "CB", 17: "FS", 18: "SS", 19: "K",  20: "P",
  21: "KR", 22: "PR", 23: "LS",
};

const ROSTER_BIO_FIELDS = new Set([
  "height", "heightInches", "weight",
  "handedness", "throwingHand", "playerHandedness",
]);

// Try all known MCA payload shapes and return a flat array of player objects
function normalizePlayers(body: unknown): any[] {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;

  // All known Madden CFM per-team roster + free-agent wrapper keys
  for (const key of [
    "rosterInfoList",        // Most common in Madden 24/25 CFM companion API
    "playerArray",
    "teamRosterInfoList",
    "activeRosterInfoList",
    "playerInfoList",
    "rosters",
    "players",
    "rosterArray",
    "teamPlayerInfoList",
    "playerRosterInfoList",
  ]) {
    if (Array.isArray(b[key])) return b[key] as any[];
  }

  // Dictionary of player objects (key = playerId or similar)
  const vals = Object.values(b);
  const firstLevel = vals.filter(v => v && typeof v === "object" && !Array.isArray(v)) as Record<string, unknown>[];
  if (firstLevel.length > 0) {
    // If values look like player objects, return them directly
    const isPlayer = (o: Record<string, unknown>) =>
      o["firstName"] != null || o["lastName"] != null || o["playerId"] != null || o["position"] != null;
    if (firstLevel.every(isPlayer)) return firstLevel;
    // Otherwise flatten one more level
    return firstLevel.flatMap(v =>
      Object.values(v).filter(inner => inner && typeof inner === "object" && !Array.isArray(inner)),
    );
  }
  return [];
}

function resolveContractYearsLeftProc(p: any): number | null {
  if (p.contractYearsLeft != null) return Number(p.contractYearsLeft);
  if (p.yearsLeft          != null) return Number(p.yearsLeft);
  if (p.contractLeft       != null) return Number(p.contractLeft);
  const len = p.contractLength ?? p.contractLen ?? null;
  const yr  = p.contractYear  ?? p.contractYr  ?? null;
  if (len != null && yr != null) return Math.max(0, Number(len) - Number(yr) + 1);
  return null;
}

function buildPlayerValues(p: any, seasonId: number, teamId: number, teamName: string, discordId: string | null) {
  const posRaw = p.position ?? p.pos ?? p.positionId ?? "";
  const position = typeof posRaw === "number"
    ? (ROSTER_POS_NUM[posRaw as number] ?? String(posRaw))
    : String(posRaw).trim().toUpperCase();

  const ovrRaw = p.playerBestOvr ?? p.overallRating ?? p.overallRatings ?? p.overall ?? p.ovr ?? p.bestOverall ?? p.playerSkillRating ?? null;
  const overall = ovrRaw != null ? Math.max(0, Math.min(99, Number(ovrRaw))) : 0;

  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "number" && k.endsWith("Rating")) { attributes[k] = v; continue; }
    if (ROSTER_BIO_FIELDS.has(k)) { attributes[k] = v; }
  }

  return {
    seasonId,
    teamId,
    teamName,
    discordId,
    playerId:          Number(p.playerId ?? p.rosterId ?? p.playerIndex ?? p.id),
    firstName:         String(p.firstName ?? "").trim(),
    lastName:          String(p.lastName  ?? "").trim(),
    position,
    overall,
    devTrait:          Number(p.devTrait ?? p.devTraitId ?? p.playerDevTrait ?? 0),
    age:               p.age != null ? Number(p.age) : null,
    jerseyNum:         (p.jerseyNum ?? p.jersey ?? p.uniformNumber) != null
      ? Number(p.jerseyNum ?? p.jersey ?? p.uniformNumber) : null,
    contractYearsLeft: resolveContractYearsLeftProc(p),
    attributes:        Object.keys(attributes).length > 0 ? attributes : null,
    importedAt:        new Date(),
  };
}

// ── /team/:teamId/roster → upsert active 53-man roster for one team ───────────

export async function processTeamRoster(body: unknown, mcaTeamId: number): Promise<ProcessResult> {
  try {
    const season = await getOrCreateActiveSeason();

    let [teamEntry] = await db.select()
      .from(franchiseMcaTeamsTable)
      .where(and(
        eq(franchiseMcaTeamsTable.seasonId, season.id),
        eq(franchiseMcaTeamsTable.teamId,   mcaTeamId),
      ))
      .limit(1);

    // ── Auto-create stub team entry so roster imports never silently fail ──────
    if (!teamEntry) {
      console.warn(`[roster/team/${mcaTeamId}] Team not in franchise_mca_teams — auto-creating stub entry (re-import /leagueteams to populate full name & Discord linkage)`);
      await db.insert(franchiseMcaTeamsTable)
        .values({
          seasonId:  season.id,
          teamId:    mcaTeamId,
          fullName:  `Team ${mcaTeamId}`,
          nickName:  `Team ${mcaTeamId}`,
          userName:  "CPU",
          isHuman:   false,
          discordId: null,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
      [teamEntry] = await db.select()
        .from(franchiseMcaTeamsTable)
        .where(and(
          eq(franchiseMcaTeamsTable.seasonId, season.id),
          eq(franchiseMcaTeamsTable.teamId,   mcaTeamId),
        ))
        .limit(1);
    }

    if (!teamEntry) {
      return { ok: false, message: `Could not create stub team entry for teamId ${mcaTeamId}` };
    }

    // Always log body structure so we can debug key-name mismatches
    const bodyKeys = body && typeof body === "object" ? Object.keys(body as Record<string, unknown>) : [];
    console.log(`[roster/team/${mcaTeamId}] Body keys: [${bodyKeys.join(", ")}]`);

    const rawPlayers = normalizePlayers(body);
    console.log(`[roster/team/${mcaTeamId}] normalizePlayers returned ${rawPlayers.length} entries`);
    if (rawPlayers.length > 0) {
      const p0 = rawPlayers[0] as Record<string, unknown>;
      console.log(`[roster/team/${mcaTeamId}] First player keys: ${Object.keys(p0).slice(0, 20).join(", ")}`);
    }

    const ACTIVE_ROS_TYPE = 0;
    const rows: ReturnType<typeof buildPlayerValues>[] = [];

    for (const p of rawPlayers) {
      if (!p || typeof p !== "object") continue;
      if (p.isOnPracticeSquad === true || p.isOnIR === true) continue;

      const rosType = p.rosType ?? p.rosterType ?? p.rostStatus ?? p.rosStatus ?? null;
      if (rosType != null && Number(rosType) !== ACTIVE_ROS_TYPE) continue;

      const rawId   = p.playerId ?? p.rosterId ?? p.playerIndex ?? p.id;
      const playerId = rawId != null ? Number(rawId) : NaN;
      if (isNaN(playerId) || playerId <= 0) continue;

      rows.push(buildPlayerValues(p, season.id, mcaTeamId, teamEntry.fullName, teamEntry.discordId ?? null));
    }

    if (rows.length === 0) {
      return { ok: true, message: `No active players in payload for team ${mcaTeamId} (${teamEntry.fullName})` };
    }

    // ── Detect roster transactions before overwriting ─────────────────────────
    const playerIds = rows.map(r => r.playerId).filter((id): id is number => id != null && id > 0);
    const existingRows = playerIds.length > 0
      ? await db.select({
          playerId: franchiseRostersTable.playerId,
          teamId:   franchiseRostersTable.teamId,
          teamName: franchiseRostersTable.teamName,
          overall:  franchiseRostersTable.overall,
          devTrait: franchiseRostersTable.devTrait,
          firstName: franchiseRostersTable.firstName,
          lastName:  franchiseRostersTable.lastName,
          position:  franchiseRostersTable.position,
        })
        .from(franchiseRostersTable)
        .where(and(
          eq(franchiseRostersTable.seasonId, season.id),
          inArray(franchiseRostersTable.playerId, playerIds),
        ))
      : [];

    const existingMap = new Map(existingRows.map(r => [r.playerId, r]));
    const DEV_LABELS: Record<number, string> = { 0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor" };
    const transactions: Array<typeof rosterTransactionsTable.$inferInsert> = [];

    for (const row of rows) {
      if (row.playerId == null) continue;
      const prev = existingMap.get(row.playerId);
      const playerName = [row.firstName, row.lastName].filter(Boolean).join(" ") || `Player ${row.playerId}`;
      const position   = row.position ?? "";

      if (!prev) continue; // brand new to the league — no prior state to compare

      // Team change: player was on a DIFFERENT team before this export
      if (prev.teamId !== mcaTeamId) {
        transactions.push({
          seasonId:        season.id,
          transactionType: "team_change",
          playerId:        row.playerId,
          playerName,
          position,
          fromTeam:  prev.teamName ?? String(prev.teamId),
          toTeam:    teamEntry.fullName,
          fromValue: null,
          toValue:   null,
        });
      } else {
        // Overall rating change (same team)
        const prevOvr = prev.overall ?? 0;
        const newOvr  = (row.overall as number | null) ?? 0;
        if (prevOvr > 0 && newOvr > 0 && prevOvr !== newOvr) {
          transactions.push({
            seasonId:        season.id,
            transactionType: "overall_change",
            playerId:        row.playerId,
            playerName,
            position,
            fromTeam:  teamEntry.fullName,
            toTeam:    teamEntry.fullName,
            fromValue: String(prevOvr),
            toValue:   String(newOvr),
          });
        }

        // Dev trait change (same team)
        const prevDev = prev.devTrait ?? 0;
        const newDev  = (row.devTrait as number | null) ?? 0;
        if (prevDev !== newDev) {
          transactions.push({
            seasonId:        season.id,
            transactionType: "dev_change",
            playerId:        row.playerId,
            playerName,
            position,
            fromTeam:  teamEntry.fullName,
            toTeam:    teamEntry.fullName,
            fromValue: DEV_LABELS[prevDev] ?? String(prevDev),
            toValue:   DEV_LABELS[newDev]  ?? String(newDev),
          });
        }
      }
    }

    if (transactions.length > 0) {
      await db.insert(rosterTransactionsTable).values(transactions);
    }

    // Replace the team's roster: delete old rows, insert fresh ones
    await db.delete(franchiseRostersTable).where(and(
      eq(franchiseRostersTable.seasonId, season.id),
      eq(franchiseRostersTable.teamId,   mcaTeamId),
    ));
    await db.insert(franchiseRostersTable).values(rows);

    return {
      ok: true,
      message: `${rows.length} players imported for team ${mcaTeamId} (${teamEntry.fullName})`,
      details: { transactions },
    };
  } catch (err) {
    console.error(`[roster/team/${mcaTeamId}] Error:`, err);
    return { ok: false, message: String(err) };
  }
}

// ── /draftpicks → import all teams' draft picks for the next 3 classes ────────
// MCA sends a flat list of picks covering every team. Each pick records the
// current holder (teamId) and optionally the original owner (originalTeamId).
// Fields seen in the wild:
//   teamId, originalTeamId, draftYear (or year), round (or roundNum),
//   pickNum (or normalizedPickNumber), currentTeam*, origTeam*
//
// perTeamId: when set (per-team endpoint), only delete/replace that team's
// existing picks instead of nuking the whole season — this lets 32 individual
// team payloads accumulate without each one wiping the previous teams' data.
export async function processDraftPicks(body: unknown, perTeamId?: number): Promise<ProcessResult> {
  try {
    const season = await getOrCreateActiveSeason();

    // Pull the current team roster so we can match teamId → name + discordId
    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

    // Normalise the picks list — try common wrapper keys first, then any array
    const bodyKeys = body && typeof body === "object" ? Object.keys(body as Record<string, unknown>) : [];
    const rawPicks = (() => {
      if (!body || typeof body !== "object") return { arr: [] as any[], key: "(none)" };
      if (Array.isArray(body)) return { arr: body, key: "(root array)" };
      const b = body as Record<string, unknown>;
      // Known keys first
      for (const key of [
        "draftPickInfoList", "draftPicks", "picks",
        "leagueDraftPickList", "leagueDraftPicks",
      ]) {
        if (Array.isArray(b[key])) return { arr: b[key] as any[], key };
      }
      // Fallback: find the largest array under any key
      let bestKey = "";
      let bestArr: any[] = [];
      for (const [k, v] of Object.entries(b)) {
        if (Array.isArray(v) && v.length > bestArr.length) { bestKey = k; bestArr = v; }
      }
      return { arr: bestArr, key: bestKey || "(none)" };
    })();

    console.log(`[mca/draftpicks] Body keys: [${bodyKeys.join(", ")}]  |  matched key: "${rawPicks.key}"  |  raw count: ${rawPicks.arr.length}`);
    if (rawPicks.arr.length > 0) {
      console.log(`[mca/draftpicks] Sample pick keys: ${Object.keys(rawPicks.arr[0] as Record<string, unknown>).join(", ")}`);
      console.log(`[mca/draftpicks] Sample pick[0]: ${JSON.stringify(rawPicks.arr[0]).slice(0, 300)}`);
    } else {
      console.log(`[mca/draftpicks] Raw body (first 400 chars): ${JSON.stringify(body).slice(0, 400)}`);
    }

    if (rawPicks.arr.length === 0) {
      return { ok: true, message: `Draft picks payload empty — body keys were: [${bodyKeys.join(", ")}]` };
    }

    type PickRow = typeof franchiseDraftPicksTable.$inferInsert;
    const rows: PickRow[] = [];

    for (const p of rawPicks.arr) {
      if (!p || typeof p !== "object") continue;

      const teamId = Number(
        p.teamId ?? p.currentTeamId ?? p.holdingTeamId ?? p.ownerTeamId ?? -1,
      );
      if (isNaN(teamId) || teamId < 0) continue;

      const draftYear = Number(
        p.draftYear ?? p.year ?? p.draftClassYear ?? p.draft_year ?? 0,
      );
      if (!draftYear || draftYear < 2020 || draftYear > 2040) continue;

      const round = Number(p.round ?? p.roundNum ?? p.roundNumber ?? 0);
      if (!round || round < 1 || round > 7) continue;

      const pickNum = Number(
        p.pickNum ?? p.normalizedPickNumber ?? p.pickNumber ?? p.pick ?? 0,
      );

      const originalTeamId: number | null = (() => {
        const raw = p.originalTeamId ?? p.origTeamId ?? p.previousTeamId ?? null;
        if (raw == null) return null;
        const n = Number(raw);
        return isNaN(n) || n < 0 || n === teamId ? null : n;
      })();

      const teamEntry       = teamMap.get(teamId);
      const origTeamEntry   = originalTeamId != null ? teamMap.get(originalTeamId) : undefined;

      const teamName        = teamEntry?.fullName ?? String(p.currentTeamName ?? p.teamName ?? teamId);
      const discordId       = teamEntry?.discordId ?? null;
      const originalTeamName: string | null = origTeamEntry?.fullName
        ?? (p.originalTeamName ?? p.origTeamName ?? null);

      rows.push({
        seasonId: season.id,
        teamId,
        teamName,
        discordId,
        draftYear,
        round,
        pickNum,
        originalTeamId: originalTeamId ?? null,
        originalTeamName: originalTeamName ?? null,
        importedAt: new Date(),
      });
    }

    if (rows.length === 0) {
      return { ok: true, message: "No valid draft picks parsed from payload" };
    }

    // Atomic replace:
    // - Per-team mode  → only wipe that team's existing picks (accumulate 32 posts)
    // - League-wide    → wipe the whole season and replace with the full flat list
    if (perTeamId !== undefined) {
      await db.delete(franchiseDraftPicksTable)
        .where(and(
          eq(franchiseDraftPicksTable.seasonId, season.id),
          eq(franchiseDraftPicksTable.teamId, perTeamId),
        ));
    } else {
      await db.delete(franchiseDraftPicksTable)
        .where(eq(franchiseDraftPicksTable.seasonId, season.id));
    }
    await db.insert(franchiseDraftPicksTable).values(rows);

    console.log(`[mca/draftpicks] Imported ${rows.length} picks for season ${season.id}`);
    return { ok: true, message: `${rows.length} draft picks imported`, details: { seasonId: season.id, count: rows.length } };
  } catch (err) {
    console.error("[mca/draftpicks] Error:", err);
    return { ok: false, message: String(err) };
  }
}

// ── /freeagents/roster → upsert the free agent pool (teamId sentinel = 999) ──

const FA_TEAM_ID = 999;

export async function processFreeAgentRoster(body: unknown): Promise<ProcessResult> {
  try {
    const season    = await getOrCreateActiveSeason();
    const rawPlayers = normalizePlayers(body);

    if (rawPlayers.length === 0) {
      console.log("[roster/freeagents] Payload was empty — EA bug still active or no free agents");
      return { ok: true, message: "Free agent payload empty — nothing imported" };
    }

    console.log(`[roster/freeagents] Received ${rawPlayers.length} players`);
    const p0 = rawPlayers[0] as Record<string, unknown>;
    console.log(`[roster/freeagents] First player keys: ${Object.keys(p0).slice(0, 20).join(", ")}`);

    const rows: ReturnType<typeof buildPlayerValues>[] = [];
    for (const p of rawPlayers) {
      if (!p || typeof p !== "object") continue;
      if (p.isOnPracticeSquad === true || p.isOnIR === true) continue;

      const rawId   = p.playerId ?? p.rosterId ?? p.playerIndex ?? p.id;
      const playerId = rawId != null ? Number(rawId) : NaN;
      if (isNaN(playerId) || playerId <= 0) continue;

      rows.push(buildPlayerValues(p, season.id, FA_TEAM_ID, "Free Agents", null));
    }

    if (rows.length === 0) {
      return { ok: true, message: "No valid players in free agent payload" };
    }

    // Replace the entire FA pool
    await db.delete(franchiseRostersTable).where(and(
      eq(franchiseRostersTable.seasonId, season.id),
      eq(franchiseRostersTable.teamId,   FA_TEAM_ID),
    ));
    await db.insert(franchiseRostersTable).values(rows);

    return { ok: true, message: `${rows.length} free agents imported` };
  } catch (err) {
    console.error("[roster/freeagents] Error:", err);
    return { ok: false, message: String(err) };
  }
}

// ── /news → import EA in-game CFM news feed ──────────────────────────────────
// EA returns a list of news items (headlines, body text, category).
// We upsert by eaNewsId so re-importing the same week never creates duplicates.
// The Twitter bot reads these to inform tweet topics and context.
export async function processLeagueNews(body: unknown): Promise<ProcessResult> {
  try {
    const season = await getOrCreateActiveSeason();

    if (!body || typeof body !== "object") {
      return { ok: true, message: "League news payload empty or invalid" };
    }

    // EA wraps news in various keys depending on version — try them all.
    const b = body as Record<string, unknown>;
    const bodyKeys = Object.keys(b);
    let rawItems: unknown[] = [];

    for (const key of ["newsItemList", "newsItems", "news", "leagueNews", "items"]) {
      if (Array.isArray(b[key])) { rawItems = b[key] as unknown[]; break; }
    }
    // Fallback: find largest array under any key
    if (rawItems.length === 0) {
      for (const v of Object.values(b)) {
        if (Array.isArray(v) && v.length > rawItems.length) rawItems = v;
      }
    }

    console.log(`[mca/news] Body keys: [${bodyKeys.join(", ")}]  |  item count: ${rawItems.length}`);
    if (rawItems.length > 0) {
      console.log(`[mca/news] Sample item keys: ${Object.keys(rawItems[0] as Record<string, unknown>).join(", ")}`);
      console.log(`[mca/news] Sample item[0]: ${JSON.stringify(rawItems[0]).slice(0, 400)}`);
    }

    if (rawItems.length === 0) {
      return { ok: true, message: `News payload empty — body keys were: [${bodyKeys.join(", ")}]` };
    }

    let upserted = 0;
    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue;
      const n = item as Record<string, unknown>;

      // Field names vary across Madden versions — try common patterns
      const headline = String(
        n["headline"] ?? n["title"] ?? n["newsHeadline"] ?? n["header"] ?? ""
      ).trim();
      if (!headline) continue;

      const bodyText = String(
        n["body"] ?? n["description"] ?? n["newsBody"] ?? n["content"] ?? ""
      ).trim() || null;

      const category = String(
        n["newsType"] ?? n["category"] ?? n["type"] ?? n["newsCategory"] ?? ""
      ).trim() || null;

      const eaNewsId = String(
        n["newsId"] ?? n["id"] ?? n["newsItemId"] ?? ""
      ).trim() || null;

      // weekIndex: EA sometimes includes a weekIndex or stageWeek
      const rawWeek = n["weekIndex"] ?? n["week"] ?? n["stageWeek"];
      const weekIndex = rawWeek != null ? Number(rawWeek) : null;

      if (eaNewsId) {
        // Upsert by eaNewsId + seasonId to avoid duplicates
        await db.insert(leagueNewsTable)
          .values({ seasonId: season.id, eaNewsId, headline, body: bodyText, category, weekIndex })
          .onConflictDoNothing();
      } else {
        // No external ID — use headline as soft dedup key (insert only if not seen this season)
        const existing = await db.select({ id: leagueNewsTable.id })
          .from(leagueNewsTable)
          .where(and(
            eq(leagueNewsTable.seasonId, season.id),
            eq(leagueNewsTable.headline, headline),
          ))
          .limit(1);
        if (existing.length === 0) {
          await db.insert(leagueNewsTable)
            .values({ seasonId: season.id, eaNewsId, headline, body: bodyText, category, weekIndex });
        }
      }
      upserted++;
    }

    console.log(`[mca/news] Stored ${upserted} news items for season ${season.id}`);
    return { ok: true, message: `${upserted} news items imported`, details: { seasonId: season.id, count: upserted } };
  } catch (err) {
    console.error("[mca/news] Error:", err);
    return { ok: false, message: String(err) };
  }
}
