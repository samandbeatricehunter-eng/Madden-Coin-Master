import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { legendsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { LIMITS, ATTRIBUTES } from "../lib/constants.js";
import { getOrCreateActiveSeason, getSeasonRules } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";

export const data = new SlashCommandBuilder()
  .setName("viewstore")
  .setDescription("View all available items in the store");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings();

  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled by the commissioners." });
    return;
  }

  const season = await getOrCreateActiveSeason();
  const rules  = await getSeasonRules(season);

  const availableLegends = settings.legendsEnabled
    ? await db.select().from(legendsTable).where(eq(legendsTable.isAvailable, true)).orderBy(asc(legendsTable.position), asc(legendsTable.name))
    : [];

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏪 Madden League Store")
    .setTimestamp();

  // Legends
  if (settings.legendsEnabled) {
    const legendList = availableLegends.length > 0
      ? availableLegends.map(l => `• **${l.name}** (${l.position})${l.description ? ` — ${l.description}` : ""}`).join("\n")
      : "No legends currently available.";
    embed.addFields({
      name: `🏆 Legends — ${rules.legendCost.toLocaleString()} coins each`,
      value: legendList.length > 1024 ? legendList.substring(0, 1020) + "..." : legendList,
    });
  }

  // Attributes
  if (settings.attributeUpgradesEnabled) {
    const coreAttrNote = rules.coreAttrCost !== rules.nonCoreAttrCost
      ? `Core attrs: **${rules.coreAttrCost} coins/pt** (cap ${rules.coreAttrCap}/season) • Non-core: **${rules.nonCoreAttrCost} coins/pt** (cap ${rules.nonCoreAttrCap}/season)`
      : `**${rules.coreAttrCost} coins/pt** — cap ${rules.coreAttrCap}/season`;
    embed.addFields({
      name: "⚡ Attribute Upgrades",
      value: `${coreAttrNote}\nAvailable attributes: ${ATTRIBUTES.join(", ")}`,
    });
  }

  // Dev Ups
  if (settings.devUpgradesEnabled) {
    embed.addFields({
      name: `📈 Development Upgrade — ${rules.devUpsCost} coins each`,
      value: `Upgrade a player's development trait. **Limit: ${rules.devUpsCap}/season.**\nYou must specify the player name and position.`,
    });
  }

  // Age Resets
  if (settings.ageResetsEnabled) {
    embed.addFields({
      name: `🔄 Age Reset — ${rules.ageResetCost} coins each`,
      value: `Reset a player's age. **Limit: ${rules.ageResetsCap}/season.**\nYou must specify the player name and position.`,
    });
  }

  // Custom Players
  if (settings.customSuperstarsEnabled) {
    embed.addFields({
      name: "🎨 Custom Players",
      value: [
        `• **Gold** — ${rules.customGoldCost} coins`,
        `• **Silver** — ${rules.customSilverCost} coins`,
        `• **Bronze** — ${rules.customBronzeCost} coins`,
      ].join("\n"),
    });
  }

  if (embed.data.fields?.length === 0) {
    embed.setDescription("*No store items are currently enabled.*");
  }

  embed.setFooter({ text: `Prices shown are Season ${season.seasonNumber} rates • Use /purchase to buy • Combined Legends + Custom Players limit: ${LIMITS.maxLegendsPlusCustomPlayers}` });

  return interaction.editReply({ embeds: [embed] });
}
