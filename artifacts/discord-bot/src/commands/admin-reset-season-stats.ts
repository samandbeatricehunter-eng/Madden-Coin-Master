/**
 * /admin-reset-season-stats
 *
 * Wipes ALL season-specific game stats for this guild's active season so
 * a clean Week 1 import can proceed.  Balance reset is optional.
 *
 * What it clears:
 *  • user_records          — wins / losses / point_differential
 *  • game_log              — individual game entries
 *  • franchise_processed_games — dedup tracking (so games can be re-imported)
 *  • franchise_game_participants
 *  • team_season_stats     — team-level cumulative stats
 *  • h2h_matchup_records   — per-opponent H2H records
 *  • allTimeH2HWins / allTimeH2HLosses / allTimeH2HPushes on economy_users
 *  • (optional) coin balance → reset to starting_balance or 200
 *
 * Dry-run by default — always preview before committing.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable,
  userRecordsTable,
  gameLogTable,
  franchiseProcessedGamesTable,
  franchiseGameParticipantsTable,
  teamSeasonStatsTable,
  h2hMatchupRecordsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-reset-season-stats")
  .setDescription("Wipe all W/L records and stats for the current season so Week 1 can be imported cleanly")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption(o => o
    .setName("dry_run")
    .setDescription("Preview without making changes — default: TRUE. Set false to actually apply.")
    .setRequired(false))
  .addBooleanOption(o => o
    .setName("reset_balances")
    .setDescription("Also reset coin balances to starting_balance (200 default) — default: FALSE")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId   = interaction.guildId!;
  const dryRun    = interaction.options.getBoolean("dry_run") ?? true;
  const resetBals = interaction.options.getBoolean("reset_balances") ?? false;

  const season = await getOrCreateActiveSeason(guildId);

  // ── Count what will be affected ──────────────────────────────────────────────

  const [recCount] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(userRecordsTable)
    .where(eq(userRecordsTable.seasonId, season.id));

  const [glCount] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(gameLogTable)
    .where(eq(gameLogTable.seasonId, season.id));

  const [pgCount] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(franchiseProcessedGamesTable)
    .where(eq(franchiseProcessedGamesTable.seasonIdRef, season.id));

  const [partCount] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(franchiseGameParticipantsTable)
    .where(eq(franchiseGameParticipantsTable.seasonId, season.id));

  const [tsCount] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, season.id));

  const [h2hCount] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(h2hMatchupRecordsTable)
    .where(eq(h2hMatchupRecordsTable.guildId, guildId));

  const STARTING_BALANCE = 200;

  const guildUsers = await db
    .select({ discordId: usersTable.discordId, balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.guildId, guildId));

  const balanceLines = resetBals
    ? guildUsers.slice(0, 5).map(u => `• <@${u.discordId}>: ${u.balance} → ${STARTING_BALANCE}`)
    : [];

  const embed = new EmbedBuilder()
    .setTitle(dryRun ? "📋 Season Stats Reset — DRY RUN (no changes made)" : "🗑️ Season Stats Reset — APPLIED")
    .setColor(dryRun ? Colors.Yellow : Colors.Red)
    .addFields(
      { name: "Season",            value: `Season ${season.seasonNumber} (ID: ${season.id})`, inline: true },
      { name: "Guild",             value: guildId,                                             inline: true },
      { name: "\u200b",            value: "\u200b",                                            inline: false },
      { name: "user_records",      value: `${recCount?.n ?? 0} rows`,   inline: true },
      { name: "game_log",          value: `${glCount?.n ?? 0} rows`,    inline: true },
      { name: "processed_games",   value: `${pgCount?.n ?? 0} rows`,    inline: true },
      { name: "game_participants", value: `${partCount?.n ?? 0} rows`,  inline: true },
      { name: "team_season_stats", value: `${tsCount?.n ?? 0} rows`,    inline: true },
      { name: "h2h_matchup_recs",  value: `${h2hCount?.n ?? 0} rows`,   inline: true },
      { name: "allTime W/L reset", value: `${guildUsers.length} users`, inline: true },
      { name: "Balance reset",     value: resetBals ? `Yes (${guildUsers.length} users)` : "No", inline: true },
    );

  if (resetBals && balanceLines.length) {
    embed.addFields({ name: "Sample balance changes (first 5)", value: balanceLines.join("\n") || "none" });
  }

  if (dryRun) {
    embed.setFooter({ text: "Re-run with dry_run:False to apply" });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Apply deletions ──────────────────────────────────────────────────────────

  await db.delete(userRecordsTable).where(eq(userRecordsTable.seasonId, season.id));
  await db.delete(gameLogTable).where(eq(gameLogTable.seasonId, season.id));
  await db.delete(franchiseProcessedGamesTable).where(eq(franchiseProcessedGamesTable.seasonIdRef, season.id));
  await db.delete(franchiseGameParticipantsTable).where(eq(franchiseGameParticipantsTable.seasonId, season.id));
  await db.delete(teamSeasonStatsTable).where(eq(teamSeasonStatsTable.seasonId, season.id));
  await db.delete(h2hMatchupRecordsTable).where(eq(h2hMatchupRecordsTable.guildId, guildId));

  // Reset allTime W/L counters
  await db.update(usersTable)
    .set({ allTimeH2HWins: 0, allTimeH2HLosses: 0, updatedAt: new Date() })
    .where(eq(usersTable.guildId, guildId));

  // Optionally reset balances to the default starting balance
  if (resetBals) {
    await db.update(usersTable)
      .set({ balance: STARTING_BALANCE, updatedAt: new Date() })
      .where(eq(usersTable.guildId, guildId));
  }

  embed.setFooter({ text: "All changes applied successfully" });
  await interaction.editReply({ embeds: [embed] });
}
