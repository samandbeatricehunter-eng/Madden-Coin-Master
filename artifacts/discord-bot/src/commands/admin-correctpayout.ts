import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, franchiseScheduleTable, franchiseProcessedGamesTable, gameLogTable,
} from "@workspace/db";
import { eq, and, or, sql, desc, asc } from "drizzle-orm";
import { getOrCreateActiveSeason, addBalance, logTransaction, upsertH2HRecord, appendGameLog } from "../lib/db-helpers.js";

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
    .setName("pointdiff").setDescription("Point differential (winning score − losing score) — required when type is h2h").setRequired(false).setMinValue(1));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const week      = interaction.options.getInteger("week", true);
  const homeTeam  = interaction.options.getString("hometeam", true).trim();
  const awayTeam  = interaction.options.getString("awayteam", true).trim();
  const newType   = interaction.options.getString("type", true) as "h2h" | "cpu" | "none";
  const winner    = interaction.options.getString("winner")?.trim() ?? null;
  const pointDiff = interaction.options.getInteger("pointdiff") ?? null;

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (newType === "h2h" && (!winner || pointDiff === null)) {
    await interaction.editReply("❌ When type is **h2h**, both `winner` and `pointdiff` are required.");
    return;
  }
  if (newType === "cpu" && !winner) {
    await interaction.editReply("❌ When type is **cpu**, `winner` is required so we know who gets the 20 coins.");
    return;
  }

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
      `Make sure the team names match exactly (try \`/seasonschedule\` or \`/weeklymatchups\` to see exact names).`,
    );
    return;
  }

  // ── Find registered users for both teams ──────────────────────────────────
  const [homeUser] = await db.select().from(usersTable)
    .where(sql`lower(${usersTable.team}) = ${homeLower}`).limit(1);
  const [awayUser] = await db.select().from(usersTable)
    .where(sql`lower(${usersTable.team}) = ${awayLower}`).limit(1);

  // ── Find the processed game record ────────────────────────────────────────
  // Try by stored lookup fields first (new records), then fall back to weekIndex scan.
  let processedGame = (await db.select().from(franchiseProcessedGamesTable)
    .where(and(
      eq(franchiseProcessedGamesTable.seasonIdRef,  season.id),
      eq(franchiseProcessedGamesTable.weekIndexRef, weekIndex),
      eq(franchiseProcessedGamesTable.homeTeamRef,  homeLower),
      eq(franchiseProcessedGamesTable.awayTeamRef,  awayLower),
    ))
    .limit(1))[0] ?? null;

  // Legacy fallback: scan all processed games for this season and find by homeTeamId match
  if (!processedGame) {
    const candidates = await db.select().from(franchiseProcessedGamesTable)
      .where(and(
        eq(franchiseProcessedGamesTable.seasonIdRef, season.id),
        eq(franchiseProcessedGamesTable.weekIndexRef, weekIndex),
      ))
      .limit(100);
    // For legacy records, try matching by gameId pattern using teamIds
    const hId = schedGame.homeTeamId;
    const aId = schedGame.awayTeamId;
    const hScore = schedGame.homeScore ?? 0;
    const aScore = schedGame.awayScore ?? 0;
    const reconstructedId = `s${season.id}-h${hId}-a${aId}-${hScore}-${aScore}`;
    processedGame = candidates.find(c => c.gameId === reconstructedId) ?? null;
  }

  if (!processedGame) {
    await interaction.editReply(
      `❌ No processed game record found for **${homeTeam} vs ${awayTeam}** in Week ${week}.\n` +
      `This game may not have been imported yet, or was imported before the tracking system was set up.`,
    );
    return;
  }

  // ── Determine what was PREVIOUSLY paid ────────────────────────────────────
  const oldType         = processedGame.payoutType ?? null;
  const oldWinnerId     = processedGame.winnerDiscordId ?? null;
  const oldLoserId      = processedGame.loserDiscordId  ?? null;
  const oldWinnerCoins  = processedGame.winnerCoins ?? 0;
  const oldLoserCoins   = processedGame.loserCoins  ?? 0;
  const oldPointDiff    = processedGame.appliedPointDiff ?? 0;

  // If no metadata (legacy record), infer from schedule and registration
  let inferredType: string | null = oldType;
  let inferredWinnerId = oldWinnerId;
  let inferredLoserId  = oldLoserId;
  let inferredWinnerCoins = oldWinnerCoins;
  let inferredLoserCoins  = oldLoserCoins;
  let inferredPointDiff   = oldPointDiff;

  if (!inferredType) {
    // Legacy inference — both registered means H2H was applied incorrectly
    const homeScore = schedGame.homeScore ?? 0;
    const awayScore = schedGame.awayScore ?? 0;
    const homeWon   = homeScore > awayScore;

    if (homeUser && awayUser) {
      inferredType        = "h2h";
      inferredWinnerId    = homeWon ? homeUser.discordId : awayUser.discordId;
      inferredLoserId     = homeWon ? awayUser.discordId : homeUser.discordId;
      inferredWinnerCoins = H2H_WIN_PAYOUT;
      inferredLoserCoins  = H2H_LOSS_PAYOUT;
      inferredPointDiff   = Math.abs(homeScore - awayScore);
    } else if (homeUser || awayUser) {
      const humanUser  = homeUser ?? awayUser!;
      const humanScore = homeUser ? (schedGame.homeScore ?? 0) : (schedGame.awayScore ?? 0);
      const cpuScore   = homeUser ? (schedGame.awayScore ?? 0) : (schedGame.homeScore ?? 0);
      inferredType        = humanScore > cpuScore ? "cpu" : "none";
      inferredWinnerId    = humanScore > cpuScore ? humanUser.discordId : null;
      inferredWinnerCoins = CPU_WIN_PAYOUT;
      inferredLoserCoins  = 0;
      inferredPointDiff   = Math.abs(humanScore - cpuScore);
    } else {
      inferredType = "none";
    }
  }

  // ── Reverse the prior payout ───────────────────────────────────────────────
  const reversalLines: string[] = [];

  if (inferredType === "h2h" && inferredWinnerId && inferredLoserId) {
    // Remove coins from both
    if (inferredWinnerCoins > 0) {
      await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} - ${inferredWinnerCoins}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, inferredWinnerId));
      await logTransaction(inferredWinnerId, -inferredWinnerCoins, "removecoins",
        `[Correction Wk${week}] Reversed incorrect H2H win payout`);
      reversalLines.push(`❌ Removed ${inferredWinnerCoins} coins from winner`);
    }
    if (inferredLoserCoins > 0) {
      await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} - ${inferredLoserCoins}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, inferredLoserId));
      await logTransaction(inferredLoserId, -inferredLoserCoins, "removecoins",
        `[Correction Wk${week}] Reversed incorrect H2H loss payout`);
      reversalLines.push(`❌ Removed ${inferredLoserCoins} coins from loser`);
    }

    // Undo H2H records
    await db.update(userRecordsTable).set({
      wins:              sql`${userRecordsTable.wins}   - 1`,
      pointDifferential: sql`${userRecordsTable.pointDifferential} - ${inferredPointDiff}`,
      updatedAt: new Date(),
    }).where(and(eq(userRecordsTable.discordId, inferredWinnerId), eq(userRecordsTable.seasonId, season.id)));

    await db.update(userRecordsTable).set({
      losses:            sql`${userRecordsTable.losses} - 1`,
      pointDifferential: sql`${userRecordsTable.pointDifferential} + ${inferredPointDiff}`,
      updatedAt: new Date(),
    }).where(and(eq(userRecordsTable.discordId, inferredLoserId), eq(userRecordsTable.seasonId, season.id)));

    // Undo all-time counters
    await db.update(usersTable)
      .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   - 1`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, inferredWinnerId));
    await db.update(usersTable)
      .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} - 1`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, inferredLoserId));

    reversalLines.push("❌ Reversed H2H win/loss records and all-time counters");

    // Remove most recent game log entries for both users related to this game
    const winnerLoserTeamName = inferredLoserId === homeUser?.discordId ? schedGame.homeTeamName : schedGame.awayTeamName;
    const loserWinnerTeamName = inferredWinnerId === homeUser?.discordId ? schedGame.homeTeamName : schedGame.awayTeamName;

    const [winnerLogEntry] = await db.select({ id: gameLogTable.id })
      .from(gameLogTable)
      .where(and(
        eq(gameLogTable.discordId, inferredWinnerId),
        eq(gameLogTable.seasonId,  season.id),
        sql`lower(${gameLogTable.opponentLabel}) = ${winnerLoserTeamName.toLowerCase()}`,
      ))
      .orderBy(desc(gameLogTable.id)).limit(1);
    if (winnerLogEntry) await db.delete(gameLogTable).where(eq(gameLogTable.id, winnerLogEntry.id));

    const [loserLogEntry] = await db.select({ id: gameLogTable.id })
      .from(gameLogTable)
      .where(and(
        eq(gameLogTable.discordId, inferredLoserId),
        eq(gameLogTable.seasonId,  season.id),
        sql`lower(${gameLogTable.opponentLabel}) = ${loserWinnerTeamName.toLowerCase()}`,
      ))
      .orderBy(desc(gameLogTable.id)).limit(1);
    if (loserLogEntry) await db.delete(gameLogTable).where(eq(gameLogTable.id, loserLogEntry.id));

    reversalLines.push("❌ Removed incorrect H2H game log entries");

  } else if (inferredType === "cpu" && inferredWinnerId) {
    if (inferredWinnerCoins > 0) {
      await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} - ${inferredWinnerCoins}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, inferredWinnerId));
      await logTransaction(inferredWinnerId, -inferredWinnerCoins, "removecoins",
        `[Correction Wk${week}] Reversed incorrect CPU win payout`);
      reversalLines.push(`❌ Removed ${inferredWinnerCoins} coins from winner`);
    }
  }

  // ── Apply the correct payout ───────────────────────────────────────────────
  const applyLines: string[] = [];
  let newPayoutMeta: {
    payoutType: string; winnerDiscordId?: string; loserDiscordId?: string;
    winnerCoins?: number; loserCoins?: number; appliedPointDiff?: number;
  } = { payoutType: newType };

  if (newType === "h2h" && winner && pointDiff !== null) {
    const winnerLower = winner.toLowerCase();
    const [winnerUser] = await db.select().from(usersTable)
      .where(sql`lower(${usersTable.team}) = ${winnerLower}`).limit(1);

    if (!winnerUser) {
      await interaction.editReply(`❌ Could not find a registered user for winner team **${winner}**.`);
      return;
    }

    // Identify loser user
    const loserUser = winnerUser.discordId === homeUser?.discordId ? awayUser : homeUser;
    if (!loserUser) {
      await interaction.editReply(`❌ Could not find the loser user — both teams must be registered for an H2H correction.`);
      return;
    }

    const winnerTeamName = winnerUser.team ?? winner;
    const loserTeamName  = loserUser.team ?? "Unknown";

    await addBalance(winnerUser.discordId, H2H_WIN_PAYOUT);
    await logTransaction(winnerUser.discordId, H2H_WIN_PAYOUT, "addcoins",
      `[Correction Wk${week}] H2H win vs ${loserTeamName} (+${pointDiff} spread)`);
    await addBalance(loserUser.discordId, H2H_LOSS_PAYOUT);
    await logTransaction(loserUser.discordId, H2H_LOSS_PAYOUT, "addcoins",
      `[Correction Wk${week}] H2H loss vs ${winnerTeamName} (−${pointDiff} spread)`);
    applyLines.push(`✅ +${H2H_WIN_PAYOUT} coins to **${winnerTeamName}**, +${H2H_LOSS_PAYOUT} coins to **${loserTeamName}**`);

    await upsertH2HRecord(winnerUser.discordId, season.id, true,   pointDiff);
    await upsertH2HRecord(loserUser.discordId,  season.id, false, -pointDiff);
    applyLines.push(`✅ H2H records updated (${winnerTeamName} +1W, ${loserTeamName} +1L)`);

    await appendGameLog(winnerUser.discordId, season.id, "win",   pointDiff,  loserTeamName);
    await appendGameLog(loserUser.discordId,  season.id, "loss", -pointDiff, winnerTeamName);

    await db.update(usersTable)
      .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   + 1`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, winnerUser.discordId));
    await db.update(usersTable)
      .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, loserUser.discordId));

    newPayoutMeta = {
      payoutType: "h2h", winnerDiscordId: winnerUser.discordId, loserDiscordId: loserUser.discordId,
      winnerCoins: H2H_WIN_PAYOUT, loserCoins: H2H_LOSS_PAYOUT, appliedPointDiff: pointDiff,
    };

  } else if (newType === "cpu" && winner) {
    const winnerLower = winner.toLowerCase();
    const [winnerUser] = await db.select().from(usersTable)
      .where(sql`lower(${usersTable.team}) = ${winnerLower}`).limit(1);

    if (!winnerUser) {
      await interaction.editReply(`❌ Could not find a registered user for winner team **${winner}**.`);
      return;
    }

    const loserTeamName = winnerLower === homeLower ? awayTeam : homeTeam;

    await addBalance(winnerUser.discordId, CPU_WIN_PAYOUT);
    await logTransaction(winnerUser.discordId, CPU_WIN_PAYOUT, "addcoins",
      `[Correction Wk${week}] CPU win vs ${loserTeamName} (force/autopilot)`);
    applyLines.push(`✅ +${CPU_WIN_PAYOUT} coins to **${winnerUser.team ?? winner}** *(CPU win, no record change)*`);

    const sched = schedGame;
    const winIsHome = winnerLower === homeLower;
    const wScore = winIsHome ? (sched.homeScore ?? 0) : (sched.awayScore ?? 0);
    const lScore = winIsHome ? (sched.awayScore ?? 0) : (sched.homeScore ?? 0);
    await appendGameLog(winnerUser.discordId, season.id, "win", wScore - lScore, `[CPU] ${loserTeamName}`);

    newPayoutMeta = {
      payoutType: "cpu", winnerDiscordId: winnerUser.discordId,
      winnerCoins: CPU_WIN_PAYOUT, loserCoins: 0, appliedPointDiff: Math.abs(wScore - lScore),
    };

  } else if (newType === "none") {
    applyLines.push("✅ Game voided — no payouts applied");
  }

  // ── Update the processed game record ──────────────────────────────────────
  await db.update(franchiseProcessedGamesTable)
    .set({
      payoutType:       newPayoutMeta.payoutType,
      winnerDiscordId:  newPayoutMeta.winnerDiscordId ?? null,
      loserDiscordId:   newPayoutMeta.loserDiscordId  ?? null,
      winnerCoins:      newPayoutMeta.winnerCoins     ?? null,
      loserCoins:       newPayoutMeta.loserCoins      ?? null,
      appliedPointDiff: newPayoutMeta.appliedPointDiff ?? null,
    })
    .where(eq(franchiseProcessedGamesTable.gameId, processedGame.gameId));

  // ── Reply ─────────────────────────────────────────────────────────────────
  const wasLegacy = !processedGame.payoutType;
  const embed = new EmbedBuilder()
    .setTitle(`🔧 Payout Corrected — Week ${week}: ${schedGame.homeTeamName} vs ${schedGame.awayTeamName}`)
    .setColor(Colors.Orange)
    .addFields(
      {
        name: `What was reversed (was: **${inferredType ?? "unknown"}**${wasLegacy ? " — inferred" : ""})`,
        value: reversalLines.length ? reversalLines.join("\n") : "*Nothing was reversed (prior type was none)*",
      },
      {
        name: `What was applied (now: **${newType}**)`,
        value: applyLines.length ? applyLines.join("\n") : "*No payouts applied*",
      },
    )
    .setFooter({ text: `Game ID: ${processedGame.gameId}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
