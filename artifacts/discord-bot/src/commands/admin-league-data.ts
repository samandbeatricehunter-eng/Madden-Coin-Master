/**
 * /admin-league-data
 *
 * Unified EA connection + data import wizard for commissioners.
 * All sub-flows are handled by button/modal/select interactions
 * in lib/league-data-handlers.ts.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { isAdminUser } from "../lib/db-helpers.js";
import { buildLeagueDataMainMenu } from "../lib/league-data-handlers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-league-data")
  .setDescription("Commissioner: EA connection, data import, and season data management")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
    await interaction.editReply({ content: "❌ Commissioner access required." });
    return;
  }

  const content = await buildLeagueDataMainMenu(interaction.guildId!);
  await interaction.editReply(content as any);
}
