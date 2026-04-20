import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-store-settings")
  .setDescription("Commissioner: Manage archetypes, legend templates, pricing, and purchase limits")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin = await isAdminUser(interaction.user.id, interaction.guildId!);
  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ Admin only." });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏪 Store & Purchase Settings")
    .setDescription(
      "Use the buttons below to manage your league's store settings.\n\n" +
      "📋 **Archetypes** — Browse and edit custom player archetype attributes\n" +
      "⭐ **Legend Templates** — Set base attribute templates for each legend model\n" +
      "💰 **Prices & Caps** — Set prices and purchase limits for all store items"
    )
    .setFooter({ text: "Changes take effect immediately" });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_arch").setLabel("📋 Archetypes").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ss_lt").setLabel("⭐ Legend Templates").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ss_pc").setLabel("💰 Prices & Caps").setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row1, row2] });
}
