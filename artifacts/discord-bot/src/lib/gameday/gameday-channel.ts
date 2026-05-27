import {
  Guild,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable,
  franchiseMcaTeamsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  getGuildChannel,
  setGuildChannel,
  getOrCreateActiveSeason,
  getScheduleSeasonId,
} from "../db/db-helpers.js";
import { getServerSettings } from "../db/server-settings.js";
import { nextAdvanceDeadline, formatAllZones } from "../discord/timezones.js";

export type GamedayChannelResult = {
  channelId: string;
  channelUrl?: string;
  h2hCount: number;
  totalGames: number;
  deletedPrevious: boolean;
  displayLabel: string;
};

function simpleTeamKey(teamName: string): string {
  return teamName.toLowerCase().trim();
}

function gamedayDisplayLabel(seasonNumber: number, weekNum: number): string {
  const playoffLabels: Record<number, string> = { 19: "Wild Card", 20: "Divisional Round", 21: "Conference Championship", 22: "Super Bowl" };
  return weekNum > 18
    ? `Season ${seasonNumber} — ${playoffLabels[weekNum] ?? `Playoff Wk ${weekNum}`}`
    : `Season ${seasonNumber} — Week ${weekNum}`;
}

export function gamedayWeekIndexFromNum(weekNum: number): number {
  const playoffIndexMap: Record<number, number> = { 19: 1018, 20: 1019, 21: 1020, 22: 1022 };
  return weekNum <= 18 ? weekNum - 1 : (playoffIndexMap[weekNum] ?? -1);
}

export function gamedayWeekNumFromWeekKey(weekKey: string): number | null {
  const raw = String(weekKey ?? "").toLowerCase().trim();
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= 18) return n;
  if (raw === "wildcard") return 19;
  if (raw === "divisional") return 20;
  if (raw === "conference") return 21;
  if (raw === "superbowl") return 22;
  return null;
}

function scheduleLines(games: Array<{ awayTeamName: string; homeTeamName: string }>): string {
  return games.map((g, i) => `**${i + 1}.** ${g.awayTeamName} @ ${g.homeTeamName}`).join("\n").slice(0, 3900);
}

export async function createWeeklyGamedayChannel(args: {
  guild: Guild;
  guildId: string;
  weekNum: number;
  categoryId?: string | null;
  deletePrevious?: boolean;
}): Promise<GamedayChannelResult> {
  const { guild, guildId, weekNum, categoryId = null, deletePrevious = true } = args;
  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = gamedayWeekIndexFromNum(weekNum);
  if (weekIndex === -1) throw new Error(`Could not resolve gameday week index for week ${weekNum}`);

  const displayLabel = gamedayDisplayLabel(season.seasonNumber, weekNum);
  const schedSeasonId = await getScheduleSeasonId(guildId);

  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, schedSeasonId),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ));

  if (games.length === 0) {
    throw new Error(`No schedule data found for ${displayLabel}. Import or sync the schedule first.`);
  }

  const [mcaTeams, allUsers] = await Promise.all([
    db.select({
      fullName: franchiseMcaTeamsTable.fullName,
      nickName: franchiseMcaTeamsTable.nickName,
      discordId: franchiseMcaTeamsTable.discordId,
    }).from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.seasonId, schedSeasonId)),
    db.select({ discordId: usersTable.discordId, team: usersTable.team })
      .from(usersTable).where(eq(usersTable.guildId, guildId)),
  ]);

  const teamToDiscord = new Map<string, string>();
  for (const t of mcaTeams) {
    if (!t.discordId || t.discordId.startsWith("unlinked_")) continue;
    teamToDiscord.set(simpleTeamKey(t.fullName), t.discordId);
    teamToDiscord.set(simpleTeamKey(t.nickName), t.discordId);
  }
  for (const u of allUsers) {
    if (!u.team || !u.discordId || u.discordId.startsWith("unlinked_")) continue;
    if (!teamToDiscord.has(simpleTeamKey(u.team))) teamToDiscord.set(simpleTeamKey(u.team), u.discordId);
  }

  const h2hGames = games
    .map((g) => ({
      ...g,
      awayDiscordId: teamToDiscord.get(simpleTeamKey(g.awayTeamName)),
      homeDiscordId: teamToDiscord.get(simpleTeamKey(g.homeTeamName)),
    }))
    .filter((g) => g.awayDiscordId && g.homeDiscordId);

  if (h2hGames.length === 0) {
    throw new Error(`No H2H matchups found for ${displayLabel}. No gameday channel created.`);
  }

  await guild.channels.fetch().catch(() => null);

  let deletedPrevious = false;
  if (deletePrevious) {
    const previousActiveChannelId = await getGuildChannel(guildId, "gameday_active" as any).catch(() => null);
    if (previousActiveChannelId) {
      const previous = guild.channels.cache.get(previousActiveChannelId)
        ?? await guild.channels.fetch(previousActiveChannelId).catch(() => null);
      if (previous) {
        await previous.delete("Weekly advance — replacing active gameday channel").catch((err) =>
          console.warn(`[gameday] Could not delete previous channel ${previousActiveChannelId}:`, err),
        );
        deletedPrevious = true;
      }
    }
  }

  const approvedRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "approved member");
  const commissionerRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "commissioner");

  if (!approvedRole && !commissionerRole) {
    throw new Error("Could not find an Approved Member or Commissioner role to grant access to the gameday channel.");
  }

  const overwrites: import("discord.js").OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: guild.client.user!.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  if (approvedRole) {
    overwrites.push({
      id: approvedRole.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  if (commissionerRole) {
    overwrites.push({
      id: commissionerRole.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    });
  }

  const safeWeekName = weekNum > 18 ? `playoffs-${weekNum}` : `week-${weekNum}`;
  const newChannel = await guild.channels.create({
    name: `${safeWeekName}-gameday`,
    type: ChannelType.GuildText,
    parent: categoryId ?? undefined,
    topic: "Use /gameday for all matchup actions. Non-command user messages are automatically deleted.",
    permissionOverwrites: overwrites,
  }) as TextChannel;

  await setGuildChannel(guildId, "gameday_active" as any, newChannel.id);
  if (categoryId) await setGuildChannel(guildId, "gameday_category" as any, categoryId);

  const settings = await getServerSettings(guildId);
  const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
  const deadlineText = formatAllZones(deadline);

  await newChannel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`🏈 ${displayLabel.toUpperCase()} SCHEDULE`)
        .setDescription(scheduleLines(games))
        .addFields({ name: "Advance Deadline", value: deadlineText }),
    ],
  });

  await newChannel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(`🔥 ${displayLabel.toUpperCase()} H2H MATCHUPS 🔥`)
        .setDescription(h2hGames.map((g, i) => `**${i + 1}.** <@${g.awayDiscordId}> @ <@${g.homeDiscordId}>`).join("\n")),
    ],
  });

  const header = await newChannel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setTitle(`🎮 OFFICIAL ${displayLabel.toUpperCase()} GAMEDAY CHANNEL`)
        .setDescription(
          "This channel is used exclusively for H2H scheduling, gameday actions, stream tracking, final score confirmations, FW/FS requests, and commissioner assistance.\n\n" +
          "Only commissioners may send normal messages here. All non-command user messages will be automatically deleted.\n\n" +
          "Use `/gameday` to access your private matchup dashboard.",
        ),
    ],
  });
  await header.pin().catch(() => null);

  const reminder = await newChannel.send({
    content: "@everyone",
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle(`🚨 ${displayLabel.toUpperCase()} ACTION REMINDERS 🚨`)
        .setDescription(
          `**ADVANCE DEADLINE**\n${deadlineText}\n\n` +
          "**SCHEDULING POLICY**\n" +
          "• If a scheduling proposal is sent and the opponent fails to respond within **9 hours**, the sender may request a Force Win due to lack of activity or extend the response window.\n\n" +
          "**GAME CHECK-IN**\n" +
          "• Players are expected to check in before their scheduled game time using `/gameday`.\n" +
          "• Games must be marked as begun through `/gameday`. This is now the only way to post your stream link and receive stream payout review.\n\n" +
          "**STREAMING POLICY**\n" +
          "• Home team is expected to stream regular season games. Either user may stream.\n" +
          "• In playoffs, home team is required to stream.\n" +
          "• If away cannot or chooses not to stream, home may still be penalized for failing to uphold streaming responsibilities. Penalties may include coin fines, compensation to the opponent, or any reasonable commissioner discipline.\n\n" +
          "**FINAL SCORES**\n" +
          "• Final scores must be submitted through `/gameday` after the game is marked begun.\n" +
          "• Opponents must approve or dispute submitted scores.\n" +
          "• Commissioners may review unresolved score disputes.\n\n" +
          "**ASSISTANCE**\n" +
          "Use `/gameday` for FW requests, FS requests, violations, commissioner contact, and scheduling issues.",
        ),
    ],
    allowedMentions: { parse: ["everyone"] },
  });
  await reminder.pin().catch(() => null);

  return {
    channelId: newChannel.id,
    channelUrl: newChannel.url,
    h2hCount: h2hGames.length,
    totalGames: games.length,
    deletedPrevious,
    displayLabel,
  };
}
