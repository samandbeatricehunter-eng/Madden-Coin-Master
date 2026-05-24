/**
 * admin-rebuild-historical.ts
 *
 * Deletes the historical records channel for the current season and rebuilds it
 * from scratch, re-posting:
 *  - Season recap article (historical channel only — no @everyone in headlines)
 *  - In-game award winners (display only — no coin bonuses re-issued)
 *  - Stat leaders (top 3 per category)
 *  - Playoff picture / division winners (with W-L and point differentials)
 *  - Community polls (loudest mouth top-5 by message count; most heart top-5+bottom-5)
 *
 * PR bonuses and GOTY poll are NOT re-run (they were already issued).
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits, Guild,
} from "discord.js";
import { getOrCreateActiveSeason } from "../../lib/db/db-helpers.js";
import { rebuildHistoricalChannel } from "../../lib/franchise/wildcard-automation.js";

export const data = new SlashCommandBuilder()
  .setName("admin-rebuild-historical")
  .setDescription("Delete and rebuild the historical records channel for the current season")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const guild  = interaction.guild as Guild | null;

  if (!guild) {
    await interaction.editReply({ content: "❌ This command must be run inside the server." });
    return;
  }

  await interaction.editReply({
    content:
      `⏳ Deleting old historical channel and rebuilding Season ${season.seasonNumber}...\n` +
      `This will scan message history (loudest mouth poll) and generate the AI season recap — ` +
      `**please wait a few minutes** before checking.`,
  });

  try {
    const newChannel = await rebuildHistoricalChannel(
      interaction.client,
      season.id,
      season.seasonNumber,
      guild,
    );

    await interaction.editReply({
      content:
        `✅ **Historical records channel rebuilt!**\n` +
        `New channel: <#${newChannel.id}>\n\n` +
        `Posted:\n` +
        `• Season recap article\n` +
        `• In-game award winners\n` +
        `• Stat leaders (top 3 per category)\n` +
        `• Playoff picture + division winners (with W-L and point differentials)\n` +
        `• Community polls (loudest mouth, most heart, best/worst of the worst)`,
    });
  } catch (err) {
    console.error("[admin-rebuild-historical] Rebuild failed:", err);
    await interaction.editReply({
      content: `❌ Rebuild failed: \`${err}\`\nCheck bot logs for details.`,
    });
  }
}
