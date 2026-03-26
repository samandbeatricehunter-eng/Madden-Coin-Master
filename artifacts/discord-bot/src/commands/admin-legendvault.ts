import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { inventoryTable, legendsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

const PERMANENT_CAP = 4;

async function checkAdmin(interaction: ChatInputCommandInteraction | AutocompleteInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAdminUser(interaction.user.id);
}

export const data = new SlashCommandBuilder()
  .setName("admin-legendvault")
  .setDescription("Manage a user's current-season and permanent legend vault (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("view")
      .setDescription("View all legend inventory for a user (shows item IDs)")
      .addUserOption(o => o.setName("user").setDescription("User to inspect").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("move")
      .setDescription("Move a legend between current and permanent categories")
      .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
      .addIntegerOption(o => o.setName("item_id").setDescription("Inventory item ID (see /admin-legendvault view)").setRequired(true).setMinValue(1))
      .addStringOption(o =>
        o.setName("to")
          .setDescription("Category to move the legend to")
          .setRequired(true)
          .addChoices(
            { name: "Current (active this season)", value: "current" },
            { name: "Permanent vault",              value: "permanent" },
          )
      )
  )
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove a legend from a user's inventory entirely (returns it to the store)")
      .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
      .addIntegerOption(o => o.setName("item_id").setDescription("Inventory item ID (see /admin-legendvault view)").setRequired(true).setMinValue(1))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!(await checkAdmin(interaction))) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const sub    = interaction.options.getSubcommand();
  const target = interaction.options.getUser("user", true);
  const season = await getOrCreateActiveSeason();

  // ── VIEW ────────────────────────────────────────────────────────────────────
  if (sub === "view") {
    const items = await db.select().from(inventoryTable)
      .where(and(eq(inventoryTable.discordId, target.id), eq(inventoryTable.itemType, "legend")))
      .orderBy(inventoryTable.legendCategory, inventoryTable.addedAt);

    const current   = items.filter(i => i.legendCategory === "current");
    const permanent = items.filter(i => i.legendCategory === "permanent");

    const fmt = (arr: typeof items) =>
      arr.length > 0
        ? arr.map(i => `**ID ${i.id}** — ${i.legendName ?? i.playerName ?? "?"} (${i.playerPosition ?? "?"})`).join("\n")
        : "*None*";

    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle(`🏅 Legend Vault — ${target.username}`)
      .addFields(
        { name: `⚡ Current Season (${current.length})`,           value: fmt(current)   },
        { name: `🔒 Permanent Vault (${permanent.length}/${PERMANENT_CAP})`, value: fmt(permanent) },
      )
      .setFooter({ text: "Use item IDs with /admin-legendvault move or remove" });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── MOVE ────────────────────────────────────────────────────────────────────
  if (sub === "move") {
    const itemId = interaction.options.getInteger("item_id", true);
    const to     = interaction.options.getString("to", true) as "current" | "permanent";

    const rows = await db.select().from(inventoryTable)
      .where(and(eq(inventoryTable.id, itemId), eq(inventoryTable.discordId, target.id), eq(inventoryTable.itemType, "legend")))
      .limit(1);
    const item = rows[0];

    if (!item) {
      await interaction.editReply({ content: `❌ Legend item ID **${itemId}** not found for <@${target.id}>.` });
      return;
    }

    if (item.legendCategory === to) {
      await interaction.editReply({ content: `⚠️ That legend is already in the **${to}** category.` });
      return;
    }

    // Enforce permanent cap when moving to permanent
    if (to === "permanent") {
      const permanentCount = await db.select({ count: sql<number>`COUNT(*)` })
        .from(inventoryTable)
        .where(and(
          eq(inventoryTable.discordId, target.id),
          eq(inventoryTable.itemType, "legend"),
          sql`${inventoryTable.legendCategory} = 'permanent'`,
        ));
      const count = Number(permanentCount[0]?.count ?? 0);
      if (count >= PERMANENT_CAP) {
        await interaction.editReply({
          content: `❌ <@${target.id}> already has **${count}/${PERMANENT_CAP}** permanent legends. Remove one first before moving another in.`,
        });
        return;
      }
    }

    await db.update(inventoryTable)
      .set({ legendCategory: to })
      .where(eq(inventoryTable.id, itemId));

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Legend Moved")
      .setDescription(
        `**${item.legendName ?? item.playerName ?? "?"}** (ID ${itemId}) moved to **${to === "permanent" ? "Permanent Vault 🔒" : "Current Season ⚡"}** for <@${target.id}>.`
      );

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── REMOVE ──────────────────────────────────────────────────────────────────
  if (sub === "remove") {
    const itemId = interaction.options.getInteger("item_id", true);

    const rows = await db.select().from(inventoryTable)
      .where(and(eq(inventoryTable.id, itemId), eq(inventoryTable.discordId, target.id), eq(inventoryTable.itemType, "legend")))
      .limit(1);
    const item = rows[0];

    if (!item) {
      await interaction.editReply({ content: `❌ Legend item ID **${itemId}** not found for <@${target.id}>.` });
      return;
    }

    // Return legend to store
    if (item.legendId) {
      await db.update(legendsTable).set({ isAvailable: true }).where(eq(legendsTable.id, item.legendId));
    }

    // Remove from inventory
    await db.delete(inventoryTable).where(eq(inventoryTable.id, itemId));

    // Decrement all-time legend count
    await db.update(usersTable)
      .set({
        totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.discordId, target.id));

    const embed = new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("🗑️ Legend Removed")
      .setDescription(
        `**${item.legendName ?? item.playerName ?? "?"}** (ID ${itemId}) removed from <@${target.id}>'s inventory and returned to the store.`
      );

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
