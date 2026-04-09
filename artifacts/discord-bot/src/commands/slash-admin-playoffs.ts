import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminPlayoffs from "./admin-playoffs.js";

export const data = new SlashCommandBuilder()
  .setName("admin_playoffs")
  .setDescription("Register playoff seeds for end-of-season payouts")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("set_nfc_seeds")
    .setDescription("Register NFC playoff seeds 1–7 (seeds 1–4 get top-4 playoff payout rate)")
    .addUserOption(o => o.setName("seed1").setDescription("NFC seed #1").setRequired(true))
    .addUserOption(o => o.setName("seed2").setDescription("NFC seed #2").setRequired(true))
    .addUserOption(o => o.setName("seed3").setDescription("NFC seed #3").setRequired(true))
    .addUserOption(o => o.setName("seed4").setDescription("NFC seed #4").setRequired(true))
    .addUserOption(o => o.setName("seed5").setDescription("NFC seed #5 (wildcard)").setRequired(false))
    .addUserOption(o => o.setName("seed6").setDescription("NFC seed #6 (wildcard)").setRequired(false))
    .addUserOption(o => o.setName("seed7").setDescription("NFC seed #7 (wildcard)").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("set_afc_seeds")
    .setDescription("Register AFC playoff seeds 1–7 (seeds 1–4 get top-4 playoff payout rate)")
    .addUserOption(o => o.setName("seed1").setDescription("AFC seed #1").setRequired(true))
    .addUserOption(o => o.setName("seed2").setDescription("AFC seed #2").setRequired(true))
    .addUserOption(o => o.setName("seed3").setDescription("AFC seed #3").setRequired(true))
    .addUserOption(o => o.setName("seed4").setDescription("AFC seed #4").setRequired(true))
    .addUserOption(o => o.setName("seed5").setDescription("AFC seed #5 (wildcard)").setRequired(false))
    .addUserOption(o => o.setName("seed6").setDescription("AFC seed #6 (wildcard)").setRequired(false))
    .addUserOption(o => o.setName("seed7").setDescription("AFC seed #7 (wildcard)").setRequired(false))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  return adminPlayoffs.execute(interaction);
}
