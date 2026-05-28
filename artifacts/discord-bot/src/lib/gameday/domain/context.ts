import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseMcaTeamsTable,
  franchiseScheduleTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getGuildChannel, getOrCreateActiveSeason, getScheduleSeasonId } from "../../db/db-helpers.js";
import { canUseCommissionerOffice } from "../../roles/rec-role-access.js";
import { currentWeekIndexFor } from "../../helpers/week-helpers.js";
import { ensureGamedaySchema, oneOf } from "./db.js";

export type GamedayContext = {
  guildId: string;
  season: any;
  weekIndex: number;
  scheduleSeasonId: number;
  channelId: string;
  userId: string;
  isCpuGame?: boolean;
  isByeWeek?: boolean;
  userTeamName?: string;
  cpuTeamName?: string;
  scheduleId?: number;
  awayDiscordId: string;
  homeDiscordId: string;
  opponentId: string;
  awayTeamName: string;
  homeTeamName: string;
  matchupKey: string;
  homeAway: "Home" | "Away";
};

export type GamedayInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

export function teamKey(teamName: string | null | undefined): string {
  return String(teamName ?? "").toLowerCase().trim();
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

async function replyEphemeral(interaction: GamedayInteraction, content: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  const payload = { content, ephemeral: true, embeds: [], components: [] } as any;
  if ((interaction as any).replied || (interaction as any).deferred) {
    await (interaction as any).followUp(payload).catch(() => null);
  } else {
    await (interaction as any).reply(payload).catch(() => null);
  }
}

type ResolveGamedayContextOptions = { silentNoMatchup?: boolean };

type Cached<T> = { value: T; expiresAt: number };
const CONTEXT_TTL_MS = 45_000;
const SHORT_TTL_MS = 20_000;
const cache = new Map<string, Cached<any>>();

function getCached<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function setCached<T>(key: string, value: T, ttlMs = CONTEXT_TTL_MS): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function cached<T>(key: string, loader: () => Promise<T>, ttlMs = CONTEXT_TTL_MS): Promise<T> {
  const hit = getCached<T>(key);
  if (hit !== null) return hit;
  return setCached(key, await loader(), ttlMs);
}

export function invalidateGamedayContextCache(guildId?: string): void {
  if (!guildId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.includes(`:${guildId}:`) || key.startsWith(`${guildId}:`)) cache.delete(key);
  }
}

export async function resolveGamedayContext(interaction: GamedayInteraction, options: ResolveGamedayContextOptions = {}): Promise<GamedayContext | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEphemeral(interaction, "❌ Gameday actions can only be used inside a server.");
    return null;
  }

  await ensureGamedaySchema();

  const activeChannelId = await cached(`${guildId}:gameday_active_channel`, () => getGuildChannel(guildId, "gameday_active" as any).catch(() => null), CONTEXT_TTL_MS);
  if (!activeChannelId) {
    if (!options.silentNoMatchup) await replyEphemeral(interaction, "❌ No active weekly gameday channel is configured yet.");
    return null;
  }

  const season = await cached(`${guildId}:active_season`, () => getOrCreateActiveSeason(guildId), SHORT_TTL_MS);
  const weekIndex = currentWeekIndexFor((season as any).currentWeek);
  if (weekIndex == null) {
    if (!options.silentNoMatchup) await replyEphemeral(interaction, "❌ There is no active H2H gameday dashboard for the current league week.");
    return null;
  }

  const scheduleSeasonId = await cached(`${guildId}:schedule_season_id`, () => getScheduleSeasonId(guildId), CONTEXT_TTL_MS);
  const hydrated = await cached(`${guildId}:${scheduleSeasonId}:week:${weekIndex}:gameday_hydrated`, async () => {
    const [games, mcaTeams, users] = await Promise.all([
      db.select().from(franchiseScheduleTable).where(and(
        eq(franchiseScheduleTable.seasonId, scheduleSeasonId),
        eq(franchiseScheduleTable.weekIndex, weekIndex),
      )),
      db.select({
        fullName: franchiseMcaTeamsTable.fullName,
        nickName: franchiseMcaTeamsTable.nickName,
        discordId: franchiseMcaTeamsTable.discordId,
      }).from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.seasonId, scheduleSeasonId)),
      db.select({ discordId: usersTable.discordId, team: usersTable.team })
        .from(usersTable)
        .where(eq(usersTable.guildId, guildId)),
    ]);
    return { games, mcaTeams, users };
  }, SHORT_TTL_MS);
  const { games, mcaTeams, users } = hydrated;

  const teamToDiscord = new Map<string, string>();
  for (const t of mcaTeams) {
    if (!t.discordId || t.discordId.startsWith("unlinked_")) continue;
    teamToDiscord.set(teamKey(t.fullName), t.discordId);
    teamToDiscord.set(teamKey(t.nickName), t.discordId);
  }
  for (const u of users) {
    if (!u.discordId || !u.team || u.discordId.startsWith("unlinked_")) continue;
    if (!teamToDiscord.has(teamKey(u.team))) teamToDiscord.set(teamKey(u.team), u.discordId);
  }

  const userId = interaction.user.id;
  const mappedGames = games.map((g) => ({
    ...g,
    awayDiscordId: teamToDiscord.get(teamKey(g.awayTeamName)),
    homeDiscordId: teamToDiscord.get(teamKey(g.homeTeamName)),
  }));
  const myGame = mappedGames.find((g) => g.awayDiscordId === userId || g.homeDiscordId === userId);

  if (!myGame) {
    const isCommissioner = canUseCommissionerOffice(interaction.member as GuildMember | null | undefined, true);
    if (isCommissioner) {
      return {
        guildId,
        season,
        weekIndex,
        scheduleSeasonId,
        channelId: activeChannelId,
        userId,
        isCpuGame: true,
        isByeWeek: true,
        userTeamName: "Bye Week / No Matchup",
        cpuTeamName: "No opponent",
        scheduleId: 0,
        awayDiscordId: userId,
        homeDiscordId: userId,
        opponentId: "",
        awayTeamName: "Bye Week",
        homeTeamName: "No Matchup",
        matchupKey: `bye:${userId}:${weekIndex}`,
        homeAway: "Home",
      };
    }
    if (!options.silentNoMatchup) await replyEphemeral(interaction, "❌ You do not have a matchup this week, so no gameday actions are available.");
    return null;
  }

  const userIsAway = myGame.awayDiscordId === userId;
  const userIsHome = myGame.homeDiscordId === userId;
  const opponentId = userIsAway ? myGame.homeDiscordId : myGame.awayDiscordId;

  if (!opponentId) {
    return {
      guildId,
      season,
      weekIndex,
      scheduleSeasonId,
      channelId: activeChannelId,
      userId,
      isCpuGame: true,
      userTeamName: userIsAway ? myGame.awayTeamName : myGame.homeTeamName,
      cpuTeamName: userIsAway ? myGame.homeTeamName : myGame.awayTeamName,
      scheduleId: Number((myGame as any).id ?? 0),
      awayDiscordId: myGame.awayDiscordId ?? userId,
      homeDiscordId: myGame.homeDiscordId ?? userId,
      opponentId: "",
      awayTeamName: myGame.awayTeamName,
      homeTeamName: myGame.homeTeamName,
      matchupKey: `cpu:${userId}:${Number((myGame as any).id ?? weekIndex)}`,
      homeAway: userIsHome ? "Home" : "Away",
    };
  }

  return {
    guildId,
    season,
    weekIndex,
    scheduleSeasonId,
    channelId: activeChannelId,
    userId,
    awayDiscordId: myGame.awayDiscordId!,
    homeDiscordId: myGame.homeDiscordId!,
    opponentId,
    awayTeamName: myGame.awayTeamName,
    homeTeamName: myGame.homeTeamName,
    matchupKey: pairKey(myGame.awayDiscordId!, myGame.homeDiscordId!),
    homeAway: userIsHome ? "Home" : "Away",
  };
}

export function isMatchupUser(userId: string, ctx: Pick<GamedayContext, "awayDiscordId" | "homeDiscordId">): boolean {
  return userId === ctx.awayDiscordId || userId === ctx.homeDiscordId;
}

export async function ensureMatchupStatus(ctx: GamedayContext): Promise<void> {
  await ensureGamedaySchema();
  if (ctx.isCpuGame) return;
  await db.execute(sql`
    insert into gameday_matchup_status (
      guild_id, season_id, week_index, matchup_key,
      away_discord_id, home_discord_id, away_team_name, home_team_name
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName}
    ) on conflict (guild_id, season_id, week_index, matchup_key) do nothing
  `);
}

export async function getMatchupStatus(ctx: GamedayContext): Promise<any | null> {
  await ensureMatchupStatus(ctx);
  return oneOf(sql`
    select *
    from gameday_matchup_status
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
    limit 1
  `);
}

export async function postToGamedayChannel(interaction: GamedayInteraction, ctx: GamedayContext, content: string): Promise<any | null> {
  const ch = await interaction.client.channels.fetch(ctx.channelId).catch(() => null);
  if (ch?.isTextBased()) return await ch.send({ content }).catch(() => null);
  return null;
}

export async function dmUser(interaction: GamedayInteraction, userId: string, content: string): Promise<void> {
  const member = await interaction.guild?.members.fetch(userId).catch(() => null);
  await member?.send(content).catch(() => null);
}
