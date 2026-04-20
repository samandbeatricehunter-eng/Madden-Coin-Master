import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-payout")
  .setDescription("Admin: all payout management tools in one interactive hub")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export function buildPayoutHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x2d6a4f)
    .setTitle("🏈 Payout Management Hub")
    .setDescription(
      "Select an action below. All menus are ephemeral (only visible to you).\n\n" +
      "**Row 1 — Player Payouts**\n" +
      "🔴 GOTW Voting | 🔵 POTW Winners | 🟢 Issue One-Time Payout\n" +
      "🔴 Deduct Coins | ⬛ Transfer Coins\n\n" +
      "**Row 2 — Game Management**\n" +
      "⬛ Issue Game Payout | 🟡 Correct Game Payout | 🔵 Set Game Payouts\n\n" +
      "**Row 3 — Configuration**\n" +
      "⬛ New Member Bonus | ⬛ GOTW Guess Bonus | ⬛ POTW Winner Bonus\n" +
      "⬛ EOS Payouts & Tiers | ⬛ Milestone Payouts & Tiers"
    )
    .setFooter({ text: "Admin Payout Hub — selections expire after 15 minutes" })
    .setTimestamp();
}

export function buildPayoutHubRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ap_gotw")
      .setLabel("GOTW Voting")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ap_potw")
      .setLabel("POTW Winners")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ap_addcoins")
      .setLabel("Issue One-Time Payout")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ap_removecoins")
      .setLabel("Deduct Coins")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ap_transfer")
      .setLabel("Transfer Coins")
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ap_game")
      .setLabel("Issue Game Payout")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ap_correct")
      .setLabel("Correct Game Payout")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ap_setpay")
      .setLabel("Set Game Payouts (Reg/Playoffs)")
      .setStyle(ButtonStyle.Primary),
  );

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ap_newmember")
      .setLabel("Set New Member Bonus")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ap_gotwbonus")
      .setLabel("Set GOTW Guess Bonus")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ap_potwbonus")
      .setLabel("Set POTW Winner Bonus")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ap_eos")
      .setLabel("Set EOS Payouts & Tiers")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ap_milestone")
      .setLabel("Set Milestone Payouts & Tiers")
      .setStyle(ButtonStyle.Secondary),
  );

  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ap_close")
      .setLabel("✖ Close Hub")
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2, row3, row4];
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const member         = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true });
    return;
  }

  await interaction.reply({
    embeds: [buildPayoutHubEmbed()],
    components: buildPayoutHubRows(),
    ephemeral: true,
  });
}
