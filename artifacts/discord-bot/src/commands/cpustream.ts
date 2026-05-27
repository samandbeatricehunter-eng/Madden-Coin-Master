import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  addBalance,
  getGuildChannel,
  getOrCreateActiveSeason,
  getOrCreateUser,
  getScheduleSeasonId,
  logTransaction,
} from "../lib/db/db-helpers.js";

const CPU_STREAM_PAYOUT = 25;

export const data = new SlashCommandBuilder()
  .setName("cpustream")
  .setDescription("Post a CPU-game stream link in the active gameday channel for 25 coins.")
  .addStringOption((option) =>
    option
      .setName("link")
      .setDescription("Your stream link")
      .setRequired(true),
  );

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

function teamKey(teamName: string): string {
  return teamName.toLowerCase().trim();
}

function isDiscordStreamLabel(content: string): boolean {
  return content.trim().toLowerCase() === "discord";
}

function hasValidUrl(content: string): boolean {
  if (isDiscordStreamLabel(content)) return true;
  try {
    const url = new URL(content.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isAllowedStreamHost(content: string): boolean {
  if (isDiscordStreamLabel(content)) return true;
  try {
    const url = new URL(content.trim());
    const host = url.hostname.toLowerCase();
    return (
      host.includes("twitch.tv") ||
      host.includes("youtube.com") ||
      host.includes("youtu.be") ||
      host.includes("kick.com") ||
      host.includes("facebook.com") ||
      host.includes("xbox.com") ||
      host.includes("discord.com")
    );
  } catch {
    return false;
  }
}

async function isReachableUrl(content: string): Promise<boolean> {
  if (isDiscordStreamLabel(content)) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(content.trim(), { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (res.ok || (res.status >= 300 && res.status < 400)) return true;
    const getRes = await fetch(content.trim(), { method: "GET", redirect: "follow", signal: controller.signal });
    return getRes.ok || (getRes.status >= 300 && getRes.status < 400);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const activeGamedayChannelId = await getGuildChannel(guildId, "gameday_active" as any).catch(() => null);

  if (!activeGamedayChannelId || interaction.channelId !== activeGamedayChannelId) {
    await interaction.reply({
      ephemeral: true,
      content: activeGamedayChannelId
        ? `❌ \`/cpustream\` only works in the active gameday channel: <#${activeGamedayChannelId}>.`
        : "❌ There is no active gameday channel configured.",
    });
    return;
  }

  const link = interaction.options.getString("link", true).trim();
  if (!hasValidUrl(link) || !isAllowedStreamHost(link) || !(await isReachableUrl(link))) {
    await interaction.reply({
      ephemeral: true,
      content: "❌ Invalid or unreachable stream entry. Supported examples: Twitch, YouTube, Kick, Facebook, Xbox, Discord links, or simply `discord`.",
    });
    return;
  }

  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = weekIndexFromCurrentWeek((season as any).currentWeek);
  if (weekIndex == null) {
    await interaction.reply({ ephemeral: true, content: "❌ CPU stream payouts are not available for this league week." });
    return;
  }

  const scheduleSeasonId = await getScheduleSeasonId(guildId);

  const teamRows = await rowsOf<any>(sql`
    select full_name, nick_name, discord_id
    from franchise_mca_teams
    where season_id = ${scheduleSeasonId}
  `);

  const teamToDiscord = new Map<string, string>();
  for (const t of teamRows) {
    if (!t.discord_id || String(t.discord_id).startsWith("unlinked_")) continue;
    teamToDiscord.set(teamKey(String(t.full_name)), String(t.discord_id));
    teamToDiscord.set(teamKey(String(t.nick_name)), String(t.discord_id));
  }

  const games = await rowsOf<any>(sql`
    select *
    from franchise_schedule
    where season_id = ${scheduleSeasonId}
      and week_index = ${weekIndex}
  `);

  const userCpuGame = games.find((g) => {
    const awayId = teamToDiscord.get(teamKey(String(g.away_team_name)));
    const homeId = teamToDiscord.get(teamKey(String(g.home_team_name)));
    const userIsAway = awayId === interaction.user.id;
    const userIsHome = homeId === interaction.user.id;
    if (!userIsAway && !userIsHome) return false;
    const opponentId = userIsAway ? homeId : awayId;
    return !opponentId;
  });

  if (!userCpuGame) {
    await interaction.reply({
      ephemeral: true,
      content: "❌ You do not appear to have a CPU game this week, so `/cpustream` is not available.",
    });
    return;
  }

  const [existing] = await rowsOf<any>(sql`
    select id
    from pending_channel_payouts
    where guild_id = ${guildId}
      and season_id = ${season.id}
      and week = ${(season as any).currentWeek ?? "1"}
      and discord_id = ${interaction.user.id}
      and type = 'cpu_stream'
    limit 1
  `);

  if (existing) {
    await interaction.reply({
      ephemeral: true,
      content: "❌ You already received a CPU stream payout this advance week.",
    });
    return;
  }

  await getOrCreateUser(interaction.user.id, interaction.user.username, guildId);
  await addBalance(interaction.user.id, CPU_STREAM_PAYOUT, guildId);
  await logTransaction(interaction.user.id, CPU_STREAM_PAYOUT, "addcoins", `CPU stream payout — ${(season as any).currentWeek ?? "1"}`, guildId, "cpu_stream");

  await db.execute(sql`
    insert into pending_channel_payouts (
      type, discord_id, amount, channel_id, message_id, guild_id, season_id, week,
      status, resolved_at, resolved_by
    )
    values (
      'cpu_stream', ${interaction.user.id}, ${CPU_STREAM_PAYOUT}, ${interaction.channelId}, 'cpustream-command',
      ${guildId}, ${season.id}, ${(season as any).currentWeek ?? "1"},
      'approved', now(), 'bot:auto'
    )
  `);

  const matchup = `${userCpuGame.away_team_name} @ ${userCpuGame.home_team_name}`;
  await interaction.reply({
    content:
      `📺 **CPU Game Stream Posted**\n` +
      `<@${interaction.user.id}> is streaming CPU game: **${matchup}**\n` +
      `${link}\n\n` +
      `💰 CPU stream payout issued: **${CPU_STREAM_PAYOUT} coins**.`,
  });
}
