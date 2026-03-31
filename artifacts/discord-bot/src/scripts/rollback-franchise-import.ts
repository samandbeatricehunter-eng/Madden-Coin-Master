import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function rollbackFranchiseImport() {
  console.log("=== FRANCHISE IMPORT ROLLBACK ===");
  console.log("Targeting transactions 408-490 (2026-03-31 18:44-18:45 UTC)\n");

  // STEP 1: Subtract coins from each user's balance
  console.log("Step 1: Reverting coin balances...");
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
    RETURNING u.discord_id, u.discord_username, u.balance
  `);
  console.log(`  Updated ${balanceResult.rows.length} user balance(s).`);
  for (const row of balanceResult.rows) {
    console.log(`    ${row.discord_username}: new balance = ${row.balance}`);
  }

  // STEP 2: Delete coin transactions 408-490
  console.log("\nStep 2: Deleting franchise import transactions (408-490)...");
  await db.execute(sql`
    DELETE FROM coin_transactions WHERE id BETWEEN 408 AND 490
  `);
  console.log("  Deleted transactions 408-490.");

  // STEP 3: Revert H2H records in user_records (Season 2)
  // Uses the signed point_spread values from game_log (positive for win, negative for loss)
  // which exactly match what upsertH2HRecord added to point_differential
  console.log("\nStep 3: Reverting H2H records in user_records (Season 2)...");
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
    RETURNING ur.discord_id, ur.wins, ur.losses, ur.point_differential
  `);
  console.log(`  Updated ${recordsResult.rows.length} user record(s).`);
  for (const row of recordsResult.rows) {
    console.log(`    Discord ${row.discord_id}: ${row.wins}W / ${row.losses}L / PD ${row.point_differential}`);
  }

  // STEP 4: Delete game_log entries 95-178 (all from the bad franchise import)
  console.log("\nStep 4: Deleting game_log entries 95-178...");
  await db.execute(sql`
    DELETE FROM game_log WHERE id BETWEEN 95 AND 178
  `);
  console.log("  Deleted game_log entries 95-178.");

  // STEP 5: Delete franchise_processed_games entries from the bad import
  console.log("\nStep 5: Clearing franchise_processed_games from bad import...");
  const fpgResult = await db.execute(sql`
    DELETE FROM franchise_processed_games
    WHERE processed_at >= '2026-03-31 18:44:00'
    RETURNING game_id
  `);
  console.log(`  Deleted ${fpgResult.rows.length} processed game record(s).`);

  // STEP 6: Delete franchise_game_participants from the bad import
  console.log("\nStep 6: Clearing franchise_game_participants from bad import...");
  const fgpResult = await db.execute(sql`
    DELETE FROM franchise_game_participants
    WHERE created_at >= '2026-03-31 18:44:00'
    RETURNING id
  `);
  console.log(`  Deleted ${fgpResult.rows.length} participant record(s).`);

  console.log("\n=== ROLLBACK COMPLETE ===");
  console.log("Summary:");
  console.log("  - Coin balances reverted for all affected users");
  console.log("  - Transactions 408-490 deleted");
  console.log("  - H2H records (Season 2) reverted to pre-import state");
  console.log("  - Game log entries 95-178 deleted");
  console.log("  - Franchise processed games cleared");
  console.log("  - Franchise game participants cleared");
  console.log("\nThe franchise update can now be re-run cleanly against the correct ZIP.");
}

rollbackFranchiseImport().catch(console.error).finally(() => process.exit(0));
