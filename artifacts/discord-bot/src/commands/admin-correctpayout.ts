import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, franchiseScheduleTable, franchiseProcessedGamesTable,
  gameLogTable, coinTransactionsTable,
} from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

const H2H_WIN_PAYOUT  = 50;
const H2H_LOSS_PAYOUT = 20;
const CPU_WIN_PAYOUT  = 20;

export const data = new SlashCommandBuilder()
  .setName("admin-correctpayout")
  .setDescription("Admin: retroactively fix a game's payout type and correct coins/records")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(o => o
    .setName("week").setDescription("Week number (1–18)").setRequired(true).setMinValue(1).setMaxValue(18))
  .addStringOption(o => o
    .setName("hometeam").setDescription("Home team name (as it appears in /seasonschedule)").setRequired(true))
  .addStringOption(o => o
    .setName("awayteam").setDescription("Away team name (as it appears in /seasonschedule)").setRequired(true))
  .addStringOption(o => o
    .setName("type").setDescription("The CORRECT payout type for this game").setRequired(true)
    .addChoices(
      { name: "h2h — true head-to-head (both users played)",    value: "h2h"  },
      { name: "cpu — force win or CPU autopilot (winner only)", value: "cpu"  },
      { name: "none — void game, no payouts",                   value: "none" },
    ))
  .addStringOption(o => o
    .setName("winner").setDescription("Winning team name — required when type is h2h or cpu").setRequired(false))
  .addIntegerOption(o => o
    .setName("pointdiff").setDescription("Point differential (winning score − losing score) — required when type is h2h").setRequired(false).setMinValue(1))
  .addStringOption(o => o
    .setName("gameid").setDescription("Override: paste the exact game ID if auto-lookup fails (check bot logs or DB)").setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const week        = interaction.options.getInteger("week", true);
  const homeTeam    = interaction.options.getString("hometeam", true).trim();
  const awayTeam    = interaction.options.getString("awayteam", true).trim();
  const newType     = interaction.options.getString("type", true) as "h2h" | "cpu" | "none";
  const winner      = interaction.options.getString("winner")?.trim() ?? null;
  const pointDiff   = interaction.options.getInteger("pointdiff") ?? null;
  const gameIdOverride = interaction.options.getString("gameid")?.trim() ?? null;

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (newType === "h2h" && (!winner || pointDiff === null)) {
    await interaction.editReply("❌ When type is **h2h**, both `winner` and `pointdiff` are required.");
    return;
  }
  // CPU: winner is optional — if omitted the schedule scores will be used to infer the winner

  const season    = await getOrCreateActiveSeason();
  const weekIndex = week - 1;
  const homeLower = homeTeam.toLowerCase();
  const awayLower = awayTeam.toLowerCase();

  // ── Find the game in the schedule ─────────────────────────────────────────
  const [schedGame] = await db.select().from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
      sql`lower(${franchiseScheduleTable.homeTeamName}) = ${homeLower}`,
      sql`lower(${franchiseScheduleTable.awayTeamName}) = ${awayLower}`,
    ))
    .limit(1);

  if (!schedGame) {
    await interaction.editReply(
      `❌ No schedule entry found for **${homeTeam} vs ${awayTeam}** in Week ${week}.\n` +
      `Make sure the team names match exactly (try \`/weeklymatchups\` to see exact names).`,
    );
    return;
  }

  // ── Validate winner belongs to this game ─────────────────────────────────
  if (winner) {
    const winnerLower = winner.toLowerCase();
    if (winnerLower !== homeLower && winnerLower !== awayLower) {
      await interaction.editReply(
        `❌ \`winner\` must be one of the two teams in this game:\n` +
        `• **${schedGame.homeTeamName}** (home)\n` +
        `• **${schedGame.awayTeamName}** (away)\n\n` +
        `You entered: \`${winner}\``,
      );
      return;
    }
  }

  // ── Find registered users for both teams ──────────────────────────────────
  const [homeUser] = await db.select().from(usersTable)
    .where(sql`lower(${usersTable.team}) = ${homeLower}`).limit(1);
  const [awayUser] = await db.select().from(usersTable)
    .where(sql`lower(${usersTable.team}) = ${awayLower}`).limit(1);

  // ── Locate the processed game record (multiple fallback strategies) ────────
  type ProcessedGameRow = typeof franchiseProcessedGamesTable.$inferSelect;
  let processedGame: ProcessedGameRow | null = null;

  // Strategy 0: manual gameid override
  if (gameIdOverride) {
    const [r] = await db.select().from(franchiseProcessedGamesTable)
      .where(eq(franchiseProcessedGamesTable.gameId, gameIdOverride)).limit(1);
    processedGame = r ?? null;
  }

  // Strategy 1: new lookup columns (works for games processed after the schema update)
  if (!processedGame) {
    const [r] = await db.select().from(franchiseProcessedGamesTable)
      .where(and(
        eq(franchiseProcessedGamesTable.seasonIdRef,  season.id),
        eq(franchiseProcessedGamesTable.weekIndexRef, weekIndex),
        eq(franchiseProcessedGamesTable.homeTeamRef,  homeLower),
        eq(franchiseProcessedGamesTable.awayTeamRef,  awayLower),
      ))
      .limit(1);
    processedGame = r ?? null;
  }

  // Strategy 2: use processedGameId stored on the schedule row (works after schedule column added)
  if (!processedGame && schedGame.processedGameId) {
    const [r] = await db.select().from(franchiseProcessedGamesTable)
      .where(eq(franchiseProcessedGamesTable.gameId, schedGame.processedGameId)).limit(1);
    processedGame = r ?? null;
  }

  // Strategy 3: reconstructed gameId format (works when Madden didn't provide its own gameId)
  if (!processedGame) {
    const hId     = schedGame.homeTeamId;
    const aId     = schedGame.awayTeamId;
    const hScore  = schedGame.homeScore ?? 0;
    const aScore  = schedGame.awayScore ?? 0;
    const constructedId = `s${season.id}-h${hId}-a${aId}-${hScore}-${aScore}`;
    const [r] = await db.select().from(franchiseProcessedGamesTable)
      .where(eq(franchiseProcessedGamesTable.gameId, constructedId)).limit(1);
    processedGame = r ?? null;
  }

  if (!processedGame) {
    const hId = schedGame.homeTeamId;
    const aId = schedGame.awayTeamId;
    await interaction.editReply(
      `❌ Could not locate the processed game record for **${schedGame.homeTeamName} vs ${schedGame.awayTeamName}** in Week ${week}.\n\n` +
      `**To fix this manually:**\n` +
      `Run the command again and add the exact game ID using the \`gameid:\` parameter.\n\n` +
      `The game ID is either a Madden-provided integer, or in the format:\n` +
      `\`s${season.id}-h${hId}-a${aId}-${schedGame.homeScore ?? "?"}-${schedGame.awayScore ?? "?"}\`\n\n` +
      `If you can't find it, run \`/franchiseupdate\` again — the next import will tag the schedule row correctly.`,
    );
    return;
  }

  // ── Determine what was PREVIOUSLY paid ────────────────────────────────────
  const oldType         = processedGame.payoutType    ?? null;
  const oldWinnerId     = processedGame.winnerDiscordId ?? null;
  const oldLoserId      = processedGame.loserDiscordId  ?? null;
  const oldWinnerCoins  = processedGame.winnerCoins    ?? 0;
  const oldLoserCoins   = processedGame.loserCoins     ?? 0;
  const oldPointDiff    = processedGame.appliedPointDiff ?? 0;

  // If no metadata (legacy record), infer from schedule and registration
  let inferredType:        string | null = oldType;
  let inferredWinnerId:    string | null = oldWinnerId;
  let inferredLoserId:     string | null = oldLoserId;
  let inferredWinnerCoins: number        = oldWinnerCoins;
  let inferredLoserCoins:  number        = oldLoserCoins;
  let inferredPointDiff:   number        = oldPointDiff;

  const schedHomeScore = schedGame.homeScore ?? 0;
  const schedAwayScore = schedGame.awayScore ?? 0;
  const schedHomeWon   = schedHomeScore > schedAwayScore;
  const schedSpread    = Math.abs(schedHomeScore - schedAwayScore);
  const schedStatus    = schedGame.status ?? 0; // 2=CPU-simmed, 3=user-played

  if (!inferredType) {
    // Legacy record — infer type from schedule status + registration
    if (homeUser && awayUser) {
      // Both registered: use schedule status to distinguish H2H from force win/autopilot
      if (schedStatus === 3) {
        inferredType        = "h2h";
        inferredWinnerId    = schedHomeWon ? homeUser.discordId : awayUser.discordId;
        inferredLoserId     = schedHomeWon ? awayUser.discordId : homeUser.discordId;
        inferredWinnerCoins = H2H_WIN_PAYOUT;
        inferredLoserCoins  = H2H_LOSS_PAYOUT;
        inferredPointDiff   = schedSpread;
      } else {
        // status=2 or unknown — treat as CPU win (force/autopilot)
        inferredType        = "cpu";
        inferredWinnerId    = schedHomeWon ? homeUser.discordId : awayUser.discordId;
        inferredWinnerCoins = CPU_WIN_PAYOUT;
        inferredLoserCoins  = 0;
        inferredPointDiff   = schedSpread;
      }
    } else if (homeUser || awayUser) {
      const humanUser  = homeUser ?? awayUser!;
      const humanScore = homeUser ? schedHomeScore : schedAwayScore;
      const cpuScore   = homeUser ? schedAwayScore : schedHomeScore;
      inferredType        = humanScore > cpuScore ? "cpu" : "none";
      inferredWinnerId    = humanScore > cpuScore ? humanUser.discordId : null;
      inferredWinnerCoins = CPU_WIN_PAYOUT;
      inferredLoserCoins  = 0;
      inferredPointDiff   = schedSpread;
    } else {
      inferredType = "none";
    }
  }

  // If type is known but winner IDs are missing (older MCA-processed games lacked full metadata),
  // recover them from the schedule scores and user registration.
  if (inferredType && !inferredWinnerId && inferredType !== "none") {
    if (inferredType === "h2h" && homeUser && awayUser) {
      inferredWinnerId    = schedHomeWon ? homeUser.discordId : awayUser.discordId;
      inferredLoserId     = schedHomeWon ? awayUser.discordId : homeUser.discordId;
      if (!inferredWinnerCoins) inferredWinnerCoins = H2H_WIN_PAYOUT;
      if (!inferredLoserCoins)  inferredLoserCoins  = H2H_LOSS_PAYOUT;
      if (!inferredPointDiff)   inferredPointDiff   = schedSpread;
    } else if (inferredType === "cpu") {
      const winnerUser = schedHomeWon ? (homeUser ?? awayUser) : (awayUser ?? homeUser);
      if (winnerUser) {
        inferredWinnerId = winnerUser.discordId;
        if (!inferredWinnerCoins) inferredWinnerCoins = CPU_WIN_PAYOUT;
        if (!inferredPointDiff)   inferredPointDiff   = schedSpread;
      }
    }
  }

  // ── Pre-validate new winner/loser before any writes ──────────────────────
  type UserRow = typeof usersTable.$inferSelect;
  let newWinnerUser: UserRow | null = null;
  let newLoserUser:  UserRow | null = null;
  let newWinnerTeamName = "";
  let newLoserTeamName  = "";
  let newWinIsHome      = false;

  if (newType === "h2h" && winner && pointDiff !== null) {
    const winnerLower = winner.toLowerCase();
    const [wu] = await db.select().from(usersTable)
      .where(sql`lower(${usersTable.team}) = ${winnerLower}`).limit(1);
    if (!wu) {
      await interaction.editReply(`❌ Could not find a registered user for winner team **${winner}**.`);
      return;
    }
    const lu = wu.discordId === homeUser?.discordId ? awayUser : homeUser;
    if (!lu) {
      await interaction.editReply(`❌ Could not find the loser user — both teams must be registered for an H2H correction.`);
      return;
    }
    newWinnerUser     = wu;
    newLoserUser      = lu;
    newWinnerTeamName = wu.team ?? winner;
    newLoserTeamName  = lu.team ?? "Unknown";
  } else if (newType === "cpu") {
    // Resolve winner: use explicit `winner` arg, else infer from schedule scores
    const resolvedWinner = winner ?? (
      (schedGame.homeScore ?? 0) >= (schedGame.awayScore ?? 0) ? homeTeam : awayTeam
    );
    const winnerLower = resolvedWinner.toLowerCase();
    const [wu] = await db.select().from(usersTable)
      .where(sql`lower(${usersTable.team}) = ${winnerLower}`).limit(1);
    if (!wu) {
      await interaction.editReply(`❌ Could not find a registered user for winner team **${resolvedWinner}** (inferred from schedule). Pass \`winner\` explicitly if scores are wrong.`);
      return;
    }
    newWinnerUser    = wu;
    newWinIsHome     = winnerLower === homeLower;
    newLoserTeamName = newWinIsHome ? awayTeam : homeTeam;
  }

  // ── Find game log entries to remove BEFORE the transaction (read-only) ───
  let winnerLogId:    number | null = null;
  let loserLogId:     number | null = null;
  let cpuWinnerLogId: number | null = null;

  if (inferredType === "h2h" && inferredWinnerId && inferredLoserId) {
    const loserTeamForWinner = inferredLoserId === homeUser?.discordId ? schedGame.homeTeamName : schedGame.awayTeamName;
    const winnerTeamForLoser = inferredWinnerId === homeUser?.discordId ? schedGame.homeTeamName : schedGame.awayTeamName;
    const [wl] = await db.select({ id: gameLogTable.id }).from(gameLogTable)
      .where(and(
        eq(gameLogTable.discordId, inferredWinnerId),
        eq(gameLogTable.seasonId,  season.id),
        sql`lower(${gameLogTable.opponentLabel}) = ${loserTeamForWinner.toLowerCase()}`,
      )).orderBy(desc(gameLogTable.id)).limit(1);
    const [ll] = await db.select({ id: gameLogTable.id }).from(gameLogTable)
      .where(and(
        eq(gameLogTable.discordId, inferredLoserId),
        eq(gameLogTable.seasonId,  season.id),
        sql`lower(${gameLogTable.opponentLabel}) = ${winnerTeamForLoser.toLowerCase()}`,
      )).orderBy(desc(gameLogTable.id)).limit(1);
    winnerLogId = wl?.id ?? null;
    loserLogId  = ll?.id ?? null;
  } else if (inferredType === "cpu" && inferredWinnerId) {
    const cpuLoserTeam  = inferredWinnerId === homeUser?.discordId ? awayTeam : homeTeam;
    const cpuLabelExact = `[cpu] ${cpuLoserTeam.toLowerCase()}`;
    const cpuLabelPlain = cpuLoserTeam.toLowerCase();
    const [cwl] = await db.select({ id: gameLogTable.id }).from(gameLogTable)
      .where(and(
        eq(gameLogTable.discordId, inferredWinnerId),
        eq(gameLogTable.seasonId,  season.id),
        sql`lower(${gameLogTable.opponentLabel}) IN (${cpuLabelExact}, ${cpuLabelPlain})`,
      )).orderBy(desc(gameLogTable.id)).limit(1);
    cpuWinnerLogId = cwl?.id ?? null;
  }

  // ── Atomically reverse the prior payout and apply the correct one ────────
  const reversalLines: string[] = [];
  const applyLines:    string[] = [];
  type PayoutMeta = {
    payoutType: string; winnerDiscordId?: string | null; loserDiscordId?: string | null;
    winnerCoins?: number | null; loserCoins?: number | null; appliedPointDiff?: number | null;
  };
  let newPayoutMeta: PayoutMeta = { payoutType: newType };
  const gameIdToUpdate = processedGame.gameId;

  await db.transaction(async (tx) => {
    // ── Reverse ────────────────────────────────────────────────────────────
    if (inferredType === "h2h" && inferredWinnerId && inferredLoserId) {
      if (inferredWinnerCoins > 0) {
        await tx.update(usersTable)
          .set({ balance: sql`${usersTable.balance} - ${inferredWinnerCoins}`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, inferredWinnerId));
        await tx.insert(coinTransactionsTable).values({
          discordId: inferredWinnerId, amount: -inferredWinnerCoins, type: "removecoins",
          description: `[Correction Wk${week}] Reversed incorrect H2H win payout`, relatedUserId: null,
        });
        reversalLines.push(`❌ Removed ${inferredWinnerCoins} coins from winner`);
      }
      if (inferredLoserCoins > 0) {
        await tx.update(usersTable)
          .set({ balance: sql`${usersTable.balance} - ${inferredLoserCoins}`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, inferredLoserId));
        await tx.insert(coinTransactionsTable).values({
          discordId: inferredLoserId, amount: -inferredLoserCoins, type: "removecoins",
          description: `[Correction Wk${week}] Reversed incorrect H2H loss payout`, relatedUserId: null,
        });
        reversalLines.push(`❌ Removed ${inferredLoserCoins} coins from loser`);
      }
      await tx.update(userRecordsTable).set({
        wins:              sql`${userRecordsTable.wins}   - 1`,
        pointDifferential: sql`${userRecordsTable.pointDifferential} - ${inferredPointDiff}`,
        updatedAt: new Date(),
      }).where(and(eq(userRecordsTable.discordId, inferredWinnerId), eq(userRecordsTable.seasonId, season.id)));
      await tx.update(userRecordsTable).set({
        losses:            sql`${userRecordsTable.losses} - 1`,
        pointDifferential: sql`${userRecordsTable.pointDifferential} + ${inferredPointDiff}`,
        updatedAt: new Date(),
      }).where(and(eq(userRecordsTable.discordId, inferredLoserId), eq(userRecordsTable.seasonId, season.id)));
      await tx.update(usersTable)
        .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   - 1`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, inferredWinnerId));
      await tx.update(usersTable)
        .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} - 1`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, inferredLoserId));
      reversalLines.push("❌ Reversed H2H win/loss records and all-time counters");
      if (winnerLogId) await tx.delete(gameLogTable).where(eq(gameLogTable.id, winnerLogId));
      if (loserLogId)  await tx.delete(gameLogTable).where(eq(gameLogTable.id, loserLogId));
      reversalLines.push("❌ Removed incorrect H2H game log entries");

    } else if (inferredType === "cpu" && inferredWinnerId) {
      if (inferredWinnerCoins > 0) {
        await tx.update(usersTable)
          .set({ balance: sql`${usersTable.balance} - ${inferredWinnerCoins}`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, inferredWinnerId));
        await tx.insert(coinTransactionsTable).values({
          discordId: inferredWinnerId, amount: -inferredWinnerCoins, type: "removecoins",
          description: `[Correction Wk${week}] Reversed incorrect CPU win payout`, relatedUserId: null,
        });
        reversalLines.push(`❌ Removed ${inferredWinnerCoins} coins from prior winner`);
      }
      if (cpuWinnerLogId) {
        await tx.delete(gameLogTable).where(eq(gameLogTable.id, cpuWinnerLogId));
        reversalLines.push("❌ Removed CPU win game log entry");
      }
    }

    // ── Apply ──────────────────────────────────────────────────────────────
    if (newType === "h2h" && newWinnerUser && newLoserUser && pointDiff !== null) {
      await tx.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${H2H_WIN_PAYOUT}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, newWinnerUser.discordId));
      await tx.insert(coinTransactionsTable).values({
        discordId: newWinnerUser.discordId, amount: H2H_WIN_PAYOUT, type: "addcoins",
        description: `[Correction Wk${week}] H2H win vs ${newLoserTeamName} (+${pointDiff})`, relatedUserId: null,
      });
      await tx.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${H2H_LOSS_PAYOUT}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, newLoserUser.discordId));
      await tx.insert(coinTransactionsTable).values({
        discordId: newLoserUser.discordId, amount: H2H_LOSS_PAYOUT, type: "addcoins",
        description: `[Correction Wk${week}] H2H loss vs ${newWinnerTeamName} (−${pointDiff})`, relatedUserId: null,
      });
      applyLines.push(`✅ +${H2H_WIN_PAYOUT} coins → **${newWinnerTeamName}** | +${H2H_LOSS_PAYOUT} coins → **${newLoserTeamName}**`);

      // Upsert records — handles case where row doesn't exist yet (early-season / legacy correction)
      await tx.insert(userRecordsTable).values({
        discordId: newWinnerUser.discordId, discordUsername: newWinnerUser.discordUsername,
        team: newWinnerUser.team ?? null, seasonId: season.id,
        wins: 1, losses: 0, pointDifferential: pointDiff,
      }).onConflictDoUpdate({
        target: [userRecordsTable.discordId, userRecordsTable.seasonId],
        set: {
          wins: sql`${userRecordsTable.wins} + 1`,
          pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointDiff}`,
          updatedAt: new Date(),
        },
      });
      await tx.insert(userRecordsTable).values({
        discordId: newLoserUser.discordId, discordUsername: newLoserUser.discordUsername,
        team: newLoserUser.team ?? null, seasonId: season.id,
        wins: 0, losses: 1, pointDifferential: -pointDiff,
      }).onConflictDoUpdate({
        target: [userRecordsTable.discordId, userRecordsTable.seasonId],
        set: {
          losses: sql`${userRecordsTable.losses} + 1`,
          pointDifferential: sql`${userRecordsTable.pointDifferential} - ${pointDiff}`,
          updatedAt: new Date(),
        },
      });
      applyLines.push(`✅ Records: **${newWinnerTeamName}** +1W, **${newLoserTeamName}** +1L`);

      await tx.insert(gameLogTable).values({
        discordId: newWinnerUser.discordId, seasonId: season.id, result: "win",
        pointSpread: pointDiff, opponentLabel: newLoserTeamName, gameType: "regular_season",
      });
      await tx.insert(gameLogTable).values({
        discordId: newLoserUser.discordId, seasonId: season.id, result: "loss",
        pointSpread: -pointDiff, opponentLabel: newWinnerTeamName, gameType: "regular_season",
      });
      await tx.update(usersTable)
        .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   + 1`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, newWinnerUser.discordId));
      await tx.update(usersTable)
        .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, newLoserUser.discordId));
      newPayoutMeta = {
        payoutType: "h2h", winnerDiscordId: newWinnerUser.discordId, loserDiscordId: newLoserUser.discordId,
        winnerCoins: H2H_WIN_PAYOUT, loserCoins: H2H_LOSS_PAYOUT, appliedPointDiff: pointDiff,
      };

    } else if (newType === "cpu" && newWinnerUser) {
      const wScore = newWinIsHome ? (schedGame.homeScore ?? 0) : (schedGame.awayScore ?? 0);
      const lScore = newWinIsHome ? (schedGame.awayScore ?? 0) : (schedGame.homeScore ?? 0);
      await tx.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${CPU_WIN_PAYOUT}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, newWinnerUser.discordId));
      await tx.insert(coinTransactionsTable).values({
        discordId: newWinnerUser.discordId, amount: CPU_WIN_PAYOUT, type: "addcoins",
        description: `[Correction Wk${week}] CPU win vs ${newLoserTeamName} (force/autopilot)`, relatedUserId: null,
      });
      applyLines.push(`✅ +${CPU_WIN_PAYOUT} coins → **${newWinnerUser.team ?? winner}** *(no record change)*`);
      await tx.insert(gameLogTable).values({
        discordId: newWinnerUser.discordId, seasonId: season.id, result: "win",
        pointSpread: wScore - lScore, opponentLabel: `[CPU] ${newLoserTeamName}`, gameType: "regular_season",
      });
      newPayoutMeta = {
        payoutType: "cpu", winnerDiscordId: newWinnerUser.discordId,
        winnerCoins: CPU_WIN_PAYOUT, loserCoins: 0, appliedPointDiff: Math.abs(wScore - lScore),
      };

    } else if (newType === "none") {
      applyLines.push("✅ Game voided — no payouts applied");
    }

    // ── Update processed game metadata ─────────────────────────────────────
    await tx.update(franchiseProcessedGamesTable)
      .set({
        payoutType:       newPayoutMeta.payoutType,
        winnerDiscordId:  newPayoutMeta.winnerDiscordId  ?? null,
        loserDiscordId:   newPayoutMeta.loserDiscordId   ?? null,
        winnerCoins:      newPayoutMeta.winnerCoins      ?? null,
        loserCoins:       newPayoutMeta.loserCoins       ?? null,
        appliedPointDiff: newPayoutMeta.appliedPointDiff ?? null,
      })
      .where(eq(franchiseProcessedGamesTable.gameId, gameIdToUpdate));
  });

  // ── Reply ─────────────────────────────────────────────────────────────────
  const wasLegacy = !oldType;
  const embed = new EmbedBuilder()
    .setTitle(`🔧 Payout Corrected — Week ${week}: ${schedGame.homeTeamName} vs ${schedGame.awayTeamName}`)
    .setColor(Colors.Orange)
    .addFields(
      {
        name: `Reversed (was: **${inferredType ?? "unknown"}**${wasLegacy ? " — inferred from schedule" : ""})`,
        value: reversalLines.length ? reversalLines.join("\n") : "*Nothing to reverse (prior type was none)*",
      },
      {
        name: `Applied (now: **${newType}**)`,
        value: applyLines.length ? applyLines.join("\n") : "*No payouts applied*",
      },
    )
    .setFooter({ text: `Game ID: ${gameIdToUpdate}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
