import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { legendsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { LIMITS, ATTRIBUTES } from "../lib/constants.js";
import { getOrCreateActiveSeason, getSeasonRules } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("viewstore")
  .setDescription("View all available items in the store");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason();
  const rules  = await getSeasonRules(season);

  const availableLegends = await db.select().from(legendsTable)
    .where(eq(legendsTable.isAvailable, true))
    .orderBy(asc(legendsTable.position), asc(legendsTable.name));

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏪 Madden League Store")
    .setTimestamp();

  // Legends
  if (availableLegends.length > 0) {
    const legendList = availableLegends.map(l => `• **${l.name}** (${l.position})${l.description ? ` — ${l.description}` : ""}`).join("\n");
    embed.addFields({
      name: `🏆 Legends — ${rules.legendCost.toLocaleString()} coins each`,
      value: legendList.length > 1024 ? legendList.substring(0, 1020) + "..." : legendList,
    });
  } else {
    embed.addFields({ name: `🏆 Legends — ${rules.legendCost.toLocaleString()} coins each`, value: "No legends currently available." });
  }

  // Attributes
  const coreAttrNote  = rules.coreAttrCost !== rules.nonCoreAttrCost
    ? `Core attrs: **${rules.coreAttrCost} coins/pt** (cap ${rules.coreAttrCap}/season) • Non-core: **${rules.nonCoreAttrCost} coins/pt** (cap ${rules.nonCoreAttrCap}/season)`
    : `**${rules.coreAttrCost} coins/pt** — cap ${rules.coreAttrCap}/season`;
  embed.addFields({
    name: `⚡ Attribute Upgrades`,
    value: `${coreAttrNote}\nSpeed capped at ${LIMITS.speedPointsPerSeason} pts/season.\nAvailable attributes: ${ATTRIBUTES.join(", ")}`,
  });

  // Dev Ups
  embed.addFields({
    name: `📈 Development Upgrade — ${rules.devUpsCost} coins each`,
    value: `Upgrade a player's development trait. **Limit: ${rules.devUpsCap}/season.**\nYou must specify the player name and position.`,
  });

  // Age Resets
  embed.addFields({
    name: `🔄 Age Reset — ${rules.ageResetCost} coins each`,
    value: `Reset a player's age. **Limit: ${rules.ageResetsCap}/season.**\nYou must specify the player name and position.`,
  });

  // Custom Players
  embed.addFields({
    name: "🎨 Custom Players",
    value: [
      `• **Gold** — ${rules.customGoldCost} coins`,
      `• **Silver** — ${rules.customSilverCost} coins`,
      `• **Bronze** — ${rules.customBronzeCost} coins`,
    ].join("\n"),
  });

  embed.setFooter({ text: `Prices shown are Season ${season.seasonNumber} rates • Use /purchase to buy • Combined Legends + Custom Players limit: ${LIMITS.maxLegendsPlusCustomPlayers}` });

  return interaction.editReply({ embeds: [embed] });
}
