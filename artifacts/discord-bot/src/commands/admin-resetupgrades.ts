import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonStatsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason, getSeasonStats } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("resetupgrades")
  .setDescription("Commissioner: Reset a user's upgrade counts for the current season")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(opt =>
    opt.setName("user").setDescription("The user to reset").setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("type")
      .setDescription("Which upgrades to reset?")
      .setRequired(true)
      .addChoices(
        { name: "All upgrades (attributes, dev ups, age resets)", value: "all" },
        { name: "Core attributes only", value: "core_attr" },
        { name: "Non-core attributes only", value: "non_core_attr" },
        { name: "All attributes (core + non-core)", value: "attributes" },
        { name: "Dev Upgrades only", value: "dev_ups" },
        { name: "Age Resets only", value: "age_resets" },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user", true);
  const resetType = interaction.options.getString("type", true);

  await getOrCreateUser(target.id, target.username);
  const season = await getOrCreateActiveSeason();
  await getSeasonStats(target.id, season.id);

  const updates: Partial<{
    coreAttrPurchased: number;
    nonCoreAttrPurchased: number;
    devUpsPurchased: number;
    ageResetsPurchased: number;
  }> = {};

  const resetFields: string[] = [];

  if (resetType === "all" || resetType === "attributes" || resetType === "core_attr") {
    updates.coreAttrPurchased = 0;
    if (resetType !== "non_core_attr") resetFields.push("Core Attributes");
  }
  if (resetType === "all" || resetType === "attributes" || resetType === "non_core_attr") {
    updates.nonCoreAttrPurchased = 0;
    if (resetType !== "core_attr") resetFields.push("Non-Core Attributes");
  }
  if (resetType === "all" || resetType === "dev_ups") {
    updates.devUpsPurchased = 0;
    resetFields.push("Dev Upgrades");
  }
  if (resetType === "all" || resetType === "age_resets") {
    updates.ageResetsPurchased = 0;
    resetFields.push("Age Resets");
  }

  await db.update(seasonStatsTable)
    .set(updates)
    .where(and(
      eq(seasonStatsTable.discordId, target.id),
      eq(seasonStatsTable.seasonId, season.id),
    ));

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🔄 Upgrades Reset")
    .setDescription(`Reset the following for ${target.toString()} (Season ${season.seasonNumber}):\n\n${resetFields.map(f => `• ${f}`).join("\n")}`)
    .setTimestamp();

  try {
    await target.send(
      `🔄 A commissioner has reset your **${resetFields.join(", ")}** upgrade counts for Season ${season.seasonNumber}.`
    ).catch(() => {});
  } catch (_) {}

  return interaction.editReply({ embeds: [embed] });
}
