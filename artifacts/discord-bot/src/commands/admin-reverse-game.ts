import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, gameLogTable,
  h2hMatchupRecordsTable, franchiseProcessedGamesTable,
} from "@workspace/db";
import { eq, and, sql, or } from "drizzle-orm";
import { logTransaction, getOrCreateActiveSeason, isAdminUser } from "../lib/db-helpers.js";

const COMMISSIONER_CHANNEL_ID = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";

const PLAYOFF_LABELS: Record<number, string> = {
  1018: "Wild Card",
  1019: "Divisional",
  1020: "Conference Championship",
  1022: "Super Bowl",
};

function weekIndexToLabel(idx: number): string {
  return PLAYOFF_LABELS[idx] ?? `Week ${idx + 1}`;
}

// ── Action flags type ─────────────────────────────────────────────────────────
interface ReverseFlags {
  doH2H:       boolean;
  doSeason:    boolean;
  doAllTime:   boolean;
  doMilestone: boolean;
  doCoins:     boolean;
  doDeleteRec: boolean;
}

// ── Per-record reversal helper ────────────────────────────────────────────────
// Returns { actionLog, warnings } for one processed game record.
async function reverseOneRecord(
  record: typeof franchiseProcessedGamesTable.$inferSelect,
  flags:  ReverseFlags,
  reason: string,
  guildId: string,
  seasonId: number,
): Promise<{ actionLog: string[]; warnings: string[] }> {
  const { doH2H, doSeason, doAllTime, doMilestone, doCoins, doDeleteRec } = flags;

  const winnerId  = record.winnerDiscordId;
  const loserId   = record.loserDiscordId;
  const pointDiff = record.appliedPointDiff ?? 0;
  const winCoins  = record.winnerCoins      ?? 0;
  const loseCoins = record.loserCoins       ?? 0;
  const mBonus    = record.milestoneBonus;
  const mPrevTier = record.milestonePrevTier;

  const weekLabel = weekIndexToLabel(record.weekIndexRef ?? 0);
  const tag       = record.homeTeamRef && record.awayTeamRef
    ? `${record.homeTeamRef} vs ${record.awayTeamRef}`
    : record.gameId;

  const actionLog: string[] = [];
  const warnings:  string[] = [];

  if (!winnerId) {
    warnings.push(`⚠️ \`${tag}\` — no winner Discord ID stored, skipped`);
    return { actionLog, warnings };
  }

  // 1. H2H matchup record
  if (doH2H && loserId) {
    const [id1, id2]   = winnerId < loserId ? [winnerId, loserId] : [loserId, winnerId];
    const winnerIsId1  = winnerId === id1;
    const [h2hRow]     = await db.select().from(h2hMatchupRecordsTable)
      .where(and(eq(h2hMatchupRecordsTable.discordId1, id1), eq(h2hMatchupRecordsTable.discordId2, id2)))
      .limit(1);

    if (h2hRow) {
      await db.update(h2hMatchupRecordsTable)
        .set({
          [winnerIsId1 ? "wins1" : "wins2"]:
            winnerIsId1
              ? sql`GREATEST(0, ${h2hMatchupRecordsTable.wins1} - 1)`
              : sql`GREATEST(0, ${h2hMatchupRecordsTable.wins2} - 1)`,
          updatedAt: new Date(),
        })
        .where(and(eq(h2hMatchupRecordsTable.discordId1, id1), eq(h2hMatchupRecordsTable.discordId2, id2)));
      actionLog.push(`✅ \`${tag}\` H2H record reversed`);
    } else {
      warnings.push(`⚠️ \`${tag}\` H2H matchup row not found`);
    }
  } else if (doH2H && !loserId) {
    warnings.push(`⚠️ \`${tag}\` H2H skipped — CPU game`);
  }

  // 2. Season W/L + point differential
  if (doSeason) {
    await db.update(userRecordsTable)
      .set({
        wins:              sql`GREATEST(0, ${userRecordsTable.wins} - 1)`,
        pointDifferential: sql`${userRecordsTable.pointDifferential} - ${pointDiff}`,
        updatedAt: new Date(),
      })
      .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, seasonId)));

    if (loserId) {
      await db.update(userRecordsTable)
        .set({
          losses:            sql`GREATEST(0, ${userRecordsTable.losses} - 1)`,
          pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointDiff}`,
          updatedAt: new Date(),
        })
        .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, seasonId)));
    }
    actionLog.push(`✅ \`${tag}\` season W/L corrected`);
  }

  // 3. All-time H2H counters
  if (doAllTime) {
    await db.update(usersTable)
      .set({ allTimeH2HWins: sql`GREATEST(0, ${usersTable.allTimeH2HWins} - 1)`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, winnerId));

    if (loserId) {
      await db.update(usersTable)
        .set({ allTimeH2HLosses: sql`GREATEST(0, ${usersTable.allTimeH2HLosses} - 1)`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, loserId));
    }
    actionLog.push(`✅ \`${tag}\` all-time W/L corrected`);
  }

  // 4. Milestone payout
  if (doMilestone) {
    if (mBonus != null && mPrevTier != null) {
      await db.update(usersTable)
        .set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${mBonus})`, milestoneTierAwarded: mPrevTier, updatedAt: new Date() })
        .where(eq(usersTable.discordId, winnerId));
      await logTransaction(
        winnerId, -mBonus, "removecoins",
        `Admin reversal: milestone clawback (tier→${mPrevTier}) — ${reason}`,
        guildId,
      );
      actionLog.push(`✅ \`${tag}\` milestone clawed back (−${mBonus} coins, tier → ${mPrevTier})`);
    } else {
      actionLog.push(`ℹ️ \`${tag}\` no milestone recorded`);
    }
  }

  // 5. Coin payouts
  if (doCoins) {
    const coinParts: string[] = [];
    if (winCoins > 0) {
      await db.update(usersTable)
        .set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${winCoins})`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, winnerId));
      await logTransaction(
        winnerId, -winCoins, "removecoins",
        `Admin reversal: win payout clawback (${weekLabel}) — ${reason}`,
        guildId,
      );
      coinParts.push(`−${winCoins} from <@${winnerId}>`);
    }
    if (loserId && loseCoins > 0) {
      await db.update(usersTable)
        .set({ balance: sql`GREATEST(0, ${usersTable.balance} - ${loseCoins})`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, loserId));
      await logTransaction(
        loserId, -loseCoins, "removecoins",
        `Admin reversal: loss payout clawback (${weekLabel}) — ${reason}`,
        guildId,
      );
      coinParts.push(`−${loseCoins} from <@${loserId}>`);
    }
    actionLog.push(
      coinParts.length > 0
        ? `✅ \`${tag}\` coins reversed: ${coinParts.join(", ")}`
        : `ℹ️ \`${tag}\` no coins recorded`,
    );
  }

  // 6. Delete processed record + most-recent game log pair
  if (doDeleteRec) {
    await db.delete(franchiseProcessedGamesTable)
      .where(eq(franchiseProcessedGamesTable.gameId, record.gameId));

    for (const [discordId, result, opponentId] of [
      [winnerId,       "win",  loserId  ] as const,
      ...(loserId ? [[loserId, "loss", winnerId] as const] : []),
    ]) {
      const [logRow] = await db
        .select({ id: gameLogTable.id })
        .from(gameLogTable)
        .where(and(
          eq(gameLogTable.discordId, discordId),
          eq(gameLogTable.seasonId,  seasonId),
          eq(gameLogTable.result,    result),
          opponentId
            ? eq(gameLogTable.opponentDiscordId, opponentId)
            : sql`${gameLogTable.opponentDiscordId} IS NULL`,
        ))
        .orderBy(sql`${gameLogTable.recordedAt} DESC`)
        .limit(1);
      if (logRow) await db.delete(gameLogTable).where(eq(gameLogTable.id, logRow.id));
    }

    actionLog.push(`✅ \`${tag}\` processed record deleted (ID: \`${record.gameId}\`)`);
  }

  return { actionLog, warnings };
}

// ── Command definition ────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("admin-reverse-game")
  .setDescription("Admin: reverse processed game result(s) — single game or all games for a full week")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  // ── Scope ────────────────────────────────────────────────────────────────────
  .addBooleanOption(o => o
    .setName("reverse_entire_week")
    .setDescription("true = reverse every game recorded for the chosen week; false = reverse one specific matchup")
    .setRequired(true))

  // ── Which week ───────────────────────────────────────────────────────────────
  .addIntegerOption(o => o
    .setName("week")
    .setDescription("Week number (1–22 regular season; 1–5 used with game_type for playoffs)")
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(22))
  .addStringOption(o => o
    .setName("game_type")
    .setDescription("Game type / round")
    .setRequired(true)
    .addChoices(
      { name: "Regular Season",          value: "regular"    },
      { name: "Wild Card (round 1)",     value: "wildcard"   },
      { name: "Divisional (round 2)",    value: "divisional" },
      { name: "Conference Championship", value: "conference" },
      { name: "Super Bowl",              value: "superbowl"  },
    ))

  // ── Required reason ──────────────────────────────────────────────────────────
  .addStringOption(o => o
    .setName("reason")
    .setDescription("Why this reversal is being performed (logged to commissioner channel)")
    .setRequired(true))

  // ── Action toggles ───────────────────────────────────────────────────────────
  .addBooleanOption(o => o
    .setName("reverse_h2h")
    .setDescription("Undo the head-to-head win/loss record for the affected matchup(s)")
    .setRequired(true))
  .addBooleanOption(o => o
    .setName("reverse_season_record")
    .setDescription("Undo season W/L and point differential in the standings")
    .setRequired(true))
  .addBooleanOption(o => o
    .setName("reverse_alltime")
    .setDescription("Undo all-time H2H win/loss counters on each player's profile")
    .setRequired(true))
  .addBooleanOption(o => o
    .setName("reverse_milestone")
    .setDescription("Reverse any milestone bonus payout and revert the winner's milestone tier")
    .setRequired(true))
  .addBooleanOption(o => o
    .setName("reverse_coins")
    .setDescription("Remove the win/loss coin payouts that were issued")
    .setRequired(true))
  .addBooleanOption(o => o
    .setName("delete_processed_record")
    .setDescription("Delete processed-game entries so the EA export can re-process them")
    .setRequired(true))

  // ── Single-game target (optional — only used when reverse_entire_week = false) ──
  .addUserOption(o => o
    .setName("winner")
    .setDescription("(Single-game mode) The player who won the game")
    .setRequired(false))
  .addUserOption(o => o
    .setName("loser")
    .setDescription("(Single-game mode) The player who lost the game (omit for CPU games)")
    .setRequired(false));

// ── Execute ───────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // Auth
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);
  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const entireWeek  = interaction.options.getBoolean("reverse_entire_week", true);
  const weekNum     = interaction.options.getInteger("week",      true);
  const gameTypeStr = interaction.options.getString("game_type",  true);
  const reason      = interaction.options.getString("reason",     true);

  const flags: ReverseFlags = {
    doH2H:       interaction.options.getBoolean("reverse_h2h",          true),
    doSeason:    interaction.options.getBoolean("reverse_season_record", true),
    doAllTime:   interaction.options.getBoolean("reverse_alltime",       true),
    doMilestone: interaction.options.getBoolean("reverse_milestone",     true),
    doCoins:     interaction.options.getBoolean("reverse_coins",         true),
    doDeleteRec: interaction.options.getBoolean("delete_processed_record", true),
  };

  const winnerUser = interaction.options.getUser("winner");
  const loserUser  = interaction.options.getUser("loser");

  // Validate single-game mode requires winner
  if (!entireWeek && !winnerUser) {
    await interaction.editReply({
      content: "❌ **winner** is required when `reverse_entire_week` is `false`.",
    });
    return;
  }

  const weekIndexMap: Record<string, number> = {
    regular:    weekNum - 1,
    wildcard:   1018,
    divisional: 1019,
    conference: 1020,
    superbowl:  1022,
  };
  const weekIndex = weekIndexMap[gameTypeStr] ?? (weekNum - 1);
  const weekLabel = weekIndexToLabel(weekIndex);

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  // ── Fetch records ─────────────────────────────────────────────────────────────
  let records: (typeof franchiseProcessedGamesTable.$inferSelect)[];

  if (entireWeek) {
    records = await db
      .select()
      .from(franchiseProcessedGamesTable)
      .where(
        and(
          eq(franchiseProcessedGamesTable.seasonIdRef,  season.id),
          eq(franchiseProcessedGamesTable.weekIndexRef, weekIndex),
        ),
      );

    if (records.length === 0) {
      await interaction.editReply({
        content: `❌ No processed game records found for Season ${season.seasonNumber} ${weekLabel}. Nothing to reverse.`,
      });
      return;
    }
  } else {
    // Single-game mode — match by winner + optional loser
    const [rec] = await db
      .select()
      .from(franchiseProcessedGamesTable)
      .where(
        and(
          eq(franchiseProcessedGamesTable.seasonIdRef,  season.id),
          eq(franchiseProcessedGamesTable.weekIndexRef, weekIndex),
          loserUser
            ? or(
                and(
                  eq(franchiseProcessedGamesTable.winnerDiscordId, winnerUser!.id),
                  eq(franchiseProcessedGamesTable.loserDiscordId,  loserUser.id),
                ),
                and(
                  eq(franchiseProcessedGamesTable.winnerDiscordId, loserUser.id),
                  eq(franchiseProcessedGamesTable.loserDiscordId,  winnerUser!.id),
                ),
              )
            : eq(franchiseProcessedGamesTable.winnerDiscordId, winnerUser!.id),
        ),
      )
      .limit(1);

    if (!rec) {
      const matchStr = loserUser
        ? `**${winnerUser!.username}** vs **${loserUser.username}**`
        : `**${winnerUser!.username}**`;
      await interaction.editReply({
        content: [
          `❌ No processed game record found for ${matchStr} in Season ${season.seasonNumber} ${weekLabel}.`,
          `Verify the winner/loser and week, or this game may not have been processed through the EA export.`,
        ].join("\n"),
      });
      return;
    }
    records = [rec];
  }

  // ── Process each record ───────────────────────────────────────────────────────
  const allActionLog: string[] = [];
  const allWarnings:  string[] = [];

  for (const record of records) {
    const { actionLog, warnings } = await reverseOneRecord(record, flags, reason, guildId, season.id);
    allActionLog.push(...actionLog);
    allWarnings.push(...warnings);
  }

  // ── Summary embed ─────────────────────────────────────────────────────────────
  const skippedItems = (Object.entries({
    "H2H record":     flags.doH2H,
    "Season W/L":     flags.doSeason,
    "All-time W/L":   flags.doAllTime,
    "Milestone":      flags.doMilestone,
    "Coins":          flags.doCoins,
    "Processed recs": flags.doDeleteRec,
  }) as [string, boolean][])
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const modeLabel = entireWeek
    ? `Full Week Clear — ${weekLabel} (${records.length} game${records.length !== 1 ? "s" : ""})`
    : weekLabel;

  // Discord embed description limit is 4096 chars — truncate if bulk run is large
  const rawDesc = [
    ...allActionLog,
    ...(allWarnings.length > 0  ? ["", ...allWarnings]  : []),
    ...(skippedItems.length > 0 ? ["", `⏭️ Skipped (false): ${skippedItems.join(", ")}`] : []),
  ].join("\n");

  const description = rawDesc.length > 3900
    ? rawDesc.slice(0, 3900) + `\n…(${records.length} games processed — see commissioner channel for full log)`
    : rawDesc;

  const embed = new EmbedBuilder()
    .setColor(entireWeek ? Colors.Red : Colors.Orange)
    .setTitle(`↩️ Game Reversal — ${modeLabel}`)
    .setDescription(description || "No actions taken.")
    .addFields(
      { name: "Season", value: `Season ${season.seasonNumber}`, inline: true },
      { name: "Week",   value: weekLabel,                        inline: true },
      { name: "Mode",   value: entireWeek ? "Full week" : "Single game", inline: true },
      { name: "Reason", value: reason, inline: false },
    )
    .setFooter({ text: `Reversed by ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  // ── Commissioner channel log ──────────────────────────────────────────────────
  if (COMMISSIONER_CHANNEL_ID) {
    try {
      const ch = await interaction.client.channels.fetch(COMMISSIONER_CHANNEL_ID);
      if (ch?.isTextBased()) {
        const logEmbed = new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle(`📋 Game Reversal — ${modeLabel}`)
          .setDescription(rawDesc.length > 3900 ? rawDesc.slice(0, 3900) + "\n…(truncated)" : rawDesc || "No actions taken.")
          .addFields(
            { name: "Season",  value: `Season ${season.seasonNumber}`, inline: true },
            { name: "Week",    value: weekLabel,                        inline: true },
            { name: "Games",   value: String(records.length),           inline: true },
            { name: "Reason",  value: reason,                           inline: false },
          )
          .setFooter({ text: `By ${interaction.user.username} (${interaction.user.id})` })
          .setTimestamp();
        await (ch as TextChannel).send({ embeds: [logEmbed] });
      }
    } catch (err) {
      console.error("Failed to log game reversal to commissioner channel:", err);
    }
  }
}
