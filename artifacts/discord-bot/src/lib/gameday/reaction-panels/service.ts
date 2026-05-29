import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Colors,
  EmbedBuilder,
  Guild,
  Message,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  User,
  ButtonInteraction,
  ModalSubmitInteraction,
  MessageReaction,
  ComponentType,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable,
  franchiseMcaTeamsTable,
  usersTable,
  pendingChannelPayoutsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getOrCreateActiveSeason, getScheduleSeasonId, getGuildChannel, setGuildChannel, addBalance } from "../../db/db-helpers.js";
import { getServerSettings } from "../../db/server-settings.js";
import { formatAllZones, nextAdvanceDeadline } from "../../discord/timezones.js";
import { getPayoutValue, PAYOUT_KEYS } from "../../economy/payout-config.js";
import { renderCommissionerGamedayReview } from "../commissioner-gameday-review.js";

export const PANEL_EMOJIS = ["🕒", "✅", "🔎", "✉️", "🔄", "📺", "🇼", "🇸", "⚠️", "🔚"] as const;
export const COMMISSIONER_EMOJIS = ["⚙️", "🕒", "📣", "📬", "🔁", "🧹"] as const;
export const CPU_EMOJIS = ["📺"] as const;
const TZ_CODES = ["EST", "CST", "MST", "PST", "AKST", "HST"] as const;
type TzCode = typeof TZ_CODES[number];

const STAFF_ROLE_RE = /commissioner|co[-\s]?commissioner|commish|league\s*architect|competition\s*council/i;
const MEMBER_ROLE_RE = /approved\s*member|locker\s*room\s*approved/i;

function staffRoles(guild: Guild) {
  return guild.roles.cache.filter((r) => STAFF_ROLE_RE.test(r.name));
}

function staffRoleMentions(guild: Guild): string {
  const roles = staffRoles(guild);
  return roles.size ? roles.map((r) => `<@&${r.id}>`).join(" ") : "League Architect / Competition Council";
}

async function memberHasStaffRole(guild: Guild, userId: string): Promise<boolean> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((r) => STAFF_ROLE_RE.test(r.name));
}


type ScheduleGame = typeof franchiseScheduleTable.$inferSelect & { awayDiscordId?: string; homeDiscordId?: string };

type PanelRow = {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  panel_type: string;
  rec_game_id: number | null;
  game_schedule_id: number | null;
  season_id: number;
  week_index: number;
  matchup_key: string | null;
  away_discord_id: string | null;
  home_discord_id: string | null;
  away_team_name: string | null;
  home_team_name: string | null;
  state_json: any;
};

function simpleTeamKey(teamName: string): string { return teamName.toLowerCase().trim(); }
function matchupKey(a: string, b: string): string { return [a, b].sort().join(":"); }
function formatTeamLine(discordId: string | null | undefined, team: string | null | undefined): string {
  return discordId ? `<@${discordId}> — ${team ?? "Unknown Team"}` : `CPU — ${team ?? "Unknown Team"}`;
}
function safeState(row?: Partial<PanelRow> | null): any { return row?.state_json && typeof row.state_json === "object" ? row.state_json : {}; }
function nowIso(): string { return new Date().toISOString(); }

function zoneFor(code: TzCode): string {
  return ({ EST: "America/New_York", CST: "America/Chicago", MST: "America/Denver", PST: "America/Los_Angeles", AKST: "America/Anchorage", HST: "Pacific/Honolulu" } as Record<TzCode,string>)[code];
}
function fmtDate(date: Date, tz: TzCode): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zoneFor(tz), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}
function formatAllSixZones(date: Date): string { return TZ_CODES.map((z) => `• **${z}** — ${fmtDate(date, z)}`).join("\n"); }
function selectedTimeBlock(date: Date, tz: TzCode): string { return `**Selected Time:**\n${fmtDate(date, tz)} ${tz}\n\n**Converted:**\n${formatAllSixZones(date)}`; }
function parseChosenDate(dayOffset: number, minute: number, tz: TzCode): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zoneFor(tz), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const baseY = Number(get("year")); const baseM = Number(get("month")); const baseD = Number(get("day"));
  const localUTC = new Date(Date.UTC(baseY, baseM - 1, baseD + dayOffset, Math.floor(minute / 60), minute % 60));
  const zoneHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zoneFor(tz), hour: "2-digit", hour12: false }).format(localUTC));
  const zoneMin = Number(new Intl.DateTimeFormat("en-US", { timeZone: zoneFor(tz), minute: "2-digit" }).format(localUTC));
  let delta = minute - (zoneHour * 60 + zoneMin);
  if (delta > 720) delta -= 1440;
  if (delta < -720) delta += 1440;
  return new Date(localUTC.getTime() + delta * 60000);
}
function dateOptions(): StringSelectMenuOptionBuilder[] {
  const out: StringSelectMenuOptionBuilder[] = [];
  const now = new Date();
  for (let d=0; d<=7; d++) {
    const date = new Date(now.getTime() + d * 86400000);
    const label = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
    out.push(new StringSelectMenuOptionBuilder().setLabel(d === 0 ? `Today — ${label}` : d === 1 ? `Tomorrow — ${label}` : label).setValue(String(d)));
  }
  return out;
}
function timeWindowOptions(): StringSelectMenuOptionBuilder[] {
  return [
    new StringSelectMenuOptionBuilder().setLabel("Morning / Afternoon").setDescription("12:00 AM – 11:30 AM").setValue("am"),
    new StringSelectMenuOptionBuilder().setLabel("Evening / Night").setDescription("12:00 PM – 11:30 PM").setValue("pm"),
  ];
}
function exactTimeOptions(window: string, dayOffset = 0, tz: TzCode = "CST"): StringSelectMenuOptionBuilder[] {
  const start = window === "am" ? 0 : 12 * 60;
  const end = window === "am" ? 11 * 60 + 30 : 23 * 60 + 30;
  const out: StringSelectMenuOptionBuilder[] = [];
  const now = Date.now();
  for (let m=start; m<=end; m+=30) {
    const dt = parseChosenDate(dayOffset, m, tz);
    if (dayOffset === 0 && dt.getTime() <= now) continue;
    const hr = Math.floor(m/60); const min = m % 60;
    const hour12 = ((hr + 11) % 12) + 1; const ampm = hr < 12 ? "AM" : "PM";
    out.push(new StringSelectMenuOptionBuilder().setLabel(`${hour12}:${String(min).padStart(2,"0")} ${ampm}`).setValue(String(m)));
  }
  return out.slice(0,25);
}
function timezoneOptions(defaultTz?: string | null): StringSelectMenuOptionBuilder[] {
  return TZ_CODES.map((z) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(defaultTz === z ? `${z} (current default)` : z)
      .setValue(z)
      .setDescription(defaultTz === z ? "Select this to keep your current default timezone." : "Select this timezone for the proposed time."),
  );
}

async function rowsOf<T=any>(query: any): Promise<T[]> { const r = await db.execute(query); return ((r as any).rows ?? r) as T[]; }
async function oneOf<T=any>(query: any): Promise<T | null> { const rows = await rowsOf<T>(query); return rows[0] ?? null; }

async function memberIsCommissioner(guild: Guild, userId: string): Promise<boolean> {
  return memberHasStaffRole(guild, userId);
}
function commissionerRoleMentions(guild: Guild): string {
  return staffRoleMentions(guild);
}
async function guildDisplayName(guildId: string, fallback?: string | null): Promise<string> {
  const row = await oneOf<{ display_name?: string; guild_id: string }>(sql`select display_name, guild_id from rec_leagues where guild_id = ${guildId} limit 1`).catch(() => null);
  return row?.display_name || fallback || `Server ${guildId}`;
}
async function userNick(guildId: string, discordId: string): Promise<string> {
  const row = await oneOf<{ server_nickname?: string; discord_username?: string; team?: string }>(sql`select server_nickname, discord_username, team from economy_users where guild_id = ${guildId} and discord_id = ${discordId} limit 1`);
  return row?.server_nickname || row?.discord_username || `<@${discordId}>`;
}

export async function ensureReactionGamedaySchema(): Promise<void> {
  await db.execute(sql`
    create table if not exists gameday_matchup_panels (
      id serial primary key,
      guild_id text not null,
      channel_id text not null,
      message_id text not null unique,
      panel_type text not null,
      rec_game_id bigint,
      game_schedule_id integer,
      season_id integer not null,
      week_index integer not null,
      matchup_key text,
      away_discord_id text,
      home_discord_id text,
      away_team_name text,
      home_team_name text,
      state_json jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await db.execute(sql`
    create table if not exists user_gameday_preferences (
      discord_id text primary key,
      default_timezone text not null default 'CST',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await db.execute(sql`alter table gameday_schedule_offers add column if not exists four_hour_reminder_sent_at timestamptz`);
  await db.execute(sql`alter table gameday_schedule_offers add column if not exists eight_hour_notice_sent_at timestamptz`);
  await db.execute(sql`alter table gameday_schedule_offers add column if not exists fw_eligible_at timestamptz`);
  await db.execute(sql`create index if not exists gameday_matchup_panels_message_idx on gameday_matchup_panels(message_id)`);
  await db.execute(sql`create index if not exists gameday_matchup_panels_lookup_idx on gameday_matchup_panels(guild_id, season_id, week_index, matchup_key)`);
  await db.execute(sql`create index if not exists gameday_schedule_offers_pending_notice_idx on gameday_schedule_offers(status, created_at, four_hour_reminder_sent_at, eight_hour_notice_sent_at)`);
}

async function setUserTz(discordId: string, tz: TzCode) {
  await db.execute(sql`
    insert into user_gameday_preferences (discord_id, default_timezone, updated_at)
    values (${discordId}, ${tz}, now())
    on conflict (discord_id) do update set default_timezone = excluded.default_timezone, updated_at = now()
  `);
}
async function getUserTz(discordId: string): Promise<TzCode> {
  const row = await oneOf<{ default_timezone: string }>(sql`select default_timezone from user_gameday_preferences where discord_id = ${discordId}`);
  return (TZ_CODES as readonly string[]).includes(row?.default_timezone ?? "") ? row!.default_timezone as TzCode : "CST";
}

async function resolveScheduleGames(guildId: string, weekNum: number): Promise<{ season: any; weekIndex: number; games: ScheduleGame[]; h2h: ScheduleGame[]; cpu: ScheduleGame[]; byeUsers: Array<{discordId:string; team:string}>; }> {
  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = weekNum <= 18 ? weekNum - 1 : ({19:1018,20:1019,21:1020,22:1022} as any)[weekNum] ?? -1;
  const schedSeasonId = await getScheduleSeasonId(guildId);
  const games = await db.select().from(franchiseScheduleTable).where(and(eq(franchiseScheduleTable.seasonId, schedSeasonId), eq(franchiseScheduleTable.weekIndex, weekIndex))) as ScheduleGame[];
  const [mcaTeams, allUsers] = await Promise.all([
    db.select({ fullName: franchiseMcaTeamsTable.fullName, nickName: franchiseMcaTeamsTable.nickName, discordId: franchiseMcaTeamsTable.discordId }).from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.seasonId, schedSeasonId)),
    db.select({ discordId: usersTable.discordId, team: usersTable.team }).from(usersTable).where(eq(usersTable.guildId, guildId)),
  ]);
  const teamToDiscord = new Map<string,string>();
  for (const t of mcaTeams) { if (t.discordId && !t.discordId.startsWith("unlinked_")) { teamToDiscord.set(simpleTeamKey(t.fullName), t.discordId); teamToDiscord.set(simpleTeamKey(t.nickName), t.discordId); } }
  for (const u of allUsers) { if (u.discordId && u.team && !u.discordId.startsWith("unlinked_") && !teamToDiscord.has(simpleTeamKey(u.team))) teamToDiscord.set(simpleTeamKey(u.team), u.discordId); }
  const hydrated = games.map((g) => ({ ...g, awayDiscordId: teamToDiscord.get(simpleTeamKey(g.awayTeamName)), homeDiscordId: teamToDiscord.get(simpleTeamKey(g.homeTeamName)) }));
  const h2h = hydrated.filter((g) => g.awayDiscordId && g.homeDiscordId);
  const cpu = hydrated.filter((g) => Boolean(g.awayDiscordId) !== Boolean(g.homeDiscordId));
  const activeIds = new Set(hydrated.flatMap((g) => [g.awayDiscordId, g.homeDiscordId]).filter(Boolean) as string[]);
  const byeUsers = allUsers.filter((u) => u.discordId && !u.discordId.startsWith("unlinked_") && u.team && !activeIds.has(u.discordId)).map((u) => ({ discordId: u.discordId, team: u.team! }));
  return { season, weekIndex, games: hydrated, h2h, cpu, byeUsers };
}

function h2hEmbed(row: Partial<PanelRow>, state: any, displayLabel?: string): EmbedBuilder {
  const away = formatTeamLine(row.away_discord_id, row.away_team_name);
  const home = formatTeamLine(row.home_discord_id, row.home_team_name);
  const e = new EmbedBuilder().setColor(Colors.Blurple).setTitle("🏈 H2H Matchup Control Panel")
    .setDescription(`${displayLabel ?? `Week ${row.week_index}`}\n\n**Away:**\n${away}\n\n**Home:**\n${home}`);
  const fields: {name:string; value:string; inline?:boolean}[] = [];
  const schedule = state.schedule;
  if (schedule?.status === "accepted") fields.push({ name: "Schedule", value: `✅ ${schedule.label}\n${schedule.converted ?? ""}`.slice(0,1024) });
  else if (schedule?.status === "pending") fields.push({ name: "Schedule", value: `⏳ Pending offer from <@${schedule.from}>\n${schedule.label}\nWaiting on <@${schedule.to}>.` });
  else if (schedule?.status === "reminder") fields.push({ name: "Schedule", value: "⚠️ Reminder sent — no accepted schedule yet." });
  else fields.push({ name: "Schedule", value: "❌ Not scheduled" });
  if (state.checkins && Object.keys(state.checkins).length) fields.push({ name: "Check-In", value: `${row.away_discord_id ? `<@${row.away_discord_id}> ${state.checkins[row.away_discord_id] ? "✅" : "❌"}` : ""}\n${row.home_discord_id ? `<@${row.home_discord_id}> ${state.checkins[row.home_discord_id] ? "✅" : "❌"}` : ""}`.trim() });
  if (state.ready) fields.push({ name: "Ready/Search", value: state.ready });
  if (state.stream) fields.push({ name: "Stream", value: state.stream });
  if (state.requests) fields.push({ name: "Requests", value: state.requests.slice(0,1024) });
  if (state.ended && Object.keys(state.ended).length) fields.push({ name: "Game Ended", value: `${row.away_discord_id ? `<@${row.away_discord_id}> ${state.ended[row.away_discord_id] ? "✅" : "❌"}` : ""}\n${row.home_discord_id ? `<@${row.home_discord_id}> ${state.ended[row.home_discord_id] ? "✅" : "❌"}` : ""}`.trim() });
  fields.push({ name: "Emoji Key", value: "🕒 Schedule / Reschedule\n✅ Check in\n🔎 Ready to search\n✉️ Request invite\n🔄 Retry search\n📺 Submit stream link\n🇼 Request Force Win\n🇸 Request Fair Sim\n⚠️ Report issue\n🔚 Mark game ended" });
  e.addFields(fields);
  return e;
}

async function updatePanel(row: PanelRow, state: any, reason?: string): Promise<void> {
  await db.execute(sql`update gameday_matchup_panels set state_json = ${JSON.stringify(state)}::jsonb, updated_at = now() where id = ${row.id}`);
  const client = (globalThis as any).__recDiscordClient;
  const ch = client?.channels ? await client.channels.fetch(row.channel_id).catch(() => null) : null;
  const msg = ch?.isTextBased?.() ? await (ch as TextChannel).messages.fetch(row.message_id).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [h2hEmbed(row, state, reason)] }).catch(() => null);
}

async function addReactions(msg: Message, emojis: readonly string[]) { for (const e of emojis) await msg.react(e).catch(() => null); }

async function storePanel(data: Omit<PanelRow,"id"|"state_json"> & { state_json?: any }) {
  await db.execute(sql`
    insert into gameday_matchup_panels (guild_id, channel_id, message_id, panel_type, rec_game_id, game_schedule_id, season_id, week_index, matchup_key, away_discord_id, home_discord_id, away_team_name, home_team_name, state_json)
    values (${data.guild_id}, ${data.channel_id}, ${data.message_id}, ${data.panel_type}, ${data.rec_game_id}, ${data.game_schedule_id}, ${data.season_id}, ${data.week_index}, ${data.matchup_key}, ${data.away_discord_id}, ${data.home_discord_id}, ${data.away_team_name}, ${data.home_team_name}, ${JSON.stringify(data.state_json ?? {})}::jsonb)
    on conflict (message_id) do update set state_json = excluded.state_json, updated_at = now()
  `);
}

export async function createReactionBasedGamedayChannel(args: { guild: Guild; guildId: string; weekNum: number; categoryId?: string | null; deletePrevious?: boolean; }): Promise<{channelId:string; channelUrl?:string; h2hCount:number; totalGames:number; deletedPrevious:boolean; displayLabel:string;}> {
  await ensureReactionGamedaySchema();
  const { guild, guildId, weekNum, categoryId = null, deletePrevious = true } = args;
  const { season, weekIndex, games, h2h, cpu, byeUsers } = await resolveScheduleGames(guildId, weekNum);
  if (!games.length) throw new Error(`No schedule data found for week ${weekNum}.`);
  const displayLabel = weekNum > 18 ? `Season ${season.seasonNumber} — Playoffs ${weekNum}` : `Season ${season.seasonNumber} — Week ${weekNum}`;
  let deletedPrevious = false;
  if (deletePrevious) {
    const prev = await getGuildChannel(guildId, "gameday_active" as any).catch(() => null);
    if (prev) { const ch = await guild.channels.fetch(prev).catch(() => null); if (ch) { await ch.delete("Weekly advance — replacing active gameday channel").catch(() => null); deletedPrevious = true; } }
  }
  const commissionerRoles = staffRoles(guild);
  const everyone = guild.roles.everyone;
  const overwrites: any[] = [
    { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions], deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.AttachFiles] },
    { id: guild.client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions] },
  ];
  for (const r of commissionerRoles.values()) overwrites.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions] });
  const name = `${weekNum > 18 ? `playoffs-${weekNum}` : `week-${weekNum}`}-gameday`;
  const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: categoryId ?? undefined, topic: "Reaction-based gameday dashboard. Users react to bot panels; only commissioners and the bot can send messages.", permissionOverwrites: overwrites }) as TextChannel;
  await setGuildChannel(guildId, "gameday_active" as any, channel.id);
  if (categoryId) await setGuildChannel(guildId, "gameday_category" as any, categoryId);
  await db.execute(sql`delete from gameday_matchup_panels where guild_id = ${guildId} and season_id = ${season.id} and week_index = ${weekIndex}`);

  const settings = await getServerSettings(guildId);
  const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
  const comm = await channel.send({ embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle("🛠 Commissioner Gameday Controls").setDescription("Commissioners only.\n\n⚙️ Commissioner Review\n🕒 Update Next Advance Time\n📣 Post Advance Reminder\n📬 DM Unscheduled H2H Users\n🔁 Regenerate Gameday Panels\n🧹 Cleanup Stale Gameday State").addFields({ name: "Next Advance", value: formatAllZones(deadline) })] });
  await addReactions(comm, COMMISSIONER_EMOJIS);
  await storePanel({ guild_id:guildId, channel_id:channel.id, message_id:comm.id, panel_type:"commissioner", rec_game_id:null, game_schedule_id:null, season_id:season.id, week_index:weekIndex, matchup_key:null, away_discord_id:null, home_discord_id:null, away_team_name:null, home_team_name:null, state_json:{} });
  if (cpu.length) {
    const lines = cpu.map((g) => {
      const uid = g.awayDiscordId ?? g.homeDiscordId!; const userTeam = g.awayDiscordId ? g.awayTeamName : g.homeTeamName; const cpuTeam = g.awayDiscordId ? g.homeTeamName : g.awayTeamName;
      return `<@${uid}> — ${userTeam} vs CPU ${cpuTeam}`;
    }).join("\n");
    const msg = await channel.send({ embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🖥 CPU Matchups").setDescription(`${lines}\n\nCPU games may be streamed for payout eligibility. If a CPU game is not played before advance, the default CPU force-win policy applies.\n\n📺 Submit stream link`)] });
    await addReactions(msg, CPU_EMOJIS);
    await storePanel({ guild_id:guildId, channel_id:channel.id, message_id:msg.id, panel_type:"cpu_summary", rec_game_id:null, game_schedule_id:null, season_id:season.id, week_index:weekIndex, matchup_key:null, away_discord_id:null, home_discord_id:null, away_team_name:null, home_team_name:null, state_json:{ allowedUsers: cpu.map((g)=>g.awayDiscordId ?? g.homeDiscordId).filter(Boolean) } });
  }
  if (byeUsers.length) await channel.send({ embeds: [new EmbedBuilder().setColor(Colors.DarkGrey).setTitle("🌙 Bye Week").setDescription(byeUsers.map((u)=>`<@${u.discordId}> — ${u.team}`).join("\n") + "\n\nNo game action is required this week.")] });
  for (const g of h2h) {
    const mkey = matchupKey(g.awayDiscordId!, g.homeDiscordId!);
    const base: Partial<PanelRow> = { guild_id:guildId, channel_id:channel.id, panel_type:"h2h", game_schedule_id:null, season_id:season.id, week_index:weekIndex, matchup_key:mkey, away_discord_id:g.awayDiscordId!, home_discord_id:g.homeDiscordId!, away_team_name:g.awayTeamName, home_team_name:g.homeTeamName };
    const msg = await channel.send({ content: `<@${g.awayDiscordId}> <@${g.homeDiscordId}>`, embeds: [h2hEmbed(base, {}, displayLabel)], allowedMentions: { users: [g.awayDiscordId!, g.homeDiscordId!] } });
    await addReactions(msg, PANEL_EMOJIS);
    await storePanel({ ...(base as any), message_id:msg.id, rec_game_id:null, state_json:{} });
  }
  return { channelId: channel.id, channelUrl: channel.url, h2hCount: h2h.length, totalGames: games.length, deletedPrevious, displayLabel };
}

async function panelForMessage(messageId: string): Promise<PanelRow | null> { await ensureReactionGamedaySchema(); return oneOf<PanelRow>(sql`select * from gameday_matchup_panels where message_id = ${messageId} limit 1`); }
function isParticipant(row: PanelRow, userId: string): boolean { return row.away_discord_id === userId || row.home_discord_id === userId; }
function opponent(row: PanelRow, userId: string): string | null { if (row.away_discord_id === userId) return row.home_discord_id; if (row.home_discord_id === userId) return row.away_discord_id; return null; }
async function dm(user: User, content: string, components?: any[]) { await user.send({ content, components }).catch(() => null); }

async function showSchedulingDm(user: User, row: PanelRow) {
  const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_action:${row.id}`).setPlaceholder("Choose scheduling action…").addOptions([
    new StringSelectMenuOptionBuilder().setLabel("Send New Time").setValue("new"),
    new StringSelectMenuOptionBuilder().setLabel("View Pending Offers (#)").setDescription("Review offers received, sent, edit, or delete").setValue("pending"),
    new StringSelectMenuOptionBuilder().setLabel("Reschedule Accepted Time").setValue("reschedule"),
    new StringSelectMenuOptionBuilder().setLabel("Cancel").setValue("cancel"),
  ]);
  await dm(user, `🕒 **Schedule Your Game**\n\n${formatTeamLine(row.away_discord_id, row.away_team_name)}\nvs\n${formatTeamLine(row.home_discord_id, row.home_team_name)}\n\nWhat do you want to do?`, [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)]);
}
async function showIssueDm(user: User, row: PanelRow) {
  const menu = new StringSelectMenuBuilder().setCustomId(`rgd_issue:${row.id}`).setPlaceholder("What issue are you reporting?").addOptions([
    new StringSelectMenuOptionBuilder().setLabel("Opponent dashed").setValue("dashed"),
    new StringSelectMenuOptionBuilder().setLabel("Desync").setValue("desync"),
    new StringSelectMenuOptionBuilder().setLabel("Connection issue").setValue("connection"),
    new StringSelectMenuOptionBuilder().setLabel("Rules violation").setValue("violation"),
  ]);
  await dm(user, "⚠️ **Report Issue**\nChoose the issue you need to report.", [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)]);
}
async function showFwDm(user: User, row: PanelRow) {
  const aNick = row.away_discord_id ? await userNick(row.guild_id, row.away_discord_id) : "Away";
  const hNick = row.home_discord_id ? await userNick(row.guild_id, row.home_discord_id) : "Home";
  const menu = new StringSelectMenuBuilder().setCustomId(`rgd_fw_for:${row.id}`).setPlaceholder("Who should receive the Force Win?").addOptions([
    new StringSelectMenuOptionBuilder().setLabel(aNick.slice(0,100)).setDescription(row.away_team_name ?? "Away").setValue(row.away_discord_id ?? "away"),
    new StringSelectMenuOptionBuilder().setLabel(hNick.slice(0,100)).setDescription(row.home_team_name ?? "Home").setValue(row.home_discord_id ?? "home"),
  ]);
  await dm(user, "🇼 **Force Win Request**\nWho are you requesting the Force Win for?", [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)]);
}
async function showStreamDm(user: User, row: PanelRow) {
  const btn = new ButtonBuilder().setCustomId(`rgd_stream_open:${row.id}`).setLabel("Submit Stream Link").setStyle(ButtonStyle.Primary);
  await dm(user, "📺 **Submit Stream Link**\nClick below to submit a valid URL or the word `discord`.", [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)]);
}

async function handleParticipantReaction(reaction: MessageReaction, user: User, row: PanelRow, emoji: string) {
  const state = safeState(row);
  const opp = opponent(row, user.id);
  if (!opp) return;
  if (emoji === "🕒") return showSchedulingDm(user, row);
  if (emoji === "✅") { state.checkins ??= {}; state.checkins[user.id] = true; state.lastAction = `<@${user.id}> checked in.`; await updatePanel(row, state); return; }
  if (emoji === "🔎") { state.ready = `<@${user.id}> is ready to search. Waiting on <@${opp}>.`; await updatePanel(row, state); await (await reaction.message.client.users.fetch(opp)).send(`<@${user.id}> is ready to search for your matchup. Please search now.`).catch(()=>null); return; }
  if (emoji === "✉️") { state.ready = `<@${user.id}> requested a lobby invite from <@${opp}>.`; await updatePanel(row,state); await (await reaction.message.client.users.fetch(opp)).send(`<@${user.id}> is requesting a lobby invite for your matchup.`).catch(()=>null); return; }
  if (emoji === "🔄") { state.ready = "Retry search requested. Both users were DM’d."; await updatePanel(row,state); for (const id of [user.id, opp]) await (await reaction.message.client.users.fetch(id)).send("Please retry matchmaking/search for your game now.").catch(()=>null); return; }
  if (emoji === "📺") return showStreamDm(user,row);
  if (emoji === "🇼") return showFwDm(user,row);
  if (emoji === "🇸") { state.fairSim ??= {}; state.fairSim[user.id] = true; const both = state.fairSim[row.away_discord_id ?? ""] && state.fairSim[row.home_discord_id ?? ""]; state.requests = both ? "Both users requested a Fair Sim. Commissioners have been notified." : `<@${user.id}> requested a Fair Sim. Commissioners have been notified.`; await updatePanel(row,state); await reaction.message.channel.send(`${commissionerRoleMentions(reaction.message.guild!)}\n${state.requests}`).catch(()=>null); return; }
  if (emoji === "⚠️") return showIssueDm(user,row);
  if (emoji === "🔚") { state.ended ??= {}; state.ended[user.id] = true; const both = state.ended[row.away_discord_id ?? ""] && state.ended[row.home_discord_id ?? ""]; if (both) { state.requests = "Both users confirmed the game ended. Status: completed_pending_import. Final score and winner will be imported from MCA."; await db.execute(sql`update game_schedules set status = 'completed_pending_import', updated_at = now() where guild_id = ${row.guild_id} and season_id = ${row.season_id} and week_index = ${row.week_index} and ((away_discord_id=${row.away_discord_id} and home_discord_id=${row.home_discord_id}) or (away_discord_id=${row.home_discord_id} and home_discord_id=${row.away_discord_id}))`).catch(()=>null); for (const id of [row.away_discord_id,row.home_discord_id].filter(Boolean) as string[]) { const u = await reaction.message.client.users.fetch(id).catch(()=>null); if (u) await dm(u, "🎮 Was this game Game of the Year worthy? Use `/menu` → Media Room → Game of the Year to nominate it. Notes/highlights are optional."); } } else { state.requests = `<@${user.id}> marked the game as ended. Waiting on <@${opp}> to confirm.`; await (await reaction.message.client.users.fetch(opp)).send(`<@${user.id}> marked your game as ended. Please click 🔚 on the matchup panel to confirm.`).catch(()=>null); } await updatePanel(row,state); return; }
}

export async function handleReactionPanelAdd(reaction: MessageReaction, user: User): Promise<boolean> {
  if (user.bot) return false;
  if (reaction.partial) reaction = await reaction.fetch().catch(() => reaction);
  const message = reaction.message;
  const guild = message.guild;
  if (!guild) return false;
  const row = await panelForMessage(message.id);
  if (!row) return false;
  const emoji = reaction.emoji.name ?? "";
  if (row.panel_type === "commissioner") {
    if (!(COMMISSIONER_EMOJIS as readonly string[]).includes(emoji)) return true;
    if (!(await memberIsCommissioner(guild, user.id))) return true;
    if (emoji === "⚙️") { const fake: any = { guildId: guild.id, guild, user, deferred:false, replied:false, reply: (p:any)=>user.send(p), update: (p:any)=>user.send(p), editReply:(p:any)=>user.send(p), followUp:(p:any)=>user.send(p), isButton:()=>true, isStringSelectMenu:()=>false, customId:"gdrev_home" }; await renderCommissionerGamedayReview(fake as ButtonInteraction); return true; }
    if (emoji === "📣") { await (message.channel as TextChannel).send("@everyone — advance reminder: please complete scheduling/check-ins for this week.").catch(()=>null); return true; }
    if (emoji === "📬") { await dmUnscheduledUsers(guild, row); return true; }
    if (emoji === "🧹") { await db.execute(sql`update gameday_schedule_offers set status='expired', updated_at=now() where guild_id=${row.guild_id} and status='pending' and created_at < now() - interval '24 hours'`).catch(()=>null); await user.send("🧹 Stale gameday state cleanup completed.").catch(()=>null); return true; }
    if (emoji === "🔁") { await user.send("🔁 Regenerate panels through /menu → Admin Operations → Post Game Channels.").catch(()=>null); return true; }
    if (emoji === "🕒") { await user.send("🕒 Advance time picker will be handled from /menu advance flow in this rollout.").catch(()=>null); return true; }
    return true;
  }
  if (row.panel_type === "cpu_summary") {
    if (emoji !== "📺") return true;
    const allowed = Array.isArray(safeState(row).allowedUsers) ? safeState(row).allowedUsers : [];
    if (!allowed.includes(user.id)) return true;
    return showStreamDm(user,row).then(()=>true);
  }
  if (row.panel_type === "h2h") {
    if (!isParticipant(row,user.id)) return true;
    await handleParticipantReaction(reaction,user,row,emoji);
    return true;
  }
  return true;
}

async function dmUnscheduledUsers(guild: Guild, control: PanelRow) {
  const rows = await rowsOf<any>(sql`
    select p.*, u1.server_nickname as proposer_nick, u2.server_nickname as recipient_nick
    from gameday_schedule_offers p
    left join economy_users u1 on u1.guild_id=p.guild_id and u1.discord_id=p.proposer_discord_id
    left join economy_users u2 on u2.guild_id=p.guild_id and u2.discord_id=p.recipient_discord_id
    where p.guild_id=${control.guild_id} and p.season_id=${control.season_id} and p.week_index=${control.week_index} and p.status='pending'
  `);
  const server = await guildDisplayName(control.guild_id, guild.name);
  for (const o of rows) {
    const recipient = await guild.client.users.fetch(o.recipient_discord_id).catch(()=>null);
    if (!recipient) continue;
    await recipient.send(`📬 **Scheduling Reminder — ${server}**\n\nYou have a pending offer from ${o.proposer_nick ? `**${o.proposer_nick}**` : `<@${o.proposer_discord_id}>`} for **${o.proposed_for} ${o.proposed_tz ?? ""}**.\n\nPlease check your offers and respond. If this reaches 8 hours from the first attempt, your opponent may request FW or Fair Sim.`).catch(()=>null);
  }
}

export async function handleReactionGamedaySelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith("rgd_")) return false;
  if (id.startsWith("rgd_sched_action:")) {
    const panelId = Number(id.split(":")[1]); const action = interaction.values[0];
    if (action === "cancel") { await interaction.update({ content:"Cancelled.", components:[] }).catch(()=>null); return true; }
    if (action === "pending") { await showPendingOffers(interaction, panelId); return true; }
    const tz = await getUserTz(interaction.user.id);
    const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_date:${panelId}:${action}`).setPlaceholder("Choose date…").addOptions(dateOptions());
    await interaction.update({ content:`Choose a date. Your default timezone is **${tz}**.`, components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }); return true;
  }
  if (id.startsWith("rgd_sched_date:")) { const [, panelId, action] = id.split(":"); const day = interaction.values[0]; const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_window:${panelId}:${action}:${day}`).setPlaceholder("Choose time window…").addOptions(timeWindowOptions(), new StringSelectMenuOptionBuilder().setLabel("← Back").setValue("back").setDescription("Return to date selection.")); await interaction.update({ content:"Choose a time window.", components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }); return true; }
  if (id.startsWith("rgd_sched_window:")) { const [, panelId, action, day] = id.split(":"); const win = interaction.values[0]; if (win === "back") { const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_date:${panelId}:${action}`).setPlaceholder("Choose date…").addOptions(dateOptions()); await interaction.update({ content:"Choose a date.", components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }); return true; } const tz = await getUserTz(interaction.user.id); const opts = exactTimeOptions(win, Number(day), tz); const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_time:${panelId}:${action}:${day}:${win}`).setPlaceholder("Choose exact time…").addOptions(...(opts.length ? opts : [new StringSelectMenuOptionBuilder().setLabel("No remaining times").setValue("none")]), new StringSelectMenuOptionBuilder().setLabel("← Back").setValue("back").setDescription("Return to time window selection.")).setDisabled(!opts.length); await interaction.update({ content:"Choose exact time.", components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }); return true; }
  if (id.startsWith("rgd_sched_time:")) { const [, panelId, action, day, win] = id.split(":"); const minute = interaction.values[0]; if (minute === "back") { const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_window:${panelId}:${action}:${day}`).setPlaceholder("Choose time window…").addOptions(timeWindowOptions(), new StringSelectMenuOptionBuilder().setLabel("← Back").setValue("back").setDescription("Return to date selection.")); await interaction.update({ content:"Choose a time window.", components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }); return true; } if (minute === "none") return true; const tz = await getUserTz(interaction.user.id); const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_tz:${panelId}:${action}:${day}:${win}:${minute}`).setPlaceholder("Choose timezone…").addOptions(...timezoneOptions(tz), new StringSelectMenuOptionBuilder().setLabel("← Back").setValue("back").setDescription("Return to exact time selection.")); await interaction.update({ content:"Choose timezone. Your current default is shown as an option and can be selected to continue.", components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }); return true; }
  if (id.startsWith("rgd_sched_tz:")) { const [, panelId, action, day, win, minute] = id.split(":"); const selectedTz = interaction.values[0]; if (selectedTz === "back") { const tz = await getUserTz(interaction.user.id); const opts = exactTimeOptions(win, Number(day), tz); const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_time:${panelId}:${action}:${day}:${win}`).setPlaceholder("Choose exact time…").addOptions(...(opts.length ? opts : [new StringSelectMenuOptionBuilder().setLabel("No remaining times").setValue("none")]), new StringSelectMenuOptionBuilder().setLabel("← Back").setValue("back").setDescription("Return to time window selection.")); await interaction.update({ content:"Choose exact time.", components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] }); return true; } await submitScheduleOffer(interaction, Number(panelId), action, Number(day), Number(minute), selectedTz as TzCode); return true; }
  if (id.startsWith("rgd_issue:")) { const panelId = Number(id.split(":")[1]); const issue = interaction.values[0]; if (issue === "violation") { const modal = new ModalBuilder().setCustomId(`rgd_violation_modal:${panelId}`).setTitle("Report Violation").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("details").setLabel("Describe the violation").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000))); await interaction.showModal(modal); return true; } await submitIssue(interaction, panelId, issue); return true; }

  if (id.startsWith("rgd_offer_manage:")) { const [, panelId, offerId] = id.split(":"); await manageOfferAction(interaction, Number(panelId), Number(offerId), interaction.values[0]); return true; }
  if (id.startsWith("rgd_fw_for:")) { await submitFw(interaction, Number(id.split(":")[1]), interaction.values[0]); return true; }
  return false;
}

async function submitScheduleOffer(interaction: StringSelectMenuInteraction, panelId: number, action: string, day: number, minute: number, tz: TzCode) {
  const row = await oneOf<PanelRow>(sql`select * from gameday_matchup_panels where id=${panelId}`); if (!row || !isParticipant(row, interaction.user.id)) return interaction.update({ content:"Not authorized.", components:[] });
  await setUserTz(interaction.user.id, tz);
  const proposed = parseChosenDate(day, minute, tz);
  const label = `${fmtDate(proposed, tz)} ${tz}`;
  const opp = opponent(row, interaction.user.id)!;
  const result = await db.execute(sql`insert into gameday_schedule_offers (guild_id, season_id, week_index, matchup_key, proposer_discord_id, recipient_discord_id, away_discord_id, home_discord_id, away_team_name, home_team_name, proposed_for, proposed_tz, notes, status, offer_kind) values (${row.guild_id}, ${row.season_id}, ${row.week_index}, ${row.matchup_key}, ${interaction.user.id}, ${opp}, ${row.away_discord_id}, ${row.home_discord_id}, ${row.away_team_name}, ${row.home_team_name}, ${proposed.toISOString()}, ${tz}, ${action === "reschedule" ? "Reschedule request" : null}, 'pending', ${action === "reschedule" ? "reschedule" : "schedule"}) returning id`);
  const state = safeState(row); state.schedule = { status:"pending", from:interaction.user.id, to:opp, label, converted: formatAllSixZones(proposed), offerId: Number((result as any).rows?.[0]?.id ?? 0) };
  state.lastAction = `<@${interaction.user.id}> sent a schedule offer to <@${opp}>.`;
  await updatePanel(row,state);
  const oppUser = await interaction.client.users.fetch(opp).catch(()=>null);
  if (oppUser) await oppUser.send(`🕒 **Schedule Offer**\n<@${interaction.user.id}> proposed a game time.\n\n${selectedTimeBlock(proposed,tz)}\n\nOpen your pending offers from the matchup panel 🕒 to accept, counter, or reject.`).catch(()=>null);
  await interaction.update({ content:`✅ Schedule offer sent.\n\n${selectedTimeBlock(proposed,tz)}`, components:[] });
}

async function showPendingOffers(interaction: StringSelectMenuInteraction, panelId: number) {
  const row = await oneOf<PanelRow>(sql`select * from gameday_matchup_panels where id=${panelId}`); if (!row) return;
  if (!isParticipant(row, interaction.user.id)) { await interaction.update({ content:"Not authorized.", components:[] }).catch(()=>null); return; }
  const offers = await rowsOf<any>(sql`select * from gameday_schedule_offers where guild_id=${row.guild_id} and season_id=${row.season_id} and week_index=${row.week_index} and matchup_key=${row.matchup_key} and status='pending' order by created_at desc limit 25`);
  if (!offers.length) { await interaction.update({ content:"No pending schedule offers.", components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`rgd_sched_action:${panelId}`).setPlaceholder("Choose scheduling action…").addOptions(new StringSelectMenuOptionBuilder().setLabel("Send New Time").setValue("new"), new StringSelectMenuOptionBuilder().setLabel("Cancel").setValue("cancel")))] }).catch(()=>null); return; }
  const received = offers.filter((o)=>o.recipient_discord_id === interaction.user.id);
  const sent = offers.filter((o)=>o.proposer_discord_id === interaction.user.id);
  const other = offers.filter((o)=>o.proposer_discord_id !== interaction.user.id && o.recipient_discord_id !== interaction.user.id);
  const fmt = (o:any) => `${new Date(o.proposed_for).toLocaleString("en-US", { timeZone: "America/Chicago" })} ${o.proposed_tz ?? ""}`;
  const lines = [
    `**Received (${received.length})**`,
    received.length ? received.map((o,i)=>`${i+1}. From <@${o.proposer_discord_id}> — ${fmt(o)} — offer #${o.id}`).join("\n") : "None",
    "",
    `**Sent (${sent.length})**`,
    sent.length ? sent.map((o,i)=>`${i+1}. To <@${o.recipient_discord_id}> — ${fmt(o)} — offer #${o.id}`).join("\n") : "None",
    other.length ? `\n**Other pending (${other.length})**\n${other.map((o,i)=>`${i+1}. <@${o.proposer_discord_id}> → <@${o.recipient_discord_id}> — ${fmt(o)} — offer #${o.id}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  const menu = new StringSelectMenuBuilder().setCustomId(`rgd_offer_action:${panelId}`).setPlaceholder("Select a pending offer to accept, edit, or delete…");
  for (const o of offers.slice(0,25)) {
    const mine = o.proposer_discord_id === interaction.user.id ? "Sent" : o.recipient_discord_id === interaction.user.id ? "Received" : "Other";
    menu.addOptions(new StringSelectMenuOptionBuilder().setLabel(`${mine} #${o.id}`.slice(0,100)).setDescription(`${fmt(o)} ${mine === "Sent" ? `to ${o.recipient_discord_id}` : `from ${o.proposer_discord_id}`}`.slice(0,100)).setValue(String(o.id)));
  }
  await interaction.update({ content:`**Pending Schedule Offers (#${offers.length})**

${lines}`.slice(0,1900), components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
}

async function showOfferActions(interaction: StringSelectMenuInteraction, panelId: number, offerId: number) {
  const row = await oneOf<PanelRow>(sql`select * from gameday_matchup_panels where id=${panelId}`); if (!row || !isParticipant(row, interaction.user.id)) return;
  const offer = await oneOf<any>(sql`select * from gameday_schedule_offers where id=${offerId} and status='pending' limit 1`); if (!offer) { await interaction.update({ content:"That offer is no longer pending.", components:[] }).catch(()=>null); return; }
  const isSender = offer.proposer_discord_id === interaction.user.id;
  const isReceiver = offer.recipient_discord_id === interaction.user.id;
  const menu = new StringSelectMenuBuilder().setCustomId(`rgd_offer_manage:${panelId}:${offerId}`).setPlaceholder("Choose what to do with this offer…");
  if (isReceiver) menu.addOptions(new StringSelectMenuOptionBuilder().setLabel("Accept Offer").setValue("accept"), new StringSelectMenuOptionBuilder().setLabel("Reject Offer").setValue("reject"));
  if (isSender) menu.addOptions(new StringSelectMenuOptionBuilder().setLabel("Edit / Replace Offer").setValue("edit"), new StringSelectMenuOptionBuilder().setLabel("Delete Offer").setValue("delete"));
  menu.addOptions(new StringSelectMenuOptionBuilder().setLabel("Back to Pending Offers").setValue("back"));
  await interaction.update({ content:`**Offer #${offer.id}**
From: <@${offer.proposer_discord_id}>
To: <@${offer.recipient_discord_id}>
Time: ${offer.proposed_for} ${offer.proposed_tz ?? ""}`, components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
}

async function manageOfferAction(interaction: StringSelectMenuInteraction, panelId: number, offerId: number, action: string) {
  const row = await oneOf<PanelRow>(sql`select * from gameday_matchup_panels where id=${panelId}`); if (!row || !isParticipant(row, interaction.user.id)) return;
  if (action === "back") return showPendingOffers(interaction, panelId);
  const offer = await oneOf<any>(sql`select * from gameday_schedule_offers where id=${offerId} and status='pending' limit 1`); if (!offer) { await interaction.update({ content:"That offer is no longer pending.", components:[] }).catch(()=>null); return; }
  const state = safeState(row);
  if (action === "accept" && offer.recipient_discord_id === interaction.user.id) {
    await db.execute(sql`update gameday_schedule_offers set status='accepted', accepted_at=now(), updated_at=now() where id=${offerId}`);
    await db.execute(sql`update gameday_schedule_offers set status='expired', updated_at=now() where guild_id=${row.guild_id} and season_id=${row.season_id} and week_index=${row.week_index} and matchup_key=${row.matchup_key} and status='pending' and id <> ${offerId}`).catch(()=>null);
    state.schedule = { status:"accepted", from:offer.proposer_discord_id, to:offer.recipient_discord_id, label:`${offer.proposed_for} ${offer.proposed_tz ?? ""}`, converted: offer.proposed_for };
    state.lastAction = `<@${interaction.user.id}> accepted schedule offer #${offerId}.`;
    await updatePanel(row,state);
    await interaction.update({ content:`✅ Accepted offer #${offerId}. The matchup panel has been updated.`, components:[] });
    return;
  }
  if (action === "reject" && offer.recipient_discord_id === interaction.user.id) {
    await db.execute(sql`update gameday_schedule_offers set status='rejected', updated_at=now() where id=${offerId}`);
    state.lastAction = `<@${interaction.user.id}> rejected schedule offer #${offerId}.`;
    await updatePanel(row,state);
    await interaction.update({ content:`❌ Rejected offer #${offerId}.`, components:[] });
    return;
  }
  if (action === "delete" && offer.proposer_discord_id === interaction.user.id) {
    await db.execute(sql`update gameday_schedule_offers set status='cancelled', updated_at=now() where id=${offerId}`);
    state.lastAction = `<@${interaction.user.id}> deleted schedule offer #${offerId}.`;
    const stillPending = await oneOf<{count:number}>(sql`select count(*)::int as count from gameday_schedule_offers where guild_id=${row.guild_id} and season_id=${row.season_id} and week_index=${row.week_index} and matchup_key=${row.matchup_key} and status='pending'`);
    if (!Number(stillPending?.count ?? 0)) state.schedule = { status:"none" };
    await updatePanel(row,state);
    await interaction.update({ content:`🗑️ Deleted offer #${offerId}.`, components:[] });
    return;
  }
  if (action === "edit" && offer.proposer_discord_id === interaction.user.id) {
    await db.execute(sql`update gameday_schedule_offers set status='cancelled', updated_at=now() where id=${offerId}`);
    state.lastAction = `<@${interaction.user.id}> is replacing schedule offer #${offerId}.`;
    await updatePanel(row,state);
    const tz = await getUserTz(interaction.user.id);
    const menu = new StringSelectMenuBuilder().setCustomId(`rgd_sched_date:${panelId}:new`).setPlaceholder("Choose replacement date…").addOptions(dateOptions());
    await interaction.update({ content:`Choose a replacement date. Your default timezone is **${tz}**.`, components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
    return;
  }
  await interaction.update({ content:"Not authorized for that action.", components:[] }).catch(()=>null);
}


async function postImmediateDecisionRequest(row: PanelRow, state: any, requestType: "force_win" | "fair_sim", title: string, body: string, channel: TextChannel, guild: Guild) {
  const mention = staffRoleMentions(guild);
  const nonce = `${requestType}:${row.id}:${Date.now()}`;
  const approve = new ButtonBuilder().setCustomId(`rgd_decide:${nonce}:approve`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success);
  const deny = new ButtonBuilder().setCustomId(`rgd_decide:${nonce}:deny`).setLabel("Deny").setEmoji("✖️").setStyle(ButtonStyle.Danger);
  const msg = await channel.send({
    content: `${mention}\n${title}\n${body}`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(approve, deny)],
    allowedMentions: { roles: staffRoles(guild).map((r) => r.id), users: [] },
  });
  state.reviewMessageId = msg.id;
  state.reviewRequestType = requestType;
  state.reviewStatus = "pending";
  await db.execute(sql`
    insert into gameday_commissioner_requests (guild_id, season_id, week_index, matchup_key, request_type, requested_by, opponent_discord_id, reason, status)
    values (${row.guild_id}, ${row.season_id}, ${row.week_index}, ${row.matchup_key}, ${requestType}, ${safeState(row).lastRequester ?? row.away_discord_id}, ${row.home_discord_id}, ${body}, 'pending')
  `).catch(() => null);
}

async function submitFw(interaction: StringSelectMenuInteraction, panelId: number, selected: string) {
  const row = await oneOf<PanelRow>(sql`select * from gameday_matchup_panels where id=${panelId}`);
  if (!row || !isParticipant(row, interaction.user.id)) return;

  const state = safeState(row);
  state.fw ??= {};
  state.fw[interaction.user.id] = selected;
  state.lastRequester = interaction.user.id;

  const a = row.away_discord_id, h = row.home_discord_id;
  if (a && h && state.fw[a] && state.fw[h]) {
    state.requests = state.fw[a] === state.fw[h]
      ? `Both users requested Force Win in favor of <@${selected}>. League Architect / Competition Council review pending.`
      : `Force Win dispute.\n<@${a}> requested FW for <@${state.fw[a]}>.\n<@${h}> requested FW for <@${state.fw[h]}>.\nLeague Architect / Competition Council review pending.`;
  } else {
    state.requests = `<@${interaction.user.id}> requested a Force Win in favor of <@${selected}>. League Architect / Competition Council review pending.`;
  }

  await updatePanel(row, state);
  const ch = await interaction.client.channels.fetch(row.channel_id).catch(() => null);
  const guild = interaction.guild ?? (ch as any)?.guild;
  if (ch?.isTextBased() && guild) {
    await postImmediateDecisionRequest(
      row,
      state,
      "force_win",
      "🇼 **Force Win Requested**",
      state.requests,
      ch as TextChannel,
      guild,
    ).catch(() => null);
    await updatePanel(row, state);
  }
  await interaction.update({ content: "✅ Force Win request recorded for League Architect / Competition Council review.", components: [] });
}

async function submitIssue(interaction: StringSelectMenuInteraction, panelId: number, issue: string, details?: string) {
  const row = await oneOf<PanelRow>(sql`select * from gameday_matchup_panels where id=${panelId}`); if (!row || !isParticipant(row, interaction.user.id)) return;
  const labels:any = { dashed:"opponent dashed", desync:"desync", connection:"connection issue", violation:"rules violation" };
  const state = safeState(row); state.requests = `<@${interaction.user.id}> reported ${labels[issue] ?? issue}.${details ? `\nDetails: ${details}` : ""}\nCommissioners have been notified.`;
  await updatePanel(row,state);
  const ch = await interaction.client.channels.fetch(row.channel_id).catch(()=>null); if (ch?.isTextBased()) await (ch as TextChannel).send(`${commissionerRoleMentions((ch as any).guild)}\n${state.requests}`).catch(()=>null);
  await interaction.update({ content:"✅ Issue report recorded.", components:[] }).catch(()=>null);
}

export async function handleReactionGamedayButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("rgd_")) return false;
  if (interaction.customId.startsWith("rgd_decide:")) {
    if (!interaction.guild || !(await memberHasStaffRole(interaction.guild, interaction.user.id))) {
      await interaction.reply({ content: "Only League Architect or Competition Council can decide this request.", ephemeral: true });
      return true;
    }
    const parts = interaction.customId.split(":");
    const requestType = parts[1] as "force_win" | "fair_sim";
    const panelId = Number(parts[2]);
    const action = parts[4];
    const row = await oneOf<PanelRow>(sql`select * from gameday_matchup_panels where id=${panelId}`);
    if (!row) { await interaction.update({ content: "Request no longer exists.", components: [] }); return true; }
    const state = safeState(row);
    state.reviewStatus = action === "approve" ? "approved" : "denied";
    state.requests = `${requestType === "force_win" ? "Force Win" : "Fair Sim"} request ${state.reviewStatus} by <@${interaction.user.id}>.`;
    if (action === "approve") {
      await db.execute(sql`update game_schedules set status = ${requestType}, updated_at = now() where guild_id = ${row.guild_id} and season_id = ${row.season_id} and week_index = ${row.week_index} and ((away_discord_id=${row.away_discord_id} and home_discord_id=${row.home_discord_id}) or (away_discord_id=${row.home_discord_id} and home_discord_id=${row.away_discord_id}))`).catch(()=>null);
    }
    await db.execute(sql`update gameday_commissioner_requests set status = ${action === "approve" ? "approved" : "denied"}, resolved_by = ${interaction.user.id}, resolved_at = now(), updated_at = now() where guild_id = ${row.guild_id} and season_id = ${row.season_id} and week_index = ${row.week_index} and matchup_key = ${row.matchup_key} and request_type = ${requestType} and status = 'pending'`).catch(()=>null);
    await updatePanel(row, state);
    await interaction.update({ content: `${action === "approve" ? "✅ Approved" : "✖️ Denied"} by <@${interaction.user.id}>.\n${state.requests}`, components: [] });
    return true;
  }
  if (interaction.customId.startsWith("rgd_stream_open:")) {
    const panelId = interaction.customId.split(":")[1];
    const modal = new ModalBuilder().setCustomId(`rgd_stream_modal:${panelId}`).setTitle("Submit Stream Link").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("url").setLabel("Stream URL or discord").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)));
    await interaction.showModal(modal); return true;
  }
  return false;
}

export async function handleReactionGamedayModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("rgd_")) return false;
  if (interaction.customId.startsWith("rgd_stream_modal:")) {
    const panelId = Number(interaction.customId.split(":")[1]); const row = await oneOf<PanelRow>(sql`select * from gameday_matchup_panels where id=${panelId}`); if (!row) return true;
    const raw = interaction.fields.getTextInputValue("url").trim();
    const ok = raw.toLowerCase() === "discord" || /^https?:\/\/\S+$/i.test(raw);
    if (!ok) { await interaction.reply({ ephemeral:true, content:"❌ Submit a valid URL or the word `discord`." }); return true; }
    const payout = await getPayoutValue(PAYOUT_KEYS.STREAM_PAYOUT, row.guild_id);
    await addBalance(interaction.user.id, payout, row.guild_id);
    await db.insert(pendingChannelPayoutsTable).values({ type:"stream", discordId:interaction.user.id, amount:payout, channelId:row.channel_id, messageId:row.message_id, guildId:row.guild_id, seasonId:row.season_id, week:String(row.week_index), status:"approved", resolvedAt:new Date(), resolvedBy:"bot:auto" } as any).catch(()=>null);
    const state = safeState(row); state.stream = `✅ <@${interaction.user.id}> submitted stream${raw.toLowerCase()==="discord" ? ": discord" : " link"}.`;
    await updatePanel(row,state);
    const ch = await interaction.client.channels.fetch(row.channel_id).catch(()=>null); if (ch?.isTextBased()) await (ch as TextChannel).send(`📺 Stream submitted by <@${interaction.user.id}>: ${raw}\n💰 Stream payout issued: **${payout} coins**.`).catch(()=>null);
    await interaction.reply({ ephemeral:true, content:`✅ Stream logged and ${payout} coins paid.` }); return true;
  }
  if (interaction.customId.startsWith("rgd_violation_modal:")) { const panelId=Number(interaction.customId.split(":")[1]); const details=interaction.fields.getTextInputValue("details"); await submitIssue(interaction as any, panelId, "violation", details); return true; }
  return false;
}
