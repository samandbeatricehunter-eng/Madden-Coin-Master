import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { getOrCreateUser } from "../lib/db-helpers.js";
import { infoEmbed } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Check your coin balance");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const user = await getOrCreateUser(interaction.user.id, interaction.user.username);
  await interaction.editReply({
    embeds: [infoEmbed("Your Balance", `You have **${user.balance.toLocaleString()} coins** 🪙`)],
  });
}
