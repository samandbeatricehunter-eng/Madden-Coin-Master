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

  await db.execute(sql`
    create table if not exists gameday_offer_extensions (
      id serial primary key,
      offer_id integer not null,
      extended_by text not null,
      hours integer not null default 2,
      reason text,
      created_at timestamp with time zone not null default now()
    )
  `);

  await db.execute(sql`
    create index if not exists gameday_offer_extensions_offer_idx
    on gameday_offer_extensions(offer_id, created_at)
  `);
}

const STAGES = [
  { key: "10m", minutes: 10 },
  { key: "30m", minutes: 30 },
  { key: "2h", minutes: 120 },
  { key: "9h_fw", minutes: 540 },
];

const TZ_TO_IANA: Record<string, string> = {
  EST: "America/New_York",
  CST: "America/Chicago",
  MST: "America/Denver",
  PST: "America/Los_Angeles",
  AKST: "America/Anchorage",
  UTC: "UTC",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function partsInZone(date: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function offsetMs(date: Date, tz: string): number {
  const p = partsInZone(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - date.getTime();
}

function localToUtc(dateIso: string, hour: number, minute: number, tzKey: string): Date {
  const tz = TZ_TO_IANA[String(tzKey ?? "UTC").toUpperCase()] ?? "UTC";
  const [year, month, day] = dateIso.split("-").map(Number);
  const guess = new Date(Date.UTC(year!, month! - 1, day!, hour, minute));
  let utc = new Date(guess.getTime() - offsetMs(guess, tz));
  utc = new Date(guess.getTime() - offsetMs(utc, tz));
  return utc;
}

function parseProposedTime(proposedFor: string, proposedTz: string | null | undefined): Date | null {
  // Expected current guided format: "YYYY-MM-DD 7:30 PM"
  const raw = String(proposedFor ?? "").trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = Number(m[3]);
  const ap = String(m[4]).toUpperCase();
  if (ap === "PM" && hour < 12) hour += 12;
  if (ap === "AM" && hour === 12) hour = 0;
  return localToUtc(m[1]!, hour, minute, String(proposedTz ?? "UTC").toUpperCase());
}

export async function processGamedayReminderTick(client: Client): Promise<void> {
  await ensureReminderTables();
  await processOfferResponseReminders(client);
  await processScheduledNoShowNotices(client);
}

async function getExtensionHours(offerId: number): Promise<number> {
  const rows = await rowsOf<{ hours: number }>(sql`
    select coalesce(sum(hours), 0)::int as hours
    from gameday_offer_extensions
    where offer_id = ${offerId}
  `);
  return Number(rows[0]?.hours ?? 0);
}

async function processOfferResponseReminders(client: Client): Promise<void> {
  const offers = await rowsOf<any>(sql`
    select o.*
    from gameday_schedule_offers o
    where o.status = 'pending'
      and o.created_at <= now() - interval '10 minutes'
    order by o.created_at asc
    limit 100
  `);

  for (const offer of offers) {
    const extensionHours = await getExtensionHours(Number(offer.id));
    const ageMinutes = Math.floor((Date.now() - new Date(offer.created_at).getTime()) / 60000);
    const adjustedFwMinutes = 540 + extensionHours * 60;

    for (const stage of STAGES) {
      const dueMinutes = stage.key === "9h_fw" ? adjustedFwMinutes : stage.minutes;
      const stageKey = stage.key === "9h_fw" && extensionHours > 0 ? `9h_fw_ext_${extensionHours}` : stage.key;
      if (ageMinutes < dueMinutes) continue;

      const existing = await rowsOf(sql`
        select id
        from gameday_offer_reminders
        where offer_id = ${offer.id}
          and stage = ${stageKey}
        limit 1
      `);
      if (existing.length > 0) continue;

      await db.execute(sql`
        insert into gameday_offer_reminders (offer_id, stage)
        values (${offer.id}, ${stageKey})
        on conflict (offer_id, stage) do nothing
      `);

      await sendOfferReminder(client, offer, stage.key, extensionHours);
    }
  }
}

async function sendOfferReminder(client: Client, offer: any, stage: string, extensionHours: number): Promise<void> {
  const recipient = await client.users.fetch(offer.recipient_discord_id).catch(() => null);
  const proposer = await client.users.fetch(offer.proposer_discord_id).catch(() => null);

  const base =
    `🗓️ **Scheduling Offer Reminder**\n\n` +
    `Matchup: <@${offer.away_discord_id}> @ <@${offer.home_discord_id}>\n` +
    `Proposed time: **${offer.proposed_for} ${offer.proposed_tz ?? ""}**\n` +
    `Offer from: <@${offer.proposer_discord_id}>\n\n` +
    `Open \`/gameday\` in the active gameday channel to accept, counter, or reject.`;

  if (stage === "9h_fw") {
    await recipient?.send(`${base}\n\n⚠️ This offer has been pending for **9+ hours${extensionHours > 0 ? ` plus ${extensionHours} extension hour(s)` : ""}**. Your opponent may request a Force Win for failure to respond.`).catch(() => null);
    await proposer?.send(`⚠️ Your scheduling offer to <@${offer.recipient_discord_id}> has gone unanswered for **9+ hours${extensionHours > 0 ? ` plus ${extensionHours} extension hour(s)` : ""}**. You may request a Force Win or extend the response window by 2 hours through the gameday channel notice.`).catch(() => null);

    const channel = await getGamedayChannel(client, offer.guild_id);
    await channel?.send({
      content:
        `⚠️ **Failure to Respond Notice — FW Eligible**\n` +
        `<@${offer.recipient_discord_id}> has not responded to a scheduling offer from <@${offer.proposer_discord_id}> for **9+ hours${extensionHours > 0 ? ` plus ${extensionHours} extension hour(s)` : ""}**.\n\n` +
        `<@${offer.proposer_discord_id}> may request a Force Win or extend the response window by **2 hours**.`,
      components: [
        {
          type: 1,
          components: [
            { type: 2, custom_id: `gd_offer_fw:${offer.id}`, label: "Request FW", style: 4 },
            { type: 2, custom_id: `gd_offer_extend:${offer.id}`, label: "Extend +2h", style: 2 },
          ],
        },
      ],
    }).catch(() => null);
    return;
  }

  await recipient?.send(base).catch(() => null);
}

async function getGamedayChannel(client: Client, guildId: string): Promise<TextChannel | null> {
  const channels = await rowsOf<{ channel_id: string }>(sql`
    select channel_id
    from guild_channels
    where guild_id = ${guildId}
      and channel_key = 'gameday_active'
    limit 1
  `);
  const channelId = channels[0]?.channel_id;
  return channelId ? await client.channels.fetch(channelId).catch(() => null) as TextChannel | null : null;
}

async function processScheduledNoShowNotices(client: Client): Promise<void> {
  const offers = await rowsOf<any>(sql`
    select distinct on (guild_id, season_id, week_index, matchup_key) *
    from gameday_schedule_offers
    where status = 'accepted'
    order by guild_id, season_id, week_index, matchup_key, accepted_at desc nulls last, updated_at desc
    limit 200
  `);

  for (const offer of offers) {
    const scheduledAt = parseProposedTime(offer.proposed_for, offer.proposed_tz);
    if (!scheduledAt) continue;
    if (Date.now() < scheduledAt.getTime() + 45 * 60_000) continue;

    const statusRows = await rowsOf<any>(sql`
      select *
      from gameday_matchup_status
      where guild_id = ${offer.guild_id}
        and season_id = ${offer.season_id}
        and week_index = ${offer.week_index}
        and matchup_key = ${offer.matchup_key}
      limit 1
    `);
    const st = statusRows[0];
    if (!st) continue;
    if (st.away_checked_in && st.home_checked_in) continue;

    let eligibleUser: string | null = null;
    let missingUser: string | null = null;
    if (st.away_checked_in && !st.home_checked_in) {
      eligibleUser = offer.away_discord_id;
      missingUser = offer.home_discord_id;
    } else if (st.home_checked_in && !st.away_checked_in) {
      eligibleUser = offer.home_discord_id;
      missingUser = offer.away_discord_id;
    } else {
      continue;
    }

    const stage = `no_show_45:${offer.matchup_key}:${String(scheduledAt.getTime())}`;
    const existing = await rowsOf(sql`
      select id
      from gameday_offer_reminders
      where offer_id = ${offer.id}
        and stage = ${stage}
      limit 1
    `);
    if (existing.length > 0) continue;

    await db.execute(sql`
      insert into gameday_offer_reminders (offer_id, stage)
      values (${offer.id}, ${stage})
      on conflict (offer_id, stage) do nothing
    `);

    const channel = await getGamedayChannel(client, offer.guild_id);
    await channel?.send({
      content:
        `🚨 **No-Show FW Eligibility Notice**\n` +
        `Scheduled game time was **45+ minutes ago** and <@${missingUser}> has not checked in.\n\n` +
        `<@${eligibleUser}> is now eligible to request a Force Win unless a commissioner recognizes an approved reschedule/context exception.`,
      components: [
        {
          type: 1,
          components: [
            { type: 2, custom_id: `gd_noshow_fw:${offer.id}`, label: "Request FW", style: 4 },
          ],
        },
      ],
    }).catch(() => null);

    const eligible = await client.users.fetch(eligibleUser).catch(() => null);
    await eligible?.send(`🚨 Your opponent has not checked in by 45 minutes after the scheduled game time. You may request a Force Win in the gameday channel.`).catch(() => null);
  }
}
