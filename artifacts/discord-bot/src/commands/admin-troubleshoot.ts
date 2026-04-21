import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-troubleshoot")
  .setDescription("Commissioner: Hub for repair and maintenance tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
    await interaction.editReply({ content: "❌ Commissioner access required." });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.DarkNavy)
    .setTitle("🔧 Commissioner Troubleshoot Panel")
    .setDescription(
      "Use the buttons below to run repair and maintenance operations.\n\n" +
      "**🔩 Repair User Records**\n" +
      "Recalculates all W/L records and point differential for the active season " +
      "from the raw franchise schedule data. Counts CPU wins and H2H wins equally. " +
      "Also rebuilds the global all-time record.\n\n" +
      "**🔄 Resync Rosters & Data**\n" +
      "Re-stamps team ownership on all inventory and custom player rows, " +
      "force-syncs permanent vault items, and scans every league member's active " +
      "roster to assign matching permanent vault legends.\n\n" +
      "**🏈 Repair Playoff Seeding & Data**\n" +
      "Reviews the current playoff seeding for both conferences. Lets you confirm " +
      "it is incorrect and reseed all 7 AFC and 7 NFC slots from live season records " +
      "using NFL seeding rules. Requires confirmation before any changes are saved.\n\n" +
      "**📊 EOS Test Run**\n" +
      "Read-only dry run of the full end-of-season payout calculation. " +
      "No coins are awarded — shows exactly what each user would receive.\n\n" +
      "**⚡ EOS Manual Run**\n" +
      "Triggers the actual end-of-season payout process for the active season. " +
      "Posts commissioner approval embeds to the commish channel for every user. " +
      "⚠️ Only run this once — duplicate runs will create duplicate payout requests.",
    )
    .setFooter({ text: "All operations are scoped to this server only" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ts_repair_records")
      .setLabel("🔩 Repair User Records")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ts_resync_data")
      .setLabel("🔄 Resync Rosters & Data")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ts_repair_playoff")
      .setLabel("🏈 Repair Playoff Seeding")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ts_eos_testrun")
      .setLabel("📊 EOS Test Run")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ts_eos_manual")
      .setLabel("⚡ EOS Manual Run")
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}
