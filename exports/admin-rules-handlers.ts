/**
 * admin-rules-handlers.ts
 * Rules Hub display + Rules Modal Handlers (add/edit/delete/paginate).
 * Also exports buildRulesPages, used by rule-violation-handlers.ts.
 */
import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import {
  getOrSeedRules, setRules, getAllSections,
} from "./db-helpers.js";

// ── buildRulesPages ────────────────────────────────────────────────────────────
// Splits a rules array into page strings (5 rules per page).
// Used by rule-violation-handlers.ts and the admin hub below.

const RULES_PER_PAGE = 5;

export function buildRulesPages(rules: string[]): string[] {
  if (rules.length === 0) return ["_No rules in this section yet._"];
  const pages: string[] = [];
  for (let i = 0; i < rules.length; i += RULES_PER_PAGE) {
    const slice = rules.slice(i, i + RULES_PER_PAGE);
    pages.push(slice.map((r, j) => `**${i + j + 1}.** ${r}`).join("\n\n"));
  }
  return pages;
}

// ── Shared UI helpers ──────────────────────────────────────────────────────────

function backToSectionsRow(section?: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(section
      ? [new ButtonBuilder().setCustomId(`ao_rules_section:${section}`).setLabel("← Back").setStyle(ButtonStyle.Secondary)]
      : [new ButtonBuilder().setCustomId("ao_rules_hub").setLabel("← Sections").setStyle(ButtonStyle.Secondary)]
    ),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
}

function buildAdminRulesPageRow(section: string, page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ao_rules_page:${section}:${page - 1}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`ao_rules_page:${section}:${page + 1}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

function buildSectionEmbed(
  meta: { title: string; color: number },
  rules: string[],
  page: number,
): EmbedBuilder {
  const pages = buildRulesPages(rules);
  const safePage = Math.min(Math.max(0, page), Math.max(0, pages.length - 1));
  const content = pages[safePage] ?? "_No rules in this section yet._";
  const footer = pages.length > 1
    ? `${rules.length} rule${rules.length !== 1 ? "s" : ""} · Page ${safePage + 1}/${pages.length} · Admin View`
    : `${rules.length} rule${rules.length !== 1 ? "s" : ""} · Admin View`;
  return new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`✏️ ${meta.title}`)
    .setDescription(content)
    .setFooter({ text: footer });
}

function buildSectionActionRow(section: string, rulesCount: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ao_rules_add:${section}`).setLabel("➕ Add Rule").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ao_rules_edit:${section}`).setLabel("✏️ Edit Rule").setStyle(ButtonStyle.Primary).setDisabled(rulesCount === 0),
    new ButtonBuilder().setCustomId(`ao_rules_delete:${section}`).setLabel("🗑️ Delete Rule").setStyle(ButtonStyle.Danger).setDisabled(rulesCount === 0),
    new ButtonBuilder().setCustomId("ao_rules_hub").setLabel("← Sections").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
}

// ── handleRulesHub ─────────────────────────────────────────────────────────────
// Entry: ao_rules button

export async function handleRulesHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const sections = await getAllSections(guildId);
  const entries = Object.entries(sections);

  if (entries.length === 0) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("📜 Rules").setDescription("No rule sections configured.")],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_rules_section_sel")
    .setPlaceholder("Select a section to edit...")
    .addOptions(
      entries.slice(0, 25).map(([key, meta]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(meta.title.replace(/[\u{1F300}-\u{1FFFF}]/gu, "").trim() || key)
          .setValue(key),
      ),
    );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0xB68B2D)
        .setTitle("📜 Edit League Rules")
        .setDescription("Select a section to view and edit its rules."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

// ── handleRulesSection ─────────────────────────────────────────────────────────
// Entry: ao_rules_section_sel (select menu) or ao_rules_section:<key> (back button)

export async function handleRulesSection(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
) {
  const guildId = interaction.guildId!;
  const section = interaction instanceof StringSelectMenuInteraction
    ? interaction.values[0]!
    : interaction.customId.split(":")[1]!;

  const sections = await getAllSections(guildId);
  const meta = sections[section];
  if (!meta) {
    await interaction.update({ content: "❌ Section not found.", components: [] });
    return;
  }

  const rules = await getOrSeedRules(section, guildId);
  const pages = buildRulesPages(rules);
  const embed = buildSectionEmbed(meta, rules, 0);
  const components: ActionRowBuilder<ButtonBuilder>[] = [buildSectionActionRow(section, rules.length)];
  if (pages.length > 1) components.push(buildAdminRulesPageRow(section, 0, pages.length));

  await interaction.update({ embeds: [embed], components });
}

// ── handleRulesPage ────────────────────────────────────────────────────────────
// Entry: ao_rules_page:<section>:<page>

export async function handleRulesPage(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const parts = interaction.customId.split(":");
  const section = parts[1]!;
  const page = parseInt(parts[2] ?? "0", 10);

  const sections = await getAllSections(guildId);
  const meta = sections[section];
  if (!meta) {
    await interaction.update({ content: "❌ Section not found.", components: [] });
    return;
  }

  const rules = await getOrSeedRules(section, guildId);
  const pages = buildRulesPages(rules);
  const safePage = Math.min(Math.max(0, page), Math.max(0, pages.length - 1));
  const embed = buildSectionEmbed(meta, rules, safePage);
  const components: ActionRowBuilder<ButtonBuilder>[] = [buildSectionActionRow(section, rules.length)];
  if (pages.length > 1) components.push(buildAdminRulesPageRow(section, safePage, pages.length));

  await interaction.update({ embeds: [embed], components });
}

// ── handleRulesAdd ─────────────────────────────────────────────────────────────
// Entry: ao_rules_add:<section>

export async function handleRulesAdd(interaction: ButtonInteraction) {
  const section = interaction.customId.split(":")[1]!;

  const modal = new ModalBuilder()
    .setCustomId(`ao_modal_rules_add:${section}`)
    .setTitle("Add Rule");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_text")
        .setLabel("Rule text")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000),
    ),
  );

  await interaction.showModal(modal);
}

// ── handleModalRulesAdd ────────────────────────────────────────────────────────
// Entry: ao_modal_rules_add:<section>

export async function handleModalRulesAdd(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const section = interaction.customId.split(":")[1]!;
  const ruleText = interaction.fields.getTextInputValue("rule_text").trim();

  if (!ruleText) {
    await interaction.editReply({ content: "❌ Rule text cannot be empty." });
    return;
  }

  const existing = await getOrSeedRules(section, guildId);
  const updated = [...existing, ruleText];
  await setRules(section, updated, interaction.user.id, guildId);

  await interaction.editReply({ content: `✅ Rule added as #${updated.length}.` });
}

// ── handleRulesEdit ────────────────────────────────────────────────────────────
// Entry: ao_rules_edit:<section>

export async function handleRulesEdit(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const section = interaction.customId.split(":")[1]!;
  const rules = await getOrSeedRules(section, guildId);

  if (rules.length === 0) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("No Rules").setDescription("There are no rules to edit.")],
      components: [backToSectionsRow(section)],
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`ao_rules_edit_sel:${section}`)
    .setPlaceholder("Select a rule to edit...")
    .addOptions(
      rules.slice(0, 25).map((r, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Rule ${i + 1}: ${r.slice(0, 80)}${r.length > 80 ? "…" : ""}`)
          .setValue(String(i)),
      ),
    );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("✏️ Edit Rule")
        .setDescription("Select the rule you want to edit."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      backToSectionsRow(section),
    ],
  });
}

// ── handleRulesEditSel ─────────────────────────────────────────────────────────
// Entry: ao_rules_edit_sel:<section>

export async function handleRulesEditSel(interaction: StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;
  const section = interaction.customId.split(":")[1]!;
  const index = parseInt(interaction.values[0]!, 10);
  const rules = await getOrSeedRules(section, guildId);
  const current = rules[index] ?? "";

  const modal = new ModalBuilder()
    .setCustomId(`ao_modal_rules_edit:${section}:${index}`)
    .setTitle(`Edit Rule ${index + 1}`);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_text")
        .setLabel("Rule text")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
        .setValue(current),
    ),
  );

  await interaction.showModal(modal);
}

// ── handleModalRulesEdit ───────────────────────────────────────────────────────
// Entry: ao_modal_rules_edit:<section>:<index>

export async function handleModalRulesEdit(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const parts = interaction.customId.split(":");
  const section = parts[1]!;
  const index = parseInt(parts[2]!, 10);
  const ruleText = interaction.fields.getTextInputValue("rule_text").trim();

  if (!ruleText) {
    await interaction.editReply({ content: "❌ Rule text cannot be empty." });
    return;
  }

  const rules = await getOrSeedRules(section, guildId);
  if (index < 0 || index >= rules.length) {
    await interaction.editReply({ content: "❌ Rule not found — it may have been deleted." });
    return;
  }

  rules[index] = ruleText;
  await setRules(section, rules, interaction.user.id, guildId);
  await interaction.editReply({ content: `✅ Rule ${index + 1} updated.` });
}

// ── handleRulesDelete ──────────────────────────────────────────────────────────
// Entry: ao_rules_delete:<section>

export async function handleRulesDelete(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const section = interaction.customId.split(":")[1]!;
  const rules = await getOrSeedRules(section, guildId);

  if (rules.length === 0) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("No Rules").setDescription("There are no rules to delete.")],
      components: [backToSectionsRow(section)],
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`ao_rules_delete_sel:${section}`)
    .setPlaceholder("Select a rule to delete...")
    .addOptions(
      rules.slice(0, 25).map((r, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Rule ${i + 1}: ${r.slice(0, 80)}${r.length > 80 ? "…" : ""}`)
          .setValue(String(i)),
      ),
    );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🗑️ Delete Rule")
        .setDescription("Select the rule you want to permanently delete."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      backToSectionsRow(section),
    ],
  });
}

// ── handleModalRulesDelete ─────────────────────────────────────────────────────
// Entry: ao_rules_delete_sel:<section> (select menu confirm)

export async function handleModalRulesDelete(interaction: StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;
  const section = interaction.customId.split(":")[1]!;
  const index = parseInt(interaction.values[0]!, 10);

  const rules = await getOrSeedRules(section, guildId);
  if (index < 0 || index >= rules.length) {
    await interaction.update({ content: "❌ Rule not found.", components: [] });
    return;
  }

  const deleted = rules.splice(index, 1)[0];
  await setRules(section, rules, interaction.user.id, guildId);

  const sections = await getAllSections(guildId);
  const meta = sections[section];

  let embed: EmbedBuilder;
  if (meta && rules.length > 0) {
    embed = buildSectionEmbed(meta, rules, 0);
    embed.setDescription((embed.data.description ?? "") + `\n\n✅ Deleted rule: *${deleted?.slice(0, 100)}*`);
  } else {
    embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Rule Deleted")
      .setDescription(`Deleted: *${deleted?.slice(0, 200)}*\n\nNo rules remaining in this section.`);
  }

  const components: ActionRowBuilder<ButtonBuilder>[] = [buildSectionActionRow(section, rules.length)];
  if (meta) {
    const pages = buildRulesPages(rules);
    if (pages.length > 1) components.push(buildAdminRulesPageRow(section, 0, pages.length));
  }

  await interaction.update({ embeds: [embed], components });
}
