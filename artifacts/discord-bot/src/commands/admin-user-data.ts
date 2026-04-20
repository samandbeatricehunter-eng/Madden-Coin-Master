import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-user-data")
  .setDescription("Admin: Manage user accounts — link/unlink teams, view/edit stats, delete data")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export function buildUserDataHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("👤 User Data Management Hub")
    .setDescription(
      "Select an action below. All menus are ephemeral (only visible to you).\n\n" +
      "**Row 1 — User Actions**\n" +
      "🔵 View All User Teams | ⬛ Link New User | 🔴 Unlink User\n" +
      "⬛ View/Edit User Data | 🔴 Delete User Data"
    )
    .setFooter({ text: "Admin User Data Hub — selections expire after 15 minutes" })
    .setTimestamp();
}

export function buildUserDataHubRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ud_view_teams")
      .setLabel("View All User Teams")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ud_link")
      .setLabel("Link New User")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ud_unlink")
      .setLabel("Unlink User")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ud_view_edit")
      .setLabel("View/Edit User Data")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ud_delete")
      .setLabel("Delete User Data")
      .setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ud_close")
      .setLabel("✖ Close Hub")
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2];
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
    embeds: [buildUserDataHubEmbed()],
    components: buildUserDataHubRows(),
    ephemeral: true,
  });
}
