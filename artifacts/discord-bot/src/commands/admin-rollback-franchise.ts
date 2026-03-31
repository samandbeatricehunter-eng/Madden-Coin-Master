import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("admin-rollback-franchise")
  .setDescription(
    "[TEMP] Rollback the bad franchise import (transactions 408-490). ONE-TIME USE."
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const lines: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    lines.push(msg);
  };

  try {
    log("=== FRANCHISE IMPORT ROLLBACK ===");

    // Verify there's something to roll back
    const checkResult = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM coin_transactions WHERE id BETWEEN 408 AND 490
    `);
    const count = Number((checkResult.rows[0] as any).cnt);

    if (count === 0) {
      await interaction.editReply(
        "❌ Nothing to roll back — transactions 408-490 do not exist (already rolled back?)."
      );
      return;
    }

    log(`Found ${count} transactions to roll back.`);

    // STEP 1: Revert coin balances
    const balanceResult = await db.execute(sql`
      UPDATE economy_users u
      SET balance = u.balance - totals.total_to_subtract,
          updated_at = NOW()
      FROM (
        SELECT discord_id, SUM(amount) as total_to_subtract
        FROM coin_transactions
        WHERE id BETWEEN 408 AND 490
        GROUP BY discord_id
      ) AS totals
      WHERE u.discord_id = totals.discord_id
      RETURNING u.discord_username, u.balance
    `);
    log(`✅ Step 1: Reverted balances for ${balanceResult.rows.length} users.`);

    // STEP 2: Delete transactions
    await db.execute(sql`
      DELETE FROM coin_transactions WHERE id BETWEEN 408 AND 490
    `);
    log("✅ Step 2: Deleted transactions 408-490.");

    // STEP 3: Revert H2H records in user_records Season 2
    const recordsResult = await db.execute(sql`
      UPDATE user_records ur
      SET wins               = GREATEST(0, ur.wins   - deltas.h2h_wins),
          losses             = GREATEST(0, ur.losses - deltas.h2h_losses),
          point_differential = ur.point_differential - deltas.pd_delta,
          updated_at         = NOW()
      FROM (
        SELECT
          discord_id,
          COUNT(*) FILTER (WHERE result = 'win')  AS h2h_wins,
          COUNT(*) FILTER (WHERE result = 'loss') AS h2h_losses,
          SUM(point_spread)                        AS pd_delta
        FROM game_log
        WHERE id BETWEEN 95 AND 178
          AND opponent_label NOT LIKE '[CPU]%'
        GROUP BY discord_id
      ) AS deltas,
      seasons s
      WHERE ur.discord_id = deltas.discord_id
        AND ur.season_id  = s.id
        AND s.season_number = 2
      RETURNING ur.discord_id
    `);
    log(`✅ Step 3: Reverted Season 2 H2H records for ${recordsResult.rows.length} users.`);

    // STEP 4: Delete game_log entries 95-178
    await db.execute(sql`
      DELETE FROM game_log WHERE id BETWEEN 95 AND 178
    `);
    log("✅ Step 4: Deleted game_log entries 95-178.");

    // STEP 5: Delete franchise_processed_games from bad import
    const fpgResult = await db.execute(sql`
      DELETE FROM franchise_processed_games
      WHERE processed_at >= '2026-03-31 18:44:00'
      RETURNING game_id
    `);
    log(`✅ Step 5: Deleted ${fpgResult.rows.length} processed game entries.`);

    // STEP 6: Delete franchise_game_participants from bad import
    const fgpResult = await db.execute(sql`
      DELETE FROM franchise_game_participants
      WHERE created_at >= '2026-03-31 18:44:00'
      RETURNING id
    `);
    log(`✅ Step 6: Deleted ${fgpResult.rows.length} participant entries.`);

    log("=== ROLLBACK COMPLETE ===");

    const summary = [
      "✅ **Franchise Import Rollback Complete**",
      "",
      `• Coin balances reverted for ${balanceResult.rows.length} users`,
      "• Transactions 408-490 deleted",
      `• Season 2 H2H records reverted for ${recordsResult.rows.length} users`,
      "• Game log entries 95-178 deleted",
      `• ${fpgResult.rows.length} processed game entries cleared`,
      `• ${fgpResult.rows.length} participant entries cleared`,
      "",
      "The `/franchiseupdate` command can now be re-run cleanly.",
    ].join("\n");

    await interaction.editReply(summary);
  } catch (err: any) {
    console.error("Rollback failed:", err);
    await interaction.editReply(
      `❌ Rollback failed at step: ${lines.at(-1) ?? "unknown"}\n\`\`\`${err.message}\`\`\``
    );
  }
}
