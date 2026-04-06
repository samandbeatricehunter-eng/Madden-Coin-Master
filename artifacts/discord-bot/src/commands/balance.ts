import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { getOrCreateUser } from "../lib/db-helpers.js";
import { infoEmbed } from "../lib/embeds.js";
import { getServerSettings } from "../lib/server-settings.js";

export const data = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Check your coin balance");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const settings = await getServerSettings();
  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled by the commissioners." });
    return;
  }
  const user = await getOrCreateUser(interaction.user.id, interaction.user.username);
  await interaction.editReply({
    embeds: [infoEmbed("Your Balance", `You have **${user.balance.toLocaleString()} coins** 🪙`)],
  });
}
