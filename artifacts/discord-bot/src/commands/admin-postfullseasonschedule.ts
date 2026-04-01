import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, seasonsTable, usersTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

const SCHEDULE_CHANNEL_ID = "1478947361014288445";

export const data = new SlashCommandBuilder()
  .setName("postfullseasonschedule")
  .setDescription("Admin: post the full 18-week season schedule to the schedule channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // ── Get active season ──────────────────────────────────────────────────────
  const [season] = await db.select()
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found." });
    return;
  }

  // ── Fetch ALL games for the season ─────────────────────────────────────────
  const allGames = await db.select()
    .from(franchiseScheduleTable)
    .where(eq(franchiseScheduleTable.seasonId, season.id))
    .orderBy(asc(franchiseScheduleTable.weekIndex), asc(franchiseScheduleTable.id));

  if (allGames.length === 0) {
    await interaction.editReply({
      content: "📭 No schedule data found. Run `/franchiseupdate` first to import the schedule.",
    });
    return;
  }

  // ── Build team name (lowercase) → discordId lookup ────────────────────────
  const allUsers = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  }).from(usersTable);

  const teamToDiscord = new Map<string, string>();
  for (const u of allUsers) {
    if (u.team) teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
  }

  function mention(teamName: string): string {
    const discordId = teamToDiscord.get(teamName.toLowerCase().trim());
    return discordId ? `<@${discordId}>` : `**${teamName}**`;
  }

  // ── Collect all team names from the schedule (for bye detection) ───────────
  const allTeamsInSchedule = new Set<string>();
  for (const g of allGames) {
    allTeamsInSchedule.add(g.homeTeamName.trim());
    allTeamsInSchedule.add(g.awayTeamName.trim());
  }

  // Group games by weekIndex (0-based) into a Map
  const gamesByWeek = new Map<number, typeof allGames>();
  for (const g of allGames) {
    if (!gamesByWeek.has(g.weekIndex)) gamesByWeek.set(g.weekIndex, []);
    gamesByWeek.get(g.weekIndex)!.push(g);
  }

  // ── Find the target channel ────────────────────────────────────────────────
  const targetChannel = interaction.client.channels.cache.get(SCHEDULE_CHANNEL_ID)
    ?? await interaction.client.channels.fetch(SCHEDULE_CHANNEL_ID).catch(() => null);

  if (!targetChannel || !targetChannel.isTextBased()) {
    await interaction.editReply({
      content: `❌ Could not find or access the schedule channel (\`${SCHEDULE_CHANNEL_ID}\`).`,
    });
    return;
  }

  // ── Post one embed per week ────────────────────────────────────────────────
  await interaction.editReply({ content: "📤 Posting schedule…" });

  let postedWeeks = 0;
  const weeks = Array.from({ length: 18 }, (_, i) => i); // weekIndex 0–17

  for (const weekIndex of weeks) {
    const weekNum   = weekIndex + 1;
    const weekGames = gamesByWeek.get(weekIndex) ?? [];

    // Find teams on bye this week (in the schedule overall but not playing this week)
    const teamsPlayingThisWeek = new Set<string>();
    for (const g of weekGames) {
      teamsPlayingThisWeek.add(g.homeTeamName.trim());
      teamsPlayingThisWeek.add(g.awayTeamName.trim());
    }
    const byeTeams = [...allTeamsInSchedule].filter(t => !teamsPlayingThisWeek.has(t)).sort();

    const lines: string[] = [];

    // Matchup lines
    for (const g of weekGames) {
      const awayMention = mention(g.awayTeamName);
      const homeMention = mention(g.homeTeamName);

      if (g.status >= 2 && g.homeScore != null && g.awayScore != null) {
        const hs = g.homeScore;
        const as_ = g.awayScore;
        if (hs === as_) {
          lines.push(`🤝 ${awayMention} **${as_}** — **${hs}** ${homeMention} *(Tie)*`);
        } else if (hs > as_) {
          lines.push(`🏆 ${awayMention} ${as_} — **${hs}** ${homeMention} ✅`);
        } else {
          lines.push(`🏆 ${awayMention} **${as_}** — ${hs} ${homeMention} ✅`);
        }
      } else {
        lines.push(`📅 ${awayMention} @ ${homeMention}`);
      }
    }

    if (lines.length === 0 && byeTeams.length === 0) continue; // skip entirely empty weeks

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`📅 Week ${weekNum} — Season ${season.seasonNumber ?? season.id}`)
      .setDescription(lines.length > 0 ? lines.join("\n") : "*No games scheduled*");

    if (byeTeams.length > 0) {
      const byeLines = byeTeams.map(t => mention(t)).join("\n");
      embed.addFields({ name: "🛌 Bye Week", value: byeLines });
    }

    await (targetChannel as TextChannel).send({ embeds: [embed] });
    postedWeeks++;

    // Small delay between posts to avoid rate limits
    await new Promise(r => setTimeout(r, 750));
  }

  await interaction.editReply({
    content: `✅ Posted **${postedWeeks} weeks** of schedule to <#${SCHEDULE_CHANNEL_ID}>.`,
  });
}
