import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
} from "discord.js";
import * as rulesCmd from "./rules.js";

export const data = new SlashCommandBuilder()
  .setName("view")
  .setDescription("View league rules and information")

  .addSubcommand(s => s
    .setName("rules")
    .setDescription("Display a section of the league rules, or quote a specific rule")
    .addStringOption(o => o.setName("section").setDescription("Which rules section?").setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName("rule_number").setDescription("Quote only this rule number from the section (optional)").setRequired(false).setMinValue(1))
    .addStringOption(o => o.setName("mention").setDescription("Broadcast to @everyone or @here (overrides the user option)").setRequired(false)
      .addChoices(
        { name: "@everyone — ping the entire server", value: "everyone" },
        { name: "@here — ping online members only",   value: "here"     },
      )
    )
    .addUserOption(o => o.setName("user").setDescription("Tag a specific member to share this rule with them (makes it visible to everyone)").setRequired(false))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  return rulesCmd.execute(interaction);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    return rulesCmd.autocomplete(interaction);
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}
