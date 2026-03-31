import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable } from "@workspace/db";
import { eq, and, or, asc, lt, sql } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

const COMPLETED_STATUS = 2;

export const data = new SlashCommandBuilder()
  .setName("nextopp")
  .setDescription("See your next upcoming opponent — only visible to you");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const user = await getOrCreateUser(interaction.user.id, interaction.user.username);

  if (!user.team) {
    await interaction.editReply({
      content: "❌ You don't have a registered team. Ask the commissioner to set you up with `/admin-setuser`.",
    });
    return;
  }

  const season  = await getOrCreateActiveSeason();
  const teamLower = user.team.toLowerCase().trim();

  const nextGames = await db.select().from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      or(
        sql`lower(${franchiseScheduleTable.homeTeamName}) = ${teamLower}`,
        sql`lower(${franchiseScheduleTable.awayTeamName}) = ${teamLower}`,
      ),
      lt(franchiseScheduleTable.status, COMPLETED_STATUS),
    ))
    .orderBy(asc(franchiseScheduleTable.weekIndex))
    .limit(1);

  if (nextGames.length === 0) {
    await interaction.editReply({
      content: "🏁 No upcoming games found. Either the regular season is complete or no schedule data has been imported yet.",
    });
    return;
  }

  const g       = nextGames[0]!;
  const isHome  = g.homeTeamName.toLowerCase().trim() === teamLower;
  const opponent = isHome ? g.awayTeamName : g.homeTeamName;
  const location = isHome ? "🏠 Home" : "✈️ Away";

  const weekNum = g.weekIndex + 1;
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`🏈 Next Opponent — Week ${weekNum}`)
        .addFields(
          { name: "Your Team", value: user.team,  inline: true },
          { name: "Opponent",  value: opponent,   inline: true },
          { name: "Location",  value: location,   inline: true },
        )
        .setFooter({ text: `Season ${season.seasonNumber} · Week ${weekNum}` })
        .setTimestamp(),
    ],
  });
}
