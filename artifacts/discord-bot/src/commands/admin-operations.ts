import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("admin-operations")
  .setDescription("Admin hub — set week, advance week, manage season, and manage league rules")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export function buildAdminOpsEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("⚙️ Admin Operations Hub")
    .setDescription(
      "**📅 Set Week** — Change the current week without triggering any auto-actions.\n\n" +
      "**⏩ Advance Week** — Advance to the next week with all auto-actions:\n" +
      "creates matchup channels, awards GOTW bonuses, posts articles, runs playoff flows, and more.\n" +
      "When advancing from Training Camp, the season number will automatically roll over.\n\n" +
      "**🔢 Set Season Number** — Jump the active season to a specific number (1 – franchise limit).\n\n" +
      "**📋 View / Edit Rules** — Browse and edit the league rulebook by section."
    )
    .setFooter({ text: "Admin Operations Hub — selections expire after 15 minutes" })
    .setTimestamp();
}

export function buildAdminOpsRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_set_week").setLabel("📅 Set Week").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_advance_week").setLabel("⏩ Advance Week").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_set_season_num").setLabel("🔢 Set Season Number").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_rules").setLabel("📋 View / Edit Rules").setStyle(ButtonStyle.Secondary),
  );
  return [row1, row3];
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    embeds: [buildAdminOpsEmbed()],
    components: buildAdminOpsRows(),
    ephemeral: true,
  });
}
