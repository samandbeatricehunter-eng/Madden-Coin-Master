import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder,
  AllowedMentionsTypes,
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
  .addStringOption(opt =>
    opt.setName("mention")
      .setDescription("Broadcast to @everyone or @here (overrides the user option)")
      .setRequired(false)
      .addChoices(
        { name: "@everyone — ping the entire server", value: "everyone" },
        { name: "@here — ping online members only",   value: "here"     },
      )
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Tag a specific member to share this rule with them (makes it visible to everyone)")
      .setRequired(false)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const allSections = await getAllSections(interaction.guildId!);
  const choices = Object.entries(allSections)
    .map(([key, meta]) => ({ name: meta.title.replace(/[\u{1F300}-\u{1FFFF}]/gu, "").trim(), value: key }))
    .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const section    = interaction.options.getString("section", true);
  const ruleNumber = interaction.options.getInteger("rule_number");
  const mention    = interaction.options.getString("mention") as "everyone" | "here" | null;
  const taggedUser = interaction.options.getUser("user");

  const allSections = await getAllSections(interaction.guildId!);
  const meta = allSections[section];
  if (!meta) {
    await interaction.reply({ content: "❌ Unknown rules section. Use `/rules` and pick from the list.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(section, interaction.guildId!);

  // ── Resolve how to address the reply ─────────────────────────────────────────
  // Priority: mention (@everyone/@here) > tagged user > no tag (ephemeral)
  let prefix   = "";
  let ephemeral = true;
  let allowedMentions: { parse: AllowedMentionsTypes[] } | undefined;

  if (mention === "everyone") {
    prefix          = "@everyone";
    ephemeral       = false;
    allowedMentions = { parse: ["everyone" as import("discord.js").AllowedMentionsTypes] };
  } else if (mention === "here") {
    prefix          = "@here";
    ephemeral       = false;
    allowedMentions = { parse: ["everyone" as import("discord.js").AllowedMentionsTypes] };   // discord.js uses "everyone" key for both @everyone and @here
  } else if (taggedUser) {
    prefix    = taggedUser.toString();
    ephemeral = false;
    allowedMentions = undefined;  // default — user mentions are always allowed
  }

  const leadIn = prefix ? `${prefix} — here's the relevant rule:\n` : undefined;

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

    await interaction.reply({
      content:         leadIn,
      embeds:          [embed],
      ephemeral,
      allowedMentions,
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

  await interaction.reply({
    content:         leadIn,
    embeds:          [embed],
    ephemeral,
    allowedMentions,
  });
}
