import { db } from "@workspace/db";
import {
  usersTable,
  seasonsTable,
  userRecordsTable,
  coinTransactionsTable,
  gameLogTable,
  franchiseScheduleTable,
  franchiseProcessedGamesTable,
  franchiseGameParticipantsTable,
  franchiseMcaTeamsTable,
  teamSeasonStatsTable,
  playerSeasonStatsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

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
): Promise<void> {
  await db.insert(gameLogTable).values({
    discordId, seasonId, result, pointSpread, opponentLabel,
    gameType: "regular_season",
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

    function findDiscordId(fullName: string, nick: string): string | null {
      return teamToUser.get(fullName.toLowerCase().trim())
        ?? teamToUser.get(nick.toLowerCase().trim())
        ?? null;
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
      getN(t, "offTDs","offTotalTDs","totalOffTDs","offTouchdowns","totalTouchdowns","offensiveTDs",
           "ptsFor","ptsScored","pointsFor","totalPoints");
    const getDefPassYds = (t: any): number =>
      getN(t, "defPassYds","defPassYards","passingYardsAllowed","defPassingYards");
    const getDefRushYds = (t: any): number =>
      getN(t, "defRushYds","defRushYards","rushingYardsAllowed","defRushingYards");
    const getDefTDs = (t: any): number =>
      getN(t, "defPtsAllowed","ptsAllowed","totalPtsAllowed","pointsAllowed","defTotalPts",
           "ptsAgainst","pointsAgainst","defPts");

    const ops: Promise<any>[] = [];
    let upserted = 0;
    for (const t of stats) {
      const teamId = Number(t?.teamId ?? t?.teamIndex ?? -1);
      if (teamId < 0 || isNaN(teamId)) continue;

      const teamEntry = teamMap.get(teamId);
      if (!teamEntry) continue;

      const offPassYds = getOffPassYds(t);
      const offRushYds = getOffRushYds(t);
      const offYds     = offPassYds + offRushYds > 0 ? offPassYds + offRushYds : getOffYds(t);

      const offTDs     = getOffTDs(t);
      const defPassYds = getDefPassYds(t);
      const defRushYds = getDefRushYds(t);
      const defTDs     = getDefTDs(t);
      const wins       = getN(t, "wins","totalWins","seasonWins");
      const losses     = getN(t, "losses","totalLosses","seasonLosses");
      const updatedAt  = new Date();
      const insertVals: typeof teamSeasonStatsTable.$inferInsert = {
        seasonId: season.id, teamId, discordId: teamEntry.discordId ?? null,
        teamName: teamEntry.fullName, offYds, offPassYds, offRushYds,
        offTDs, defPassYds, defRushYds, defTDs, wins, losses, updatedAt,
      };
      ops.push(
        db.insert(teamSeasonStatsTable)
          .values(insertVals)
          .onConflictDoUpdate({
            target: [teamSeasonStatsTable.seasonId, teamSeasonStatsTable.teamId],
            set: {
              discordId: teamEntry.discordId ?? null, teamName: teamEntry.fullName,
              offYds, offPassYds, offRushYds, offTDs, defPassYds, defRushYds, defTDs,
              wins, losses, updatedAt,
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

// ── /week/:weekType/:weekNum/{passing|rushing|receiving|defense} → playerSeasonStatsTable ──
export type WeekStatType = "passing" | "rushing" | "receiving" | "defense";

const STAT_LIST_KEYS: Record<WeekStatType, string> = {
  passing:   "playerPassingStatInfoList",
  rushing:   "playerRushingStatInfoList",
  receiving: "playerReceivingStatInfoList",
  defense:   "playerDefenseStatInfoList",
};

export async function processPlayerWeekStats(
  body: unknown,
  statType: WeekStatType,
): Promise<ProcessResult> {
  try {
    const season  = await getOrCreateActiveSeason();
    const listKey = STAT_LIST_KEYS[statType];
    const players = extractList(body, listKey);

    if (!players.length) {
      return { ok: true, message: `No ${statType} records in payload` };
    }

    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
    const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

    const ops: Promise<any>[] = [];
    let upserted = 0;

    for (const p of players) {
      const playerId = getN(p, "rosterId", "playerId", "rosterid", "playerid");
      if (!playerId) continue;

      const teamId    = getN(p, "teamId", "teamid");
      const mcaTeam   = teamMap.get(teamId);
      const teamName  = mcaTeam?.fullName ?? String(p.teamName ?? p.teamname ?? "");
      const discordId = mcaTeam?.discordId ?? null;
      const firstName = String(p.firstName ?? p.firstname ?? "");
      const lastName  = String(p.lastName  ?? p.lastname  ?? "");
      const position  = String(p.position  ?? p.pos ?? "");

      let statFields: Partial<typeof playerSeasonStatsTable.$inferInsert> = {};
      if (statType === "passing") {
        statFields = {
          passYds: getN(p, "passYds", "passingYards", "passyds"),
          passTDs: getN(p, "passTDs", "passingTds",   "passtds"),
        };
      } else if (statType === "rushing") {
        statFields = {
          rushYds: getN(p, "rushYds", "rushingYards", "rushyds"),
          rushTDs: getN(p, "rushTDs", "rushingTds",   "rushtds"),
        };
      } else if (statType === "receiving") {
        statFields = {
          recYds: getN(p, "recYds", "receivingYards", "recyds"),
          recTDs: getN(p, "recTDs", "receivingTds",   "rectds"),
        };
      } else if (statType === "defense") {
        statFields = {
          sacks:        getN(p, "sacks",        "defSacks",    "sack"),
          defInts:      getN(p, "defInts",      "interceptions","defints", "ints"),
          totalTackles: getN(p, "totalTackles", "tackleTotal", "tackles"),
          tackleSolo:   getN(p, "tackleSolo",   "tacklesoloprops", "soloTackles"),
          tackleAssist: getN(p, "tackleAssist", "assistTackles"),
        };
      }

      ops.push(
        db.insert(playerSeasonStatsTable)
          .values({
            seasonId: season.id,
            playerId,
            teamId,
            teamName,
            discordId,
            firstName,
            lastName,
            position,
            ...statFields,
          })
          .onConflictDoUpdate({
            target: [playerSeasonStatsTable.seasonId, playerSeasonStatsTable.playerId],
            set: {
              teamId,
              teamName,
              discordId,
              firstName,
              lastName,
              position,
              ...statFields,
              updatedAt: new Date(),
            },
          })
      );
      upserted++;
    }

    await Promise.all(ops);
    console.log(`[mca/${statType}] Upserted ${upserted} player stat records for season ${season.id}`);
    return { ok: true, message: `${statType}: upserted ${upserted} records`, details: { upserted } };
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

    await db.delete(franchiseScheduleTable).where(eq(franchiseScheduleTable.seasonId, season.id));

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

      const weekIdx   = Number(g.weekIndex ?? g.week ?? -1);
      if (weekIdx < 0) continue;

      const weekType = Number(g.weekType ?? 1);
      if (weekType !== 1) continue; // reg season only

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

    const inserts: Promise<any>[] = [];
    for (const e of schedMap.values()) {
      inserts.push(
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
          .onConflictDoNothing()
      );
    }
    await Promise.all(inserts);
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
}

export async function processWeekScores(
  body: unknown,
  weekNum: number,
): Promise<WeekScoresResult> {
  const zero: WeekScoresResult = {
    ok: false, message: "", gamesProcessed: 0, gamesDuplicate: 0,
    gamesCpuVsCpu: 0, gamesUnregistered: 0, payoutLines: [], milestoneLines: [],
    resultLines: [], unregisteredLines: [],
    weekNum, seasonId: 0,
  };

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

    const weekIndexTarget = weekNum - 1; // MCA week 1 = weekIndex 0

    let gamesProcessed    = 0;
    let gamesDuplicate    = 0;
    let gamesCpuVsCpu     = 0;
    let gamesUnregistered = 0;
    const payoutLines:     string[] = [];
    const milestoneLines:  string[] = [];
    const resultLines:     string[] = [];
    const unregisteredLines: string[] = [];
    const seenKeys = new Set<string>();

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
      const gameId = rawId != null
        ? String(rawId)
        : `s${season.id}-w${weekNum}-h${hId}-a${aId}-${homeScore}-${awayScore}`;

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
      const status  = Number(g.scheduleStatus ?? g.status ?? 3);
      const bothReg = homeIsHuman && awayIsHuman;
      const isTrueH2H   = bothReg && status === 3;
      const isForcedCPU = bothReg && status === 2;

      // Payout metadata — populated in each branch, saved to DB for admin-correctpayout reversals
      let payoutMeta: {
        payoutType: string;
        winnerDiscordId?: string | null;
        loserDiscordId?: string | null;
        winnerCoins?: number | null;
        loserCoins?: number | null;
        appliedPointDiff?: number | null;
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

          await addBalance(winnerId, H2H_WIN_PAYOUT);
          await logTransaction(winnerId, H2H_WIN_PAYOUT, "addcoins",
            `MCA webhook: H2H win vs ${loserTeam} (${hiScore}–${loScore})`);
          await addBalance(loserId, H2H_LOSS_PAYOUT);
          await logTransaction(loserId, H2H_LOSS_PAYOUT, "addcoins",
            `MCA webhook: H2H loss vs ${winnerTeam} (${loScore}–${hiScore})`);

          payoutLines.push(`🏆 **${winnerTeam}** +${H2H_WIN_PAYOUT} | 🎮 **${loserTeam}** +${H2H_LOSS_PAYOUT} *(${hiScore}–${loScore})*`);
          resultLines.push(`🏆 **${winnerTeam}** ${hiScore} — ${loScore} **${loserTeam}**`);

          await upsertH2HRecord(winnerId, season.id, true,    spread);
          await upsertH2HRecord(loserId,  season.id, false, -spread);
          await appendGameLog(winnerId, season.id, "win",  spread,  loserTeam);
          await appendGameLog(loserId,  season.id, "loss", -spread, winnerTeam);

          await db.update(usersTable)
            .set({ allTimeH2HWins: sql`${usersTable.allTimeH2HWins} + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, winnerId));
          await db.update(usersTable)
            .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, loserId));

          const winnerRow = await db.select({ allTimeH2HWins: usersTable.allTimeH2HWins, milestoneTierAwarded: usersTable.milestoneTierAwarded })
            .from(usersTable).where(eq(usersTable.discordId, winnerId)).limit(1);
          const milestone = checkMilestone(winnerRow[0]?.allTimeH2HWins ?? 0, winnerRow[0]?.milestoneTierAwarded ?? 0);
          if (milestone) {
            await addBalance(winnerId, milestone.bonus);
            await logTransaction(winnerId, milestone.bonus, "addcoins", `Career milestone: ${milestone.label} (MCA webhook)`);
            await db.update(usersTable)
              .set({ milestoneTierAwarded: milestone.tier, updatedAt: new Date() })
              .where(eq(usersTable.discordId, winnerId));
            milestoneLines.push(`🎯 **${winnerTeam}** hit **${milestone.label}** → +${milestone.bonus} coins`);
          }

          payoutMeta = {
            payoutType: "h2h",
            winnerDiscordId: winnerId, loserDiscordId: loserId,
            winnerCoins: H2H_WIN_PAYOUT, loserCoins: H2H_LOSS_PAYOUT,
            appliedPointDiff: spread,
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

    console.log(`[mca/week${weekNum}/schedules] Processed: ${gamesProcessed} games, ${gamesDuplicate} dupes, ${gamesCpuVsCpu} cpu-vs-cpu, ${gamesUnregistered} unregistered`);
    return {
      ok: true,
      message: `Week ${weekNum}: ${gamesProcessed} game(s) processed`,
      gamesProcessed, gamesDuplicate, gamesCpuVsCpu, gamesUnregistered,
      payoutLines, milestoneLines, resultLines, unregisteredLines,
      weekNum, seasonId: season.id,
    };
  } catch (err) {
    console.error(`[mca/week${weekNum}/scores] Error:`, err);
    return { ...zero, ok: false, message: String(err) };
  }
}
