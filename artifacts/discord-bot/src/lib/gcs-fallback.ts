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
