/**
 * admin-cancel-resend-eos.ts
 *
 * Cancels all "pending" EOS payout rows for the active season and re-posts
 * fresh approval embeds to the commissioner channel.  Use this when you had
 * to re-run /advanceweek for wildcard week and the original payout messages
 * were deleted.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { pendingEosPayoutsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { runEosAutoPost } from "../lib/eos-auto-post.js";

export const data = new SlashCommandBuilder()
  .setName("admin-cancel-resend-eos")
  .setDescription("Cancel pending EOS payout approvals and repost them to the commissioner channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  // Delete all pending (not yet approved) EOS payout rows for this season
  const deleted = await db.delete(pendingEosPayoutsTable)
    .where(and(
      eq(pendingEosPayoutsTable.seasonId, season.id),
      inArray(pendingEosPayoutsTable.status, ["pending"]),
    ))
    .returning({ id: pendingEosPayoutsTable.id });

  await interaction.editReply({
    content: `🗑️ Cancelled **${deleted.length}** pending EOS payout record(s). Reposting approval embeds now — this may take a minute…`,
  });

  try {
    const result = await runEosAutoPost(interaction.client, season.id, interaction.guildId!);

    await interaction.editReply({
      content:
        `✅ Done!\n` +
        `• **${deleted.length}** old pending record(s) cancelled\n` +
        `• **${result.posted}** new payout approval embed(s) posted to the commissioner channel\n` +
        `• **${result.skipped}** user(s) skipped (no stat data)\n` +
        (result.errors > 0 ? `• ⚠️ **${result.errors}** error(s) — check bot logs` : ""),
    });
  } catch (err) {
    console.error("[admin-cancel-resend-eos] EOS re-post failed:", err);
    await interaction.editReply({
      content: `⚠️ Cancelled **${deleted.length}** pending record(s) but EOS auto-post failed: \`${err}\``,
    });
  }
}
