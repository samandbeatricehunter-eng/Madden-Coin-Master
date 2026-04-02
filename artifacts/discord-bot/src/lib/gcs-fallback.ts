/**
 * GCS fallback helpers.
 *
 * When bot commands run and find their DB tables empty they call these helpers,
 * which read the most-recently-stored MCA JSON files from object storage and
 * return data in the same shape as the DB rows they replace.
 *
 * This means: as long as the MCA has exported data to the webhook at least once,
 * every command shows current information — no manual re-sync required.
 */

import { db } from "@workspace/db";
import {
  userRecordsTable,
  usersTable,
  franchiseMcaTeamsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { readMcaJson, mcaFileExists, listMcaFilesSafe } from "./gcs-reader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractList(data: any, ...keys: string[]): any[] {
  for (const k of keys) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return Array.isArray(data) ? data : [];
}

function getN(obj: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

// ── Season records (userRecordsTable-compatible shape) ────────────────────────

export interface GcsSeasonRecord {
  discordId:       string;
  discordUsername: string;
  team:            string | null;
  wins:            number;
  losses:          number;
  pointDifferential: number;
  playoffWins:     number;
  playoffLosses:   number;
  superbowlWins:   number;
  superbowlLosses: number;
  /** true when this row came from GCS rather than the DB */
  fromGcs: boolean;
}

/**
 * Returns season records for the given seasonId.
 *
 * Primary source: userRecordsTable (DB).
 * Fallback when DB is empty: mca/standings.json from object storage.
 * Returns { records, source } where source is "db" | "gcs" | "empty".
 */
export async function getSeasonRecords(seasonId: number): Promise<{
  records: GcsSeasonRecord[];
  source: "db" | "gcs" | "empty";
}> {
  // ── 1. Try DB first ─────────────────────────────────────────────────────────
  const dbRows = await db.select().from(userRecordsTable)
    .where(eq(userRecordsTable.seasonId, seasonId));

  if (dbRows.length > 0) {
    return {
      source: "db",
      records: dbRows.map(r => ({
        discordId:         r.discordId,
        discordUsername:   r.discordUsername,
        team:              r.team ?? null,
        wins:              r.wins,
        losses:            r.losses,
        pointDifferential: r.pointDifferential,
        playoffWins:       r.playoffWins,
        playoffLosses:     r.playoffLosses,
        superbowlWins:     r.superbowlWins,
        superbowlLosses:   r.superbowlLosses,
        fromGcs:           false,
      })),
    };
  }

  // ── 2. Fall back to mca/standings.json ─────────────────────────────────────
  const standingsExists = await mcaFileExists("mca/standings.json").catch(() => false);
  if (!standingsExists) return { records: [], source: "empty" };

  let body: unknown;
  try {
    body = await readMcaJson("mca/standings.json");
  } catch {
    return { records: [], source: "empty" };
  }

  const entries = extractList(body,
    "standingsInfoList", "teamStandingsInfoList", "standings");
  if (entries.length === 0) return { records: [], source: "empty" };

  // Load team → discord user mapping
  const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, seasonId));
  const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

  const allUsers = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  }).from(usersTable);
  const userMap = new Map(allUsers.map(u => [u.discordId, u]));

  const records: GcsSeasonRecord[] = [];
  for (const entry of entries) {
    const teamId  = Number(entry?.teamId ?? entry?.teamIndex ?? -1);
    const teamData = teamMap.get(teamId);
    if (!teamData?.discordId || !teamData.isHuman) continue;

    const wins   = getN(entry, "wins",   "totalWins",   "seasonWins");
    const losses = getN(entry, "losses", "totalLosses", "seasonLosses");
    if (wins === 0 && losses === 0) continue;

    const user = userMap.get(teamData.discordId);
    records.push({
      discordId:         teamData.discordId,
      discordUsername:   user?.discordUsername ?? teamData.userName ?? teamData.fullName,
      team:              user?.team ?? teamData.nickName ?? teamData.fullName,
      wins,
      losses,
      pointDifferential: 0,   // standings.json typically has no point diff
      playoffWins:       getN(entry, "playoffWins",   "postSeasonWins"),
      playoffLosses:     getN(entry, "playoffLosses", "postSeasonLosses"),
      superbowlWins:     0,
      superbowlLosses:   0,
      fromGcs:           true,
    });
  }

  return {
    source: records.length > 0 ? "gcs" : "empty",
    records,
  };
}

/**
 * Returns all-time records across every season.
 * Falls back to mca/standings.json aggregated across ALL stored week schedule files
 * when the DB has no records at all.
 */
export async function getAllTimeRecords(): Promise<{
  records: GcsSeasonRecord[];
  source: "db" | "gcs" | "empty";
}> {
  // ── 1. Try DB ──────────────────────────────────────────────────────────────
  const dbRows = await db.select().from(userRecordsTable);

  if (dbRows.length > 0) {
    // Aggregate across seasons in JS (same as records.ts today)
    const agg = new Map<string, GcsSeasonRecord>();
    for (const r of dbRows) {
      const ex = agg.get(r.discordId);
      if (ex) {
        ex.wins              += r.wins;
        ex.losses            += r.losses;
        ex.pointDifferential += r.pointDifferential;
        ex.playoffWins       += r.playoffWins;
        ex.playoffLosses     += r.playoffLosses;
        ex.superbowlWins     += r.superbowlWins;
        ex.superbowlLosses   += r.superbowlLosses;
        if (r.team) ex.team = r.team;
        ex.discordUsername = r.discordUsername;
      } else {
        agg.set(r.discordId, {
          discordId:         r.discordId,
          discordUsername:   r.discordUsername,
          team:              r.team ?? null,
          wins:              r.wins,
          losses:            r.losses,
          pointDifferential: r.pointDifferential,
          playoffWins:       r.playoffWins,
          playoffLosses:     r.playoffLosses,
          superbowlWins:     r.superbowlWins,
          superbowlLosses:   r.superbowlLosses,
          fromGcs:           false,
        });
      }
    }
    return { source: "db", records: [...agg.values()] };
  }

  // ── 2. Fall back to mca/standings.json (best available snapshot) ───────────
  const standingsExists = await mcaFileExists("mca/standings.json").catch(() => false);
  if (!standingsExists) return { records: [], source: "empty" };

  let body: unknown;
  try { body = await readMcaJson("mca/standings.json"); }
  catch { return { records: [], source: "empty" }; }

  const entries = extractList(body,
    "standingsInfoList", "teamStandingsInfoList", "standings");
  if (entries.length === 0) return { records: [], source: "empty" };

  const mcaTeams = await db.select().from(franchiseMcaTeamsTable);
  const teamMap  = new Map(mcaTeams.map(t => [t.teamId, t]));
  const allUsers = await db.select({
    discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team,
  }).from(usersTable);
  const userMap = new Map(allUsers.map(u => [u.discordId, u]));

  const records: GcsSeasonRecord[] = [];
  for (const entry of entries) {
    const teamId   = Number(entry?.teamId ?? entry?.teamIndex ?? -1);
    const teamData = teamMap.get(teamId);
    if (!teamData?.discordId || !teamData.isHuman) continue;

    const wins   = getN(entry, "wins",   "totalWins",   "seasonWins");
    const losses = getN(entry, "losses", "totalLosses", "seasonLosses");
    if (wins === 0 && losses === 0) continue;

    const user = userMap.get(teamData.discordId);
    records.push({
      discordId:         teamData.discordId,
      discordUsername:   user?.discordUsername ?? teamData.userName ?? teamData.fullName,
      team:              user?.team ?? teamData.nickName ?? teamData.fullName,
      wins,
      losses,
      pointDifferential: 0,
      playoffWins:       getN(entry, "playoffWins",   "postSeasonWins"),
      playoffLosses:     getN(entry, "playoffLosses", "postSeasonLosses"),
      superbowlWins:     0,
      superbowlLosses:   0,
      fromGcs:           true,
    });
  }

  return {
    source: records.length > 0 ? "gcs" : "empty",
    records,
  };
}

/**
 * Returns the week numbers for which schedule files exist in object storage.
 * Used by commands that need to know which weeks have been exported.
 */
export async function getStoredWeekNumbers(): Promise<{ reg: number[]; pre: number[]; post: number[] }> {
  const { files } = await listMcaFilesSafe("mca/week-");
  const reg: number[] = [], pre: number[] = [], post: number[] = [];
  for (const f of files) {
    if (!f.endsWith("-schedules.json")) continue;
    const m = f.match(/week-(\w+)-(\d+)-schedules\.json$/);
    if (!m) continue;
    const type = m[1]!, num = parseInt(m[2]!, 10);
    if (type === "reg")  reg.push(num);
    if (type === "pre")  pre.push(num);
    if (type === "post") post.push(num);
  }
  return {
    reg:  [...new Set(reg)].sort((a, b) => a - b),
    pre:  [...new Set(pre)].sort((a, b) => a - b),
    post: [...new Set(post)].sort((a, b) => a - b),
  };
}

// ── Article standings — always GCS-first for complete league coverage ─────────
// Unlike getSeasonRecords (which only returns bot-registered users), this reads
// mca/standings.json so the article sees every team in the league, whether or
// not they have a Discord account linked.

export interface ArticleStanding {
  teamName:          string;  // e.g. "New England Patriots" or "Patriots"
  discordUsername:   string | null; // null if not linked to bot
  wins:              number;
  losses:            number;
  pointDifferential: number;
}

/**
 * Computes standings by aggregating per-week score files from GCS.
 *
 * This is more reliable than reading mca/standings.json, which is exported by MCA
 * before all week results are finalized and can be one week behind.
 *
 * @param seasonId       - DB season id (for Discord username lookup)
 * @param completedWeekNum - 1-based number of the last completed week (e.g. 10)
 */
export async function getArticleStandings(
  seasonId:         number,
  completedWeekNum: number,
): Promise<ArticleStanding[]> {

  // ── 1. Build team-name map from leagueteams ──────────────────────────────────
  const teamNames = new Map<number, string>();
  try {
    const lt    = await readMcaJson("mca/leagueteams.json");
    const teams = extractList(lt, "leagueTeamInfoList", "teamInfoList", "teams");
    for (const t of teams) {
      const id   = Number(t?.teamId ?? t?.teamIndex ?? -1);
      if (id < 0) continue;
      const nick = String(t?.nickName ?? t?.teamName ?? "").trim();
      const city = String(t?.cityName ?? "").trim();
      teamNames.set(id, city ? `${city} ${nick}` : nick);
    }
  } catch { /* non-fatal — will fall back to Team{id} */ }

  // ── 2. Build teamId → discordUsername from DB ─────────────────────────────────
  const discordByTeam = new Map<number, string | null>();
  try {
    const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, seasonId));
    const allUsers = await db.select({
      discordId: usersTable.discordId, discordUsername: usersTable.discordUsername,
    }).from(usersTable);
    const userByDiscord = new Map(allUsers.map(u => [u.discordId, u.discordUsername]));
    for (const t of mcaTeams) {
      if (t.discordId) discordByTeam.set(t.teamId, userByDiscord.get(t.discordId) ?? null);
    }
  } catch { /* non-fatal */ }

  // ── 3. Aggregate wins / losses / point differential from per-week score files ─
  // This is the source of truth: each week-reg-{N}-schedules.json has the actual
  // game results. MCA's standings export can lag behind the latest week; the score
  // files are always up-to-date because they're written at game-result time.
  const winsMap   = new Map<number, number>();
  const lossesMap = new Map<number, number>();
  const pdMap     = new Map<number, number>();
  let   scoredWeeks = 0;

  for (let wk = 1; wk <= completedWeekNum; wk++) {
    const key = `mca/week-reg-${wk}-schedules.json`;
    try {
      if (!await mcaFileExists(key)) continue;
      const raw   = await readMcaJson(key);
      const games = extractList(raw, "gameScheduleInfoList", "scheduleInfoList", "schedules");

      let weekHadResults = false;
      for (const g of games) {
        if (!g || typeof g !== "object") continue;
        const hId    = Number(g.homeTeamId ?? -1);
        const aId    = Number(g.awayTeamId ?? -1);
        if (hId < 0 || aId < 0) continue;
        const hScore = g.homeScore != null ? Number(g.homeScore) : null;
        const aScore = g.awayScore != null ? Number(g.awayScore) : null;
        if (hScore === null || aScore === null) continue; // game not played yet

        weekHadResults = true;
        const margin = hScore - aScore;

        // home team
        winsMap.set(hId,   (winsMap.get(hId)   ?? 0) + (hScore > aScore ? 1 : 0));
        lossesMap.set(hId, (lossesMap.get(hId) ?? 0) + (hScore < aScore ? 1 : 0));
        pdMap.set(hId,     (pdMap.get(hId)     ?? 0) + margin);

        // away team
        winsMap.set(aId,   (winsMap.get(aId)   ?? 0) + (aScore > hScore ? 1 : 0));
        lossesMap.set(aId, (lossesMap.get(aId) ?? 0) + (aScore < hScore ? 1 : 0));
        pdMap.set(aId,     (pdMap.get(aId)     ?? 0) - margin);
      }
      if (weekHadResults) scoredWeeks++;
    } catch { /* skip a missing/corrupt week file */ }
  }

  // ── 4. If we got results, build standings from aggregated data ────────────────
  if (scoredWeeks > 0) {
    const allTeamIds = new Set([...winsMap.keys(), ...lossesMap.keys()]);
    const standings: ArticleStanding[] = [];
    for (const teamId of allTeamIds) {
      const wins   = winsMap.get(teamId)   ?? 0;
      const losses = lossesMap.get(teamId) ?? 0;
      const pd     = pdMap.get(teamId)     ?? 0;
      const name   = teamNames.get(teamId) ?? `Team${teamId}`;
      standings.push({
        teamName:          name,
        discordUsername:   discordByTeam.get(teamId) ?? null,
        wins,
        losses,
        pointDifferential: pd,
      });
    }
    return standings.sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
  }

  // ── 5. No score files found — fall back to mca/standings.json ────────────────
  try {
    if (await mcaFileExists("mca/standings.json")) {
      const body    = await readMcaJson("mca/standings.json");
      const entries = extractList(body, "standingsInfoList", "teamStandingsInfoList", "standings");
      if (entries.length > 0) {
        const standings: ArticleStanding[] = [];
        for (const e of entries) {
          const teamId  = Number(e?.teamId ?? e?.teamIndex ?? -1);
          const rawNick = String(e?.teamName ?? e?.nickName ?? e?.teamNickname ?? "").trim();
          const rawCity = String(e?.cityName ?? e?.teamCity ?? "").trim();
          const name    = (teamNames.get(teamId) ?? (rawCity ? `${rawCity} ${rawNick}` : rawNick)) || `Team${teamId}`;
          standings.push({
            teamName:          name,
            discordUsername:   discordByTeam.get(teamId) ?? null,
            wins:              Number(e?.wins ?? e?.totalWins   ?? 0),
            losses:            Number(e?.losses ?? e?.totalLosses ?? 0),
            pointDifferential: Number(e?.pointDifferential ?? e?.netPoints ?? 0),
          });
        }
        if (standings.length > 0) {
          return standings.sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
        }
      }
    }
  } catch { /* fall through to DB */ }

  // ── 6. Last resort — DB (bot-registered users only, may be stale) ─────────────
  const dbRows = await db.select({
    discordId:         userRecordsTable.discordId,
    discordUsername:   userRecordsTable.discordUsername,
    team:              userRecordsTable.team,
    wins:              userRecordsTable.wins,
    losses:            userRecordsTable.losses,
    pointDifferential: userRecordsTable.pointDifferential,
  }).from(userRecordsTable).where(eq(userRecordsTable.seasonId, seasonId)).catch(() => []);

  return dbRows
    .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential)
    .map(r => ({
      teamName:          r.team ?? r.discordUsername,
      discordUsername:   r.discordUsername,
      wins:              r.wins,
      losses:            r.losses,
      pointDifferential: r.pointDifferential,
    }));
}

// ── Shared team-name resolver ─────────────────────────────────────────────────
// Reads mca/leagueteams.json and returns a map from teamId → { name, isHuman }.
async function buildTeamNameMap(): Promise<Map<number, { name: string; isHuman: boolean }>> {
  const map = new Map<number, { name: string; isHuman: boolean }>();
  try {
    const raw = await readMcaJson("mca/leagueteams.json");
    const teams = extractList(raw, "leagueTeamInfoList", "teamInfoList", "teams");
    for (const t of teams) {
      const teamId  = Number(t?.teamId ?? t?.teamIndex ?? -1);
      if (teamId < 0) continue;
      const nick    = String(t?.nickName ?? t?.teamName ?? `Team${teamId}`).trim();
      const city    = String(t?.cityName ?? "").trim();
      const name    = city ? `${city} ${nick}` : nick;
      const user    = String(t?.userName ?? "CPU").trim();
      const isHuman = user !== "CPU" && user !== "" && user !== "0";
      map.set(teamId, { name, isHuman });
    }
  } catch {
    // If leagueteams.json is missing, return empty map — callers handle gracefully
  }
  return map;
}

export type GcsGame = {
  homeTeamName: string;
  awayTeamName: string;
  homeScore:    number | null;
  awayScore:    number | null;
  isH2H:        boolean;
};

/**
 * Reads mca/week-reg-{weekNum}-schedules.json from GCS and returns game results.
 * Used as a fallback when franchise_schedule DB table is empty for that week.
 *
 * H2H detection: scheduleStatus === 3 means Madden treated the game as human vs human.
 * We trust this value directly rather than cross-referencing leagueteams registration.
 */
export async function getWeekResultsFromGcs(weekNum: number): Promise<GcsGame[]> {
  const key = `mca/week-reg-${weekNum}-schedules.json`;
  if (!await mcaFileExists(key)) return [];

  const raw   = await readMcaJson(key);
  const games = extractList(raw, "gameScheduleInfoList", "scheduleInfoList", "schedules");
  const teams = await buildTeamNameMap();

  const results: GcsGame[] = [];
  for (const g of games) {
    if (!g || typeof g !== "object") continue;
    const hId    = Number(g.homeTeamId ?? -1);
    const aId    = Number(g.awayTeamId ?? -1);
    if (hId < 0 || aId < 0) continue;

    const hScore = g.homeScore != null ? Number(g.homeScore) : null;
    const aScore = g.awayScore != null ? Number(g.awayScore) : null;
    if (hScore === null || aScore === null) continue; // skip unplayed

    // scheduleStatus === 3 is Madden's own H2H completion flag — trust it directly
    const status = Number(g.scheduleStatus ?? g.status ?? 0);
    const isH2H  = status === 3;

    const hTeam = teams.get(hId);
    const aTeam = teams.get(aId);

    results.push({
      homeTeamName: hTeam?.name ?? `Team${hId}`,
      awayTeamName: aTeam?.name ?? `Team${aId}`,
      homeScore:    hScore,
      awayScore:    aScore,
      isH2H,
    });
  }
  return results;
}

/**
 * Reads mca/schedules.json (full season schedule) and returns matchups for a given week.
 *
 * @param weekNum - 1-based week number (e.g. 11 for Week 11).
 *
 * The MCA schedules export uses either a 1-based `week` field or a 0-based `weekIndex` field
 * depending on the app version. We accept a match on either (weekNum OR weekNum-1) so the
 * filter works regardless of which convention the export uses.
 */
export async function getUpcomingMatchupsFromGcs(weekNum: number): Promise<GcsGame[]> {
  if (!await mcaFileExists("mca/schedules.json")) return [];

  const raw   = await readMcaJson("mca/schedules.json");
  const games = extractList(raw, "scheduleInfoList", "gameScheduleInfoList", "schedules");
  const teams = await buildTeamNameMap();

  const matchups: GcsGame[] = [];
  for (const g of games) {
    if (!g || typeof g !== "object") continue;

    const weekType = Number(g.weekType ?? 1);
    if (weekType !== 1) continue; // regular season only

    // Accept 1-based week field (week=11) OR 0-based weekIndex field (weekIndex=10) for week 11
    const wVal = Number(g.weekIndex ?? g.week ?? -1);
    if (wVal !== weekNum && wVal !== weekNum - 1) continue;

    const hId = Number(g.homeTeamId ?? -1);
    const aId = Number(g.awayTeamId ?? -1);
    if (hId < 0 || aId < 0) continue;

    const hTeam  = teams.get(hId);
    const aTeam  = teams.get(aId);
    // scheduleStatus === 3 means H2H completed; for unplayed games use isHuman flags
    const status = Number(g.scheduleStatus ?? g.status ?? 0);
    const isH2H  = status === 3
      ? true
      : (hTeam?.isHuman ?? false) && (aTeam?.isHuman ?? false);

    matchups.push({
      homeTeamName: hTeam?.name ?? `Team${hId}`,
      awayTeamName: aTeam?.name ?? `Team${aId}`,
      homeScore:    g.homeScore != null ? Number(g.homeScore) : null,
      awayScore:    g.awayScore != null ? Number(g.awayScore) : null,
      isH2H,
    });
  }
  return matchups;
}
