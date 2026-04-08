import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { createSession } from "../lib/custom-player-session.js";
import { positionSelectRow } from "../lib/custom-player-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("purchasecustomplayer")
  .setDescription("Build and purchase a custom player for the draft class");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sessionId = createSession(interaction.user.id, interaction.guild?.id ?? "");

  await interaction.editReply({
    content:
      "**🏈 Custom Player Builder — Step 1 of 8**\n\n" +
      "Select your player's position to get started:",
    components: [positionSelectRow(sessionId)],
  });
}
