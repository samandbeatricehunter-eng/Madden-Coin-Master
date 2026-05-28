import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type GamedayCleanupSummary = {
  expiredOffers: number;
  staleForceReviewsClosed: number;
  orphanChannelsMarked: number;
};

export async function cleanupGamedayState(): Promise<GamedayCleanupSummary> {
  let expiredOffers: any;
  try {
    expiredOffers = await db.execute(sql`
      update gameday_schedule_offers
      set status = 'expired', updated_at = now()
      where status = 'pending'
        and created_at < now() - interval '24 hours'
    `);
  } catch (err) {
    // Older databases had a status CHECK constraint that did not allow `expired`.
    // Keep reconciliation alive even before the SQL hotfix is applied.
    console.warn("[gameday-cleanup] failed to mark offers expired; falling back to superseded", err);
    expiredOffers = await db.execute(sql`
      update gameday_schedule_offers
      set status = 'superseded', updated_at = now()
      where status = 'pending'
        and created_at < now() - interval '24 hours'
    `);
  }

  const staleForceReviews = await db.execute(sql`
    update game_schedules
    set status = 'scheduled', updated_at = now()
    where status = 'force_win_review'
      and force_win_requested_at is not null
      and force_win_requested_at < now() - interval '72 hours'
      and winner_discord_id is null
      and imported_winner_discord_id is null
  `);

  const orphanChannels = await db.execute(sql`
    update game_channels gc
    set status = 'orphaned', updated_at = now()
    where not exists (
      select 1 from game_schedules gs where gs.channel_id = gc.channel_id
    )
      and coalesce(gc.status, '') not in ('archived', 'orphaned')
  `);

  return {
    expiredOffers: (expiredOffers as any).rowCount ?? 0,
    staleForceReviewsClosed: (staleForceReviews as any).rowCount ?? 0,
    orphanChannelsMarked: (orphanChannels as any).rowCount ?? 0,
  };
}
