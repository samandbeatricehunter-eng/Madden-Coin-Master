import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { openGamedayDashboard } from "../lib/gameday/gameday-dashboard.js";

export const data = new SlashCommandBuilder()
  .setName("gameday")
  .setDescription("Open your private dashboard for this week's H2H matchup.");

export async function execute(interaction: ChatInputCommandInteraction) {
  await openGamedayDashboard(interaction);
}
