import { db, usersTable } from "@workspace/db";
import { and, eq, sql, isNotNull, ne, notLike } from "drizzle-orm";

export const ECONOMY_MIN_LINKED_USERS = 8;

export interface EconomyEligibility {
  ok: boolean;
  activeLinked: number;
  threshold: number;
  reason?: string;
}

/**
 * Returns whether the guild has the minimum number of active+linked users
 * required for ANY payout/economy system to run (EOS auto-post, EOS
 * rebalance, luxury tax, scheduled payouts, etc.).
 *
 * "Active+linked" = an economy_users row in this guild whose `team` is set
 * and whose `discordId` is a real Discord ID (not an `unlinked_*` placeholder).
 */
export async function assertEconomyEligible(guildId: string): Promise<EconomyEligibility> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(and(
      eq(usersTable.guildId, guildId),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
      notLike(usersTable.discordId, "unlinked_%"),
    ));

  const activeLinked = Number(row?.count ?? 0);
  const ok = activeLinked >= ECONOMY_MIN_LINKED_USERS;
  return {
    ok,
    activeLinked,
    threshold: ECONOMY_MIN_LINKED_USERS,
    reason: ok ? undefined : `fewer than ${ECONOMY_MIN_LINKED_USERS} active+linked users (${activeLinked})`,
  };
}
