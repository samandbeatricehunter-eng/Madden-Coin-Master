import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminSeason from "./admin-season.js";

export const data = new SlashCommandBuilder()
  .setName("admin_upgrade")
  .setDescription("Manage upgrade limits, costs, and core attribute definitions")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("set_limits")
    .setDescription("Set upgrade limits and costs for the current season")
    .addIntegerOption(o => o.setName("core_attr_cost").setDescription("Cost per core attribute point (default: 25)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("core_attr_cap").setDescription("Max core attribute points this season (default: 16)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("non_core_attr_cost").setDescription("Cost per non-core attribute point (default: 10)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("non_core_attr_cap").setDescription("Max non-core attribute points this season (default: 32)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("dev_ups_cap").setDescription("Max dev upgrades per season (default: 2)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("dev_ups_cost").setDescription("Coin cost per dev upgrade (default: 250)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("age_resets_cap").setDescription("Max age resets per season (default: 2)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("age_resets_cost").setDescription("Coin cost per age reset (default: 250)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("legend_cost").setDescription("Coin cost per legend (default: 1000)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("custom_gold_cost").setDescription("Coin cost for a Gold custom player (default: 300)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("custom_silver_cost").setDescription("Coin cost for a Silver custom player (default: 200)").setRequired(false).setMinValue(1))
    .addIntegerOption(o => o.setName("custom_bronze_cost").setDescription("Coin cost for a Bronze custom player (default: 100)").setRequired(false).setMinValue(1))
    .addBooleanOption(o => o.setName("clear").setDescription("Set to True to clear ALL overrides and restore defaults").setRequired(false))
  )
  .addSubcommand(s => {
    let sub = s
      .setName("set_core_attributes")
      .setDescription("Set which attributes count as Core this season (1–10 slots)")
      .addStringOption(o => o.setName("attr1").setDescription("Core attribute #1 (required — at least one)").setRequired(true).setAutocomplete(true));
    for (let i = 2; i <= 10; i++) {
      sub = sub.addStringOption(o => o.setName(`attr${i}`).setDescription(`Core attribute #${i}`).setRequired(false).setAutocomplete(true));
    }
    return sub.addBooleanOption(o => o.setName("reset").setDescription("Set to True to restore default core attribute list").setRequired(false));
  });

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  return adminSeason.execute(interaction);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  return adminSeason.autocomplete(interaction);
}
