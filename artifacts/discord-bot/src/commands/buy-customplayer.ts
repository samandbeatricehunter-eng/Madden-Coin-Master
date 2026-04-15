import {
  SlashCommandBuilder, ChatInputCommandInteraction,
} from "discord.js";
import * as purchaseCustomPlayer from "./purchasecustomplayer.js";

export const data = new SlashCommandBuilder()
  .setName("buy-customplayer")
  .setDescription("Build and buy a custom player — see /view store for package prices and current availability");

export async function execute(interaction: ChatInputCommandInteraction) {
  return purchaseCustomPlayer.execute(interaction);
}
