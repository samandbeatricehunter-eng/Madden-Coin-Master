import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { inventoryTable, usersTable } from "@workspace/db";
import { eq, and, or, desc } from "drizzle-orm";
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

const TIER_TO_ITEM_TYPE: Record<string, string> = {
  gold:   "custom_player_gold",
  silver: "custom_player_silver",
  bronze: "custom_player_bronze",
};

function itemSummary(item: typeof inventoryTable.$inferSelect): string {
  const type = ITEM_TYPE_LABELS[item.itemType] ?? item.itemType;
  const parts: string[] = [];
  if (item.legendName) parts.push(item.legendName);
  if (item.playerName) parts.push(item.playerName);
  if (item.playerPosition) parts.push(`(${item.playerPosition})`);
  if (item.attributeName) parts.push(`— ${item.attributeName}`);
  if (item.notes) parts.push(`[${item.notes}]`);
  const perm = item.legendCategory === "permanent" ? " 🔒" : "";
  const detail = parts.length > 0 ? ` — ${parts.join(" ")}` : "";
  return `**ID ${item.id}** · ${type}${perm}${detail}`;
}

async function checkAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAdminUser(interaction.user.id);
}

export const data = new SlashCommandBuilder()
  .setName("admininventory")
  .setDescription("Admin: view, remove, transfer, or manually add inventory items")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("view")
      .setDescription("View inventory items for a user (current season + all permanent items)")
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
  )
  .addSubcommand(sub =>
    sub.setName("add_custom_player")
      .setDescription("Manually label an existing roster player as a permanent custom player for a user")
      .addUserOption(opt =>
        opt.setName("user").setDescription("The user who owns this custom player").setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("player_name").setDescription("Full player name (e.g. John Smith)").setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("position").setDescription("Player position (e.g. QB, HB, WR)").setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("tier")
          .setDescription("Custom player tier")
          .setRequired(true)
          .addChoices(
            { name: "Gold", value: "gold" },
            { name: "Silver", value: "silver" },
            { name: "Bronze", value: "bronze" },
          )
      )
      .addStringOption(opt =>
        opt.setName("notes").setDescription("Optional notes (e.g. archetype, backstory)").setRequired(false)
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

    // Show current-season items AND all permanent items for this user
    const items = await db.select().from(inventoryTable)
      .where(
        and(
          eq(inventoryTable.discordId, targetUser.id),
          or(
            eq(inventoryTable.seasonId, season.id),
            eq(inventoryTable.legendCategory, "permanent"),
          ),
        )
      )
      .orderBy(desc(inventoryTable.addedAt));

    if (items.length === 0) {
      await interaction.reply({
        content: `📦 **${targetUser.username}** has no inventory items.`,
        ephemeral: true,
      });
      return;
    }

    const lines = items.map(itemSummary).join("\n");
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`📦 Inventory — ${targetUser.username}`)
      .setDescription(lines)
      .setFooter({ text: "🔒 = permanent item. Use /admininventory remove <ID> or move <ID> <user> to manage." })
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

  // ── ADD CUSTOM PLAYER ────────────────────────────────────────────────────────
  if (sub === "add_custom_player") {
    const targetUser = interaction.options.getUser("user", true);
    const playerName = interaction.options.getString("player_name", true).trim();
    const position   = interaction.options.getString("position", true).trim().toUpperCase();
    const tier       = interaction.options.getString("tier", true) as "gold" | "silver" | "bronze";
    const notes      = interaction.options.getString("notes")?.trim() ?? null;

    const season = await getOrCreateActiveSeason();

    // Look up user record to get their team name
    const userRow = await db.select({ team: usersTable.team, discordUsername: usersTable.discordUsername })
      .from(usersTable)
      .where(eq(usersTable.discordId, targetUser.id))
      .limit(1);

    if (userRow.length === 0) {
      await interaction.reply({
        content: `❌ **${targetUser.username}** is not registered in the bot. Use \`/admin linkteam\` first.`,
        ephemeral: true,
      });
      return;
    }

    const { team, discordUsername } = userRow[0]!;
    const itemType = TIER_TO_ITEM_TYPE[tier]! as "custom_player_gold" | "custom_player_silver" | "custom_player_bronze";

    const [inserted] = await db.insert(inventoryTable).values({
      discordId:        targetUser.id,
      seasonId:         season.id,
      purchaseId:       0,
      itemType,
      playerName,
      playerPosition:   position,
      notes,
      legendCategory:   "permanent",
      team:             team ?? null,
    }).returning();

    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    const teamNote  = team ? ` (team: **${team}**)` : "";
    const notesNote = notes ? `\n📝 Notes: ${notes}` : "";

    await interaction.reply({
      content: [
        `✅ Added **${playerName}** (${position}) as a permanent **${tierLabel}** custom player for **${discordUsername}**${teamNote}.`,
        `They will now appear under 🗃️ Permanent Custom Players in \`/userstats\`.`,
        notesNote,
        `\n*Item ID: ${inserted?.id ?? "—"} — use \`/admininventory remove\` to undo.*`,
      ].filter(Boolean).join("\n"),
      ephemeral: true,
    });
    return;
  }
}
