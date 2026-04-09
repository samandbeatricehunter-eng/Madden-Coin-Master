import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminRules from "./admin-rules.js";

export const data = new SlashCommandBuilder()
  .setName("admin_rules")
  .setDescription("Manage league rules")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("add_section")
    .setDescription("Create a new custom rules section")
    .addStringOption(o => o.setName("key").setDescription("Internal key (lowercase, underscores — e.g. overtime_rules)").setRequired(true))
    .addStringOption(o => o.setName("title").setDescription("Display title shown in embeds (e.g. ⏱️ Overtime Rules)").setRequired(true))
    .addIntegerOption(o => o.setName("color").setDescription("Embed color (default: Blue)").setRequired(false)
      .addChoices(
        { name: "Blue",   value: 0x3498db }, { name: "Green",  value: 0x57f287 },
        { name: "Gold",   value: 0xfee75c }, { name: "Red",    value: 0xed4245 },
        { name: "Purple", value: 0xa855f7 }, { name: "Orange", value: 0xeb6f31 },
        { name: "Pink",   value: 0xff73fa }, { name: "Teal",   value: 0x1abc9c },
      )
    )
  )
  .addSubcommand(s => s
    .setName("list_section")
    .setDescription("List all rules in a section with their numbers")
    .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName("rule_number").setDescription("Show only this specific rule number (optional)").setRequired(false).setMinValue(1))
    .addBooleanOption(o => o.setName("public").setDescription("Post publicly in the channel (default: ephemeral)").setRequired(false))
    .addUserOption(o => o.setName("user1").setDescription("Tag a member to share this rule with them").setRequired(false))
    .addUserOption(o => o.setName("user2").setDescription("Tag additional members").setRequired(false))
    .addUserOption(o => o.setName("user3").setDescription("Tag additional members").setRequired(false))
    .addUserOption(o => o.setName("user4").setDescription("Tag additional members").setRequired(false))
    .addUserOption(o => o.setName("user5").setDescription("Tag additional members").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("edit")
    .setDescription("Edit a specific rule by its number")
    .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName("rule_number").setDescription("Rule number to edit").setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName("text").setDescription("New text for this rule").setRequired(true))
  )
  .addSubcommand(s => s
    .setName("add")
    .setDescription("Append a new rule to a section")
    .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName("text").setDescription("Text for the new rule").setRequired(true))
  )
  .addSubcommand(s => s
    .setName("remove")
    .setDescription("Remove a rule by its number from a section")
    .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName("rule_number").setDescription("Rule number to remove").setRequired(true).setMinValue(1))
  )
  .addSubcommand(s => s
    .setName("reset")
    .setDescription("Reset a section to its original defaults, or clear all rules in a custom section")
    .addStringOption(o => o.setName("section").setDescription("Which section? (use 'all' to reset everything)").setRequired(true).setAutocomplete(true))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  return adminRules.execute(interaction);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  return adminRules.autocomplete(interaction);
}
