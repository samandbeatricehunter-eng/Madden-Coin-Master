import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable,
  franchiseMcaTeamsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  getGuildChannel,
  getOrCreateActiveSeason,
  getScheduleSeasonId,
  addBalance,
  logTransaction,
} from "../db/db-helpers.js";
import { weekLabel } from "../helpers/week-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";
import { getServerSettings } from "../db/server-settings.js";
import { nextAdvanceDeadline } from "../discord/timezones.js";

type GamedayContext = {
  guildId: string;
  season: any;
  weekIndex: number;
  scheduleSeasonId: number;
  channelId: string;
  userId: string;
  awayDiscordId: string;
  homeDiscordId: string;
  opponentId: string;
  awayTeamName: string;
  homeTeamName: string;
  matchupKey: string;
  homeAway: "Home" | "Away";
};

type OfferRow = {
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
  created_at: Date | string;
  updated_at: Date | string;
};


const GAMEDAY_TZ_OPTIONS = [
  { key: "EST", label: "EST", timeZone: "America/New_York" },
  { key: "CST", label: "CST", timeZone: "America/Chicago" },
  { key: "MST", label: "MST", timeZone: "America/Denver" },
  { key: "PST", label: "PST", timeZone: "America/Los_Angeles" },
  { key: "AKST", label: "AKST", timeZone: "America/Anchorage" },
  { key: "UTC", label: "UTC", timeZone: "UTC" },
] as const;

type GamedayTzKey = typeof GAMEDAY_TZ_OPTIONS[number]["key"];

type ScheduleDraft = {
  dayIso?: string;
  tz?: GamedayTzKey;
  time?: string;
};

const scheduleDrafts = new Map<string, ScheduleDraft>();

function draftKey(ctx: GamedayContext): string {
  return `${ctx.guildId}:${ctx.season.id}:${ctx.weekIndex}:${ctx.matchupKey}:${ctx.userId}`;
}

function getScheduleDraft(ctx: GamedayContext): ScheduleDraft {
  const key = draftKey(ctx);
  let d = scheduleDrafts.get(key);
  if (!d) {
    d = {};
    scheduleDrafts.set(key, d);
  }
  return d;
}

function setScheduleDraft(ctx: GamedayContext, patch: Partial<ScheduleDraft>): ScheduleDraft {
  const key = draftKey(ctx);
  const next = { ...getScheduleDraft(ctx), ...patch };
  scheduleDrafts.set(key, next);
  return next;
}

function tzByKey(key: string | undefined | null) {
  return GAMEDAY_TZ_OPTIONS.find((t) => t.key === key);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatPartsInTimeZone(date: Date, tzKey: GamedayTzKey): { year: number; month: number; day: number; hour: number; minute: number } {
  const tz = tzByKey(tzKey)!;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function localParts(date: Date, tzKey: GamedayTzKey): { year: number; month: number; day: number; hour: number; minute: number } {
  return formatPartsInTimeZone(date, tzKey);
}

function localIsoDate(date: Date, tzKey: GamedayTzKey): string {
  const p = localParts(date, tzKey);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function timeZoneOffsetMs(date: Date, tzKey: GamedayTzKey): number {
  const p = localParts(date, tzKey);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - date.getTime();
}

function localDateTimeToUtc(dateIso: string, time: string, tzKey: GamedayTzKey): Date {
  const [year, month, day] = dateIso.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);

  // Initial guess treats the selected local wall time as UTC, then adjusts by
  // the real timezone offset for that instant. The second pass handles DST.
  let guess = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!));
  let utc = new Date(guess.getTime() - timeZoneOffsetMs(guess, tzKey));
  utc = new Date(guess.getTime() - timeZoneOffsetMs(utc, tzKey));
  return utc;
}

function displayTime(time: string): string {
  const [hRaw, mRaw] = time.split(":").map(Number);
  const h = hRaw ?? 0;
  const m = mRaw ?? 0;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)} ${suffix}`;
}

async function getBaseAdvanceDeadline(ctx: GamedayContext): Promise<Date> {
  const settings = await getServerSettings(ctx.guildId);
  return nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
}

async function getAdvanceDeadline(ctx: GamedayContext): Promise<Date> {
  await ensureGamedayTables();
  const result = await db.execute(sql`
    select advance_at_utc
    from gameday_advance_overrides
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and status = 'active'
    order by created_at desc
    limit 1
  `);
  const rows = ((result as any).rows ?? result) as Array<{ advance_at_utc: string | Date }>;
  if (rows[0]?.advance_at_utc) return new Date(rows[0].advance_at_utc);
  return getBaseAdvanceDeadline(ctx);
}

async function getAvailableDays(ctx: GamedayContext, tzKey: GamedayTzKey): Promise<Array<{ iso: string; label: string }>> {
  const now = new Date();
  const deadline = await getAdvanceDeadline(ctx);
  const todayIso = localIsoDate(now, tzKey);
  const deadlineIso = localIsoDate(deadline, tzKey);

  const days: Array<{ iso: string; label: string }> = [];
  const todayParts = todayIso.split("-").map(Number);
  let cursor = new Date(Date.UTC(todayParts[0]!, todayParts[1]! - 1, todayParts[2]!));

  for (let i = 0; i < 10; i++) {
    const iso = `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`;
    if (iso > deadlineIso) break;

    // Include a day only if it has at least one future slot before deadline.
    const hasTimes = (await getAvailableTimes(ctx, iso, tzKey)).length > 0;
    if (hasTimes) {
      const dateLabel = `${cursor.getUTCMonth() + 1}/${cursor.getUTCDate()}/${cursor.getUTCFullYear()}`;
      const label = iso === todayIso ? `Today — ${dateLabel}` : iso === deadlineIso ? `Advance Day — ${dateLabel}` : dateLabel;
      days.push({ iso, label });
    }

    cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
  }

  return days;
}

async function getAvailableTimes(ctx: GamedayContext, dayIso: string, tzKey: GamedayTzKey): Promise<Array<{ value: string; label: string; late: boolean }>> {
  const now = new Date();
  const deadline = await getAdvanceDeadline(ctx);
  const out: Array<{ value: string; label: string; late: boolean }> = [];

  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 30]) {
      const time = `${pad2(hour)}:${pad2(minute)}`;
      const utc = localDateTimeToUtc(dayIso, time, tzKey);

      // Hard guard: never show slots that are already past or within the current minute.
      if (utc.getTime() <= now.getTime() + 60_000) continue;
      if (utc.getTime() > deadline.getTime()) continue;

      const late = utc.getTime() >= deadline.getTime() - 60 * 60_000;
      out.push({ value: time, label: `${displayTime(time)} ${tzKey}${late ? " ⚠️ late" : ""}`, late });
    }
  }

  return out;
}

function commissionerRoleMention(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): string {
  const role = interaction.guild?.roles.cache.find((r) => r.name.toLowerCase() === "commissioner");
  return role ? `<@&${role.id}>` : "@Commissioners";
}

async function isCommissionerOrAdmin(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((r) => r.name.toLowerCase() === "commissioner");
}

function teamKey(teamName: string): string {
  return teamName.toLowerCase().trim();
}

function weekIndexFromCurrentWeek(currentWeek: string | null | undefined): number | null {
  const raw = String(currentWeek ?? "").toLowerCase().trim();
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= 18) return n - 1;
  if (raw === "wildcard") return 1018;
  if (raw === "divisional") return 1019;
  if (raw === "conference") return 1020;
  if (raw === "superbowl") return 1022;
  return null;
}

function matchupKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

async function ensureGamedayTables(): Promise<void> {
  await db.execute(sql`
    create table if not exists gameday_schedule_offers (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer not null,
      matchup_key text not null,
      proposer_discord_id text not null,
      recipient_discord_id text not null,
      away_discord_id text not null,
      home_discord_id text not null,
      away_team_name text not null,
      home_team_name text not null,
      proposed_for text not null,
      proposed_tz text,
      notes text,
      status text not null default 'pending',
      accepted_at timestamp with time zone,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);
  await db.execute(sql`
    create index if not exists gameday_schedule_offers_lookup_idx
    on gameday_schedule_offers(guild_id, season_id, week_index, matchup_key, status)
  `);
  await db.execute(sql`
    create index if not exists gameday_schedule_offers_recipient_idx
    on gameday_schedule_offers(guild_id, recipient_discord_id, status)
  `);

  await db.execute(sql`
    create table if not exists gameday_matchup_status (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer not null,
      matchup_key text not null,
      away_discord_id text not null,
      home_discord_id text not null,
      away_team_name text not null,
      home_team_name text not null,
      away_checked_in boolean not null default false,
      home_checked_in boolean not null default false,
      search_advised_by text,
      invite_requested_by text,
      begun_by text,
      begun_at timestamp with time zone,
      stream_url text,
      stream_paid_to text,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now(),
      unique(guild_id, season_id, week_index, matchup_key)
    )
  `);

  await db.execute(sql`
    create table if not exists gameday_score_submissions (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer not null,
      matchup_key text not null,
      away_discord_id text not null,
      home_discord_id text not null,
      away_team_name text not null,
      home_team_name text not null,
      submitted_by text not null,
      opponent_discord_id text not null,
      away_score integer not null,
      home_score integer not null,
      winner_discord_id text,
      status text not null default 'pending',
      dispute_reason text,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);

  await db.execute(sql`
    create index if not exists gameday_score_submissions_lookup_idx
    on gameday_score_submissions(guild_id, season_id, week_index, matchup_key, status)
  `);

  await db.execute(sql`
    create index if not exists gameday_score_submissions_opp_idx
    on gameday_score_submissions(guild_id, opponent_discord_id, status)
  `);
  await db.execute(sql`
    create table if not exists gameday_advance_overrides (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer not null,
      requested_by text,
      approved_by text,
      advance_at_utc timestamp with time zone not null,
      tz text not null,
      reason text,
      status text not null default 'active',
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);

  await db.execute(sql`
    create table if not exists gameday_commissioner_requests (
      id serial primary key,
      guild_id text not null,
      season_id integer not null,
      week_index integer not null,
      matchup_key text not null,
      request_type text not null,
      requested_by text not null,
      opponent_discord_id text,
      reason text,
      status text not null default 'pending',
      message_id text,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);

}

async function queryOffers(whereSql: any): Promise<OfferRow[]> {
  const result = await db.execute(sql`
    select *
    from gameday_schedule_offers
    where ${whereSql}
    order by created_at desc
  `);
  return ((result as any).rows ?? result) as OfferRow[];
}

async function countOffers(whereSql: any): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count
    from gameday_schedule_offers
    where ${whereSql}
  `);
  const rows = ((result as any).rows ?? result) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

async function executeOfferUpdate(q: any): Promise<void> {
  await db.execute(q);
}

async function updatePanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  payload: any,
): Promise<void> {
  if ((interaction as any).deferred || (interaction as any).replied) {
    await interaction.editReply(payload).catch(async () => {
      await interaction.followUp({ ...payload, ephemeral: true }).catch(() => null);
    });
    return;
  }

  await interaction.update(payload).catch(async (err: any) => {
    if (err?.code === 10062) {
      await interaction.deferUpdate().catch(() => null);
      await interaction.editReply(payload).catch(() => null);
      return;
    }
    throw err;
  });
}

function isValidHttpUrl(value: string | null | undefined): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function ensureMatchupStatus(ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();
  await db.execute(sql`
    insert into gameday_matchup_status (
      guild_id, season_id, week_index, matchup_key,
      away_discord_id, home_discord_id, away_team_name, home_team_name
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName}
    )
    on conflict (guild_id, season_id, week_index, matchup_key) do nothing
  `);
}

async function getMatchupStatus(ctx: GamedayContext): Promise<any> {
  await ensureMatchupStatus(ctx);
  const result = await db.execute(sql`
    select *
    from gameday_matchup_status
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
    limit 1
  `);
  const rows = ((result as any).rows ?? result) as any[];
  return rows[0] ?? null;
}

async function dmOpponent(interaction: ButtonInteraction | ModalSubmitInteraction, ctx: GamedayContext, content: string): Promise<void> {
  const member = await interaction.guild?.members.fetch(ctx.opponentId).catch(() => null);
  await member?.send(content).catch(() => null);
}

async function postPublic(interaction: ButtonInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  const ch = interaction.channel;
  if (ch?.isTextBased()) await ch.send({ content }).catch(() => null);
}

async function getContext(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<GamedayContext | null> {
  const guildId = interaction.guildId!;
  const activeChannelId = await getGuildChannel(guildId, "gameday_active" as any).catch(() => null);

  if (!activeChannelId || interaction.channelId !== activeChannelId) {
    const msg = activeChannelId
      ? `❌ \`/gameday\` only works in the active weekly gameday channel: <#${activeChannelId}>.`
      : "❌ No active weekly gameday channel is configured yet.";
    if (interaction.isRepliable()) {
      if ((interaction as any).deferred || (interaction as any).replied) {
        await (interaction as any).editReply({ content: msg, embeds: [], components: [] }).catch(async () => {
          await (interaction as any).followUp({ content: msg, ephemeral: true }).catch(() => null);
        });
      } else {
        await (interaction as any).reply({ content: msg, ephemeral: true }).catch(() => null);
      }
    }
    return null;
  }

  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = weekIndexFromCurrentWeek((season as any).currentWeek);
  if (weekIndex == null) {
    if (interaction.isRepliable()) {
      await (interaction as any).reply?.({ ephemeral: true, content: "❌ There is no active H2H gameday dashboard for the current league week." }).catch(() => null);
    }
    return null;
  }

  const scheduleSeasonId = await getScheduleSeasonId(guildId);
  const [games, mcaTeams, users] = await Promise.all([
    db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId, scheduleSeasonId),
        eq(franchiseScheduleTable.weekIndex, weekIndex),
      )),
    db.select({
      fullName: franchiseMcaTeamsTable.fullName,
      nickName: franchiseMcaTeamsTable.nickName,
      discordId: franchiseMcaTeamsTable.discordId,
    }).from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, scheduleSeasonId)),
    db.select({ discordId: usersTable.discordId, team: usersTable.team })
      .from(usersTable)
      .where(eq(usersTable.guildId, guildId)),
  ]);

  const teamToDiscord = new Map<string, string>();
  for (const t of mcaTeams) {
    if (!t.discordId || t.discordId.startsWith("unlinked_")) continue;
    teamToDiscord.set(teamKey(t.fullName), t.discordId);
    teamToDiscord.set(teamKey(t.nickName), t.discordId);
  }
  for (const u of users) {
    if (!u.team || !u.discordId || u.discordId.startsWith("unlinked_")) continue;
    if (!teamToDiscord.has(teamKey(u.team))) teamToDiscord.set(teamKey(u.team), u.discordId);
  }

  const userId = interaction.user.id;
  const myGame = games
    .map((g) => ({
      ...g,
      awayDiscordId: teamToDiscord.get(teamKey(g.awayTeamName)),
      homeDiscordId: teamToDiscord.get(teamKey(g.homeTeamName)),
    }))
    .find((g) => g.awayDiscordId === userId || g.homeDiscordId === userId);

  if (!myGame || !myGame.awayDiscordId || !myGame.homeDiscordId) {
    if (interaction.isRepliable()) {
      if ((interaction as any).replied || (interaction as any).deferred) await (interaction as any).followUp({ ephemeral: true, content: "❌ You do not have a H2H matchup this week, so there are no gameday actions available." }).catch(() => null);
      else await (interaction as any).reply({ ephemeral: true, content: "❌ You do not have a H2H matchup this week, so there are no gameday actions available." }).catch(() => null);
    }
    return null;
  }

  const opponentId = myGame.awayDiscordId === userId ? myGame.homeDiscordId : myGame.awayDiscordId;

  return {
    guildId,
    season,
    weekIndex,
    scheduleSeasonId,
    channelId: activeChannelId,
    userId,
    awayDiscordId: myGame.awayDiscordId,
    homeDiscordId: myGame.homeDiscordId,
    opponentId,
    awayTeamName: myGame.awayTeamName,
    homeTeamName: myGame.homeTeamName,
    matchupKey: matchupKey(myGame.awayDiscordId, myGame.homeDiscordId),
    homeAway: myGame.homeDiscordId === userId ? "Home" : "Away",
  };
}

function mainRows(activeCount: number, pendingCount: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_schedule").setLabel("🗓️ Schedule Game").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("gd_pending").setLabel(`📨 Pending Offers (${pendingCount})`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_queue").setLabel("🎮 Game Queue").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("gd_assist").setLabel("🚨 Assistance").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_manage_offers").setLabel(`⚙️ Manage Active Offers (${activeCount})`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_score_pending").setLabel("🏁 Score Approval").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function renderDashboard(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();

  const activeCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  const pendingCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and recipient_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎮 Gameday Dashboard")
    .setDescription([
      `**Week:** ${weekLabel((ctx.season as any).currentWeek)}`,
      `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>`,
      `**You are:** ${ctx.homeAway}`,
      `**Opponent:** <@${ctx.opponentId}>`,
    ].join("\n"))
    .addFields(
      { name: "Schedule Game", value: `Send proposed times · Manage active offers (**${activeCount}**) · Edit/delete offers`, inline: false },
      { name: `Pending Offers (${pendingCount})`, value: "Accept · Counter · Reject with reason", inline: false },
      { name: "Game Queue", value: "Check in/out · message opponent · advise search · request invite · mark begun with stream link", inline: false },
      { name: "Assistance", value: "Contact commissioner · flag violation · request FS/FW", inline: false },
    );

  const payload = { ephemeral: true, embeds: [embed], components: mainRows(activeCount, pendingCount) as any };
  if (interaction.isChatInputCommand()) await interaction.reply(payload);
  else if ((interaction as any).replied || (interaction as any).deferred) await (interaction as any).editReply(payload).catch(() => (interaction as any).followUp(payload));
  else await (interaction as any).update(payload).catch(() => (interaction as any).reply(payload));
}

export async function openGamedayDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await getContext(interaction);
  if (!ctx) return;
  await renderDashboard(interaction, ctx);
}

async function showScheduleMenu(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();
  const activeCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🗓️ Schedule Game")
        .setDescription(
          `You may have up to **3 active pending offers** for this matchup.\n\n` +
          `Current active offers sent by you: **${activeCount}/3**.`,
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_offer_new").setLabel("➕ Send New Proposed Time").setStyle(ButtonStyle.Primary).setDisabled(activeCount >= 3),
        new ButtonBuilder().setCustomId("gd_manage_offers").setLabel(`⚙️ Manage Active Offers (${activeCount})`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}


async function showNewOfferModal(interaction: ButtonInteraction, ctx?: GamedayContext): Promise<void> {
  // Backward-compatible name. The flow is now selector-driven, not a freeform modal.
  if (!ctx) {
    await interaction.reply({ ephemeral: true, content: "❌ Scheduling session expired. Reopen `/gameday` and try again." });
    return;
  }
  setScheduleDraft(ctx, {});
  await showTimezoneSelect(interaction, ctx);
}

async function showTimezoneSelect(interaction: ButtonInteraction | StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("gd_sched_tz")
    .setPlaceholder("Select your timezone…")
    .addOptions(GAMEDAY_TZ_OPTIONS.map((tz) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(tz.label)
        .setDescription(tz.key === "UTC" ? "Coordinated Universal Time" : `UTC${tz.offsetMinutes / 60}`)
        .setValue(tz.key),
    ));

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🗓️ Schedule Game — Step 1")
        .setDescription("Select the timezone you want to use for scheduling."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_schedule").setLabel("← Back").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function showDaySelect(interaction: StringSelectMenuInteraction | ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const draft = getScheduleDraft(ctx);
  const tzKey = draft.tz ?? "CST";
  const days = await getAvailableDays(ctx, tzKey);
  if (days.length === 0) {
    await updatePanel(interaction, {
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Scheduling Days Available").setDescription("There are no selectable days before the current advance deadline.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_schedule").setLabel("← Back").setStyle(ButtonStyle.Secondary))],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("gd_sched_day")
    .setPlaceholder("Select the day…")
    .addOptions(days.slice(0, 25).map((d) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(d.label)
        .setValue(d.iso),
    ));

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🗓️ Schedule Game — Step 2")
        .setDescription(`Timezone selected: **${tzKey}**\n\nSelect the day for your proposed game time.`),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_offer_new").setLabel("← Back to Timezone").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function showTimeSelect(interaction: StringSelectMenuInteraction | ButtonInteraction, ctx: GamedayContext, page = 0): Promise<void> {
  const draft = getScheduleDraft(ctx);
  if (!draft.tz || !draft.dayIso) {
    await showTimezoneSelect(interaction as any, ctx);
    return;
  }

  const times = await getAvailableTimes(ctx, draft.dayIso, draft.tz);
  if (times.length === 0) {
    await updatePanel(interaction, {
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Times Available").setDescription("No remaining time slots are available on that date before advance. Pick a different day/timezone or contact a commissioner.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_sched_back_day").setLabel("← Back to Day").setStyle(ButtonStyle.Secondary))],
    });
    return;
  }

  const pageSize = 24;
  const pageCount = Math.max(1, Math.ceil(times.length / pageSize));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const slice = times.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const menu = new StringSelectMenuBuilder()
    .setCustomId("gd_sched_time")
    .setPlaceholder(`Select time — page ${safePage + 1}/${pageCount}`)
    .addOptions(slice.map((t) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(t.label)
        .setDescription(t.late ? "Within 1 hour of advance; commissioner delay request will post." : "Available before advance deadline")
        .setValue(t.value),
    ));

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🗓️ Schedule Game — Step 3")
        .setDescription(`Timezone: **${draft.tz}**\nDay: **${draft.dayIso}**\n\nSelect a time. Late slots are marked with ⚠️.`),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_sched_time_page:${safePage - 1}`).setLabel("← Prev").setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
        new ButtonBuilder().setCustomId(`gd_sched_time_page:${safePage + 1}`).setLabel("Next →").setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
        new ButtonBuilder().setCustomId("gd_sched_back_day").setLabel("Back to Day").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function showOfferConfirm(interaction: StringSelectMenuInteraction | ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const draft = getScheduleDraft(ctx);
  if (!draft.tz || !draft.dayIso || !draft.time) {
    await showTimezoneSelect(interaction as any, ctx);
    return;
  }

  const selectedUtc = localDateTimeToUtc(draft.dayIso, draft.time, draft.tz);
  const deadline = await getAdvanceDeadline(ctx);
  const late = selectedUtc.getTime() >= deadline.getTime() - 60 * 60_000;

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(late ? Colors.Orange : Colors.Green)
        .setTitle("🗓️ Confirm Scheduling Offer")
        .setDescription([
          `**Proposed:** ${draft.dayIso} at ${displayTime(draft.time)} ${draft.tz}`,
          `**Opponent:** <@${ctx.opponentId}>`,
          late ? "⚠️ This time is within 1 hour of the advance deadline. If confirmed, commissioners will be tagged with Approve/Deny delay buttons." : "",
        ].filter(Boolean).join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_offer_confirm").setLabel("✅ Send Offer").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("gd_sched_note").setLabel("📝 Add Note").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("gd_sched_back_time").setLabel("← Back to Time").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function showOfferNoteModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("gd_modal_offer_note")
    .setTitle("Optional Scheduling Note");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Optional note")
        .setPlaceholder("Example: I can start 15 minutes earlier if needed.")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(false),
    ),
  );

  await interaction.showModal(modal);
}

async function handleOfferNoteModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  const notes = interaction.fields.getTextInputValue("notes").trim() || undefined;
  (setScheduleDraft(ctx, {}) as any).notes = notes;
  await interaction.reply({
    ephemeral: true,
    content: notes ? "✅ Note saved. Use the button below to continue." : "✅ Note cleared. Use the button below to continue.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_offer_confirm").setLabel("Continue to Confirm").setStyle(ButtonStyle.Success),
      ),
    ],
  });
}




async function handleNewOfferModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  // Legacy modal path retained only for old stale interactions.
  await interaction.reply({ ephemeral: true, content: "❌ This scheduling form is outdated. Please reopen `/gameday` and use the new dropdown scheduler." });
}

async function sendGuidedOffer(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();

  const activeCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  if (activeCount >= 3) {
    await interaction.reply({ ephemeral: true, content: "❌ You already have 3 active pending offers for this matchup. Edit/delete one first." });
    return;
  }

  const draft: any = getScheduleDraft(ctx);
  if (!draft.tz || !draft.dayIso || !draft.time) {
    await interaction.reply({ ephemeral: true, content: "❌ Scheduling selection expired. Restart the scheduler." });
    return;
  }

  const selectedUtc = localDateTimeToUtc(draft.dayIso, draft.time, draft.tz);
  const deadline = await getAdvanceDeadline(ctx);
  if (selectedUtc.getTime() > deadline.getTime()) {
    await interaction.reply({ ephemeral: true, content: "❌ That time is after the current advance deadline. Pick an earlier time or request commissioner help." });
    return;
  }

  const proposedFor = `${draft.dayIso} ${displayTime(draft.time)}`;
  const proposedTz = draft.tz;
  const notes = draft.notes ?? null;
  const late = selectedUtc.getTime() >= deadline.getTime() - 60 * 60_000;

  const result = await db.execute(sql`
    insert into gameday_schedule_offers (
      guild_id, season_id, week_index, matchup_key,
      proposer_discord_id, recipient_discord_id,
      away_discord_id, home_discord_id, away_team_name, home_team_name,
      proposed_for, proposed_tz, notes, status
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.userId}, ${ctx.opponentId},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName},
      ${proposedFor}, ${proposedTz}, ${notes}, 'pending'
    )
    returning id
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: number }>;
  const offerId = rows[0]?.id;

  const dmText =
    `🗓️ **New Scheduling Offer**\n\n` +
    `<@${ctx.userId}> proposed a game time for **${ctx.awayTeamName} @ ${ctx.homeTeamName}**:\n\n` +
    `**Time:** ${proposedFor} ${proposedTz}\n` +
    (notes ? `**Note:** ${notes}\n\n` : "\n") +
    `Open \`/gameday\` in the active gameday channel to accept, counter, or reject.`;

  const member = await interaction.guild?.members.fetch(ctx.opponentId).catch(() => null);
  await member?.send(dmText).catch(() => null);

  if (late) {
    const commissionerMention = commissionerRoleMention(interaction);
    const delayMsg = await interaction.channel?.isTextBased()
      ? await interaction.channel.send({
          content:
            `⚠️ **Late Game Scheduled — Delay Review Needed**\n${commissionerMention}\n\n` +
            `<@${ctx.userId}> proposed a game time within **1 hour** of advance.\n\n` +
            `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>\n` +
            `**Proposed:** ${proposedFor} ${proposedTz}\n` +
            `**Current advance deadline:** <t:${Math.floor(deadline.getTime() / 1000)}:F>\n\n` +
            `Commissioners may approve a delay or deny it.`,
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`gd_delay_approve:${offerId}`).setLabel("✅ Approve Delay").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`gd_delay_deny:${offerId}`).setLabel("❌ Deny Delay").setStyle(ButtonStyle.Danger),
            ),
          ],
        }).catch(() => null)
      : null;

    await db.execute(sql`
      insert into gameday_commissioner_requests (
        guild_id, season_id, week_index, matchup_key, request_type,
        requested_by, opponent_discord_id, reason, status, message_id
      )
      values (
        ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, 'advance_delay',
        ${ctx.userId}, ${ctx.opponentId}, ${`Late scheduling offer #${offerId}: ${proposedFor} ${proposedTz}`}, 'pending', ${delayMsg?.id ?? null}
      )
    `);
  }

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(late ? Colors.Orange : Colors.Green)
        .setTitle("✅ Scheduling Offer Sent")
        .setDescription(`Offer #${offerId ?? "?"} sent to <@${ctx.opponentId}>.\n\n**Time:** ${proposedFor} ${proposedTz}${late ? "\n\n⚠️ Commissioner delay review was posted because this is within 1 hour of advance." : ""}`),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });

  scheduleDrafts.delete(draftKey(ctx));
}



async function showPendingOffers(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();
  const offers = await queryOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and recipient_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  if (offers.length === 0) {
    await updatePanel(interaction, {
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("📨 Pending Offers").setDescription("You do not have any pending scheduling offers.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("gd_pending_select")
    .setPlaceholder("Select an offer to review…")
    .addOptions(offers.slice(0, 25).map(o =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`#${o.id} · ${o.proposed_for}`.slice(0, 100))
        .setDescription(`From ${o.proposer_discord_id}`.slice(0, 100))
        .setValue(String(o.id)),
    ));

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📨 Pending Offers (${offers.length})`).setDescription("Select an offer to accept, counter, or reject.")],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function showManageOffers(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await ensureGamedayTables();
  const offers = await queryOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);

  if (offers.length === 0) {
    await updatePanel(interaction, {
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("⚙️ Manage Active Offers").setDescription("You have no active pending offers to manage.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("gd_manage_select")
    .setPlaceholder("Select one of your offers…")
    .addOptions(offers.slice(0, 25).map(o =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`#${o.id} · ${o.proposed_for}`.slice(0, 100))
        .setDescription(`To ${o.recipient_discord_id}`.slice(0, 100))
        .setValue(String(o.id)),
    ));

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`⚙️ Manage Active Offers (${offers.length})`).setDescription("Select an offer to edit or delete.")],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function getOfferById(id: number): Promise<OfferRow | null> {
  const result = await db.execute(sql`select * from gameday_schedule_offers where id = ${id} limit 1`);
  const rows = ((result as any).rows ?? result) as OfferRow[];
  return rows[0] ?? null;
}

async function showPendingOfferDetail(interaction: StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const offerId = Number(interaction.values[0]);
  const offer = await getOfferById(offerId);
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") {
    await updatePanel(interaction, { ephemeral: true, content: "❌ Offer not found or no longer pending.", embeds: [], components: [] });
    return;
  }

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`📨 Scheduling Offer #${offer.id}`)
        .setDescription([
          `**From:** <@${offer.proposer_discord_id}>`,
          `**Matchup:** <@${offer.away_discord_id}> @ <@${offer.home_discord_id}>`,
          `**Proposed Time:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`,
          offer.notes ? `**Note:** ${offer.notes}` : "",
        ].filter(Boolean).join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_offer_accept:${offer.id}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gd_offer_counter:${offer.id}`).setLabel("🔁 Counter").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`gd_offer_reject:${offer.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_pending").setLabel("← Pending Offers").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function showManageOfferDetail(interaction: StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const offerId = Number(interaction.values[0]);
  const offer = await getOfferById(offerId);
  if (!offer || offer.proposer_discord_id !== ctx.userId || offer.status !== "pending") {
    await updatePanel(interaction, { ephemeral: true, content: "❌ Offer not found or no longer pending.", embeds: [], components: [] });
    return;
  }

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`⚙️ Manage Offer #${offer.id}`)
        .setDescription([
          `**To:** <@${offer.recipient_discord_id}>`,
          `**Proposed Time:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`,
          offer.notes ? `**Note:** ${offer.notes}` : "",
        ].filter(Boolean).join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_offer_edit:${offer.id}`).setLabel("✏️ Edit").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`gd_offer_delete:${offer.id}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_manage_offers").setLabel("← Manage Offers").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function acceptOffer(interaction: ButtonInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set status = 'accepted', accepted_at = now(), updated_at = now()
    where id = ${offer.id}
  `);

  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set status = 'superseded', updated_at = now()
    where guild_id = ${offer.guild_id}
      and season_id = ${offer.season_id}
      and week_index = ${offer.week_index}
      and matchup_key = ${offer.matchup_key}
      and status = 'pending'
      and id <> ${offer.id}
  `);

  const publicText =
    `✅ **Game Scheduled**\n` +
    `<@${offer.away_discord_id}> @ <@${offer.home_discord_id}>\n` +
    `**Confirmed Time:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`;

  const ch = interaction.channel;
  if (ch?.isTextBased()) await ch.send({ content: publicText }).catch(() => null);

  for (const uid of [offer.proposer_discord_id, offer.recipient_discord_id]) {
    const member = await interaction.guild?.members.fetch(uid).catch(() => null);
    await member?.send(publicText).catch(() => null);
  }

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Offer Accepted").setDescription("The confirmed schedule was posted publicly in the gameday channel.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function rejectOfferModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_reject:${offerId}`)
    .setTitle("Reject Scheduling Offer");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(true),
    ),
  );
  await interaction.showModal(modal);
}

async function handleRejectModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  const reason = interaction.fields.getTextInputValue("reason").trim();
  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set status = 'rejected', notes = coalesce(notes, '') || ${`\n\nRejected reason: ${reason}`}, updated_at = now()
    where id = ${offer.id}
  `);

  const member = await interaction.guild?.members.fetch(offer.proposer_discord_id).catch(() => null);
  await member?.send(`❌ Your scheduling offer for **${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}** was rejected.\n\n**Reason:** ${reason}`).catch(() => null);

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("❌ Offer Rejected").setDescription("The proposer was notified by DM.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function counterOfferModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_counter:${offerId}`)
    .setTitle("Counter Scheduling Offer");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("proposed_for").setLabel("Counter date/time").setPlaceholder("Example: Friday 9 PM CST").setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("proposed_tz").setLabel("Timezone").setPlaceholder("CST, EST, MST, PST, etc.").setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("notes").setLabel("Optional note").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false),
    ),
  );
  await interaction.showModal(modal);
}

async function handleCounterModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  await ensureGamedayTables();
  const original = await getOfferById(offerId);
  if (!original || original.recipient_discord_id !== ctx.userId || original.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  const activeCount = await countOffers(sql`
    guild_id = ${ctx.guildId}
    and season_id = ${ctx.season.id}
    and week_index = ${ctx.weekIndex}
    and matchup_key = ${ctx.matchupKey}
    and proposer_discord_id = ${ctx.userId}
    and status = 'pending'
  `);
  if (activeCount >= 3) {
    await interaction.reply({ ephemeral: true, content: "❌ You already have 3 active pending offers. Edit/delete one before countering." });
    return;
  }

  const proposedFor = interaction.fields.getTextInputValue("proposed_for").trim();
  const proposedTz = interaction.fields.getTextInputValue("proposed_tz").trim() || null;
  const notes = interaction.fields.getTextInputValue("notes").trim() || null;

  await executeOfferUpdate(sql`update gameday_schedule_offers set status = 'countered', updated_at = now() where id = ${original.id}`);

  await db.execute(sql`
    insert into gameday_schedule_offers (
      guild_id, season_id, week_index, matchup_key,
      proposer_discord_id, recipient_discord_id,
      away_discord_id, home_discord_id, away_team_name, home_team_name,
      proposed_for, proposed_tz, notes, status
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.userId}, ${ctx.opponentId},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName},
      ${proposedFor}, ${proposedTz}, ${notes}, 'pending'
    )
  `);

  const member = await interaction.guild?.members.fetch(ctx.opponentId).catch(() => null);
  await member?.send(`🔁 <@${ctx.userId}> countered with a new proposed game time:\n\n**${proposedFor}${proposedTz ? ` ${proposedTz}` : ""}**\n\nOpen \`/gameday\` to respond.`).catch(() => null);

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("🔁 Counter Sent").setDescription(`Counter sent to <@${ctx.opponentId}>.`)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function editOfferModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_edit:${offerId}`)
    .setTitle("Edit Scheduling Offer");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("proposed_for").setLabel("Proposed date/time").setValue(offer?.proposed_for ?? "").setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("proposed_tz").setLabel("Timezone").setValue(offer?.proposed_tz ?? "").setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("notes").setLabel("Optional note").setValue(offer?.notes ?? "").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false),
    ),
  );
  await interaction.showModal(modal);
}

async function handleEditModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  if (!offer || offer.proposer_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  const proposedFor = interaction.fields.getTextInputValue("proposed_for").trim();
  const proposedTz = interaction.fields.getTextInputValue("proposed_tz").trim() || null;
  const notes = interaction.fields.getTextInputValue("notes").trim() || null;

  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set proposed_for = ${proposedFor}, proposed_tz = ${proposedTz}, notes = ${notes}, updated_at = now()
    where id = ${offer.id}
  `);

  const member = await interaction.guild?.members.fetch(offer.recipient_discord_id).catch(() => null);
  await member?.send(`✏️ <@${ctx.userId}> edited a pending scheduling offer.\n\n**New Time:** ${proposedFor}${proposedTz ? ` ${proposedTz}` : ""}\n\nOpen \`/gameday\` to respond.`).catch(() => null);

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✏️ Offer Updated").setDescription("The opponent was notified by DM.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function deleteOffer(interaction: ButtonInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  const offer = await getOfferById(offerId);
  if (!offer || offer.proposer_discord_id !== ctx.userId || offer.status !== "pending") {
    await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." });
    return;
  }

  await executeOfferUpdate(sql`
    update gameday_schedule_offers
    set status = 'cancelled', updated_at = now()
    where id = ${offer.id}
  `);

  const member = await interaction.guild?.members.fetch(offer.recipient_discord_id).catch(() => null);
  await member?.send(`🗑️ <@${ctx.userId}> deleted a pending scheduling offer for **${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}**.`).catch(() => null);

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🗑️ Offer Deleted").setDescription("The pending offer has been cancelled.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}


async function showGameQueue(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const status = await getMatchupStatus(ctx);
  const isAway = ctx.userId === ctx.awayDiscordId;
  const meChecked = isAway ? status.away_checked_in : status.home_checked_in;
  const oppChecked = isAway ? status.home_checked_in : status.away_checked_in;
  const bothChecked = Boolean(status.away_checked_in && status.home_checked_in);

  const begunText = status.begun_at
    ? `Game marked begun by <@${status.begun_by}> at <t:${Math.floor(new Date(status.begun_at).getTime() / 1000)}:t>.`
    : "Game has not been marked begun yet.";

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(bothChecked ? Colors.Green : Colors.Orange)
        .setTitle("🎮 Game Queue")
        .setDescription([
          `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>`,
          `**Away check-in:** ${status.away_checked_in ? "✅ Checked in" : "❌ Not checked in"} ${ctx.awayDiscordId === ctx.userId ? "**(you)**" : ""}`,
          `**Home check-in:** ${status.home_checked_in ? "✅ Checked in" : "❌ Not checked in"} ${ctx.homeDiscordId === ctx.userId ? "**(you)**" : ""}`,
          `**Status:** ${begunText}`,
          "",
          bothChecked
            ? "Both users are checked in. Gameday actions are now unlocked."
            : "Both opponents must check in before search, invite, mark begun, or final score actions unlock.",
        ].join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_checkin").setLabel("✅ Check In").setStyle(ButtonStyle.Success).setDisabled(meChecked),
        new ButtonBuilder().setCustomId("gd_checkout").setLabel("↩️ Check Out").setStyle(ButtonStyle.Secondary).setDisabled(!meChecked),
        new ButtonBuilder().setCustomId("gd_msg_opp").setLabel("💬 Message Opponent").setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_advise_search").setLabel("🔎 Advise to Search").setStyle(ButtonStyle.Primary).setDisabled(!bothChecked),
        new ButtonBuilder().setCustomId("gd_request_invite").setLabel("🎮 Request Invite").setStyle(ButtonStyle.Primary).setDisabled(!bothChecked),
        new ButtonBuilder().setCustomId("gd_mark_begun").setLabel("▶️ Mark Game Begun").setStyle(ButtonStyle.Success).setDisabled(!bothChecked),
        new ButtonBuilder().setCustomId("gd_submit_final").setLabel("🏁 Submit Final").setStyle(ButtonStyle.Danger).setDisabled(!bothChecked),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function handleCheckIn(interaction: ButtonInteraction, ctx: GamedayContext, checkedIn: boolean): Promise<void> {
  await ensureMatchupStatus(ctx);
  const isAway = ctx.userId === ctx.awayDiscordId;
  if (isAway) {
    await db.execute(sql`
      update gameday_matchup_status
      set away_checked_in = ${checkedIn}, updated_at = now()
      where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
    `);
  } else {
    await db.execute(sql`
      update gameday_matchup_status
      set home_checked_in = ${checkedIn}, updated_at = now()
      where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
    `);
  }

  await dmOpponent(
    interaction,
    ctx,
    checkedIn
      ? `✅ <@${ctx.userId}> has checked in and is ready for your game.`
      : `↩️ <@${ctx.userId}> has checked out and is no longer marked ready.`,
  );

  const refreshed = await getMatchupStatus(ctx);
  const bothChecked = Boolean(refreshed?.away_checked_in && refreshed?.home_checked_in);

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(bothChecked ? Colors.Green : Colors.Orange)
        .setTitle(checkedIn ? "✅ Check-In Updated" : "↩️ Check-Out Updated")
        .setDescription([
          `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>`,
          `**Away check-in:** ${refreshed?.away_checked_in ? "✅ Checked in" : "❌ Not checked in"}`,
          `**Home check-in:** ${refreshed?.home_checked_in ? "✅ Checked in" : "❌ Not checked in"}`,
          "",
          bothChecked
            ? "Both users are checked in. Gameday actions are now unlocked."
            : "Waiting for both users to check in before gameday actions unlock.",
        ].join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_queue").setLabel("Refresh Game Queue").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}


async function requireBothCheckedIn(interaction: ButtonInteraction | ModalSubmitInteraction, ctx: GamedayContext): Promise<boolean> {
  const status = await getMatchupStatus(ctx);
  if (status?.away_checked_in && status?.home_checked_in) return true;

  const payload = {
    ephemeral: true,
    content: "❌ Both opponents must check in before this gameday action can be used.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_queue").setLabel("Open Game Queue").setStyle(ButtonStyle.Primary),
      ),
    ],
  };

  if ((interaction as any).isButton?.()) {
    await (interaction as ButtonInteraction).reply(payload).catch(() => null);
  } else {
    await (interaction as ModalSubmitInteraction).reply(payload).catch(() => null);
  }
  return false;
}

async function handleAdviseSearch(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  if (!(await requireBothCheckedIn(interaction, ctx))) return;

  await ensureMatchupStatus(ctx);
  await db.execute(sql`
    update gameday_matchup_status
    set search_advised_by = ${ctx.userId}, updated_at = now()
    where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
  `);
  await postPublic(interaction, `🔎 <@${ctx.opponentId}> — <@${ctx.userId}> is advising you to search **Play Game** in the franchise menu.`);
  await interaction.reply({ ephemeral: true, content: "✅ Public search notice posted." });
}

async function handleRequestInvite(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  if (!(await requireBothCheckedIn(interaction, ctx))) return;

  await ensureMatchupStatus(ctx);
  await db.execute(sql`
    update gameday_matchup_status
    set invite_requested_by = ${ctx.userId}, updated_at = now()
    where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
  `);
  await postPublic(interaction, `🎮 <@${ctx.opponentId}> — <@${ctx.userId}> is requesting that you send a game invite from the franchise menu.`);
  await interaction.reply({ ephemeral: true, content: "✅ Public invite request posted." });
}

async function showOpponentMessageModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("gd_modal_msg_opp")
    .setTitle("Message Opponent");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("message")
        .setLabel("Message")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(800),
    ),
  );

  await interaction.showModal(modal);
}

async function handleOpponentMessageModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  const message = interaction.fields.getTextInputValue("message").trim();
  await dmOpponent(interaction, ctx, `💬 Message from <@${ctx.userId}> about your matchup:\n\n${message}`);
  await interaction.reply({ ephemeral: true, content: "✅ Message sent to your opponent by DM." });
}

async function showMarkBegunModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("gd_modal_mark_begun")
    .setTitle("Mark Game Begun");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("stream_url")
        .setLabel("Stream URL (optional)")
        .setPlaceholder("https://twitch.tv/yourchannel or leave blank")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200),
    ),
  );

  await interaction.showModal(modal);
}

async function autoPayStreamIfEligible(interaction: ModalSubmitInteraction, ctx: GamedayContext, streamUrl: string): Promise<number> {
  if (!isValidHttpUrl(streamUrl)) return 0;

  const payout = await getPayoutValue(PAYOUT_KEYS.STREAM_PAYOUT, ctx.guildId);

  const existing = await db.execute(sql`
    select id
    from pending_channel_payouts
    where type = 'stream'
      and discord_id = ${ctx.userId}
      and season_id = ${ctx.season.id}
      and week = ${(ctx.season as any).currentWeek ?? "1"}
    limit 1
  `);
  const rows = ((existing as any).rows ?? existing) as any[];
  if (rows.length > 0) return 0;

  await db.execute(sql`
    insert into pending_channel_payouts (
      type, discord_id, amount, channel_id, message_id, guild_id, season_id, week,
      status, resolved_at, resolved_by
    )
    values (
      'stream', ${ctx.userId}, ${payout}, ${ctx.channelId}, 'gameday-start', ${ctx.guildId}, ${ctx.season.id}, ${(ctx.season as any).currentWeek ?? "1"},
      'approved', now(), 'bot:auto'
    )
  `);

  await addBalance(ctx.userId, payout, ctx.guildId);
  await logTransaction(ctx.userId, payout, "payout", `Auto stream payout — ${(ctx.season as any).currentWeek ?? "1"}`, ctx.guildId, "stream");
  return payout;
}

async function handleMarkBegunModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  if (!(await requireBothCheckedIn(interaction, ctx))) return;

  await ensureMatchupStatus(ctx);
  const rawUrl = interaction.fields.getTextInputValue("stream_url").trim();
  if (rawUrl && !isValidHttpUrl(rawUrl)) {
    await interaction.reply({ ephemeral: true, content: "❌ Invalid stream URL. Use a full valid URL starting with http:// or https://, or leave it blank." });
    return;
  }

  const paid = await autoPayStreamIfEligible(interaction, ctx, rawUrl);

  await db.execute(sql`
    update gameday_matchup_status
    set begun_by = ${ctx.userId},
        begun_at = coalesce(begun_at, now()),
        stream_url = case when ${rawUrl || null}::text is not null then ${rawUrl || null} else stream_url end,
        stream_paid_to = case when ${paid > 0 ? ctx.userId : null}::text is not null then ${paid > 0 ? ctx.userId : null} else stream_paid_to end,
        updated_at = now()
    where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
  `);

  await postPublic(
    interaction,
    `▶️ **Game Begun**\n<@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>\nMarked begun by <@${ctx.userId}>.${rawUrl ? `\n📺 Stream: ${rawUrl}` : ""}${paid > 0 ? `\n💰 Stream payout automatically issued: **${paid} coins**.` : ""}`,
  );

  await interaction.reply({
    ephemeral: true,
    content: `✅ Game marked as begun.${paid > 0 ? ` Stream payout issued: ${paid} coins.` : rawUrl ? " Stream was already paid or payout was unavailable." : ""}`,
  });
}


async function showSubmitFinalModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("gd_modal_submit_final")
    .setTitle("Submit Final Score");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("away_score")
        .setLabel("Away score")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("home_score")
        .setLabel("Home score")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3),
    ),
  );

  await interaction.showModal(modal);
}

function scoreWinner(ctx: GamedayContext, awayScore: number, homeScore: number): string | null {
  if (awayScore > homeScore) return ctx.awayDiscordId;
  if (homeScore > awayScore) return ctx.homeDiscordId;
  return null;
}

async function handleSubmitFinalModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  if (!(await requireBothCheckedIn(interaction, ctx))) return;

  await ensureGamedayTables();
  const status = await getMatchupStatus(ctx);
  if (!status?.begun_at) {
    await interaction.reply({ ephemeral: true, content: "❌ You must mark the game as begun before submitting a final score." });
    return;
  }

  const awayScore = Number(interaction.fields.getTextInputValue("away_score").trim());
  const homeScore = Number(interaction.fields.getTextInputValue("home_score").trim());
  if (!Number.isInteger(awayScore) || !Number.isInteger(homeScore) || awayScore < 0 || homeScore < 0) {
    await interaction.reply({ ephemeral: true, content: "❌ Scores must be valid non-negative whole numbers." });
    return;
  }

  const winnerDiscordId = scoreWinner(ctx, awayScore, homeScore);
  if (!winnerDiscordId) {
    await interaction.reply({ ephemeral: true, content: "❌ Ties cannot be submitted through this flow. Contact a commissioner if this is intentional." });
    return;
  }

  await db.execute(sql`
    update gameday_score_submissions
    set status = 'superseded', updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and status = 'pending'
  `);

  const result = await db.execute(sql`
    insert into gameday_score_submissions (
      guild_id, season_id, week_index, matchup_key,
      away_discord_id, home_discord_id, away_team_name, home_team_name,
      submitted_by, opponent_discord_id,
      away_score, home_score, winner_discord_id, status
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName},
      ${ctx.userId}, ${ctx.opponentId},
      ${awayScore}, ${homeScore}, ${winnerDiscordId}, 'pending'
    )
    returning id
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: number }>;
  const id = rows[0]?.id ?? 0;

  await dmOpponent(
    interaction,
    ctx,
    `🏁 <@${ctx.userId}> submitted a final score for **${ctx.awayTeamName} @ ${ctx.homeTeamName}**:\n\n` +
    `**${ctx.awayTeamName}: ${awayScore}**\n` +
    `**${ctx.homeTeamName}: ${homeScore}**\n\n` +
    `Open \`/gameday\` in the active gameday channel to approve or dispute it.`,
  );

  await interaction.reply({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("🏁 Final Score Submitted")
        .setDescription(`Score submission #${id} was sent to <@${ctx.opponentId}> for approval.`),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function getPendingScoreApproval(ctx: GamedayContext): Promise<any | null> {
  await ensureGamedayTables();
  const result = await db.execute(sql`
    select *
    from gameday_score_submissions
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and opponent_discord_id = ${ctx.userId}
      and status = 'pending'
    order by created_at desc
    limit 1
  `);
  const rows = ((result as any).rows ?? result) as any[];
  return rows[0] ?? null;
}

async function showScoreApproval(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const score = await getPendingScoreApproval(ctx);
  if (!score) {
    await updatePanel(interaction, {
      ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("🏁 Score Approval").setDescription("You do not have any pending score approvals.")],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
    });
    return;
  }

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`🏁 Score Approval #${score.id}`)
        .setDescription([
          `**Submitted by:** <@${score.submitted_by}>`,
          `**Matchup:** <@${score.away_discord_id}> @ <@${score.home_discord_id}>`,
          `**${score.away_team_name}:** ${score.away_score}`,
          `**${score.home_team_name}:** ${score.home_score}`,
          `**Winner:** <@${score.winner_discord_id}>`,
        ].join("\n")),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_score_approve:${score.id}`).setLabel("✅ Approve Score").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gd_score_dispute:${score.id}`).setLabel("⚠️ Dispute Score").setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function approveScore(interaction: ButtonInteraction, ctx: GamedayContext, scoreId: number): Promise<void> {
  const result = await db.execute(sql`
    select *
    from gameday_score_submissions
    where id = ${scoreId}
      and guild_id = ${ctx.guildId}
      and opponent_discord_id = ${ctx.userId}
      and status = 'pending'
    limit 1
  `);
  const rows = ((result as any).rows ?? result) as any[];
  const score = rows[0];
  if (!score) {
    await interaction.reply({ ephemeral: true, content: "❌ Score submission not found or no longer pending." });
    return;
  }

  await db.execute(sql`
    update gameday_score_submissions
    set status = 'approved', updated_at = now()
    where id = ${score.id}
  `);

  await db.execute(sql`
    update game_schedules
    set
      away_score = ${score.away_score},
      home_score = ${score.home_score},
      winner_discord_id = ${score.winner_discord_id},
      status = 'completed_pending_import',
      finished_at = coalesce(finished_at, now()),
      updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and (
           (away_discord_id = ${ctx.awayDiscordId} and home_discord_id = ${ctx.homeDiscordId})
        or (away_discord_id = ${ctx.homeDiscordId} and home_discord_id = ${ctx.awayDiscordId})
      )
  `);

  await postPublic(
    interaction,
    `🏁 **FINAL SUBMITTED & APPROVED**\n` +
    `<@${score.away_discord_id}> @ <@${score.home_discord_id}>\n` +
    `**${score.away_team_name}: ${score.away_score}**\n` +
    `**${score.home_team_name}: ${score.home_score}**\n` +
    `Winner: <@${score.winner_discord_id}>\n\n` +
    `Status: **Completed — pending EA import confirmation**.`,
  );

  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Score Approved").setDescription("The final score was publicly posted and marked completed pending import.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}

async function showDisputeScoreModal(interaction: ButtonInteraction, scoreId: number): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_score_dispute:${scoreId}`)
    .setTitle("Dispute Final Score");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason for dispute")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(800),
    ),
  );

  await interaction.showModal(modal);
}

async function handleDisputeScoreModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, scoreId: number): Promise<void> {
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const result = await db.execute(sql`
    select *
    from gameday_score_submissions
    where id = ${scoreId}
      and guild_id = ${ctx.guildId}
      and opponent_discord_id = ${ctx.userId}
      and status = 'pending'
    limit 1
  `);
  const rows = ((result as any).rows ?? result) as any[];
  const score = rows[0];
  if (!score) {
    await interaction.reply({ ephemeral: true, content: "❌ Score submission not found or no longer pending." });
    return;
  }

  await db.execute(sql`
    update gameday_score_submissions
    set status = 'disputed', dispute_reason = ${reason}, updated_at = now()
    where id = ${score.id}
  `);

  await postPublic(
    interaction,
    `⚠️ **FINAL SCORE DISPUTED**\n` +
    `<@${score.away_discord_id}> @ <@${score.home_discord_id}>\n` +
    `Submitted score: **${score.away_team_name} ${score.away_score} — ${score.home_team_name} ${score.home_score}**\n` +
    `Disputed by: <@${ctx.userId}>\n\n` +
    `Commissioners should review this result.`,
  );

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚠️ Score Disputed").setDescription("The dispute was posted publicly for commissioner review.")],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary))],
  });
}


async function showDelayApproveModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  if (!(await isCommissionerOrAdmin(interaction))) {
    await interaction.reply({ ephemeral: true, content: "❌ Only commissioners can approve advance delays." });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_delay_approve:${offerId}`)
    .setTitle("Approve Advance Delay");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("advance_at")
        .setLabel("New advance date/time")
        .setPlaceholder("Example: 2026-05-29 10:30 PM")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(40),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("timezone")
        .setLabel("Timezone: EST, CST, MST, PST, AKST, UTC")
        .setPlaceholder("CST")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6),
    ),
  );

  await interaction.showModal(modal);
}

function parseCommissionerDateTime(raw: string, tzKey: GamedayTzKey): Date | null {
  const cleaned = raw.trim().replace(/,/g, "");
  const m = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  let hour = Number(m[4]);
  const minute = Number(m[5] ?? "0");
  const ampm = m[6]?.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  const iso = `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  return localDateTimeToUtc(iso, `${pad2(hour)}:${pad2(minute)}`, tzKey);
}

async function handleDelayApproveModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  if (!(await isCommissionerOrAdmin(interaction))) {
    await interaction.reply({ ephemeral: true, content: "❌ Only commissioners can approve advance delays." });
    return;
  }

  const raw = interaction.fields.getTextInputValue("advance_at").trim();
  const tzRaw = interaction.fields.getTextInputValue("timezone").trim().toUpperCase();
  const tz = tzByKey(tzRaw);
  if (!tz) {
    await interaction.reply({ ephemeral: true, content: "❌ Invalid timezone. Use EST, CST, MST, PST, AKST, or UTC." });
    return;
  }

  const newAdvance = parseCommissionerDateTime(raw, tz.key);
  if (!newAdvance || newAdvance.getTime() <= Date.now()) {
    await interaction.reply({ ephemeral: true, content: "❌ Invalid date/time. Use format like `2026-05-29 10:30 PM` and make sure it is in the future." });
    return;
  }

  await db.execute(sql`
    update gameday_advance_overrides
    set status = 'replaced', updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and status = 'active'
  `);

  await db.execute(sql`
    insert into gameday_advance_overrides (
      guild_id, season_id, week_index, requested_by, approved_by,
      advance_at_utc, tz, reason, status
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.userId}, ${interaction.user.id},
      ${newAdvance.toISOString()}, ${tz.key}, ${`Approved late-game delay from offer #${offerId}`}, 'active'
    )
  `);

  await db.execute(sql`
    update gameday_commissioner_requests
    set status = 'approved', updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and request_type = 'advance_delay'
      and status = 'pending'
  `);

  await postPublic(
    interaction,
    `✅ **Advance Delay Approved**\n` +
    `Commissioner: <@${interaction.user.id}>\n` +
    `New advance time: <t:${Math.floor(newAdvance.getTime() / 1000)}:F>\n\n` +
    `All /gameday scheduling options now adjust to this updated deadline.`,
  );

  await interaction.reply({ ephemeral: true, content: "✅ Advance delay approved and scheduling deadline updated." });
}

async function denyDelay(interaction: ButtonInteraction, ctx: GamedayContext, offerId: number): Promise<void> {
  if (!(await isCommissionerOrAdmin(interaction))) {
    await interaction.reply({ ephemeral: true, content: "❌ Only commissioners can deny advance delays." });
    return;
  }

  await db.execute(sql`
    update gameday_commissioner_requests
    set status = 'denied', updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and request_type = 'advance_delay'
      and status = 'pending'
  `);

  await postPublic(
    interaction,
    `❌ **Advance Delay Denied**\n` +
    `Commissioner: <@${interaction.user.id}>\n` +
    `Delay request related to scheduling offer #${offerId} was denied. Current advance deadline remains in effect.`,
  );

  await interaction.reply({ ephemeral: true, content: "❌ Delay request denied." });
}

async function requestAssistance(interaction: ButtonInteraction, ctx: GamedayContext, type: "force_win" | "fair_sim" | "violation" | "contact_commish"): Promise<void> {
  const labels: Record<typeof type, string> = {
    force_win: "Force Win",
    fair_sim: "Fair Sim",
    violation: "Violation",
    contact_commish: "Commissioner Contact",
  };

  const modal = new ModalBuilder()
    .setCustomId(`gd_modal_assist:${type}`)
    .setTitle(labels[type]);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason / details")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000),
    ),
  );

  await interaction.showModal(modal);
}

async function handleAssistModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, type: string): Promise<void> {
  const reason = interaction.fields.getTextInputValue("reason").trim();
  await db.execute(sql`
    insert into gameday_commissioner_requests (
      guild_id, season_id, week_index, matchup_key, request_type,
      requested_by, opponent_discord_id, reason, status
    )
    values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, ${type},
      ${ctx.userId}, ${ctx.opponentId}, ${reason}, 'pending'
    )
  `);

  const commissionerMention = commissionerRoleMention(interaction);
  await postPublic(
    interaction,
    `🚨 **${type.replace(/_/g, " ").toUpperCase()} REQUEST**\n${commissionerMention}\n\n` +
    `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>\n` +
    `**Submitted by:** <@${ctx.userId}>\n` +
    `**Opponent notified:** <@${ctx.opponentId}>\n\n` +
    `Commissioners should review this request in the gameday channel/context.`,
  );

  await dmOpponent(interaction, ctx, `🚨 <@${ctx.userId}> submitted a **${type.replace(/_/g, " ")}** request for your matchup. Commissioners have been notified.`);
  await interaction.reply({ ephemeral: true, content: "✅ Request submitted and commissioners were tagged publicly." });
}

async function showAssistance(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await updatePanel(interaction, {
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🚨 Gameday Assistance")
        .setDescription("Choose the type of commissioner assistance needed."),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_req_fw").setLabel("🏳️ Request Force Win").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("gd_req_fs").setLabel("⚖️ Request Fair Sim").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("gd_req_violation").setLabel("🚫 Flag Violation").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("gd_contact_commish").setLabel("📣 Contact Commissioner").setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

export async function handleGamedayInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("gd_")) return false;

  const shouldDefer =
    interaction.isStringSelectMenu() ||
    (interaction.isButton() && (
      interaction.customId.startsWith("gd_sched_") ||
      interaction.customId === "gd_offer_confirm" ||
      interaction.customId === "gd_schedule" ||
      interaction.customId === "gd_pending" ||
      interaction.customId === "gd_manage_offers" ||
      interaction.customId === "gd_queue" ||
      interaction.customId === "gd_score_pending" ||
      interaction.customId === "gd_assist" ||
      interaction.customId === "gd_refresh"
    ));

  if (shouldDefer && !(interaction as any).deferred && !(interaction as any).replied) {
    await interaction.deferUpdate().catch(() => null);
  }

  const ctx = await getContext(interaction);
  if (!ctx) return true;

  if (interaction.isButton()) {
    if (interaction.customId === "gd_refresh") { await renderDashboard(interaction, ctx); return true; }
    if (interaction.customId === "gd_schedule") { await showScheduleMenu(interaction, ctx); return true; }
    if (interaction.customId === "gd_offer_new") { await showNewOfferModal(interaction, ctx); return true; }
    if (interaction.customId === "gd_sched_back_day") { await showDaySelect(interaction, ctx); return true; }
    if (interaction.customId === "gd_sched_back_time") { await showTimeSelect(interaction, ctx); return true; }
    if (interaction.customId === "gd_sched_note") { await showOfferNoteModal(interaction); return true; }
    if (interaction.customId === "gd_offer_confirm") { await sendGuidedOffer(interaction, ctx); return true; }
    if (interaction.customId.startsWith("gd_sched_time_page:")) { await showTimeSelect(interaction, ctx, Number(interaction.customId.split(":")[1] ?? "0")); return true; }
    if (interaction.customId === "gd_pending") { await showPendingOffers(interaction, ctx); return true; }
    if (interaction.customId === "gd_manage_offers") { await showManageOffers(interaction, ctx); return true; }
    if (interaction.customId === "gd_queue") { await showGameQueue(interaction, ctx); return true; }
    if (interaction.customId === "gd_checkin") { await handleCheckIn(interaction, ctx, true); return true; }
    if (interaction.customId === "gd_checkout") { await handleCheckIn(interaction, ctx, false); return true; }
    if (interaction.customId === "gd_advise_search") { await handleAdviseSearch(interaction, ctx); return true; }
    if (interaction.customId === "gd_request_invite") { await handleRequestInvite(interaction, ctx); return true; }
    if (interaction.customId === "gd_msg_opp") { await showOpponentMessageModal(interaction); return true; }
    if (interaction.customId === "gd_mark_begun") { if (!(await requireBothCheckedIn(interaction, ctx))) return true; await showMarkBegunModal(interaction); return true; }
    if (interaction.customId === "gd_submit_final") { if (!(await requireBothCheckedIn(interaction, ctx))) return true; await showSubmitFinalModal(interaction); return true; }
    if (interaction.customId === "gd_score_pending") { await showScoreApproval(interaction, ctx); return true; }
    if (interaction.customId === "gd_assist") { await showAssistance(interaction, ctx); return true; }
    if (interaction.customId === "gd_req_fw") { await requestAssistance(interaction, ctx, "force_win"); return true; }
    if (interaction.customId === "gd_req_fs") { await requestAssistance(interaction, ctx, "fair_sim"); return true; }
    if (interaction.customId === "gd_req_violation") { await requestAssistance(interaction, ctx, "violation"); return true; }
    if (interaction.customId === "gd_contact_commish") { await requestAssistance(interaction, ctx, "contact_commish"); return true; }
    if (interaction.customId.startsWith("gd_delay_approve:")) { await showDelayApproveModal(interaction, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_delay_deny:")) { await denyDelay(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }

    if (interaction.customId.startsWith("gd_score_approve:")) { await approveScore(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_score_dispute:")) { await showDisputeScoreModal(interaction, Number(interaction.customId.split(":")[1])); return true; }

    if (interaction.customId.startsWith("gd_offer_accept:")) { await acceptOffer(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_offer_reject:")) { await rejectOfferModal(interaction, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_offer_counter:")) { await counterOfferModal(interaction, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_offer_edit:")) { await editOfferModal(interaction, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_offer_delete:")) { await deleteOffer(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }

    await interaction.reply({ ephemeral: true, content: "❌ Unknown or expired gameday action. Reopen `/gameday` and try again." });
    return true;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "gd_sched_tz") { setScheduleDraft(ctx, { tz: interaction.values[0] as GamedayTzKey, dayIso: undefined, time: undefined }); await showDaySelect(interaction, ctx); return true; }
    if (interaction.customId === "gd_sched_day") { setScheduleDraft(ctx, { dayIso: interaction.values[0], time: undefined }); await showTimeSelect(interaction, ctx); return true; }
    if (interaction.customId === "gd_sched_time") { setScheduleDraft(ctx, { time: interaction.values[0] }); await showOfferConfirm(interaction, ctx); return true; }
    if (interaction.customId === "gd_pending_select") { await showPendingOfferDetail(interaction, ctx); return true; }
    if (interaction.customId === "gd_manage_select") { await showManageOfferDetail(interaction, ctx); return true; }
    return true;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "gd_modal_offer_new") { await handleNewOfferModal(interaction, ctx); return true; }
    if (interaction.customId === "gd_modal_offer_note") { await handleOfferNoteModal(interaction, ctx); return true; }
    if (interaction.customId.startsWith("gd_modal_delay_approve:")) { await handleDelayApproveModal(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_modal_assist:")) { await handleAssistModal(interaction, ctx, interaction.customId.split(":")[1] ?? "contact_commish"); return true; }
    if (interaction.customId === "gd_modal_msg_opp") { await handleOpponentMessageModal(interaction, ctx); return true; }
    if (interaction.customId === "gd_modal_mark_begun") { await handleMarkBegunModal(interaction, ctx); return true; }
    if (interaction.customId === "gd_modal_submit_final") { await handleSubmitFinalModal(interaction, ctx); return true; }
    if (interaction.customId.startsWith("gd_modal_score_dispute:")) { await handleDisputeScoreModal(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_modal_reject:")) { await handleRejectModal(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_modal_counter:")) { await handleCounterModal(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    if (interaction.customId.startsWith("gd_modal_edit:")) { await handleEditModal(interaction, ctx, Number(interaction.customId.split(":")[1])); return true; }
    return true;
  }

  return true;
}
