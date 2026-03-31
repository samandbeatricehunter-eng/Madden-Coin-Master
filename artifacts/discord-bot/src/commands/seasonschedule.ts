import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, usersTable } from "@workspace/db";
import { eq, and, or, asc, sql } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

const MIN_COMPLETED_STATUS = 2; // Madden: 1=upcoming, 2=CPU-completed, 3=H2H-completed

export const data = new SlashCommandBuilder()
  .setName("seasonschedule")
  .setDescription("View your full season schedule — only visible to you");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const user = await getOrCreateUser(interaction.user.id, interaction.user.username);

  if (!user.team) {
    await interaction.editReply({
      content: "❌ You don't have a registered team. Ask the commissioner to set you up with `/admin-setuser`.",
    });
    return;
  }

  const season = await getOrCreateActiveSeason();
  const teamLower = user.team.toLowerCase().trim();

  const allGames = await db.select().from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      or(
        sql`lower(${franchiseScheduleTable.homeTeamName}) = ${teamLower}`,
        sql`lower(${franchiseScheduleTable.awayTeamName}) = ${teamLower}`,
      ),
    ))
    .orderBy(asc(franchiseScheduleTable.weekIndex));

  if (allGames.length === 0) {
    await interaction.editReply({
      content: "📭 No schedule data found yet. The commissioner needs to run `/franchiseupdate` first.",
    });
    return;
  }

  const played = allGames.filter(g => g.status >= MIN_COMPLETED_STATUS).length;

  const lines = allGames.map(g => {
    const isHome     = g.homeTeamName.toLowerCase().trim() === teamLower;
    const opponent   = isHome ? g.awayTeamName : g.homeTeamName;
    const location   = isHome ? "vs" : "@";
    const myScore    = isHome ? g.homeScore : g.awayScore;
    const oppScore   = isHome ? g.awayScore : g.homeScore;

    const weekNum = g.weekIndex + 1;
    if (g.status >= MIN_COMPLETED_STATUS && myScore !== null && oppScore !== null) {
      const tied  = myScore === oppScore;
      const won   = myScore > oppScore;
      const label = tied ? "T" : (won ? "W" : "L");
      const emoji = tied ? "🤝" : (won ? "✅" : "❌");
      return `**Wk ${weekNum}** ${location} ${opponent} — ${emoji} **${label}** (${myScore}–${oppScore})`;
    }
    return `**Wk ${weekNum}** ${location} ${opponent} — ⏳ Upcoming`;
  });

  const description = lines.join("\n");

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`📅 ${user.team} — Season ${season.seasonNumber} Schedule`)
        .setDescription(description.length > 4000 ? description.slice(0, 3997) + "..." : description)
        .setFooter({ text: `${played} of ${allGames.length} games played` })
        .setTimestamp(),
    ],
  });
}
