import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
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

export async function resolveGamedayContext(
  interaction: GamedayInteraction,
  options: { silentNoMatchup?: boolean } = {},
): Promise<GamedayContext | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEphemeral(interaction, "❌ Gameday actions can only be used inside a server.");
    return null;
  }

  await ensureGamedaySchema();

  const activeChannelId = await getGuildChannel(guildId, "gameday_active" as any).catch(() => null);
  if (!activeChannelId) {
    await replyEphemeral(interaction, "❌ No active weekly gameday channel is configured yet.");
    return null;
  }

  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = currentWeekIndexFor((season as any).currentWeek);
  if (weekIndex == null) {
    await replyEphemeral(interaction, "❌ There is no active H2H gameday dashboard for the current league week.");
    return null;
  }

  const scheduleSeasonId = await getScheduleSeasonId(guildId);
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
    if (!options.silentNoMatchup) {
      await replyEphemeral(interaction, "❌ You do not have a matchup this week, so no gameday actions are available.");
    }
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
