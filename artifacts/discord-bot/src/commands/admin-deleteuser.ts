/**
 * admin user_delete subcommand
 *
 * Permanently removes a user and all of their associated data from the
 * database. Requires explicit confirmation to prevent accidents.
 *
 * Deleted tables (all keyed by discord_id):
 *   userSavingsTable, inventoryTable, seasonStatsTable, userRecordsTable,
 *   coinTransactionsTable, purchasesTable, tradeBlockListingsTable,
 *   tradeBlockISOTable, customPlayersTable, h2hMatchupRecordsTable,
 *   gameLogTable, wagersTable, payoutRequestsTable, interviewRequestsTable,
 *   pendingChannelPayoutsTable, pendingEosPayoutsTable,
 *   franchiseMcaTeamsTable, teamSeasonStatsTable, playerSeasonStatsTable,
 *   usersTable (last)
 */

import {
  ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable,
  userSavingsTable,
  inventoryTable,
  seasonStatsTable,
  userRecordsTable,
  coinTransactionsTable,
  purchasesTable,
  tradeBlockListingsTable,
  tradeBlockISOTable,
  customPlayersTable,
  h2hMatchupRecordsTable,
  gameLogTable,
  wagersTable,
  payoutRequestsTable,
  interviewRequestsTable,
  pendingChannelPayoutsTable,
  pendingEosPayoutsTable,
  franchiseMcaTeamsTable,
  teamSeasonStatsTable,
  playerSeasonStatsTable,
} from "@workspace/db";
import { eq, or } from "drizzle-orm";

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser("user", true);
  const confirmed  = interaction.options.getBoolean("confirm") ?? false;

  const discordId = targetUser.id;

  // ── Look up the user ────────────────────────────────────────────────────────
  const [existing] = await db
    .select({
      discordId:       usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team:            usersTable.team,
      balance:         usersTable.balance,
    })
    .from(usersTable)
    .where(eq(usersTable.discordId, discordId))
    .limit(1);

  if (!existing) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ User Not Found")
          .setDescription(`<@${discordId}> is not registered in the bot database.`),
      ],
    });
  }

  // ── Show preview if not confirmed ──────────────────────────────────────────
  if (!confirmed) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("⚠️ Confirm User Deletion")
          .setDescription(
            `You are about to **permanently delete** all data for:\n\n` +
            `**${existing.discordUsername}** (<@${discordId}>)\n` +
            `• Team: **${existing.team ?? "none"}**\n` +
            `• Balance: **${existing.balance.toLocaleString()} 🪙**\n\n` +
            `This will delete their balance, inventory, stats, records, transactions, ` +
            `wagers, trade listings, and all other associated data.\n\n` +
            `**This action cannot be undone.** Re-run with \`confirm: True\` to proceed.`,
          )
          .setFooter({ text: "Re-run this command with confirm: True to permanently delete this user." }),
      ],
    });
  }

  // ── Perform deletion ────────────────────────────────────────────────────────
  const counts: Record<string, number> = {};

  const del = async (label: string, promise: Promise<{ id?: number | string }[]>) => {
    const rows = await promise;
    counts[label] = rows.length;
  };

  await del("savings",          db.delete(userSavingsTable)       .where(eq(userSavingsTable.discordId,       discordId)).returning({ id: userSavingsTable.discordId }));
  await del("inventory",        db.delete(inventoryTable)         .where(eq(inventoryTable.discordId,         discordId)).returning({ id: inventoryTable.id }));
  await del("season_stats",     db.delete(seasonStatsTable)       .where(eq(seasonStatsTable.discordId,       discordId)).returning({ id: seasonStatsTable.id }));
  await del("user_records",     db.delete(userRecordsTable)       .where(eq(userRecordsTable.discordId,       discordId)).returning({ id: userRecordsTable.id }));
  await del("transactions",     db.delete(coinTransactionsTable)  .where(eq(coinTransactionsTable.discordId,  discordId)).returning({ id: coinTransactionsTable.id }));
  await del("purchases",        db.delete(purchasesTable)         .where(eq(purchasesTable.discordId,         discordId)).returning({ id: purchasesTable.id }));
  await del("trade_listings",   db.delete(tradeBlockListingsTable).where(eq(tradeBlockListingsTable.discordId, discordId)).returning({ id: tradeBlockListingsTable.id }));
  await del("trade_iso",        db.delete(tradeBlockISOTable)     .where(eq(tradeBlockISOTable.discordId,     discordId)).returning({ id: tradeBlockISOTable.id }));
  await del("custom_players",   db.delete(customPlayersTable)     .where(eq(customPlayersTable.discordId,     discordId)).returning({ id: customPlayersTable.id }));
  await del("h2h_records",      db.delete(h2hMatchupRecordsTable) .where(or(eq(h2hMatchupRecordsTable.discordId1, discordId), eq(h2hMatchupRecordsTable.discordId2, discordId))).returning({ id: h2hMatchupRecordsTable.id }));
  await del("game_log",         db.delete(gameLogTable)           .where(eq(gameLogTable.discordId,           discordId)).returning({ id: gameLogTable.id }));
  await del("wagers",           db.delete(wagersTable)            .where(or(eq(wagersTable.challengerId, discordId), eq(wagersTable.opponentId, discordId))).returning({ id: wagersTable.id }));
  await del("payout_requests",  db.delete(payoutRequestsTable)    .where(or(eq(payoutRequestsTable.requesterId, discordId), eq(payoutRequestsTable.opponentId, discordId))).returning({ id: payoutRequestsTable.id }));
  await del("interviews",       db.delete(interviewRequestsTable) .where(eq(interviewRequestsTable.discordId, discordId)).returning({ id: interviewRequestsTable.id }));
  await del("channel_payouts",  db.delete(pendingChannelPayoutsTable).where(eq(pendingChannelPayoutsTable.discordId, discordId)).returning({ id: pendingChannelPayoutsTable.id }));
  await del("eos_payouts",      db.delete(pendingEosPayoutsTable) .where(eq(pendingEosPayoutsTable.discordId, discordId)).returning({ id: pendingEosPayoutsTable.id }));
  await del("franchise_mca",    db.delete(franchiseMcaTeamsTable) .where(eq(franchiseMcaTeamsTable.discordId, discordId)).returning({ id: franchiseMcaTeamsTable.id }));
  await del("team_season_stats",db.delete(teamSeasonStatsTable)   .where(eq(teamSeasonStatsTable.discordId,   discordId)).returning({ id: teamSeasonStatsTable.id }));
  await del("player_stats",     db.delete(playerSeasonStatsTable) .where(eq(playerSeasonStatsTable.discordId, discordId)).returning({ id: playerSeasonStatsTable.id }));

  // Delete the user last
  await db.delete(usersTable).where(eq(usersTable.discordId, discordId));

  // ── Build summary ───────────────────────────────────────────────────────────
  const summaryLines = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `• ${label}: **${n}** row${n === 1 ? "" : "s"} deleted`);

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🗑️ User Deleted")
        .setDescription(
          `**${existing.discordUsername}**${existing.team ? ` (${existing.team})` : ""} has been permanently removed.\n\n` +
          (summaryLines.length > 0 ? summaryLines.join("\n") : "*No associated data found.*"),
        )
        .setFooter({ text: `Deleted by ${interaction.user.username}` })
        .setTimestamp(),
    ],
  });
}
