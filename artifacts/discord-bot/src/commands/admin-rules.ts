import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import {
  getOrSeedRules, setRules, DEFAULT_RULES, getAllSections, createSection, isAdminUser,
} from "../lib/db-helpers.js";

const COLOR_CHOICES = [
  { name: "Blue",   value: 0x3498db },
  { name: "Green",  value: 0x57f287 },
  { name: "Gold",   value: 0xfee75c },
  { name: "Red",    value: 0xed4245 },
  { name: "Purple", value: 0xa855f7 },
  { name: "Orange", value: 0xeb6f31 },
  { name: "Pink",   value: 0xff73fa },
  { name: "Teal",   value: 0x1abc9c },
];

export const data = new SlashCommandBuilder()
  .setName("adminrules")
  .setDescription("Admin: manage the displayed league rules")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  // ── new-section ────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("new-section")
      .setDescription("Create a new custom rules section")
      .addStringOption(opt =>
        opt.setName("key")
          .setDescription("Internal key for this section (lowercase, underscores — e.g. overtime_rules)")
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("title")
          .setDescription("Display title shown in embeds (emojis OK — e.g. ⏱️ Overtime Rules)")
          .setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName("color")
          .setDescription("Embed color for this section (default: Blue)")
          .setRequired(false)
          .addChoices(...COLOR_CHOICES.map(c => ({ name: c.name, value: c.value })))
      )
  )
  // ── list ───────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("list")
      .setDescription("List all rules in a section with their numbers")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true)
      )
  )
  // ── set ────────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("set")
      .setDescription("Edit a specific rule by its number")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption(opt =>
        opt.setName("rule_number").setDescription("Rule number to edit (see /adminrules list)").setRequired(true).setMinValue(1)
      )
      .addStringOption(opt =>
        opt.setName("text").setDescription("New text for this rule").setRequired(true)
      )
  )
  // ── add ────────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Append a new rule to a section")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("text").setDescription("Text for the new rule").setRequired(true)
      )
  )
  // ── remove ─────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove a rule by its number from a section")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption(opt =>
        opt.setName("rule_number").setDescription("Rule number to remove (see /adminrules list)").setRequired(true).setMinValue(1)
      )
  )
  // ── reset ──────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("reset")
      .setDescription("Reset a built-in section to default rules, or clear all rules in a custom section")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true)
      )
  );

async function checkAdmin(interaction: ChatInputCommandInteraction | AutocompleteInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAdminUser(interaction.user.id);
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  // setDefaultMemberPermissions(Administrator) already gates this command — skip
  // the slow admin check here so autocomplete always responds within Discord's 3-second window.
  try {
    const focused = interaction.options.getFocused().toLowerCase();
    const allSections = await getAllSections();
    const choices = Object.entries(allSections)
      .map(([key, meta]) => ({ name: meta.title.replace(/[\u{1F300}-\u{1FFFF}]/gu, "").trim() + ` [${key}]`, value: key }))
      .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
      .slice(0, 25);
    await interaction.respond(choices);
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await checkAdmin(interaction))) {
    await interaction.reply({ content: "❌ You do not have permission to use admin commands.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── new-section ────────────────────────────────────────────────────────────
  if (sub === "new-section") {
    const rawKey = interaction.options.getString("key", true).trim().toLowerCase().replace(/\s+/g, "_");
    const title  = interaction.options.getString("title", true).trim();
    const color  = interaction.options.getInteger("color") ?? 0x3498db;

    const allSections = await getAllSections();
    if (allSections[rawKey]) {
      await interaction.reply({ content: `⚠️ A section with key \`${rawKey}\` already exists: **${allSections[rawKey]!.title}**. Use \`/adminrules set/add\` to edit its rules, or choose a different key.`, ephemeral: true });
      return;
    }

    await createSection(rawKey, title, color);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle(`✅ New Section Created: ${title}`)
          .setDescription(`**Key:** \`${rawKey}\`\nUse \`/adminrules add section:${rawKey}\` to add rules.\nUsers can view it with \`/rules section:${rawKey}\`.`)
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }

  // All other subcommands require a section
  const section = interaction.options.getString("section", true);
  const allSections = await getAllSections();
  const meta = allSections[section];
  if (!meta) {
    await interaction.reply({ content: `❌ Unknown section \`${section}\`. Use \`/adminrules new-section\` to create it first.`, ephemeral: true });
    return;
  }

  if (sub === "list") {
    const rules = await getOrSeedRules(section);
    const text = rules.map((r, i) => `**${i + 1}.** ${r}`).join("\n") || "_No rules set._";
    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(`${meta.title} — Current Rules`)
      .setDescription(text)
      .setFooter({ text: "Use /adminrules set, add, or remove to edit." })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === "set") {
    const num  = interaction.options.getInteger("rule_number", true);
    const text = interaction.options.getString("text", true);
    const rules = await getOrSeedRules(section);
    if (num > rules.length) {
      await interaction.reply({ content: `❌ Rule #${num} doesn't exist. This section has ${rules.length} rule(s).`, ephemeral: true });
      return;
    }
    rules[num - 1] = text;
    await setRules(section, rules, interaction.user.tag ?? interaction.user.username);
    await interaction.reply({ content: `✅ Rule #${num} in **${meta.title}** updated.`, ephemeral: true });
    return;
  }

  if (sub === "add") {
    const text  = interaction.options.getString("text", true);
    const rules = await getOrSeedRules(section);
    rules.push(text);
    await setRules(section, rules, interaction.user.tag ?? interaction.user.username);
    await interaction.reply({ content: `✅ New rule added to **${meta.title}** as rule #${rules.length}.`, ephemeral: true });
    return;
  }

  if (sub === "remove") {
    const num   = interaction.options.getInteger("rule_number", true);
    const rules = await getOrSeedRules(section);
    if (num > rules.length) {
      await interaction.reply({ content: `❌ Rule #${num} doesn't exist. This section has ${rules.length} rule(s).`, ephemeral: true });
      return;
    }
    const removed = rules.splice(num - 1, 1)[0];
    await setRules(section, rules, interaction.user.tag ?? interaction.user.username);
    await interaction.reply({ content: `✅ Removed rule #${num} from **${meta.title}**: *${removed}*`, ephemeral: true });
    return;
  }

  if (sub === "reset") {
    const defaults = DEFAULT_RULES[section] ?? [];
    await setRules(section, defaults, interaction.user.tag ?? interaction.user.username);
    const msg = defaults.length > 0
      ? `✅ **${meta.title}** has been reset to the default rules (${defaults.length} rules).`
      : `✅ **${meta.title}** is a custom section — all rules cleared (${defaults.length} rules remaining).`;
    await interaction.reply({ content: msg, ephemeral: true });
    return;
  }
}
