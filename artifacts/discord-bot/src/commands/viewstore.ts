import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { legendsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { COSTS, LIMITS, ATTRIBUTES } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("viewstore")
  .setDescription("View all available items in the store");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const availableLegends = await db.select().from(legendsTable).where(eq(legendsTable.isAvailable, true));

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏪 Madden League Store")
    .setTimestamp();

  // Legends
  if (availableLegends.length > 0) {
    const legendList = availableLegends.map(l => `• **${l.name}** (${l.position})${l.description ? ` — ${l.description}` : ""}`).join("\n");
    embed.addFields({
      name: `🏆 Legends — ${COSTS.legend.toLocaleString()} coins each`,
      value: legendList.length > 1024 ? legendList.substring(0, 1020) + "..." : legendList,
    });
  } else {
    embed.addFields({ name: "🏆 Legends", value: "No legends currently available." });
  }

  // Attributes
  embed.addFields({
    name: `⚡ Attribute Upgrades — ${COSTS.attribute} coins each`,
    value: `Boost any player attribute by 1 point. **Limit: ${LIMITS.attributesPerSeason}/season** (Speed capped at ${LIMITS.speedPointsPerSeason} pts/season).\nAvailable attributes: ${ATTRIBUTES.join(", ")}`,
  });

  // Dev Ups
  embed.addFields({
    name: `📈 Development Upgrade — ${COSTS.dev_up} coins each`,
    value: `Upgrade a player's development trait. **Limit: ${LIMITS.devUpsPerSeason}/season.**\nYou must specify the player name and position.`,
  });

  // Age Resets
  embed.addFields({
    name: `🔄 Age Reset — ${COSTS.age_reset} coins each`,
    value: `Reset a player's age. **Limit: ${LIMITS.ageResetsPerSeason}/season.**\nYou must specify the player name and position.`,
  });

  // Custom Players
  embed.addFields({
    name: "🎨 Custom Players",
    value: [
      `• **Gold** — ${COSTS.custom_player_gold} coins`,
      `• **Silver** — ${COSTS.custom_player_silver} coins`,
      `• **Bronze** — ${COSTS.custom_player_bronze} coins`,
    ].join("\n"),
  });

  embed.setFooter({ text: `Use /purchase to buy items • Combined Legends + Custom Players limit: ${LIMITS.maxLegendsPlusCustomPlayers}/season` });

  return interaction.editReply({ embeds: [embed] });
}
