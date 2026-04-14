import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { isNotNull, asc, and, eq } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("teamlist")
  .setDescription("Show all league members and their assigned NFL teams");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const members = await db
    .select({
      discordId: usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team: usersTable.team,
    })
    .from(usersTable)
    .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, interaction.guildId!)))
    .orderBy(asc(usersTable.team));

  if (members.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle("🏈 League Teams")
          .setDescription("No teams have been assigned yet. Commissioners can link users to teams via `/setuser`.")
          .setTimestamp(),
      ],
    });
  }

  const lines = members.map(m => `**${m.team}** — <@${m.discordId}>`);

  const embeds: EmbedBuilder[] = [];
  for (let i = 0; i < lines.length; i += 25) {
    const chunk = lines.slice(i, i + 25);
    embeds.push(
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(i === 0 ? `🏈 League Teams (${members.length} total)` : "🏈 League Teams (continued)")
        .setDescription(chunk.join("\n"))
        .setTimestamp(),
    );
  }

  return interaction.editReply({ embeds: embeds.slice(0, 10) });
}
