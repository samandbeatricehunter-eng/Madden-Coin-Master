import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, AttachmentBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { customArchetypesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { ALL_POSITIONS, formatArchetypeEmbed } from "../lib/custom-player-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-customarchetypes")
  .setDescription("Manage custom player archetypes")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("list")
    .setDescription("List all archetypes (optionally filter by position)")
    .addStringOption(o => o
      .setName("position")
      .setDescription("Filter by position")
      .setRequired(false)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))),
    ),
  )
  .addSubcommand(sub => sub
    .setName("add")
    .setDescription("Add or replace an archetype (JSON format: {\"Speed\":70,\"Accel\":72,...})")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name").setRequired(true))
    .addStringOption(o => o.setName("attributes").setDescription('JSON object: {"SpeedAttr":70,"Acceleration":72,...}').setRequired(true)),
  )
  .addSubcommand(sub => sub
    .setName("remove")
    .setDescription("Deactivate an archetype")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name to deactivate").setRequired(true)),
  )
  .addSubcommand(sub => sub
    .setName("restore")
    .setDescription("Re-activate a deactivated archetype")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name").setRequired(true)),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── List ─────────────────────────────────────────────────────────────────
  if (sub === "list") {
    const posFilter = interaction.options.getString("position");
    const rows = posFilter
      ? await db.select().from(customArchetypesTable).where(eq(customArchetypesTable.position, posFilter))
      : await db.select().from(customArchetypesTable);

    if (rows.length === 0) {
      await interaction.editReply({ content: "No archetypes found." });
      return;
    }

    const lines = rows.map(r =>
      `${r.isActive ? "✅" : "❌"} **${r.position}** — ${r.name}`,
    ).join("\n");

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("📋 Custom Archetypes")
      .setDescription(lines.slice(0, 4000))
      .setFooter({ text: `${rows.length} total` });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Add ──────────────────────────────────────────────────────────────────
  if (sub === "add") {
    const position   = interaction.options.getString("position", true);
    const name       = interaction.options.getString("name", true).trim();
    const attrStr    = interaction.options.getString("attributes", true);

    let attributes: Record<string, number>;
    try {
      const parsed = JSON.parse(attrStr);
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Must be a JSON object");
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "number") throw new Error(`Value for "${k}" must be a number`);
      }
      attributes = parsed as Record<string, number>;
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Invalid JSON: ${err.message}` });
      return;
    }

    // Upsert by position + name
    const existing = await db.select()
      .from(customArchetypesTable)
      .where(and(
        eq(customArchetypesTable.position, position),
        eq(customArchetypesTable.name, name),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(customArchetypesTable)
        .set({ attributes, isActive: true, updatedAt: new Date() })
        .where(eq(customArchetypesTable.id, existing[0]!.id));
    } else {
      await db.insert(customArchetypesTable).values({ position, name, attributes });
    }

    const embed = formatArchetypeEmbed(position, name, attributes);
    embed.setTitle(`✅ Archetype Saved — ${embed.data.title}`);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Remove / Restore ─────────────────────────────────────────────────────
  const position = interaction.options.getString("position", true);
  const name     = interaction.options.getString("name", true).trim();
  const activate = sub === "restore";

  const [row] = await db.select()
    .from(customArchetypesTable)
    .where(and(
      eq(customArchetypesTable.position, position),
      eq(customArchetypesTable.name, name),
    ))
    .limit(1);

  if (!row) {
    await interaction.editReply({ content: `❌ No archetype found: **${position}** — ${name}` });
    return;
  }

  await db.update(customArchetypesTable)
    .set({ isActive: activate, updatedAt: new Date() })
    .where(eq(customArchetypesTable.id, row.id));

  await interaction.editReply({
    content: `${activate ? "✅ Restored" : "🗑️ Deactivated"}: **${position}** — ${name}`,
  });
}
