import { db } from "@workspace/db";
import {
  pressConferencesTable, gameSchedulesTable, franchiseScheduleTable,
  franchiseMcaTeamsTable, seasonsTable,
} from "@workspace/db";
import { and, eq, or, desc, sql } from "drizzle-orm";
import { currentWeekIndexFor } from "../helpers/week-helpers.js";

export type PressConfType = "trash_talk" | "general";

export type WeekContext = {
  seasonId:  number;
  weekKey:   string;   // e.g. "1".."18", "wildcard", etc. (raw seasons.currentWeek)
  weekIndex: number;   // canonical numeric (0..17 regular; 1018..1022 playoff)
};

/**
 * Resolve the active season + canonical week index for press-conference use.
 * Returns null when there's no active season or the week isn't a game week
 * (training_camp / offseason / unmapped).
 */
export async function getActiveWeekContext(guildId: string): Promise<WeekContext | null> {
  const [season] = await db.select({
    id: seasonsTable.id,
    currentWeek: seasonsTable.currentWeek,
  }).from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);
  if (!season) return null;
  const weekKey = (season.currentWeek ?? "1") as string;
  const weekIndex = currentWeekIndexFor(weekKey);
  if (weekIndex == null) return null;
  return { seasonId: season.id, weekKey, weekIndex };
}

/**
 * Find this week's H2H opponent for a user. Prefers `game_schedules` (the
 * per-channel matchup table) since both discord IDs are already resolved
 * there. Falls back to franchise_schedule joined with franchise_mca_teams
 * for weeks where no private channel has been provisioned yet.
 * Returns null if user isn't scheduled against a linked opponent this week.
 */
export async function findOpponentForWeek(
  guildId: string,
  userId: string,
  ctx: WeekContext,
): Promise<{ opponentId: string; userTeam: string; opponentTeam: string } | null> {
  // 1) game_schedules first
  const schedRows = await db.select({
    away: gameSchedulesTable.awayDiscordId,
    home: gameSchedulesTable.homeDiscordId,
    awayTeam: gameSchedulesTable.awayTeamName,
    homeTeam: gameSchedulesTable.homeTeamName,
  }).from(gameSchedulesTable)
    .where(and(
      eq(gameSchedulesTable.guildId, guildId),
      eq(gameSchedulesTable.seasonId, ctx.seasonId),
      eq(gameSchedulesTable.weekIndex, ctx.weekIndex),
      or(eq(gameSchedulesTable.awayDiscordId, userId), eq(gameSchedulesTable.homeDiscordId, userId)),
    ));
  if (schedRows.length) {
    const r = schedRows[0]!;
    const isHome = r.home === userId;
    const opp = isHome ? r.away : r.home;
    if (opp && opp !== userId) {
      return {
        opponentId:   opp,
        userTeam:     isHome ? r.homeTeam : r.awayTeam,
        opponentTeam: isHome ? r.awayTeam : r.homeTeam,
      };
    }
  }

  // 2) franchise_schedule fallback
  let wkIdxList = [ctx.weekIndex];
  if (ctx.weekIndex >= 1000) wkIdxList.push(ctx.weekIndex - 1000);
  const linked = await db.select({
    teamId: franchiseMcaTeamsTable.teamId,
    discordId: franchiseMcaTeamsTable.discordId,
  }).from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, ctx.seasonId));
  const teamByDiscord = new Map<string, number>();
  const discordByTeam = new Map<number, string>();
  for (const l of linked) {
    if (l.discordId) {
      teamByDiscord.set(l.discordId, l.teamId);
      discordByTeam.set(l.teamId, l.discordId);
    }
  }
  const userTeamId = teamByDiscord.get(userId);
  if (!userTeamId) return null;

  for (const wk of wkIdxList) {
    const games = await db.select({
      home: franchiseScheduleTable.homeTeamId,
      away: franchiseScheduleTable.awayTeamId,
      homeName: franchiseScheduleTable.homeTeamName,
      awayName: franchiseScheduleTable.awayTeamName,
    }).from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId, ctx.seasonId),
        eq(franchiseScheduleTable.weekIndex, wk),
        or(
          eq(franchiseScheduleTable.homeTeamId, userTeamId),
          eq(franchiseScheduleTable.awayTeamId, userTeamId),
        ),
      ))
      .limit(1);
    if (games.length) {
      const g = games[0]!;
      const isHome = g.home === userTeamId;
      const oppTeamId = isHome ? g.away : g.home;
      const oppId = discordByTeam.get(oppTeamId);
      if (oppId && oppId !== userId) {
        return {
          opponentId:   oppId,
          userTeam:     isHome ? g.homeName : g.awayName,
          opponentTeam: isHome ? g.awayName : g.homeName,
        };
      }
    }
  }
  return null;
}

/**
 * Look up the user's existing press conference row for this week, if any.
 * Used to gate "one press conf per week regardless of type" + to detect
 * which trash-talk reply (if any) is still pending an opponent response.
 */
export async function findExistingPressConfThisWeek(
  guildId: string,
  ctx: WeekContext,
  userId: string,
) {
  const rows = await db.select().from(pressConferencesTable)
    .where(and(
      eq(pressConferencesTable.guildId, guildId),
      eq(pressConferencesTable.seasonId, ctx.seasonId),
      eq(pressConferencesTable.weekKey, ctx.weekKey),
      eq(pressConferencesTable.userId, userId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Count completed (paid) trash-talk press conferences between two users
 * regardless of direction. Used as a +1 boost to the rivalry rating between
 * those two coaches.
 */
export async function countTrashTalkBetween(
  guildId: string,
  userA: string,
  userB: string,
): Promise<number> {
  const rows = await db.select({ c: sql<number>`count(*)::int` })
    .from(pressConferencesTable)
    .where(and(
      eq(pressConferencesTable.guildId, guildId),
      eq(pressConferencesTable.type, "trash_talk"),
      or(
        and(eq(pressConferencesTable.userId, userA), eq(pressConferencesTable.opponentId, userB)),
        and(eq(pressConferencesTable.userId, userB), eq(pressConferencesTable.opponentId, userA)),
      ),
    ));
  return rows[0]?.c ?? 0;
}

/**
 * Bulk-fetch the trash-talk press-conf counts FROM a given user TO each of
 * the listed opponents. Used by the Rivalries view so the page builds in a
 * single query instead of N round-trips.
 */
export async function trashTalkCountsForUser(
  guildId: string,
  userId: string,
  opponents: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (opponents.length === 0) return out;
  const rows = await db.select({
    a: pressConferencesTable.userId,
    b: pressConferencesTable.opponentId,
    c: sql<number>`count(*)::int`,
  }).from(pressConferencesTable)
    .where(and(
      eq(pressConferencesTable.guildId, guildId),
      eq(pressConferencesTable.type, "trash_talk"),
      or(eq(pressConferencesTable.userId, userId), eq(pressConferencesTable.opponentId, userId)),
    ))
    .groupBy(pressConferencesTable.userId, pressConferencesTable.opponentId);
  for (const r of rows) {
    const other = r.a === userId ? r.b : r.a;
    if (!other) continue;
    if (!opponents.includes(other)) continue;
    out.set(other, (out.get(other) ?? 0) + (r.c ?? 0));
  }
  return out;
}

/**
 * Order the most recent press conferences (any user) for an admin / debug
 * view. Not used by the user-facing flow but handy for the Commissioner's
 * Office to scan recent activity if we ever surface it there.
 */
export async function recentPressConferences(guildId: string, limit = 25) {
  return db.select().from(pressConferencesTable)
    .where(eq(pressConferencesTable.guildId, guildId))
    .orderBy(desc(pressConferencesTable.createdAt))
    .limit(limit);
}
