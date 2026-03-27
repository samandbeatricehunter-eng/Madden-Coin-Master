import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { inventoryTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

const ITEM_TYPE_LABELS: Record<string, string> = {
  legend: "Legend",
  attribute: "Attribute",
  dev_up: "Dev Up",
  age_reset: "Age Reset",
  custom_player_gold: "Custom Player (Gold)",
  custom_player_silver: "Custom Player (Silver)",
  custom_player_bronze: "Custom Player (Bronze)",
};

function itemSummary(item: typeof inventoryTable.$inferSelect): string {
  const type = ITEM_TYPE_LABELS[item.itemType] ?? item.itemType;
  const parts: string[] = [];
  if (item.legendName) parts.push(item.legendName);
  if (item.playerName) parts.push(item.playerName);
  if (item.playerPosition) parts.push(`(${item.playerPosition})`);
  if (item.attributeName) parts.push(`— ${item.attributeName}`);
  if (item.notes) parts.push(`[${item.notes}]`);
  const detail = parts.length > 0 ? ` — ${parts.join(" ")}` : "";
  return `**ID ${item.id}** · ${type}${detail}`;
}

async function checkAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAdminUser(interaction.user.id);
}

export const data = new SlashCommandBuilder()
  .setName("admininventory")
  .setDescription("Admin: view, remove, or transfer inventory items for any user")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("view")
      .setDescription("View all inventory items for a user (shows item IDs)")
      .addUserOption(opt =>
        opt.setName("user").setDescription("The user whose inventory to view").setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove an inventory item by its ID")
      .addIntegerOption(opt =>
        opt.setName("item_id").setDescription("The item ID (see /admininventory view)").setRequired(true).setMinValue(1)
      )
      .addStringOption(opt =>
        opt.setName("reason").setDescription("Optional reason for the removal").setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub.setName("move")
      .setDescription("Transfer an inventory item to a different user")
      .addIntegerOption(opt =>
        opt.setName("item_id").setDescription("The item ID (see /admininventory view)").setRequired(true).setMinValue(1)
      )
      .addUserOption(opt =>
        opt.setName("to_user").setDescription("The user who will receive the item").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await checkAdmin(interaction))) {
    await interaction.reply({ content: "❌ You do not have permission to use admin commands.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── VIEW ────────────────────────────────────────────────────────────────────
  if (sub === "view") {
    const targetUser = interaction.options.getUser("user", true);
    const season = await getOrCreateActiveSeason();
    const items = await db.select().from(inventoryTable)
      .where(and(eq(inventoryTable.discordId, targetUser.id), eq(inventoryTable.seasonId, season.id)));

    if (items.length === 0) {
      await interaction.reply({
        content: `📦 **${targetUser.username}** has no items in their Season ${season.seasonNumber} inventory.`,
        ephemeral: true,
      });
      return;
    }

    const lines = items.map(itemSummary).join("\n");
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`📦 Inventory — ${targetUser.username} (Season ${season.seasonNumber})`)
      .setDescription(lines)
      .setFooter({ text: "Use /admininventory remove <ID> or /admininventory move <ID> <user> to manage items." })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // ── REMOVE ──────────────────────────────────────────────────────────────────
  if (sub === "remove") {
    const itemId = interaction.options.getInteger("item_id", true);
    const reason = interaction.options.getString("reason");

    const existing = await db.select().from(inventoryTable).where(eq(inventoryTable.id, itemId)).limit(1);
    if (existing.length === 0) {
      await interaction.reply({ content: `❌ No inventory item found with ID **${itemId}**.`, ephemeral: true });
      return;
    }

    const item = existing[0]!;
    await db.delete(inventoryTable).where(eq(inventoryTable.id, itemId));

    const ownerInfo = await db.select({ discordUsername: usersTable.discordUsername })
      .from(usersTable).where(eq(usersTable.discordId, item.discordId)).limit(1);
    const ownerName = ownerInfo[0]?.discordUsername ?? item.discordId;

    const reasonNote = reason ? `\n**Reason:** ${reason}` : "";
    await interaction.reply({
      content: `🗑️ Removed **${itemSummary(item)}** from **${ownerName}**'s inventory.${reasonNote}`,
      ephemeral: true,
    });
    return;
  }

  // ── MOVE ────────────────────────────────────────────────────────────────────
  if (sub === "move") {
    const itemId = interaction.options.getInteger("item_id", true);
    const toUser = interaction.options.getUser("to_user", true);

    const existing = await db.select().from(inventoryTable).where(eq(inventoryTable.id, itemId)).limit(1);
    if (existing.length === 0) {
      await interaction.reply({ content: `❌ No inventory item found with ID **${itemId}**.`, ephemeral: true });
      return;
    }

    const item = existing[0]!;
    const oldOwnerInfo = await db.select({ discordUsername: usersTable.discordUsername })
      .from(usersTable).where(eq(usersTable.discordId, item.discordId)).limit(1);
    const oldOwnerName = oldOwnerInfo[0]?.discordUsername ?? item.discordId;

    await db.update(inventoryTable)
      .set({ discordId: toUser.id })
      .where(eq(inventoryTable.id, itemId));

    await interaction.reply({
      content: `🔄 Transferred **${itemSummary(item)}** from **${oldOwnerName}** → **${toUser.username}**.`,
      ephemeral: true,
    });
    return;
  }
}
