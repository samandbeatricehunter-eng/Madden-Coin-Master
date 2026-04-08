import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle,
  type StringSelectMenuInteraction, type ButtonInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { customArchetypesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ALL_POSITIONS, formatArchetypeEmbed } from "../lib/custom-player-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("viewcustomarchetypes")
  .setDescription("Browse available custom player archetypes by position");

// ── Shared helpers ─────────────────────────────────────────────────────────────

function positionSelectRow(placeholder: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("vca_pos")
      .setPlaceholder(placeholder)
      .addOptions(
        ALL_POSITIONS.map(p =>
          new StringSelectMenuOptionBuilder().setLabel(p).setValue(p),
        ),
      ),
  );
}

function navRow(position: string, idx: number, total: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`vca_prev:${position}:${idx}`)
      .setLabel("◀  Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx <= 0),
    new ButtonBuilder()
      .setCustomId("vca_page_indicator")
      .setLabel(`${idx + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`vca_next:${position}:${idx}`)
      .setLabel("Next  ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx >= total - 1),
  );
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  await interaction.editReply({
    content: "**📋 Custom Archetypes Browser**\nSelect a position to browse its archetypes:",
    components: [positionSelectRow("Select a position…")],
  });
}

// ── Position selected ──────────────────────────────────────────────────────────

export async function handleViewArchetypeSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const position = interaction.values[0]!;
  await interaction.deferUpdate();

  const archs = await db.select()
    .from(customArchetypesTable)
    .where(eq(customArchetypesTable.position, position));

  const active = archs.filter(a => a.isActive);

  if (active.length === 0) {
    await interaction.editReply({
      content: `No archetypes found for **${position}** yet. Check back later!`,
      components: [positionSelectRow("Select another position…")],
      embeds: [],
    });
    return;
  }

  const first = active[0]!;
  await interaction.editReply({
    content: `**📋 ${position} Archetypes** — browse below, then pick another position when done.`,
    embeds:  [formatArchetypeEmbed(position, first.name, first.attributes as Record<string, number>)],
    components: [
      navRow(position, 0, active.length),
      positionSelectRow(`Showing ${position} — switch position…`),
    ],
  });
}

// ── Prev / Next buttons ────────────────────────────────────────────────────────

export async function handleVcaNav(
  interaction: ButtonInteraction,
  direction: "prev" | "next",
  position: string,
  currentIdx: number,
): Promise<void> {
  await interaction.deferUpdate();

  const archs = await db.select()
    .from(customArchetypesTable)
    .where(eq(customArchetypesTable.position, position));

  const active = archs.filter(a => a.isActive);
  if (active.length === 0) return;

  const newIdx = Math.max(0, Math.min(active.length - 1,
    direction === "prev" ? currentIdx - 1 : currentIdx + 1,
  ));

  const arch = active[newIdx]!;
  await interaction.editReply({
    content: `**📋 ${position} Archetypes** — browse below, then pick another position when done.`,
    embeds:  [formatArchetypeEmbed(position, arch.name, arch.attributes as Record<string, number>)],
    components: [
      navRow(position, newIdx, active.length),
      positionSelectRow(`Showing ${position} — switch position…`),
    ],
  });
}
