import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { legendsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";

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
      .setDescription("View all legends (available and purchased)")
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
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

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

  if (sub === "list") {
    const legends = await db.select().from(legendsTable).orderBy(asc(legendsTable.position), asc(legendsTable.name));

    if (legends.length === 0) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🏆 Legends").setDescription("No legends have been added yet.")],
      });
    }

    const available = legends.filter(l => l.isAvailable);
    const purchased = legends.filter(l => !l.isAvailable);

    // Split lines into chunks that fit within Discord's 1024-char field limit
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

    const embed = new EmbedBuilder().setColor(Colors.Gold).setTitle(`🏆 All Legends (${legends.length} total)`).setTimestamp();

    if (available.length > 0) {
      const lines = available.map(l => `**#${l.id}** — ${l.name} (${l.position})${l.description ? ` — ${l.description}` : ""}`);
      embed.addFields(chunkLines(lines, `✅ Available in Store (${available.length})`));
    } else {
      embed.addFields({ name: "✅ Available in Store", value: "None currently available." });
    }

    if (purchased.length > 0) {
      const lines = purchased.map(l => `**#${l.id}** — ${l.name} (${l.position})`);
      embed.addFields(chunkLines(lines, `❌ Purchased / Removed (${purchased.length})`));
    }

    return interaction.editReply({ embeds: [embed] });
  }

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
}
