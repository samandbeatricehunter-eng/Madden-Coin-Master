import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { customPlayerSettingsTable } from "@workspace/db";
import { getSettings } from "../lib/custom-player-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-customplayersettings")
  .setDescription("View or update custom player package settings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("view")
    .setDescription("View current package settings"),
  )
  .addSubcommand(sub => sub
    .setName("set")
    .setDescription("Update a package's creation points and/or coin cost")
    .addStringOption(o => o
      .setName("package")
      .setDescription("Package tier to update")
      .setRequired(true)
      .addChoices(
        { name: "Bronze",         value: "bronze" },
        { name: "Silver",         value: "silver" },
        { name: "Gold",           value: "gold" },
        { name: "K/P Default",    value: "kp" },
      ),
    )
    .addIntegerOption(o => o.setName("points").setDescription("Creation points").setRequired(false).setMinValue(1).setMaxValue(500))
    .addIntegerOption(o => o.setName("cost").setDescription("Coin cost").setRequired(false).setMinValue(0).setMaxValue(9999)),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  if (sub === "view") {
    const s = await getSettings();
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("⚙️ Custom Player Package Settings")
      .addFields(
        { name: "Bronze",      value: `${s.bronzePoints} pts — ${s.bronzeCost} coins`, inline: true },
        { name: "Silver",      value: `${s.silverPoints} pts — ${s.silverCost} coins`, inline: true },
        { name: "Gold",        value: `${s.goldPoints} pts — ${s.goldCost} coins`,   inline: true },
        { name: "K/P Default", value: `${s.kpPoints} pts — ${s.kpCost} coins`,       inline: true },
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // sub === "set"
  const pkg    = interaction.options.getString("package", true) as "bronze"|"silver"|"gold"|"kp";
  const points = interaction.options.getInteger("points");
  const cost   = interaction.options.getInteger("cost");

  if (points == null && cost == null) {
    await interaction.editReply({ content: "❌ Provide at least one of: `points`, `cost`." });
    return;
  }

  const s = await getSettings();
  const update: Partial<typeof s> = { updatedAt: new Date() };

  if (pkg === "bronze") {
    if (points != null) update.bronzePoints = points;
    if (cost   != null) update.bronzeCost   = cost;
  } else if (pkg === "silver") {
    if (points != null) update.silverPoints = points;
    if (cost   != null) update.silverCost   = cost;
  } else if (pkg === "gold") {
    if (points != null) update.goldPoints = points;
    if (cost   != null) update.goldCost   = cost;
  } else {
    if (points != null) update.kpPoints = points;
    if (cost   != null) update.kpCost   = cost;
  }

  await db.update(customPlayerSettingsTable).set(update);

  const s2  = await getSettings();
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Package Settings Updated")
    .addFields(
      { name: "Bronze",      value: `${s2.bronzePoints} pts — ${s2.bronzeCost} coins`, inline: true },
      { name: "Silver",      value: `${s2.silverPoints} pts — ${s2.silverCost} coins`, inline: true },
      { name: "Gold",        value: `${s2.goldPoints} pts — ${s2.goldCost} coins`,   inline: true },
      { name: "K/P Default", value: `${s2.kpPoints} pts — ${s2.kpCost} coins`,       inline: true },
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}
