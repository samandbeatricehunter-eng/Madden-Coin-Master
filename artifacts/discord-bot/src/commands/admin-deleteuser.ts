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
  seasonsTable,
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
  const guildId = interaction.guildId!;
  const counts: Record<string, number> = {};
  const skipped: string[] = [];

  const del = async (label: string, promise: Promise<{ id?: number | string }[]>) => {
    const rows = await promise;
    counts[label] = rows.length;
  };

  // Subquery: season IDs that belong to this guild — used to scope all
  // tables that have seasonId but no guildId column.
  const guildSeasonIds = db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.guildId, guildId));

  if (flags.economy) {
    // userSavingsTable is intentionally global — no guild filter
    await del("savings",      db.delete(userSavingsTable)     .where(eq(userSavingsTable.discordId, discordId)).returning({ id: userSavingsTable.discordId }));
    await del("inventory",    db.delete(inventoryTable)       .where(and(eq(inventoryTable.discordId,        discordId), inArray(inventoryTable.seasonId,   guildSeasonIds))).returning({ id: inventoryTable.id }));
    await del("season_stats", db.delete(seasonStatsTable)     .where(and(eq(seasonStatsTable.discordId,      discordId), inArray(seasonStatsTable.seasonId, guildSeasonIds))).returning({ id: seasonStatsTable.id }));
    await del("transactions", db.delete(coinTransactionsTable).where(and(eq(coinTransactionsTable.discordId, discordId), eq(coinTransactionsTable.guildId, guildId))).returning({ id: coinTransactionsTable.id }));
    await del("purchases",    db.delete(purchasesTable)       .where(and(eq(purchasesTable.discordId,        discordId), inArray(purchasesTable.seasonId,   guildSeasonIds))).returning({ id: purchasesTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["economy"]!);
  }

  if (flags.records) {
    await del("user_records", db.delete(userRecordsTable)      .where(and(eq(userRecordsTable.discordId, discordId), inArray(userRecordsTable.seasonId, guildSeasonIds))).returning({ id: userRecordsTable.id }));
    await del("h2h_records",  db.delete(h2hMatchupRecordsTable).where(and(or(eq(h2hMatchupRecordsTable.discordId1, discordId), eq(h2hMatchupRecordsTable.discordId2, discordId)), eq(h2hMatchupRecordsTable.guildId, guildId))).returning({ id: h2hMatchupRecordsTable.id }));
    await del("game_log",     db.delete(gameLogTable)          .where(and(eq(gameLogTable.discordId,         discordId), eq(gameLogTable.guildId, guildId))).returning({ id: gameLogTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["records"]!);
  }

  if (flags.wagers) {
    await del("wagers", db.delete(wagersTable).where(and(or(eq(wagersTable.challengerId, discordId), eq(wagersTable.opponentId, discordId)), eq(wagersTable.guildId, guildId))).returning({ id: wagersTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["wagers"]!);
  }

  if (flags.trade_listings) {
    await del("trade_listings", db.delete(tradeBlockListingsTable).where(and(eq(tradeBlockListingsTable.discordId, discordId), inArray(tradeBlockListingsTable.seasonId, guildSeasonIds))).returning({ id: tradeBlockListingsTable.id }));
    await del("trade_iso",      db.delete(tradeBlockISOTable)     .where(and(eq(tradeBlockISOTable.discordId,     discordId), inArray(tradeBlockISOTable.seasonId,     guildSeasonIds))).returning({ id: tradeBlockISOTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["trade_listings"]!);
  }

  if (flags.payout_data) {
    // payoutRequestsTable has no guildId or seasonId — delete by discordId only
    await del("payout_requests", db.delete(payoutRequestsTable)      .where(or(eq(payoutRequestsTable.requesterId, discordId), eq(payoutRequestsTable.opponentId, discordId))).returning({ id: payoutRequestsTable.id }));
    await del("channel_payouts", db.delete(pendingChannelPayoutsTable).where(and(eq(pendingChannelPayoutsTable.discordId, discordId), eq(pendingChannelPayoutsTable.guildId, guildId))).returning({ id: pendingChannelPayoutsTable.id }));
    await del("eos_payouts",     db.delete(pendingEosPayoutsTable)    .where(and(eq(pendingEosPayoutsTable.discordId, discordId),    inArray(pendingEosPayoutsTable.seasonId, guildSeasonIds))).returning({ id: pendingEosPayoutsTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["payout_data"]!);
  }

  if (flags.interviews) {
    await del("interviews", db.delete(interviewRequestsTable).where(and(eq(interviewRequestsTable.discordId, discordId), eq(interviewRequestsTable.guildId, guildId))).returning({ id: interviewRequestsTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["interviews"]!);
  }

  if (flags.franchise_data) {
    // Clear the discord link on MCA teams (set to CPU) rather than deleting the row —
    // the team still exists in Madden; we just unlink the owner.
    const mcaRows = await db.update(franchiseMcaTeamsTable)
      .set({ discordId: null, isHuman: false, updatedAt: new Date() })
      .where(and(eq(franchiseMcaTeamsTable.discordId, discordId), inArray(franchiseMcaTeamsTable.seasonId, guildSeasonIds)))
      .returning({ id: franchiseMcaTeamsTable.id });
    counts["franchise_mca"] = mcaRows.length;

    // Null out discord_id on all roster rows owned by this player
    const rosterResult = await db.update(franchiseRostersTable)
      .set({ discordId: null })
      .where(and(eq(franchiseRostersTable.discordId, discordId), inArray(franchiseRostersTable.seasonId, guildSeasonIds)))
      .returning({ id: franchiseRostersTable.id });
    counts["franchise_rosters"] = rosterResult.length;

    await del("team_season_stats", db.delete(teamSeasonStatsTable)  .where(and(eq(teamSeasonStatsTable.discordId,   discordId), inArray(teamSeasonStatsTable.seasonId,   guildSeasonIds))).returning({ id: teamSeasonStatsTable.id }));
    await del("player_stats",      db.delete(playerSeasonStatsTable).where(and(eq(playerSeasonStatsTable.discordId, discordId), inArray(playerSeasonStatsTable.seasonId,   guildSeasonIds))).returning({ id: playerSeasonStatsTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["franchise_data"]!);
  }

  if (flags.custom_players) {
    await del("custom_players", db.delete(customPlayersTable).where(and(eq(customPlayersTable.discordId, discordId), inArray(customPlayersTable.seasonId, guildSeasonIds))).returning({ id: customPlayersTable.id }));
  } else {
    skipped.push(CATEGORY_LABELS["custom_players"]!);
  }

  // Always delete the user profile last — scoped to this guild only
  await db.delete(usersTable).where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)));

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
