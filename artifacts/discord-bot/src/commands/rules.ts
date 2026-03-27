import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder,
} from "discord.js";
import { getOrSeedRules, getAllSections } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("rules")
  .setDescription("Display a section of the league rules, or quote a specific rule")
  .addStringOption(opt =>
    opt.setName("section")
      .setDescription("Which rules section?")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addIntegerOption(opt =>
    opt.setName("rule_number")
      .setDescription("Quote only this rule number from the section (optional)")
      .setRequired(false)
      .setMinValue(1)
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Tag a member to share this rule with them (makes it visible to everyone)")
      .setRequired(false)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const allSections = await getAllSections();
  const choices = Object.entries(allSections)
    .map(([key, meta]) => ({ name: meta.title.replace(/[\u{1F300}-\u{1FFFF}]/gu, "").trim(), value: key }))
    .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const section    = interaction.options.getString("section", true);
  const ruleNumber = interaction.options.getInteger("rule_number");
  const taggedUser = interaction.options.getUser("user");

  const allSections = await getAllSections();
  const meta = allSections[section];
  if (!meta) {
    await interaction.reply({ content: "❌ Unknown rules section. Use `/rules` and pick from the list.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(section);

  // ── Single-rule quote ────────────────────────────────────────────────────────
  if (ruleNumber !== null) {
    if (ruleNumber > rules.length || rules.length === 0) {
      await interaction.reply({
        content: `❌ Rule #${ruleNumber} doesn't exist in **${meta.title}**. This section has **${rules.length}** rule(s).`,
        ephemeral: true,
      });
      return;
    }
    const ruleText = rules[ruleNumber - 1]!;
    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(`${meta.title} — Rule #${ruleNumber}`)
      .setDescription(`**${ruleNumber}.** ${ruleText}`)
      .setFooter({ text: `REC League • Rule ${ruleNumber} of ${rules.length} in this section` })
      .setTimestamp();

    const mention = taggedUser ? `${taggedUser.toString()} — here's the relevant rule:\n` : "";
    await interaction.reply({
      content: mention || undefined,
      embeds: [embed],
      ephemeral: !taggedUser,
    });
    return;
  }

  // ── Full section ─────────────────────────────────────────────────────────────
  const rulesText = rules.map((r, i) => `**${i + 1}.** ${r}`).join("\n") || "_No rules have been set for this section yet._";
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(meta.title)
    .setDescription(rulesText)
    .setFooter({ text: "REC League • Use /rules to view any section" })
    .setTimestamp();

  const mention = taggedUser ? `${taggedUser.toString()} — here's the relevant rule:\n` : "";
  await interaction.reply({
    content: mention || undefined,
    embeds: [embed],
    ephemeral: !taggedUser,
  });
}
