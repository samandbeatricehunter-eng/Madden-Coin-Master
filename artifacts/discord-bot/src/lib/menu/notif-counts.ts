/**
 * Unaddressed-item counts for menu label badges "(N)".
 *
 * - Commissioner's Office (per-bucket + total)
 * - GOTW Vote tile: 1 if any open matchup the user hasn't voted on yet
 * - GOTY Vote tile: 1 if an active GOTY round exists the user hasn't voted in
 */

import { db } from "@workspace/db";
import {
  purchasesTable, seasonsTable, usersTable,
  payoutRequestsTable, interviewRequestsTable, pendingChannelPayoutsTable,
  gotwHistoryTable, gotwVotesTable, gameSchedulesTable,
  gotyRoundsTable, gotyVotesTable,
} from "@workspace/db";
import { eq, and, inArray, sql, desc } from "drizzle-orm";

export interface CommOfficeCounts {
  purchases:       number;
  payouts:         number;
  interviews:      number;
  streamHighlight: number;
  total:           number;
}

export async function getCommOfficeCounts(guildId: string): Promise<CommOfficeCounts> {
  // Guild-scoped users (for tables without guildId)
  const userRows = await db.select({ id: usersTable.discordId }).from(usersTable).where(eq(usersTable.guildId, guildId));
  const userIds = userRows.map(r => r.id);

  const guildSeasons = await db.select({ id: seasonsTable.id }).from(seasonsTable).where(eq(seasonsTable.guildId, guildId));
  const seasonIds = guildSeasons.map(s => s.id);

  const [purchasesRow] = seasonIds.length === 0 ? [{ cnt: 0 }] : await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(purchasesTable)
    .where(and(eq(purchasesTable.status, "pending"), inArray(purchasesTable.seasonId, seasonIds)));

  const [payoutsRow] = userIds.length === 0 ? [{ cnt: 0 }] : await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(payoutRequestsTable)
    .where(and(eq(payoutRequestsTable.status, "pending"), inArray(payoutRequestsTable.requesterId, userIds)));

  const [interviewsRow] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(interviewRequestsTable)
    .where(and(eq(interviewRequestsTable.guildId, guildId), eq(interviewRequestsTable.status, "pending")));

  const [channelRow] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(pendingChannelPayoutsTable)
    .where(and(eq(pendingChannelPayoutsTable.guildId, guildId), eq(pendingChannelPayoutsTable.status, "pending")));

  const purchases       = purchasesRow?.cnt ?? 0;
  const payouts         = payoutsRow?.cnt ?? 0;
  const interviews      = interviewsRow?.cnt ?? 0;
  const streamHighlight = channelRow?.cnt ?? 0;

  return {
    purchases, payouts, interviews, streamHighlight,
    total: purchases + payouts + interviews + streamHighlight,
  };
}

/** Returns the number of open GOTW matchups the user has not voted on yet. */
export async function getGotwUnvotedCount(userId: string, seasonId: number): Promise<number> {
  // Find latest week in this season's gotw_history
  const recent = await db.select({ weekIndex: gotwHistoryTable.weekIndex })
    .from(gotwHistoryTable)
    .where(eq(gotwHistoryTable.seasonId, seasonId))
    .orderBy(desc(gotwHistoryTable.weekIndex))
    .limit(1);
  if (recent.length === 0) return 0;
  const weekIndex = recent[0]!.weekIndex;

  const matchups = await db.select().from(gotwHistoryTable).where(and(
    eq(gotwHistoryTable.seasonId, seasonId),
    eq(gotwHistoryTable.weekIndex, weekIndex),
  ));
  if (matchups.length === 0) return 0;

  const scheds = await db.select().from(gameSchedulesTable).where(and(
    eq(gameSchedulesTable.seasonId, seasonId),
    eq(gameSchedulesTable.weekIndex, weekIndex),
  ));

  const LOCKED = new Set(["started", "finished", "completed_imported", "fair_sim", "auto_fair_sim", "force_win"]);
  function isLocked(m: typeof matchups[number]): boolean {
    const s = scheds.find(s =>
      (s.awayDiscordId === m.discordId1 && s.homeDiscordId === m.discordId2) ||
      (s.awayDiscordId === m.discordId2 && s.homeDiscordId === m.discordId1),
    );
    if (!s) return false;
    if (LOCKED.has(s.status)) return true;
    if (s.scheduledAt && s.scheduledAt.getTime() <= Date.now()) return true;
    return false;
  }

  const myVotes = await db.select({ matchupIndex: gotwVotesTable.matchupIndex })
    .from(gotwVotesTable)
    .where(and(
      eq(gotwVotesTable.seasonId, seasonId),
      eq(gotwVotesTable.weekIndex, weekIndex),
      eq(gotwVotesTable.voterId, userId),
    ));
  const voted = new Set(myVotes.map(v => v.matchupIndex));

  let count = 0;
  for (const m of matchups) {
    if (isLocked(m)) continue;
    if (!voted.has(m.matchupIndex)) count++;
  }
  return count;
}

/** Returns 1 if there is an open GOTY round the user hasn't voted in, else 0. Also returns whether a round exists at all. */
export async function getGotyStatus(userId: string, seasonId: number): Promise<{ unvoted: number; active: boolean }> {
  const [round] = await db.select().from(gotyRoundsTable).where(eq(gotyRoundsTable.seasonId, seasonId)).limit(1);
  if (!round) return { unvoted: 0, active: false };
  const isOpen = round.status === "open" && round.voteEndsAt.getTime() > Date.now();
  if (!isOpen) return { unvoted: 0, active: false };
  const [myVote] = await db.select().from(gotyVotesTable)
    .where(and(eq(gotyVotesTable.seasonId, seasonId), eq(gotyVotesTable.voterId, userId)))
    .limit(1);
  return { unvoted: myVote ? 0 : 1, active: true };
}
