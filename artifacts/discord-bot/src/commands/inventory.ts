import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";

export const data = new SlashCommandBuilder()
  .setName("inventory")
  .setDescription("Check your inventory for the current season");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings();
  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled by the commissioners." });
    return;
  }

  const user = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const season = await getOrCreateActiveSeason();

  const items = await db.select().from(inventoryTable)
    .where(and(eq(inventoryTable.discordId, interaction.user.id), eq(inventoryTable.seasonId, season.id)));

  const embed = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle(`🎒 ${interaction.user.username}'s Inventory`)
    .setDescription(`Season ${season.seasonNumber} | Balance: **${user.balance.toLocaleString()} coins** 🪙`)
    .setTimestamp();

  const legends = items.filter(i => i.itemType === "legend");
  const customs = items.filter(i => ["custom_player_gold", "custom_player_silver", "custom_player_bronze"].includes(i.itemType));
  const attributes = items.filter(i => i.itemType === "attribute");
  const devUps = items.filter(i => i.itemType === "dev_up");
  const ageResets = items.filter(i => i.itemType === "age_reset");

  if (legends.length > 0) {
    embed.addFields({
      name: `🏆 Legends (${legends.length}/4)`,
      value: legends.map(l => `• ${l.legendName ?? "Unknown"}`).join("\n"),
    });
  }

  if (customs.length > 0) {
    embed.addFields({
      name: `🎨 Custom Players (${customs.length})`,
      value: customs.map(c => {
        const tier = c.customPlayerTier ? c.customPlayerTier.charAt(0).toUpperCase() + c.customPlayerTier.slice(1) : "Unknown";
        return `• ${tier} — ${c.playerName ?? "Unknown"} (${c.playerPosition ?? "?"})`;
      }).join("\n"),
    });
  }

  if (attributes.length > 0) {
    embed.addFields({
      name: `⚡ Attributes (${attributes.length})`,
      value: attributes.map(a => `• ${a.attributeName ?? "Unknown"} — ${a.playerName ?? "Unknown"}`).join("\n"),
    });
  }

  if (devUps.length > 0) {
    embed.addFields({
      name: `📈 Dev Upgrades (${devUps.length})`,
      value: devUps.map(d => `• ${d.playerName ?? "Unknown"} (${d.playerPosition ?? "?"})${d.notes ? ` — ${d.notes}` : ""}`).join("\n"),
    });
  }

  if (ageResets.length > 0) {
    embed.addFields({
      name: `🔄 Age Resets (${ageResets.length})`,
      value: ageResets.map(a => `• ${a.playerName ?? "Unknown"} (${a.playerPosition ?? "?"})`).join("\n"),
    });
  }

  if (items.length === 0) {
    embed.setDescription(`Season ${season.seasonNumber} | Balance: **${user.balance.toLocaleString()} coins** 🪙\n\nYour inventory is empty. Use **/viewstore** to see what's available!`);
  }

  const legendPlusCustom = legends.length + customs.length;
  embed.setFooter({ text: `Legends + Custom Players: ${legendPlusCustom}/7 this season` });

  return interaction.editReply({ embeds: [embed] });
}
