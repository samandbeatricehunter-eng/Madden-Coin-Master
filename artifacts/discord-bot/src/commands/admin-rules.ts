import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { getOrSeedRules, setRules, DEFAULT_RULES, SECTION_META, isAdminUser } from "../lib/db-helpers.js";

const SECTION_CHOICES = [
  { name: "Sportsmanship", value: "sportsmanship" },
  { name: "Activity",      value: "activity" },
  { name: "Settings",      value: "settings" },
  { name: "4th Down",      value: "4th_down" },
  { name: "Trade Policy",  value: "trade_policy" },
  { name: "Off-Season",    value: "off_season" },
];

export const data = new SlashCommandBuilder()
  .setName("adminrules")
  .setDescription("Admin: manage the displayed league rules")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("list")
      .setDescription("List all rules in a section with their numbers")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).addChoices(...SECTION_CHOICES)
      )
  )
  .addSubcommand(sub =>
    sub.setName("set")
      .setDescription("Edit a specific rule by its number")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).addChoices(...SECTION_CHOICES)
      )
      .addIntegerOption(opt =>
        opt.setName("rule_number").setDescription("Rule number to edit (see /adminrules list)").setRequired(true).setMinValue(1)
      )
      .addStringOption(opt =>
        opt.setName("text").setDescription("New text for this rule").setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Append a new rule to a section")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).addChoices(...SECTION_CHOICES)
      )
      .addStringOption(opt =>
        opt.setName("text").setDescription("Text for the new rule").setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove a rule by its number from a section")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).addChoices(...SECTION_CHOICES)
      )
      .addIntegerOption(opt =>
        opt.setName("rule_number").setDescription("Rule number to remove (see /adminrules list)").setRequired(true).setMinValue(1)
      )
  )
  .addSubcommand(sub =>
    sub.setName("reset")
      .setDescription("Reset a section back to the original default rules")
      .addStringOption(opt =>
        opt.setName("section").setDescription("Which section?").setRequired(true).addChoices(...SECTION_CHOICES)
      )
  );

async function checkAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAdminUser(interaction.user.id);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(await checkAdmin(interaction))) {
    await interaction.reply({ content: "❌ You do not have permission to use admin commands.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const section = interaction.options.getString("section", true);
  const meta = SECTION_META[section]!;

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
    const num = interaction.options.getInteger("rule_number", true);
    const text = interaction.options.getString("text", true);
    const rules = await getOrSeedRules(section);
    if (num > rules.length) {
      await interaction.reply({ content: `❌ Rule #${num} doesn't exist. This section has ${rules.length} rule(s).`, ephemeral: true });
      return;
    }
    rules[num - 1] = text;
    await setRules(section, rules, interaction.user.tag);
    await interaction.reply({ content: `✅ Rule #${num} in **${meta.title}** updated.`, ephemeral: true });
    return;
  }

  if (sub === "add") {
    const text = interaction.options.getString("text", true);
    const rules = await getOrSeedRules(section);
    rules.push(text);
    await setRules(section, rules, interaction.user.tag);
    await interaction.reply({ content: `✅ New rule added to **${meta.title}** as rule #${rules.length}.`, ephemeral: true });
    return;
  }

  if (sub === "remove") {
    const num = interaction.options.getInteger("rule_number", true);
    const rules = await getOrSeedRules(section);
    if (num > rules.length) {
      await interaction.reply({ content: `❌ Rule #${num} doesn't exist. This section has ${rules.length} rule(s).`, ephemeral: true });
      return;
    }
    const removed = rules.splice(num - 1, 1)[0];
    await setRules(section, rules, interaction.user.tag);
    await interaction.reply({ content: `✅ Removed rule #${num} from **${meta.title}**: *${removed}*`, ephemeral: true });
    return;
  }

  if (sub === "reset") {
    const defaults = DEFAULT_RULES[section] ?? [];
    await setRules(section, defaults, interaction.user.tag);
    await interaction.reply({ content: `✅ **${meta.title}** has been reset to the default rules (${defaults.length} rules).`, ephemeral: true });
    return;
  }
}
