/**
 * repair-records.ts
 *
 * Rebuilds user_records (in-guild W/L) and global_user_records from
 * franchise_schedule for all completed games in the active season.
 *
 * A win is a win — CPU or H2H, all games count towards in-guild record
 * and the global record. The CPU/H2H distinction only matters for payouts.
 */

import { db } from "@workspace/db";
import {
  franchiseScheduleTable,
  franchiseMcaTeamsTable,
  userRecordsTable,
  globalUserRecordsTable,
  usersTable,
  seasonsTable,
} from "@workspace/db";
import { eq, and, isNotNull, sql } from "drizzle-orm";

// Playoff week indices as used by the franchise schedule importer.
const SUPERBOWL_WEEK_INDICES = new Set([1022, 22, 1003, 1004]);
const ALL_PLAYOFF_WEEK_INDICES = new Set([
  1018, 18, 1000,         // wildcard
  1019, 19, 1001,         // divisional
  1020, 20, 1002,         // conference
  1022, 22, 1003, 1004,   // superbowl
]);

function gameCategory(weekIndex: number): "regular" | "playoff" | "superbowl" {
  if (SUPERBOWL_WEEK_INDICES.has(weekIndex)) return "superbowl";
  if (ALL_PLAYOFF_WEEK_INDICES.has(weekIndex)) return "playoff";
  return "regular";
}

export interface RepairResult {
  gamesProcessed: number;
  usersUpdated:   number;
  globalUpdated:  number;
  seasonNumber:   number;
}

export async function repairUserRecords(guildId: string): Promise<RepairResult | null> {
  // ── 1. Active season ──────────────────────────────────────────────────────
  const [season] = await db.select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
    .from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);

  if (!season) return null;

  // ── 2. Zero out existing records for this season ──────────────────────────
  // We delete and re-insert rather than zeroing-then-incrementing so the
  // discordUsername / team columns stay accurate after account transfers.
  await db.delete(userRecordsTable).where(eq(userRecordsTable.seasonId, season.id));

  // ── 3. Build teamName (lower) → discordId lookup ──────────────────────────
  const mcaTeams = await db.select({
    fullName:  franchiseMcaTeamsTable.fullName,
    nickName:  franchiseMcaTeamsTable.nickName,
    discordId: franchiseMcaTeamsTable.discordId,
  })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, season.id),
      isNotNull(franchiseMcaTeamsTable.discordId),
    ));

  // Resolve user info for all relevant discordIds
  const humanDiscordIds = [...new Set(mcaTeams.map(t => t.discordId!))];
  const userRows = humanDiscordIds.length > 0
    ? await db.select({
        discordId:       usersTable.discordId,
        discordUsername: usersTable.discordUsername,
        team:            usersTable.team,
      }).from(usersTable).where(eq(usersTable.guildId, guildId))
    : [];

  const userInfo = new Map(userRows.map(u => [u.discordId, u]));

  const teamToDiscord = new Map<string, string>();
  for (const t of mcaTeams) {
    if (!t.discordId) continue;
    if (t.fullName) teamToDiscord.set(t.fullName.toLowerCase().trim(), t.discordId);
    if (t.nickName) teamToDiscord.set(t.nickName.toLowerCase().trim(), t.discordId);
  }
  // Fallback: usersTable.team field
  for (const u of userRows) {
    if (u.team && !teamToDiscord.has(u.team.toLowerCase().trim())) {
      teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
    }
  }

  // ── 4. Load all completed games for the active season ─────────────────────
  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      isNotNull(franchiseScheduleTable.homeScore),
      isNotNull(franchiseScheduleTable.awayScore),
    ));

  // ── 5. Aggregate records in memory ───────────────────────────────────────
  type RecordAccum = {
    wins: number; losses: number; ties: number;
    pointDifferential: number;
    playoffWins: number; playoffLosses: number;
    superbowlWins: number; superbowlLosses: number;
    discordUsername: string;
    team: string | null;
  };

  const recordMap = new Map<string, RecordAccum>();

  function getOrCreate(discordId: string): RecordAccum {
    if (!recordMap.has(discordId)) {
      const u = userInfo.get(discordId);
      recordMap.set(discordId, {
        wins: 0, losses: 0, ties: 0, pointDifferential: 0,
        playoffWins: 0, playoffLosses: 0, superbowlWins: 0, superbowlLosses: 0,
        discordUsername: u?.discordUsername ?? discordId,
        team: u?.team ?? null,
      });
    }
    return recordMap.get(discordId)!;
  }

  function applyGame(
    discordId: string,
    won: boolean | null,
    pointSpread: number,
    category: "regular" | "playoff" | "superbowl",
  ): void {
    const r = getOrCreate(discordId);
    if (won === true)       r.wins++;
    else if (won === false) r.losses++;
    else                    r.ties++;
    r.pointDifferential += pointSpread;

    if (category === "playoff") {
      if (won === true)       r.playoffWins++;
      else if (won === false) r.playoffLosses++;
    } else if (category === "superbowl") {
      if (won === true)       r.superbowlWins++;
      else if (won === false) r.superbowlLosses++;
    }
  }

  let gamesProcessed = 0;

  for (const game of games) {
    const homeDiscordId = teamToDiscord.get(game.homeTeamName.toLowerCase().trim());
    const awayDiscordId = teamToDiscord.get(game.awayTeamName.toLowerCase().trim());

    if (!homeDiscordId && !awayDiscordId) continue; // CPU vs CPU — skip

    const homeScore = game.homeScore!;
    const awayScore = game.awayScore!;
    const category  = gameCategory(game.weekIndex);

    let homeWon: boolean | null;
    if (homeScore > awayScore)      homeWon = true;
    else if (homeScore < awayScore) homeWon = false;
    else                            homeWon = null; // tie

    if (homeDiscordId) applyGame(homeDiscordId, homeWon,          homeScore - awayScore, category);
    if (awayDiscordId) applyGame(awayDiscordId, homeWon === null ? null : !homeWon, awayScore - homeScore, category);

    gamesProcessed++;
  }

  // ── 6. Insert rebuilt records ─────────────────────────────────────────────
  if (recordMap.size > 0) {
    const rows = [...recordMap.entries()].map(([discordId, r]) => ({
      discordId,
      discordUsername: r.discordUsername,
      team:            r.team,
      seasonId:        season.id,
      wins:            r.wins,
      losses:          r.losses,
      ties:            r.ties,
      pointDifferential: r.pointDifferential,
      playoffWins:     r.playoffWins,
      playoffLosses:   r.playoffLosses,
      superbowlWins:   r.superbowlWins,
      superbowlLosses: r.superbowlLosses,
    }));
    await db.insert(userRecordsTable).values(rows);
  }

  // ── 7. Rebuild global_user_records from ALL user_records (all guilds) ─────
  const globalResult = await db.execute(sql`
    INSERT INTO global_user_records
      (discord_id, wins, losses, ties, point_differential, updated_at)
    SELECT
      discord_id,
      SUM(wins),
      SUM(losses),
      SUM(ties),
      SUM(point_differential),
      NOW()
    FROM user_records
    GROUP BY discord_id
    ON CONFLICT (discord_id) DO UPDATE SET
      wins               = EXCLUDED.wins,
      losses             = EXCLUDED.losses,
      ties               = EXCLUDED.ties,
      point_differential = EXCLUDED.point_differential,
      updated_at         = NOW()
  `);

  return {
    gamesProcessed,
    usersUpdated:  recordMap.size,
    globalUpdated: (globalResult as any).rowCount ?? 0,
    seasonNumber:  season.seasonNumber,
  };
}
