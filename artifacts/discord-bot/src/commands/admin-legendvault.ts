import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { inventoryTable, legendsTable, usersTable } from "@workspace/db";
import { eq, and, sql, ilike, isNull, or } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

const PERMANENT_CAP = 4;

async function checkAdmin(interaction: ChatInputCommandInteraction | AutocompleteInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAdminUser(interaction.user.id, interaction.guildId!);
}

export const data = new SlashCommandBuilder()
  .setName("admin-legendvault")
  .setDescription("Manage a user's current-season and permanent legend vault (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Add a legend directly to a user's permanent vault (retroactive / commissioner use)")
      .addUserOption(o => o.setName("user").setDescription("User to receive the legend").setRequired(true))
      .addStringOption(o => o.setName("legend_name").setDescription("Name of the legend (e.g. Jerry Rice)").setRequired(true))
      .addStringOption(o => o.setName("position").setDescription("Position (e.g. WR, QB, CB)").setRequired(true))
      .addStringOption(o => o.setName("description").setDescription("Optional description for the store entry").setRequired(false))
  )
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
  const target = interaction.options.getUser("user", false);
  const season = await getOrCreateActiveSeason(interaction.guildId!);

  // "add_to_user_vault", "vault_view", and "move_in_inventory" all require a target user
  if (!target && sub !== "remove_from_inventory") {
    await interaction.editReply({ content: "❌ Please provide a **user** for this command." });
    return;
  }
  // After the guard above, target is guaranteed non-null for all subs except vaultRemove
  const t = target!;

  // ── ADD (retroactive) ───────────────────────────────────────────────────────
  if (sub === "add_to_user_vault") {
    const legendName = interaction.options.getString("legend_name", true).trim();
    const position   = interaction.options.getString("position", true).trim().toUpperCase();
    const description = interaction.options.getString("description") ?? undefined;

    // Guard: user must exist in the system
    const userRows = await db.select().from(usersTable).where(and(eq(usersTable.discordId, t.id), eq(usersTable.guildId, interaction.guildId!))).limit(1);
    if (!userRows[0]) {
      await interaction.editReply({ content: `❌ <@${t.id}> doesn't have an economy account yet. Add them first.` });
      return;
    }

    // Resolve the team this user controls (permanent vault belongs to the franchise)
    const teamName = userRows[0]!.team ?? null;

    // Guard: permanent vault cap — count by team if available, else by discordId
    const capWhere = and(
      teamName
        ? or(eq(inventoryTable.team, teamName), and(isNull(inventoryTable.team), eq(inventoryTable.discordId, t.id)))
        : eq(inventoryTable.discordId, t.id),
      eq(inventoryTable.itemType, "legend"),
      sql`${inventoryTable.legendCategory} = 'permanent'`,
    );
    const countRows = await db.select({ c: sql<string>`COUNT(*)` })
      .from(inventoryTable)
      .where(capWhere);
    const permanentCount = parseInt(countRows[0]?.c ?? "0", 10);
    if (permanentCount >= PERMANENT_CAP) {
      await interaction.editReply({
        content: `❌ <@${t.id}>${teamName ? ` (${teamName})` : ""} already has **${permanentCount}/${PERMANENT_CAP}** permanent legends. Remove one first.`,
      });
      return;
    }

    // Find or create the legend in the store (case-insensitive name match)
    let legendId: number;
    let wasCreated = false;
    const existing = await db.select().from(legendsTable).where(ilike(legendsTable.name, legendName)).limit(1);

    if (existing[0]) {
      legendId = existing[0].id;
      // Make sure it's marked unavailable (it's being assigned to someone)
      await db.update(legendsTable).set({ isAvailable: false }).where(eq(legendsTable.id, legendId));
    } else {
      // Create a new store entry for this legend
      const [created] = await db.insert(legendsTable).values({
        name: legendName,
        position,
        description: description ?? null,
        isAvailable: false,
      }).returning();
      legendId = created!.id;
      wasCreated = true;
    }

    // Add to permanent vault — stamp with team so the vault follows the franchise
    await db.insert(inventoryTable).values({
      discordId:      t.id,
      seasonId:       season.id,
      purchaseId:     0,            // 0 = admin-granted, no purchase record
      itemType:       "legend",
      legendId,
      legendName,
      playerPosition: position,
      legendCategory: "permanent",
      ...(teamName ? { team: teamName } : {}),
    });

    // Increment all-time legend purchase count
    await db.update(usersTable)
      .set({ totalLegendPurchases: sql`${usersTable.totalLegendPurchases} + 1`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, t.id));

    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("🏅 Legend Added to Permanent Vault")
      .addFields(
        { name: "User",           value: `<@${t.id}>`, inline: true },
        { name: "Legend",         value: `**${legendName}** (${position})`, inline: true },
        { name: "Vault",          value: `${permanentCount + 1}/${PERMANENT_CAP}`, inline: true },
        { name: "Store Entry",    value: wasCreated ? `✅ Created (ID ${legendId})` : `Existing (ID ${legendId})` },
      )
      .setFooter({ text: wasCreated ? "Legend was not in the store — a new entry was created and assigned." : "Legend found in store and assigned." });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── VIEW ────────────────────────────────────────────────────────────────────
  if (sub === "vault_view") {
    // Resolve the user's team so we can show team-owned permanent items
    const [viewUserRow] = await db.select({ team: usersTable.team }).from(usersTable)
      .where(and(eq(usersTable.discordId, t.id), eq(usersTable.guildId, interaction.guildId!))).limit(1);
    const viewTeam = viewUserRow?.team ?? null;

    // Current-season legends: always by discordId
    const currentItems = await db.select().from(inventoryTable)
      .where(and(
        eq(inventoryTable.discordId, t.id),
        eq(inventoryTable.itemType, "legend"),
        sql`${inventoryTable.legendCategory} = 'current'`,
      ))
      .orderBy(inventoryTable.addedAt);

    // Permanent legends: by team (or discordId fallback for pre-team rows)
    const permanentItems = await db.select().from(inventoryTable)
      .where(and(
        eq(inventoryTable.itemType, "legend"),
        sql`${inventoryTable.legendCategory} = 'permanent'`,
        viewTeam
          ? or(eq(inventoryTable.team, viewTeam), and(isNull(inventoryTable.team), eq(inventoryTable.discordId, t.id)))
          : eq(inventoryTable.discordId, t.id),
      ))
      .orderBy(inventoryTable.addedAt);

    const fmt = (arr: typeof currentItems) =>
      arr.length > 0
        ? arr.map(i => `**ID ${i.id}** — ${i.legendName ?? i.playerName ?? "?"} (${i.playerPosition ?? "?"})`).join("\n")
        : "*None*";

    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle(`🏅 Legend Vault — ${t.username}${viewTeam ? ` (${viewTeam})` : ""}`)
      .addFields(
        { name: `⚡ Current Season (${currentItems.length})`,                    value: fmt(currentItems)   },
        { name: `🔒 Permanent Vault (${permanentItems.length}/${PERMANENT_CAP})`, value: fmt(permanentItems) },
      )
      .setFooter({ text: "Use item IDs with /admin-legendvault move or remove" });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── MOVE ────────────────────────────────────────────────────────────────────
  if (sub === "move_in_inventory") {
    const itemId = interaction.options.getInteger("item_id", true);
    const to     = interaction.options.getString("to", true) as "current" | "permanent";

    const rows = await db.select().from(inventoryTable)
      .where(and(eq(inventoryTable.id, itemId), eq(inventoryTable.discordId, t.id), eq(inventoryTable.itemType, "legend")))
      .limit(1);
    const item = rows[0];

    if (!item) {
      await interaction.editReply({ content: `❌ Legend item ID **${itemId}** not found for <@${t.id}>.` });
      return;
    }

    if (item.legendCategory === to) {
      await interaction.editReply({ content: `⚠️ That legend is already in the **${to}** category.` });
      return;
    }

    // Enforce permanent cap when moving to permanent (count by team if available)
    if (to === "permanent") {
      const [moveUserRow] = await db.select({ team: usersTable.team }).from(usersTable)
        .where(and(eq(usersTable.discordId, t.id), eq(usersTable.guildId, interaction.guildId!))).limit(1);
      const moveTeam = moveUserRow?.team ?? null;

      const capWhere = and(
        moveTeam
          ? or(eq(inventoryTable.team, moveTeam), and(isNull(inventoryTable.team), eq(inventoryTable.discordId, t.id)))
          : eq(inventoryTable.discordId, t.id),
        eq(inventoryTable.itemType, "legend"),
        sql`${inventoryTable.legendCategory} = 'permanent'`,
      );
      const permanentCount = await db.select({ count: sql<number>`COUNT(*)` })
        .from(inventoryTable).where(capWhere);
      const count = Number(permanentCount[0]?.count ?? 0);
      if (count >= PERMANENT_CAP) {
        await interaction.editReply({
          content: `❌ <@${t.id}> already has **${count}/${PERMANENT_CAP}** permanent legends. Remove one first before moving another in.`,
        });
        return;
      }

      // Stamp with team so item follows the franchise going forward
      await db.update(inventoryTable)
        .set({ legendCategory: "permanent", ...(moveTeam ? { team: moveTeam } : {}) })
        .where(eq(inventoryTable.id, itemId));
    } else {
      await db.update(inventoryTable)
        .set({ legendCategory: to })
        .where(eq(inventoryTable.id, itemId));
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Legend Moved")
      .setDescription(
        `**${item.legendName ?? item.playerName ?? "?"}** (ID ${itemId}) moved to **${to === "permanent" ? "Permanent Vault 🔒" : "Current Season ⚡"}** for <@${t.id}>.`
      );

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── REMOVE ──────────────────────────────────────────────────────────────────
  if (sub === "remove_from_inventory") {
    const itemId = interaction.options.getInteger("item_id", true);

    const rows = await db.select().from(inventoryTable)
      .where(and(eq(inventoryTable.id, itemId), eq(inventoryTable.itemType, "legend")))
      .limit(1);
    const item = rows[0];

    if (!item) {
      await interaction.editReply({ content: `❌ Legend item ID **${itemId}** not found.` });
      return;
    }

    const ownerId = item.discordId;

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
      .where(eq(usersTable.discordId, ownerId));

    const embed = new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("🗑️ Legend Removed")
      .setDescription(
        `**${item.legendName ?? item.playerName ?? "?"}** (ID ${itemId}) removed from <@${ownerId}>'s inventory and returned to the store.`
      );

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
