/**
 * /admin-rollback-franchise
 *
 * Reverses ALL data written by a /franchiseupdate import that ran after a
 * given timestamp.  Safe to run any time a bad import is discovered.
 *
 * What it undoes:
 *  • coin_transactions describing "Franchise import" or "Career win milestone (franchise"
 *  • Corresponding balance changes on economy_users
 *  • game_log entries recorded after the cutoff
 *  • user_records (wins/losses/point_differential) deduced from those game_log rows
 *  • allTimeH2HWins / allTimeH2HLosses on economy_users (same deduction)
 *  • franchise_processed_games entries (processed_at after cutoff)
 *  • franchise_game_participants entries (created_at after cutoff)
 *
 * Default dry_run = true — always preview before committing.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, h2hMatchupRecordsTable,
  franchiseProcessedGamesTable, franchiseGameParticipantsTable,
} from "@workspace/db";
import { eq, and, gte, sql, inArray } from "drizzle-orm";
import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

// Local table definitions for tables not re-exported by the db barrel
const coinTransactionsTable = pgTable("coin_transactions", {
  id:          serial("id").primaryKey(),
  discordId:   text("discord_id").notNull(),
  amount:      integer("amount").notNull(),
  type:        text("type").notNull(),
  description: text("description").notNull(),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

const gameLogTable = pgTable("game_log", {
  id:                serial("id").primaryKey(),
  discordId:         text("discord_id").notNull(),
  seasonId:          integer("season_id").notNull(),
  result:            text("result").notNull(),
  pointSpread:       integer("point_spread").notNull().default(0),
  opponentLabel:     text("opponent_label").notNull().default(""),
  opponentDiscordId: text("opponent_discord_id"),
  recordedAt:        timestamp("recorded_at").notNull().defaultNow(),
});

// ── Command ──────────────────────────────────────────────────────────────────
const TIME_PERIOD_HOURS: Record<string, number> = {
  "2h": 2, "4h": 4, "8h": 8, "12h": 12, "24h": 24,
};

export const data = new SlashCommandBuilder()
  .setName("admin-rollback-franchise")
  .setDescription("Reverse all data written by franchise imports within a recent time window")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o
    .setName("time_period")
    .setDescription("How far back to roll back from right now")
    .setRequired(true)
    .addChoices(
      { name: "2 hours",  value: "2h"  },
      { name: "4 hours",  value: "4h"  },
      { name: "8 hours",  value: "8h"  },
      { name: "12 hours", value: "12h" },
      { name: "24 hours", value: "24h" },
    ))
  .addBooleanOption(o => o
    .setName("dry_run")
    .setDescription("Preview without making changes — default: TRUE. Set false to actually apply.")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const timePeriod = interaction.options.getString("time_period", true);
  const dryRun     = interaction.options.getBoolean("dry_run") ?? true;
  const hours      = TIME_PERIOD_HOURS[timePeriod] ?? 2;
  const since      = new Date(Date.now() - hours * 3_600_000);

  await interaction.editReply({ content: `🔍 Scanning for franchise data after ${since.toISOString()} (${timePeriod} window)...` });

  // ── Step 1: Franchise coin transactions ────────────────────────────────────
  const franchiseTxns = await db.select()
    .from(coinTransactionsTable)
    .where(
      and(
        gte(coinTransactionsTable.createdAt, since),
        sql`(lower(${coinTransactionsTable.description}) LIKE '%franchise import%'
          OR lower(${coinTransactionsTable.description}) LIKE '%career win milestone%(franchise%'
          OR lower(${coinTransactionsTable.description}) LIKE '%career win milestone%franchise%')`,
      )
    );

  // Net coin amount per user to reverse
  const balanceDelta = new Map<string, number>();
  for (const tx of franchiseTxns) {
    balanceDelta.set(tx.discordId, (balanceDelta.get(tx.discordId) ?? 0) + tx.amount);
  }

  // ── Step 2: game_log entries after cutoff ─────────────────────────────────
  const gameLogs = await db.select()
    .from(gameLogTable)
    .where(gte(gameLogTable.recordedAt, since));

  // Determine record corrections per (discordId, seasonId)
  type RecordKey = string; // `${discordId}:${seasonId}`
  type MatchupKey = string; // `${id1}:${id2}` canonical
  const recordDeltas   = new Map<RecordKey,  { wins: number; losses: number; pd: number }>();
  const allTimeDeltas  = new Map<string,     { wins: number; losses: number }>();
  // wins1/wins2 to subtract per canonical pair
  const matchupDeltas  = new Map<MatchupKey, { wins1: number; wins2: number }>();

  for (const log of gameLogs) {
    const key   = `${log.discordId}:${log.seasonId}`;
    const isH2H = log.opponentDiscordId != null;

    if (!recordDeltas.has(key))            recordDeltas.set(key, { wins: 0, losses: 0, pd: 0 });
    if (!allTimeDeltas.has(log.discordId)) allTimeDeltas.set(log.discordId, { wins: 0, losses: 0 });

    if (isH2H) {
      const rd = recordDeltas.get(key)!;
      const at = allTimeDeltas.get(log.discordId)!;
      if (log.result === "win")  { rd.wins++;   rd.pd += log.pointSpread; at.wins++; }
      if (log.result === "loss") { rd.losses++; rd.pd += log.pointSpread; at.losses++; }

      // Build per-pair matchup delta (only count the "win" side to avoid double-counting)
      if (log.result === "win" && log.opponentDiscordId) {
        const [id1, id2] = log.discordId < log.opponentDiscordId
          ? [log.discordId, log.opponentDiscordId]
          : [log.opponentDiscordId, log.discordId];
        const mKey = `${id1}:${id2}`;
        if (!matchupDeltas.has(mKey)) matchupDeltas.set(mKey, { wins1: 0, wins2: 0 });
        const md = matchupDeltas.get(mKey)!;
        if (log.discordId === id1) md.wins1++; else md.wins2++;
      }
    }
  }

  // ── Step 3: franchise_processed_games ─────────────────────────────────────
  const processedToDelete = await db.select({ gameId: franchiseProcessedGamesTable.gameId })
    .from(franchiseProcessedGamesTable)
    .where(gte(franchiseProcessedGamesTable.processedAt, since));

  // ── Step 4: franchise_game_participants ────────────────────────────────────
  const participantCount = (await db.select({ count: sql<number>`count(*)` })
    .from(franchiseGameParticipantsTable)
    .where(gte(franchiseGameParticipantsTable.createdAt, since)))[0]?.count ?? 0;

  // ── Build summary ─────────────────────────────────────────────────────────
  const lines: string[] = [
    `**Cutoff:** ${since.toISOString()}`,
    `**Mode:** ${dryRun ? "🔍 DRY RUN (nothing changed)" : "⚠️ LIVE — changes applied"}`,
    "",
    `Coin transactions to reverse: **${franchiseTxns.length}**`,
    `Game log entries to delete: **${gameLogs.length}**`,
    `Processed game IDs to clear: **${processedToDelete.length}**`,
    `Game participant records to clear: **${participantCount}**`,
    `Users affected: **${balanceDelta.size}**`,
  ];

  if (balanceDelta.size > 0) {
    lines.push("\n**Balance reversals:**");
    for (const [did, amt] of balanceDelta) {
      lines.push(`• <@${did}>  −${amt} coins`);
    }
  }

  if (recordDeltas.size > 0) {
    lines.push("\n**Record corrections (H2H only):**");
    for (const [key, delta] of recordDeltas) {
      const [did] = key.split(":");
      if (delta.wins || delta.losses || delta.pd) {
        lines.push(`• <@${did}>  W−${delta.wins}  L−${delta.losses}  PD${delta.pd >= 0 ? "−" : "+"}${Math.abs(delta.pd)}`);
      }
    }
  }

  if (dryRun) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔍 Franchise Rollback — DRY RUN")
          .setColor(Colors.Yellow)
          .setDescription(lines.join("\n").slice(0, 3900))
          .setTimestamp(),
      ],
    });
    return;
  }

  // ── Apply rollback ─────────────────────────────────────────────────────────

  // 5a. Reverse balances
  for (const [discordId, delta] of balanceDelta) {
    if (delta === 0) continue;
    await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} - ${delta}`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, discordId));
  }

  // 5b. Delete franchise coin transactions
  if (franchiseTxns.length > 0) {
    await db.delete(coinTransactionsTable)
      .where(inArray(coinTransactionsTable.id, franchiseTxns.map(t => t.id)));
  }

  // 5c. Correct user_records (subtract wins/losses/PD)
  for (const [key, delta] of recordDeltas) {
    const [discordId, seasonIdStr] = key.split(":");
    const seasonId = parseInt(seasonIdStr!, 10);
    if (!discordId || isNaN(seasonId)) continue;
    if (!delta.wins && !delta.losses && !delta.pd) continue;

    await db.update(userRecordsTable)
      .set({
        wins:              sql`GREATEST(0, ${userRecordsTable.wins}              - ${delta.wins})`,
        losses:            sql`GREATEST(0, ${userRecordsTable.losses}            - ${delta.losses})`,
        pointDifferential: sql`${userRecordsTable.pointDifferential}             - ${delta.pd}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(userRecordsTable.discordId, discordId),
        eq(userRecordsTable.seasonId,  seasonId),
      ));
  }

  // 5d. Correct all-time H2H counters
  for (const [discordId, delta] of allTimeDeltas) {
    if (!delta.wins && !delta.losses) continue;
    await db.update(usersTable)
      .set({
        allTimeH2HWins:   sql`GREATEST(0, ${usersTable.allTimeH2HWins}   - ${delta.wins})`,
        allTimeH2HLosses: sql`GREATEST(0, ${usersTable.allTimeH2HLosses} - ${delta.losses})`,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.discordId, discordId));
  }

  // 5d.5. Correct per-opponent matchup records
  for (const [mKey, md] of matchupDeltas) {
    const [id1, id2] = mKey.split(":") as [string, string];
    if (!md.wins1 && !md.wins2) continue;
    await db.update(h2hMatchupRecordsTable)
      .set({
        wins1: md.wins1 ? sql`GREATEST(0, ${h2hMatchupRecordsTable.wins1} - ${md.wins1})` : undefined,
        wins2: md.wins2 ? sql`GREATEST(0, ${h2hMatchupRecordsTable.wins2} - ${md.wins2})` : undefined,
        updatedAt: new Date(),
      })
      .where(and(
        eq(h2hMatchupRecordsTable.discordId1, id1),
        eq(h2hMatchupRecordsTable.discordId2, id2),
      ));
  }

  // 5e. Delete game_log entries
  if (gameLogs.length > 0) {
    await db.delete(gameLogTable)
      .where(inArray(gameLogTable.id, gameLogs.map(g => g.id)));
  }

  // 5f. Clear franchise_processed_games
  if (processedToDelete.length > 0) {
    await db.delete(franchiseProcessedGamesTable)
      .where(inArray(franchiseProcessedGamesTable.gameId, processedToDelete.map(g => g.gameId)));
  }

  // 5g. Clear franchise_game_participants
  await db.delete(franchiseGameParticipantsTable)
    .where(gte(franchiseGameParticipantsTable.createdAt, since));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Franchise Import Rolled Back")
        .setColor(Colors.Red)
        .setDescription(lines.join("\n").slice(0, 3900))
        .setTimestamp(),
    ],
  });
}
