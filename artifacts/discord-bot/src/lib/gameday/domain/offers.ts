import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { GamedayContext } from "./context.js";
import { dmUser, postToGamedayChannel } from "./context.js";
import { ensureGamedaySchema, oneOf, rowsOf } from "./db.js";
import { parseAcceptedOfferDate } from "./time.js";
import type { ButtonInteraction } from "discord.js";

export type OfferRow = {
  id: number;
  guild_id: string;
  season_id: number;
  week_index: number;
  matchup_key: string;
  proposer_discord_id: string;
  recipient_discord_id: string;
  away_discord_id: string;
  home_discord_id: string;
  away_team_name: string;
  home_team_name: string;
  proposed_for: string;
  proposed_tz: string | null;
  notes: string | null;
  status: string;
  accepted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  offer_kind?: string | null;
  game_schedule_id?: number | null;
  replaces_scheduled_at?: Date | string | null;
  replaces_scheduled_tz?: string | null;
};

export async function countActiveOffers(ctx: GamedayContext): Promise<number> {
  await ensureGamedaySchema();
  const row = await oneOf<{ count: number }>(sql`
    select count(*)::int as count
    from gameday_schedule_offers
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and proposer_discord_id = ${ctx.userId}
      and status = 'pending'
  `);
  return Number(row?.count ?? 0);
}

export async function countPendingOffers(ctx: GamedayContext): Promise<number> {
  await ensureGamedaySchema();
  const row = await oneOf<{ count: number }>(sql`
    select count(*)::int as count
    from gameday_schedule_offers
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and recipient_discord_id = ${ctx.userId}
      and status = 'pending'
  `);
  return Number(row?.count ?? 0);
}

export async function listOffers(ctx: GamedayContext, mode: "sent" | "received"): Promise<OfferRow[]> {
  await ensureGamedaySchema();
  const column = mode === "sent" ? sql`proposer_discord_id` : sql`recipient_discord_id`;
  return rowsOf<OfferRow>(sql`
    select *
    from gameday_schedule_offers
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and ${column} = ${ctx.userId}
      and status = 'pending'
    order by created_at desc
    limit 25
  `);
}

export async function getOffer(id: number): Promise<OfferRow | null> {
  await ensureGamedaySchema();
  return oneOf<OfferRow>(sql`select * from gameday_schedule_offers where id = ${id} limit 1`);
}

export async function cleanupScheduleAttemptsForMatchup(ctx: GamedayContext): Promise<void> {
  await db.execute(sql`
    delete from gameday_offer_reminders
    where offer_id in (
      select id from gameday_schedule_offers
      where guild_id = ${ctx.guildId}
        and season_id = ${ctx.season.id}
        and week_index = ${ctx.weekIndex}
        and matchup_key = ${ctx.matchupKey}
    )
  `).catch(() => null);
  await db.execute(sql`
    delete from gameday_schedule_offers
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and status <> 'accepted'
  `);
}

export async function createOffer(ctx: GamedayContext, proposedFor: string, proposedTz: string, notes?: string | null): Promise<number> {
  await ensureGamedaySchema();
  const result = await db.execute(sql`
    insert into gameday_schedule_offers (
      guild_id, season_id, week_index, matchup_key,
      proposer_discord_id, recipient_discord_id,
      away_discord_id, home_discord_id, away_team_name, home_team_name,
      proposed_for, proposed_tz, notes, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.userId}, ${ctx.opponentId},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName},
      ${proposedFor}, ${proposedTz}, ${notes ?? null}, 'pending'
    ) returning id
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: number }>;
  return Number(rows[0]?.id ?? 0);
}

export async function acceptOffer(interaction: ButtonInteraction, ctx: GamedayContext, offerId: number): Promise<OfferRow | null> {
  const offer = await getOffer(offerId);
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") return null;

  await db.execute(sql`
    update gameday_schedule_offers
    set status = 'accepted', accepted_at = now(), updated_at = now()
    where id = ${offer.id}
  `);
  await db.execute(sql`
    update gameday_schedule_offers
    set status = 'superseded', updated_at = now()
    where guild_id = ${offer.guild_id}
      and season_id = ${offer.season_id}
      and week_index = ${offer.week_index}
      and matchup_key = ${offer.matchup_key}
      and status = 'pending'
      and id <> ${offer.id}
  `);
  await db.execute(sql`
    delete from gameday_offer_reminders
    where offer_id in (
      select id from gameday_schedule_offers
      where guild_id = ${offer.guild_id}
        and season_id = ${offer.season_id}
        and week_index = ${offer.week_index}
        and matchup_key = ${offer.matchup_key}
        and id <> ${offer.id}
    )
  `).catch(() => null);
  await db.execute(sql`
    delete from gameday_schedule_offers
    where guild_id = ${offer.guild_id}
      and season_id = ${offer.season_id}
      and week_index = ${offer.week_index}
      and matchup_key = ${offer.matchup_key}
      and id <> ${offer.id}
  `);

  const acceptedAt = parseAcceptedOfferDate(offer.proposed_for, offer.proposed_tz);
  if (acceptedAt) {
    if ((offer as any).offer_kind === "reschedule" && (offer as any).game_schedule_id) {
      await db.execute(sql`
        update game_schedules
        set scheduled_at = ${acceptedAt.toISOString()},
            scheduled_tz = ${offer.proposed_tz ?? null},
            status = case when status in ('unscheduled','pending','confirmed') then 'scheduled' else status end,
            reschedule_pending_offer_id = null,
            reschedule_approved_at = now(),
            reschedule_requested_at = null,
            updated_at = now()
        where guild_id = ${ctx.guildId}
          and id = ${(offer as any).game_schedule_id}
      `);
      await db.execute(sql`
        update gameday_schedule_offers
        set approved_by_discord_id = ${ctx.userId}, updated_at = now()
        where id = ${offer.id}
      `);
    } else {
      await db.execute(sql`
        update game_schedules
        set scheduled_at = ${acceptedAt.toISOString()},
            scheduled_tz = ${offer.proposed_tz ?? null},
            status = case when status in ('unscheduled','pending') then 'confirmed' else status end,
            updated_at = now()
        where guild_id = ${ctx.guildId}
          and season_id = ${ctx.season.id}
          and week_index = ${ctx.weekIndex}
          and (
               (away_discord_id = ${ctx.awayDiscordId} and home_discord_id = ${ctx.homeDiscordId})
            or (away_discord_id = ${ctx.homeDiscordId} and home_discord_id = ${ctx.awayDiscordId})
          )
      `);
    }
  }

  const publicText =
    `✅ **Game Scheduled**\n` +
    `<@${offer.away_discord_id}> @ <@${offer.home_discord_id}>\n` +
    `**Confirmed Time:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`;
  await postToGamedayChannel(interaction, ctx, publicText);
  await dmUser(interaction, offer.proposer_discord_id, publicText);
  await dmUser(interaction, offer.recipient_discord_id, publicText);
  return offer;
}

export async function rejectOffer(ctx: GamedayContext, offerId: number, reason: string): Promise<OfferRow | null> {
  const offer = await getOffer(offerId);
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") return null;
  await db.execute(sql`
    update gameday_schedule_offers
    set status = 'rejected', notes = coalesce(notes, '') || ${`\n\nRejected reason: ${reason}`}, updated_at = now()
    where id = ${offer.id}
  `);
  if ((offer as any).offer_kind === "reschedule" && (offer as any).game_schedule_id) {
    await db.execute(sql`
      update game_schedules
      set reschedule_pending_offer_id = null,
          reschedule_requested_at = null,
          updated_at = now()
      where id = ${(offer as any).game_schedule_id}
        and guild_id = ${offer.guild_id}
    `);
  }
  return offer;
}

export async function cancelOffer(ctx: GamedayContext, offerId: number): Promise<OfferRow | null> {
  const offer = await getOffer(offerId);
  if (!offer || offer.proposer_discord_id !== ctx.userId || offer.status !== "pending") return null;
  await db.execute(sql`update gameday_schedule_offers set status = 'cancelled', updated_at = now() where id = ${offer.id}`);
  if ((offer as any).offer_kind === "reschedule" && (offer as any).game_schedule_id) {
    await db.execute(sql`
      update game_schedules
      set reschedule_pending_offer_id = null,
          reschedule_requested_at = null,
          updated_at = now()
      where id = ${(offer as any).game_schedule_id}
        and guild_id = ${offer.guild_id}
    `);
  }
  return offer;
}

export async function counterOffer(ctx: GamedayContext, originalId: number, proposedFor: string, proposedTz: string, notes?: string | null): Promise<number | null> {
  const original = await getOffer(originalId);
  if (!original || original.recipient_discord_id !== ctx.userId || original.status !== "pending") return null;
  await db.execute(sql`update gameday_schedule_offers set status = 'countered', updated_at = now() where id = ${original.id}`);
  return createOffer(ctx, proposedFor, proposedTz, notes);
}
