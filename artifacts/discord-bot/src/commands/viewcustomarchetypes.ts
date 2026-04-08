import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle,
  type StringSelectMenuInteraction, type ButtonInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { customArchetypesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ALL_POSITIONS, formatArchetypeEmbed,
  attrPageCount, buildVcaAttrPageNavRow,
} from "../lib/custom-player-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("viewcustomarchetypes")
  .setDescription("Browse available custom player archetypes by position");

// ── Shared UI helpers ─────────────────────────────────────────────────────────

type ArchRow = { id: number; name: string; position: string; isActive: boolean; attributes: unknown };

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

function archNavRow(position: string, idx: number, total: number) {
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

function buildVcaReply(
  position: string,
  active: ArchRow[],
  archIdx: number,
  attrPage: number,
) {
  const arch      = active[archIdx]!;
  const attrs     = arch.attributes as Record<string, number>;
  const totalAttrPages = attrPageCount(attrs);

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (totalAttrPages > 1) {
    components.push(buildVcaAttrPageNavRow(position, archIdx, attrPage, totalAttrPages));
  }
  components.push(archNavRow(position, archIdx, active.length));
  components.push(positionSelectRow(`Showing ${position} — switch position…`));

  return {
    content: `**📋 ${position} Archetypes** — use **Prev/Next Attrs** to page through all stats, **Prev/Next** to switch archetypes.`,
    embeds:  [formatArchetypeEmbed(position, arch.name, attrs, attrPage)],
    components,
  };
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

  await interaction.editReply(buildVcaReply(position, active, 0, 0));
}

// ── Archetype Prev / Next ─────────────────────────────────────────────────────

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

  // Reset attr page when switching archetypes
  await interaction.editReply(buildVcaReply(position, active, newIdx, 0));
}

// ── Attribute page Prev / Next ────────────────────────────────────────────────

export async function handleVcaAttrPageNav(
  interaction: ButtonInteraction,
  direction: "prev" | "next",
  position: string,
  archIdx: number,
  currentAttrPage: number,
): Promise<void> {
  await interaction.deferUpdate();

  const archs = await db.select()
    .from(customArchetypesTable)
    .where(eq(customArchetypesTable.position, position));

  const active = archs.filter(a => a.isActive);
  if (active.length === 0) return;

  const safeArchIdx = Math.max(0, Math.min(active.length - 1, archIdx));
  const arch        = active[safeArchIdx]!;
  const totalPages  = attrPageCount(arch.attributes as Record<string, number>);
  const newAttrPage = Math.max(0, Math.min(totalPages - 1,
    direction === "prev" ? currentAttrPage - 1 : currentAttrPage + 1,
  ));

  await interaction.editReply(buildVcaReply(position, active, safeArchIdx, newAttrPage));
}
