import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminSeason from "./admin-season.js";

export const data = new SlashCommandBuilder()
  .setName("admin_franchise")
  .setDescription("Franchise-level settings and lifecycle management")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("length")
    .setDescription("Set the maximum number of seasons allowed in this franchise (1–50)")
    .addIntegerOption(o => o.setName("limit").setDescription("Max seasons (1–50)").setRequired(true).setMinValue(1).setMaxValue(50))
  )
  .addSubcommand(s => s
    .setName("reset")
    .setDescription("⚠️ END-OF-FRANCHISE RESET: returns all legends to store, resets all coins, restarts at Season 1")
    .addBooleanOption(o => o.setName("confirm").setDescription("Set to True to confirm this irreversible action").setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  return adminSeason.execute(interaction);
}
