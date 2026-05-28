import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type CommissionerQueueItem = {
  id: number;
  guild_id: string;
  season_id: number;
  week_index: number;
  matchup_key: string;
  request_type: string;
  requested_by: string;
  opponent_discord_id: string | null;
  reason: string | null;
  status: string;
  created_at: string | Date;
};

function rowsOf<T = any>(result: any): T[] {
  return ((result as any).rows ?? result) as T[];
}

export async function listCommissionerReviewQueue(guildId: string, limit = 25): Promise<CommissionerQueueItem[]> {
  return rowsOf<CommissionerQueueItem>(await db.execute(sql`
    select id, guild_id, season_id, week_index, matchup_key,
           request_type, requested_by, opponent_discord_id, reason, status, created_at
    from gameday_commissioner_requests
    where guild_id = ${guildId}
      and status = 'pending'
    order by created_at asc
    limit ${limit}
  `));
}

export async function logCommissionerOperationalEvent(args: {
  guildId: string;
  eventType: string;
  actorDiscordId?: string | null;
  subjectDiscordId?: string | null;
  source?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    insert into guild_operational_events (
      guild_id, event_type, actor_discord_id, subject_discord_id, source, payload, created_at
    ) values (
      ${args.guildId}, ${args.eventType}, ${args.actorDiscordId ?? null}, ${args.subjectDiscordId ?? null},
      ${args.source ?? 'discord-bot'}, ${JSON.stringify(args.payload ?? {})}::jsonb, now()
    )
  `).catch(() => null);
}

export async function resolveCommissionerQueueItem(args: {
  guildId: string;
  requestId: number;
  status: "approved" | "denied" | "resolved" | "cancelled";
  actorDiscordId: string;
  note?: string | null;
}): Promise<boolean> {
  const updated = rowsOf(await db.execute(sql`
    update gameday_commissioner_requests
    set status = ${args.status},
        reason = case when ${args.note ?? null}::text is null then reason else concat(coalesce(reason, ''), E'\n\nCommissioner note: ', ${args.note}) end,
        updated_at = now()
    where guild_id = ${args.guildId}
      and id = ${args.requestId}
      and status = 'pending'
    returning id, request_type, requested_by, opponent_discord_id
  `))[0];

  if (!updated) return false;
  await logCommissionerOperationalEvent({
    guildId: args.guildId,
    eventType: "force_win_review_resolved",
    actorDiscordId: args.actorDiscordId,
    subjectDiscordId: updated.requested_by,
    payload: { requestId: args.requestId, status: args.status, requestType: updated.request_type, note: args.note ?? null },
  });
  return true;
}
