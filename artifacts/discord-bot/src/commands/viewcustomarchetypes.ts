import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { customArchetypesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ALL_POSITIONS, formatArchetypeEmbed } from "../lib/custom-player-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("viewcustomarchetypes")
  .setDescription("Browse available custom player archetypes by position");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("vca_pos")
      .setPlaceholder("Select a position to view archetypes…")
      .addOptions(
        ALL_POSITIONS.map(p =>
          new StringSelectMenuOptionBuilder().setLabel(p).setValue(p),
        ),
      ),
  );

  await interaction.editReply({
    content: "**📋 Custom Archetypes Browser**\nSelect a position to see all available archetypes:",
    components: [row],
  });
}

// ── Handler called from interactionCreate ─────────────────────────────────────
export async function handleViewArchetypeSelect(
  interaction: import("discord.js").StringSelectMenuInteraction,
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
      components: [],
    });
    return;
  }

  // Build one embed per archetype; Discord ephemeral supports multiple embeds
  const embeds = active.map(a =>
    formatArchetypeEmbed(a.position, a.name, a.attributes as Record<string, number>),
  );

  // Discord has a 10-embed limit per message
  const MAX_EMBEDS = 10;
  const firstBatch = embeds.slice(0, MAX_EMBEDS);

  // Rebuild the position selector so user can pick another position
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("vca_pos")
      .setPlaceholder(`Showing ${position} — select another position…`)
      .addOptions(
        ALL_POSITIONS.map(p =>
          new StringSelectMenuOptionBuilder().setLabel(p).setValue(p),
        ),
      ),
  );

  await interaction.editReply({
    content: `**${position} Archetypes** (${active.length} available)${embeds.length > MAX_EMBEDS ? ` — showing first ${MAX_EMBEDS}` : ""}`,
    embeds:  firstBatch,
    components: [row],
  });

  // If overflow, send remaining as follow-ups (still ephemeral)
  for (let i = MAX_EMBEDS; i < embeds.length; i += MAX_EMBEDS) {
    await interaction.followUp({
      embeds:    embeds.slice(i, i + MAX_EMBEDS),
      ephemeral: true,
    });
  }
}
