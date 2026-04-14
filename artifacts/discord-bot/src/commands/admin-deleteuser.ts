/**
 * admin user_delete subcommand
 *
 * Permanently removes a user and their associated data. Each data category
 * can be individually included or excluded via boolean options (all default
 * to true). Requires confirm:True to execute.
 *
 * Categories:
 *   del_economy        — savings, inventory, season_stats, transactions, purchases
 *   del_records        — user_records, h2h_records, game_log
 *   del_wagers         — wagers
 *   del_trade_listings — trade_block_listings, trade_block_iso
 *   del_payout_data    — payout_requests, channel_payouts, eos_payouts
 *   del_interviews     — interview_requests
 *   del_franchise_data — franchise_mca_teams, team_season_stats, player_season_stats
 *   del_custom_players — custom_players
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
  franchiseRostersTable,
  teamSeasonStatsTable,
  playerSeasonStatsTable,
} from "@workspace/db";
import { eq, or, and, inArray } from "drizzle-orm";

// ── Category labels shown in the preview / summary ─────────────────────────────
const CATEGORY_LABELS: Record<string, string> = {
  economy:        "Economy (savings, inventory, season limits, transactions, purchases)",
  records:        "Records (season records, H2H records, game log)",
  wagers:         "Wagers",
  trade_listings: "Trade listings (trade block & ISO)",
  payout_data:    "Payout data (requests, channel payouts, pending EOS payouts)",
  interviews:     "Interview requests",
  franchise_data: "Franchise data (MCA mapping, team stats, player stats)",
  custom_players: "Custom players",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser("user", true);
  const confirmed  = interaction.options.getBoolean("confirm") ?? false;

  // Read category flags — all default to true
  const flags = {
    economy:        interaction.options.getBoolean("del_economy")        ?? true,
    records:        interaction.options.getBoolean("del_records")        ?? true,
    wagers:         interaction.options.getBoolean("del_wagers")         ?? true,
    trade_listings: interaction.options.getBoolean("del_trade_listings") ?? true,
    payout_data:    interaction.options.getBoolean("del_payout_data")    ?? true,
    interviews:     interaction.options.getBoolean("del_interviews")     ?? true,
    franchise_data: interaction.options.getBoolean("del_franchise_data") ?? true,
    custom_players: interaction.options.getBoolean("del_custom_players") ?? true,
  };

  const transferTo = interaction.options.getUser("transfer_to") ?? null;
  const discordId  = targetUser.id;

  // ── Look up the user ────────────────────────────────────────────────────────
  const [existing] = await db
    .select({
      discordId:       usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team:            usersTable.team,
      balance:         usersTable.balance,
    })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, interaction.guildId!)))
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

  // ── Build what-will-be-deleted list ────────────────────────────────────────
  const willDelete  = Object.entries(flags).filter(([, v]) => v).map(([k]) => `• 🗑️ ${CATEGORY_LABELS[k]}`);
  const willKeep    = Object.entries(flags).filter(([, v]) => !v).map(([k]) => `• 🔒 ${CATEGORY_LABELS[k]} *(preserved)*`);

  // ── Show preview if not confirmed ──────────────────────────────────────────
  if (!confirmed) {
    const lines = [
      `**${existing.discordUsername}** (<@${discordId}>)`,
      `• Team: **${existing.team ?? "none"}**`,
      `• Balance: **${existing.balance.toLocaleString()} 🪙**`,
      "",
      "**Will be deleted:**",
      ...willDelete,
    ];
    if (willKeep.length > 0) {
      lines.push("", "**Will be preserved:**", ...willKeep);
    }
    lines.push("", "**This action cannot be undone.** Re-run with `confirm: True` to proceed.");

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("⚠️ Confirm User Deletion")
          .setDescription(lines.join("\n"))
          .setFooter({ text: "Re-run this command with confirm: True to execute." }),
      ],
    });
  }

  // ── Perform deletion ────────────────────────────────────────────────────────
  const counts: Record<string, number> = {};
  const skipped: string[] = [];

  const del = async (label: string, promise: Promise<{ id?: number | string }[]>) => {
    const rows = await promise;
    counts[label] = rows.length;
  };

  if (flags.economy) {
    await del("savings",      db.delete(userSavingsTable)     .where(eq(userSavingsTable.discordId,      discordId)).returning({ id: userSavingsTable.discordId }));
    await del("inventory",    db.delete(inventoryTable)       .where(eq(inventoryTable.discordId,        discordId)).returning({ id: inventoryTable.id }));
    await del("season_stats", db.delete(seasonStatsTable)     .where(eq(seasonStatsTable.discordId,      discordId)).returning({ id: seasonStatsTable.id }));
    await del("transactions", db.delete(coinTransactionsTable).where(eq(coinTransactionsTable.discordId, discordId)).returning({ id: coinTransactionsTable.id }));
    await del("purchases",    db.delete(purchasesTable)       .where(eq(purchasesTable.discordId,        discordId)).returning({ id: purchasesTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["economy"]!);
  }

  if (flags.records) {
    await del("user_records", db.delete(userRecordsTable)      .where(eq(userRecordsTable.discordId,     discordId)).returning({ id: userRecordsTable.id }));
    await del("h2h_records",  db.delete(h2hMatchupRecordsTable).where(or(eq(h2hMatchupRecordsTable.discordId1, discordId), eq(h2hMatchupRecordsTable.discordId2, discordId))).returning({ id: h2hMatchupRecordsTable.id }));
    await del("game_log",     db.delete(gameLogTable)          .where(eq(gameLogTable.discordId,         discordId)).returning({ id: gameLogTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["records"]!);
  }

  if (flags.wagers) {
    await del("wagers", db.delete(wagersTable).where(or(eq(wagersTable.challengerId, discordId), eq(wagersTable.opponentId, discordId))).returning({ id: wagersTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["wagers"]!);
  }

  if (flags.trade_listings) {
    await del("trade_listings", db.delete(tradeBlockListingsTable).where(eq(tradeBlockListingsTable.discordId, discordId)).returning({ id: tradeBlockListingsTable.id }));
    await del("trade_iso",      db.delete(tradeBlockISOTable)     .where(eq(tradeBlockISOTable.discordId,     discordId)).returning({ id: tradeBlockISOTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["trade_listings"]!);
  }

  if (flags.payout_data) {
    await del("payout_requests", db.delete(payoutRequestsTable)      .where(or(eq(payoutRequestsTable.requesterId, discordId), eq(payoutRequestsTable.opponentId, discordId))).returning({ id: payoutRequestsTable.id }));
    await del("channel_payouts", db.delete(pendingChannelPayoutsTable).where(eq(pendingChannelPayoutsTable.discordId, discordId)).returning({ id: pendingChannelPayoutsTable.id }));
    await del("eos_payouts",     db.delete(pendingEosPayoutsTable)    .where(eq(pendingEosPayoutsTable.discordId,    discordId)).returning({ id: pendingEosPayoutsTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["payout_data"]!);
  }

  if (flags.interviews) {
    await del("interviews", db.delete(interviewRequestsTable).where(eq(interviewRequestsTable.discordId, discordId)).returning({ id: interviewRequestsTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["interviews"]!);
  }

  if (flags.franchise_data) {
    // Clear the discord link on MCA teams (set to CPU) rather than deleting the row —
    // the team still exists in Madden; we just unlink the owner.
    const mcaRows = await db.update(franchiseMcaTeamsTable)
      .set({ discordId: null, isHuman: false, updatedAt: new Date() })
      .where(eq(franchiseMcaTeamsTable.discordId, discordId))
      .returning({ id: franchiseMcaTeamsTable.id });
    counts["franchise_mca"] = mcaRows.length;

    // Null out discord_id on all roster rows owned by this player
    const rosterResult = await db.update(franchiseRostersTable)
      .set({ discordId: null })
      .where(eq(franchiseRostersTable.discordId, discordId))
      .returning({ id: franchiseRostersTable.id });
    counts["franchise_rosters"] = rosterResult.length;

    await del("team_season_stats", db.delete(teamSeasonStatsTable)   .where(eq(teamSeasonStatsTable.discordId,    discordId)).returning({ id: teamSeasonStatsTable.id }));
    await del("player_stats",      db.delete(playerSeasonStatsTable) .where(eq(playerSeasonStatsTable.discordId, discordId)).returning({ id: playerSeasonStatsTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["franchise_data"]!);
  }

  if (flags.custom_players) {
    await del("custom_players", db.delete(customPlayersTable).where(eq(customPlayersTable.discordId, discordId)).returning({ id: customPlayersTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["custom_players"]!);
  }

  // Always delete the user profile last
  await db.delete(usersTable).where(eq(usersTable.discordId, discordId));

  // ── Build summary ───────────────────────────────────────────────────────────
  const deletedLines = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `• ${label}: **${n}** row${n === 1 ? "" : "s"} deleted`);

  const skippedLines = skipped.map(s => `• 🔒 ${s} *(preserved)*`);

  const descParts = [
    `**${existing.discordUsername}**${existing.team ? ` (${existing.team})` : ""} has been permanently removed from the database.`,
    "",
    deletedLines.length > 0 ? `**Deleted:**\n${deletedLines.join("\n")}` : "*No associated data found.*",
  ];
  if (skippedLines.length > 0) {
    descParts.push("", `**Preserved (skipped):**\n${skippedLines.join("\n")}`);
  }

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🗑️ User Deleted")
        .setDescription(descParts.join("\n"))
        .setFooter({ text: `Deleted by ${interaction.user.username}` })
        .setTimestamp(),
    ],
  });
}
