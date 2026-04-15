import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { isNotNull, and, eq } from "drizzle-orm";
import { NFL_TEAMS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("openteams")
  .setDescription("Show all NFL teams that are not yet claimed by a league member");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const takenRows = await db
    .select({ team: usersTable.team, discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, interaction.guildId!)));

  // Exclude placeholder slots — only count teams with a real linked Discord user
  const taken = new Set(
    takenRows
      .filter(r => !r.discordId.startsWith("unlinked_"))
      .map(r => r.team as string),
  );
  const open = NFL_TEAMS.filter(t => !taken.has(t));

  if (open.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle("🏈 Open Teams")
          .setDescription("All 32 NFL teams are currently assigned to league members!")
          .setTimestamp(),
      ],
    });
  }

  const embeds: EmbedBuilder[] = [];
  const chunkSize = 32;
  for (let i = 0; i < open.length; i += chunkSize) {
    const chunk = open.slice(i, i + chunkSize);
    embeds.push(
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(i === 0 ? `🏈 Open Teams (${open.length} available)` : "🏈 Open Teams (continued)")
        .setDescription(chunk.map(t => `• ${t}`).join("\n"))
        .setTimestamp(),
    );
  }

  return interaction.editReply({ embeds: embeds.slice(0, 10) });
}
