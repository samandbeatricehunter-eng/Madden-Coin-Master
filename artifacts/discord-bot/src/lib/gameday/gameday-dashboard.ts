import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
  getOrCreateActiveSeason,
  getScheduleSeasonId,
} from "../db/db-helpers.js";
import { weekLabel } from "../helpers/week-helpers.js";

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

export async function openGamedayDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const activeChannelId = await getGuildChannel(guildId, "gameday_active" as any).catch(() => null);

  if (!activeChannelId || interaction.channelId !== activeChannelId) {
    await interaction.reply({
      ephemeral: true,
      content: activeChannelId
        ? `❌ \`/gameday\` only works in the active weekly gameday channel: <#${activeChannelId}>.`
        : "❌ No active weekly gameday channel is configured yet.",
    });
    return;
  }

  const season = await getOrCreateActiveSeason(guildId);
  const weekIndex = weekIndexFromCurrentWeek((season as any).currentWeek);
  if (weekIndex == null) {
    await interaction.reply({
      ephemeral: true,
      content: "❌ There is no active H2H gameday dashboard for the current league week.",
    });
    return;
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

  const myGame = games
    .map((g) => ({
      ...g,
      awayDiscordId: teamToDiscord.get(teamKey(g.awayTeamName)),
      homeDiscordId: teamToDiscord.get(teamKey(g.homeTeamName)),
    }))
    .find((g) => g.awayDiscordId === interaction.user.id || g.homeDiscordId === interaction.user.id);

  if (!myGame || !myGame.awayDiscordId || !myGame.homeDiscordId) {
    await interaction.reply({
      ephemeral: true,
      content: "❌ You do not have a H2H matchup this week, so there are no gameday actions available.",
    });
    return;
  }

  const opponentId = myGame.awayDiscordId === interaction.user.id ? myGame.homeDiscordId : myGame.awayDiscordId;
  const homeAway = myGame.homeDiscordId === interaction.user.id ? "Home" : "Away";

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎮 Gameday Dashboard")
    .setDescription([
      `**Week:** ${weekLabel((season as any).currentWeek)}`,
      `**Matchup:** <@${myGame.awayDiscordId}> @ <@${myGame.homeDiscordId}>`,
      `**You are:** ${homeAway}`,
      `**Opponent:** <@${opponentId}>`,
      "",
      "This is the Phase 1 dashboard shell. Scheduling offers, queue controls, final-score approval, FS/FW, and stream payout routing will be added in the next phases.",
    ].join("\n"))
    .addFields(
      { name: "Schedule Game", value: "Send proposed times · Manage active offers (0) · Edit/delete offers", inline: false },
      { name: "Pending Offers (0)", value: "Accept · Counter · Reject with reason", inline: false },
      { name: "Game Queue", value: "Check in/out · Message opponent · Advise search · Request invite · Mark begun · Submit final", inline: false },
      { name: "Assistance", value: "Contact Commissioner · Flag Violation · Request FS · Request FW", inline: false },
    );

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_schedule").setLabel("🗓️ Schedule Game").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId("gd_pending").setLabel("📨 Pending Offers (0)").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("gd_queue").setLabel("🎮 Game Queue").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId("gd_assist").setLabel("🚨 Assistance").setStyle(ButtonStyle.Danger).setDisabled(true),
    ),
  ];

  await interaction.reply({
    ephemeral: true,
    embeds: [embed],
    components: rows,
  });
}
