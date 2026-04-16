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
    const descText = `**${ruleNumber}.** ${ruleText}`.slice(0, 4096);
    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(`${meta.title} — Rule #${ruleNumber}`)
      .setDescription(descText)
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

  // ── Full section — chunked into multiple embeds if needed (4096 char limit) ──
  const LIMIT = 4096;
  const lines  = rules.length
    ? rules.map((r, i) => `**${i + 1}.** ${r}`)
    : ["_No rules have been set for this section yet._"];

  // Pack lines into pages where each page stays under LIMIT
  const pages: string[] = [];
  let current = "";
  for (const line of lines) {
    const appended = current ? `${current}\n${line}` : line;
    if (appended.length > LIMIT) {
      if (current) pages.push(current);
      // If a single line itself exceeds LIMIT, hard-truncate it
      current = line.length > LIMIT ? line.slice(0, LIMIT) : line;
    } else {
      current = appended;
    }
  }
  if (current) pages.push(current);

  const embeds = pages.map((page, idx) => {
    const b = new EmbedBuilder()
      .setColor(meta.color)
      .setDescription(page)
      .setTimestamp();
    if (idx === 0) b.setTitle(meta.title);
    else b.setTitle(`${meta.title} (cont.)`);
    if (idx === pages.length - 1)
      b.setFooter({ text: "REC League • Use /rules to view any section" });
    return b;
  });

  await interaction.reply({
    content:         leadIn,
    embeds,
    ephemeral,
    allowedMentions,
  });
}
