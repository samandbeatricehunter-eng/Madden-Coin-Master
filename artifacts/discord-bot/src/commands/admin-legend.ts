import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { legendsTable, inventoryTable, usersTable } from "@workspace/db";
import { eq, and, asc, inArray, sql } from "drizzle-orm";
import { DEFAULT_LEGENDS } from "../lib/default-legends.js";

export const data = new SlashCommandBuilder()
  .setName("legend")
  .setDescription("Commissioner: Manage available legends")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Add a new legend to the store")
      .addStringOption(opt => opt.setName("name").setDescription("Legend name").setRequired(true))
      .addStringOption(opt => opt.setName("position").setDescription("Player position").setRequired(true))
      .addStringOption(opt => opt.setName("description").setDescription("Optional description").setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName("list")
      .setDescription("View all legends — store, current-season owned, and permanent vaults")
  )
  .addSubcommand(sub =>
    sub.setName("edit")
      .setDescription("Edit a legend's details")
      .addIntegerOption(opt => opt.setName("id").setDescription("Legend ID").setRequired(true))
      .addStringOption(opt => opt.setName("name").setDescription("New name").setRequired(false))
      .addStringOption(opt => opt.setName("position").setDescription("New position").setRequired(false))
      .addStringOption(opt => opt.setName("description").setDescription("New description").setRequired(false))
      .addBooleanOption(opt => opt.setName("available").setDescription("Set availability").setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove a legend from the store")
      .addIntegerOption(opt => opt.setName("id").setDescription("Legend ID to remove").setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName("seed-defaults")
      .setDescription("Add any missing default legends to the store without overwriting existing ones")
  );

// Split long line arrays into multiple embed fields to stay under Discord's 1024-char limit
function chunkLines(lines: string[], label: string): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  let current: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > 1020 && current.length > 0) {
      fields.push({ name: fields.length === 0 ? label : `${label} (cont.)`, value: current.join("\n") });
      current = [];
      len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length > 0) {
    fields.push({ name: fields.length === 0 ? label : `${label} (cont.)`, value: current.join("\n") });
  }
  return fields;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── ADD ────────────────────────────────────────────────────────────────────
  if (sub === "add") {
    const name = interaction.options.getString("name", true);
    const position = interaction.options.getString("position", true);
    const description = interaction.options.getString("description") ?? undefined;

    const [legend] = await db.insert(legendsTable).values({
      name,
      position,
      description,
      isAvailable: true,
    }).returning();

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Legend Added")
          .setDescription(`**${name}** (${position}) has been added to the store.\nID: **#${legend!.id}**`)
          .setTimestamp(),
      ],
    });
  }

  // ── LIST ───────────────────────────────────────────────────────────────────
  if (sub === "list_all") {
    // Fetch all legends ever added (never deleted from this table)
    const legends = await db.select().from(legendsTable)
      .orderBy(asc(legendsTable.name));

    if (legends.length === 0) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🏆 Legends").setDescription("No legends have been added yet.")],
      });
    }

    // Fetch all active legend inventory records
    const inventoryRows = await db.select({
      legendId: inventoryTable.legendId,
      discordId: inventoryTable.discordId,
      legendCategory: inventoryTable.legendCategory,
      addedAt: inventoryTable.addedAt,
    }).from(inventoryTable)
      .where(eq(inventoryTable.itemType, "legend"));

    // Resolve usernames for all owners
    const ownerDiscordIds = [...new Set(inventoryRows.map(r => r.discordId))];
    const userMap: Record<string, string> = {};
    if (ownerDiscordIds.length > 0) {
      const userRows = await db.select({
        discordId: usersTable.discordId,
        discordUsername: usersTable.discordUsername,
      }).from(usersTable)
        .where(and(inArray(usersTable.discordId, ownerDiscordIds), eq(usersTable.guildId, interaction.guildId!)));
      for (const u of userRows) userMap[u.discordId] = u.discordUsername;
    }

    // Build ownership map: legendId → { category, owner }
    // Sort by addedAt desc so the most recent record wins if there are duplicates
    const sortedInv = inventoryRows.slice().sort((a, b) =>
      new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
    const ownershipMap = new Map<number, { category: string; owner: string }>();
    for (const row of sortedInv) {
      if (row.legendId !== null && row.legendId !== undefined && !ownershipMap.has(row.legendId)) {
        ownershipMap.set(row.legendId, {
          category: row.legendCategory ?? "current",
          owner: userMap[row.discordId] ?? row.discordId,
        });
      }
    }

    // Bucket legends by their current status
    const inStore: typeof legends = [];
    const ownedCurrent: { legend: typeof legends[0]; owner: string }[] = [];
    const ownedPermanent: { legend: typeof legends[0]; owner: string }[] = [];
    const ownedUnknown: typeof legends = [];

    for (const l of legends) {
      if (l.isAvailable) {
        inStore.push(l);
      } else {
        const info = ownershipMap.get(l.id);
        if (!info) {
          ownedUnknown.push(l);
        } else if (info.category === "permanent") {
          ownedPermanent.push({ legend: l, owner: info.owner });
        } else {
          ownedCurrent.push({ legend: l, owner: info.owner });
        }
      }
    }

    // Sort each bucket: owned sections by owner name → position; store/unknown by position
    const byOwnerThenPosition = (a: { legend: typeof legends[0]; owner: string }, b: { legend: typeof legends[0]; owner: string }) =>
      a.owner.localeCompare(b.owner) || a.legend.position.localeCompare(b.legend.position) || a.legend.name.localeCompare(b.legend.name);
    const byPosition = (a: typeof legends[0], b: typeof legends[0]) =>
      a.position.localeCompare(b.position) || a.name.localeCompare(b.name);

    ownedPermanent.sort(byOwnerThenPosition);
    ownedCurrent.sort(byOwnerThenPosition);
    inStore.sort(byPosition);
    ownedUnknown.sort(byPosition);

    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`🏆 All Legends (${legends.length} total)`)
      .setTimestamp();

    // In Store
    if (inStore.length > 0) {
      const lines = inStore.map(l =>
        `**#${l.id}** — ${l.name} (${l.position})${l.description ? ` — ${l.description}` : ""}`
      );
      embed.addFields(chunkLines(lines, `⬜ In Store (${inStore.length})`));
    } else {
      embed.addFields({ name: "⬜ In Store", value: "*None available*" });
    }

    // Owned — current season
    if (ownedCurrent.length > 0) {
      const lines = ownedCurrent.map(({ legend: l, owner }) =>
        `**#${l.id}** — ${l.name} (${l.position}) → **${owner}**`
      );
      embed.addFields(chunkLines(lines, `⚡ Owned — Current Season (${ownedCurrent.length})`));
    }

    // Owned — permanent vault
    if (ownedPermanent.length > 0) {
      const lines = ownedPermanent.map(({ legend: l, owner }) =>
        `**#${l.id}** — ${l.name} (${l.position}) → **${owner}**`
      );
      embed.addFields(chunkLines(lines, `🔒 Owned — Permanent Vault (${ownedPermanent.length})`));
    }

    // Unknown (isAvailable=false but no inventory record — edge case)
    if (ownedUnknown.length > 0) {
      const lines = ownedUnknown.map(l => `**#${l.id}** — ${l.name} (${l.position})`);
      embed.addFields(chunkLines(lines, `❓ Removed from Store (${ownedUnknown.length})`));
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // ── EDIT ───────────────────────────────────────────────────────────────────
  if (sub === "edit") {
    const id = interaction.options.getInteger("id", true);
    const name = interaction.options.getString("name");
    const position = interaction.options.getString("position");
    const description = interaction.options.getString("description");
    const available = interaction.options.getBoolean("available");

    const updates: Partial<{ name: string; position: string; description: string; isAvailable: boolean }> = {};
    if (name) updates.name = name;
    if (position) updates.position = position;
    if (description !== null && description !== undefined) updates.description = description;
    if (available !== null && available !== undefined) updates.isAvailable = available;

    if (Object.keys(updates).length === 0) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Changes").setDescription("You didn't provide any fields to update.")] });
    }

    const [updated] = await db.update(legendsTable).set(updates).where(eq(legendsTable.id, id)).returning();

    if (!updated) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Not Found").setDescription(`No legend found with ID **#${id}**.`)] });
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Legend Updated")
          .setDescription(`**#${id} — ${updated.name}** (${updated.position})\nAvailable: ${updated.isAvailable ? "Yes" : "No"}`)
          .setTimestamp(),
      ],
    });
  }

  // ── REMOVE ─────────────────────────────────────────────────────────────────
  if (sub === "remove") {
    const id = interaction.options.getInteger("id", true);
    const [updated] = await db.update(legendsTable)
      .set({ isAvailable: false })
      .where(eq(legendsTable.id, id))
      .returning();

    if (!updated) {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Not Found").setDescription(`No legend found with ID **#${id}**.`)] });
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("🗑️ Legend Removed")
          .setDescription(`**${updated.name}** has been removed from the store.`)
          .setTimestamp(),
      ],
    });
  }

  // ── SEED DEFAULTS ──────────────────────────────────────────────────────────
  if (sub === "seed-defaults") {
    const result = await db.execute(sql`
      INSERT INTO legends (name, position, cost, is_available)
      SELECT v.name, v.position, 1000, true
      FROM (VALUES ${sql.raw(
        DEFAULT_LEGENDS.map(l => `('${l.name.replace(/'/g, "''")}','${l.position}')`).join(",")
      )}) AS v(name, position)
      WHERE NOT EXISTS (
        SELECT 1 FROM legends ex WHERE lower(ex.name) = lower(v.name)
      )
    `);
    const added = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(legendsTable)
      .then(r => Number(r[0]?.count ?? 0));

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(added > 0 ? Colors.Green : Colors.Blue)
          .setTitle(added > 0 ? `✅ Seeded ${added} Legend(s)` : "✅ Already Up to Date")
          .setDescription(
            added > 0
              ? `Added **${added}** missing legend(s) from the default catalog.\nStore now contains **${total}** legends total.`
              : `All **${DEFAULT_LEGENDS.length}** default legends are already in the store (**${total}** total).`,
          )
          .setTimestamp(),
      ],
    });
  }

  return interaction.editReply({ content: "❌ Unknown subcommand." });
}
