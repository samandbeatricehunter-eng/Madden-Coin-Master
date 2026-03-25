import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { getOrCreateUser, getUserBalance, deductBalance, addBalance, logTransaction } from "../lib/db-helpers.js";
import { successEmbed, errorEmbed } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("sendcoins")
  .setDescription("Send coins to another user")
  .addUserOption(opt =>
    opt.setName("user").setDescription("The user to send coins to").setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName("amount").setDescription("Amount of coins to send").setRequired(true).setMinValue(1)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);

  if (target.id === interaction.user.id) {
    return interaction.editReply({ embeds: [errorEmbed("Invalid Transfer", "You cannot send coins to yourself.")] });
  }
  if (target.bot) {
    return interaction.editReply({ embeds: [errorEmbed("Invalid Transfer", "You cannot send coins to a bot.")] });
  }

  await getOrCreateUser(interaction.user.id, interaction.user.username);
  await getOrCreateUser(target.id, target.username);

  const balance = await getUserBalance(interaction.user.id);
  if (balance < amount) {
    return interaction.editReply({
      embeds: [errorEmbed("Insufficient Funds", `You only have **${balance.toLocaleString()} coins** but tried to send **${amount.toLocaleString()} coins**.`)],
    });
  }

  await deductBalance(interaction.user.id, amount);
  await addBalance(target.id, amount);

  await logTransaction(
    interaction.user.id,
    -amount,
    "sendcoins_sent",
    `Sent to ${target.username}`,
    target.id,
  );
  await logTransaction(
    target.id,
    amount,
    "sendcoins_received",
    `Received from ${interaction.user.username}`,
    interaction.user.id,
  );

  return interaction.editReply({
    embeds: [successEmbed("Coins Sent!", `You sent **${amount.toLocaleString()} coins** to ${target.toString()} 🪙`)],
  });
}
