import { Client, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

async function ensureReminderTables(): Promise<void> {
  await db.execute(sql`
    create table if not exists gameday_offer_reminders (
      id serial primary key,
      offer_id integer not null,
      stage text not null,
      sent_at timestamp with time zone not null default now(),
      unique(offer_id, stage)
    )
  `);
}

const STAGES = [
  { key: "10m", minutes: 10 },
  { key: "30m", minutes: 30 },
  { key: "2h", minutes: 120 },
  { key: "4h_fw", minutes: 240 },
];

export async function processGamedayReminderTick(client: Client): Promise<void> {
  await ensureReminderTables();

  const offers = await rowsOf<any>(sql`
    select o.*
    from gameday_schedule_offers o
    where o.status = 'pending'
      and o.created_at <= now() - interval '10 minutes'
    order by o.created_at asc
    limit 100
  `);

  for (const offer of offers) {
    const ageMinutes = Math.floor((Date.now() - new Date(offer.created_at).getTime()) / 60000);

    for (const stage of STAGES) {
      if (ageMinutes < stage.minutes) continue;

      const existing = await rowsOf(sql`
        select id
        from gameday_offer_reminders
        where offer_id = ${offer.id}
          and stage = ${stage.key}
        limit 1
      `);
      if (existing.length > 0) continue;

      await db.execute(sql`
        insert into gameday_offer_reminders (offer_id, stage)
        values (${offer.id}, ${stage.key})
        on conflict (offer_id, stage) do nothing
      `);

      await sendReminder(client, offer, stage.key);
    }
  }
}

async function sendReminder(client: Client, offer: any, stage: string): Promise<void> {
  const recipient = await client.users.fetch(offer.recipient_discord_id).catch(() => null);
  const proposer = await client.users.fetch(offer.proposer_discord_id).catch(() => null);

  const base =
    `🗓️ **Scheduling Offer Reminder**\n\n` +
    `Matchup: <@${offer.away_discord_id}> @ <@${offer.home_discord_id}>\n` +
    `Proposed time: **${offer.proposed_for} ${offer.proposed_tz ?? ""}**\n` +
    `Offer from: <@${offer.proposer_discord_id}>\n\n` +
    `Open \`/gameday\` in the active gameday channel to accept, counter, or reject.`;

  if (stage === "4h_fw") {
    await recipient?.send(`${base}\n\n⚠️ This offer has been pending for **4+ hours**. Your opponent may request a Force Win for failure to respond.`).catch(() => null);
    await proposer?.send(`⚠️ Your scheduling offer to <@${offer.recipient_discord_id}> has gone unanswered for **4+ hours**. You may request a Force Win through \`/gameday → Assistance → Request Force Win\`.`).catch(() => null);

    const channels = await rowsOf<{ channel_id: string }>(sql`
      select channel_id
      from guild_channels
      where guild_id = ${offer.guild_id}
        and channel_key = 'gameday_active'
      limit 1
    `);
    const channelId = channels[0]?.channel_id;
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) as TextChannel | null : null;
    await channel?.send(
      `⚠️ **Failure to Respond Notice**\n` +
      `<@${offer.recipient_discord_id}> has not responded to a scheduling offer from <@${offer.proposer_discord_id}> for **4+ hours**.\n\n` +
      `<@${offer.proposer_discord_id}> may request a Force Win or extend the response window through \`/gameday\`.`,
    ).catch(() => null);
    return;
  }

  await recipient?.send(base).catch(() => null);
}
