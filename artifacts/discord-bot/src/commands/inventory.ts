import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { inventoryTable, usersTable } from "@workspace/db";
import { eq, and, or, isNull, sql } from "drizzle-orm";
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

  const user = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
  const season = await getOrCreateActiveSeason(interaction.guildId!);

  // ── Current-season items (devUps, ageResets, attributes, this season's legends/customs) ──
  // These are non-permanent items bought in the active season.
  const currentItems = await db.select().from(inventoryTable)
    .where(and(
      eq(inventoryTable.discordId, interaction.user.id),
      eq(inventoryTable.seasonId, season.id),
      sql`${inventoryTable.legendCategory} != 'permanent'`,
    ));

  // ── Permanent vault items (legends + custom players from past seasons) ──
  // Permanent items are anchored to the TEAM, not the user, so new owners of a franchise
  // can still see them. Fall back to discordId match for rows that pre-date the team column.
  let permanentItems: typeof currentItems = [];
  if (user.team) {
    permanentItems = await db.select().from(inventoryTable)
      .where(and(
        sql`${inventoryTable.legendCategory} = 'permanent'`,
        or(
          eq(inventoryTable.team, user.team),
          and(isNull(inventoryTable.team), eq(inventoryTable.discordId, interaction.user.id)),
        ),
      ));
  } else {
    permanentItems = await db.select().from(inventoryTable)
      .where(and(
        eq(inventoryTable.discordId, interaction.user.id),
        sql`${inventoryTable.legendCategory} = 'permanent'`,
      ));
  }

  const items = [...currentItems, ...permanentItems];

  const embed = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle(`🎒 ${interaction.user.username}'s Inventory`)
    .setDescription(`Season ${season.seasonNumber} | Balance: **${user.balance.toLocaleString()} coins** 🪙`)
    .setTimestamp();

  const currentLegends = currentItems.filter(i => i.itemType === "legend");
  const permanentLegends = permanentItems.filter(i => i.itemType === "legend");
  const currentCustoms = currentItems.filter(i => ["custom_player_gold", "custom_player_silver", "custom_player_bronze"].includes(i.itemType));
  const permanentCustoms = permanentItems.filter(i => ["custom_player_gold", "custom_player_silver", "custom_player_bronze"].includes(i.itemType));
  const attributes = currentItems.filter(i => i.itemType === "attribute");
  const devUps = currentItems.filter(i => i.itemType === "dev_up");
  const ageResets = currentItems.filter(i => i.itemType === "age_reset");

  const totalLegends = currentLegends.length + permanentLegends.length;
  const totalCustoms = currentCustoms.length + permanentCustoms.length;

  if (permanentLegends.length > 0) {
    embed.addFields({
      name: `🔒 Permanent Vault Legends (${permanentLegends.length}/4)`,
      value: permanentLegends.map(l => `• ${l.legendName ?? l.playerName ?? "Unknown"}`).join("\n"),
    });
  }

  if (currentLegends.length > 0) {
    embed.addFields({
      name: `🏆 This Season's Legends (${currentLegends.length})`,
      value: currentLegends.map(l => `• ${l.legendName ?? "Unknown"}`).join("\n"),
    });
  }

  if (permanentCustoms.length > 0) {
    embed.addFields({
      name: `🔒 Permanent Custom Players (${permanentCustoms.length})`,
      value: permanentCustoms.map(c => {
        const tier = c.customPlayerTier ? c.customPlayerTier.charAt(0).toUpperCase() + c.customPlayerTier.slice(1) : "Unknown";
        return `• ${tier} — ${c.playerName ?? "Unknown"} (${c.playerPosition ?? "?"})`;
      }).join("\n"),
    });
  }

  if (currentCustoms.length > 0) {
    embed.addFields({
      name: `🎨 This Season's Custom Players (${currentCustoms.length})`,
      value: currentCustoms.map(c => {
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

  embed.setFooter({ text: `Legends + Custom Players: ${totalLegends + totalCustoms}/7 this season` });

  return interaction.editReply({ embeds: [embed] });
}
