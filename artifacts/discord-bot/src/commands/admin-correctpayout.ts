import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, franchiseScheduleTable, franchiseProcessedGamesTable, gameLogTable,
} from "@workspace/db";
import { eq, and, sql, desc, like } from "drizzle-orm";
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
  if (newType === "cpu" && !winner) {
    await interaction.editReply("❌ When type is **cpu**, `winner` is required so we know who gets the coins.");
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
      `Make sure the team names match exactly (try \`/weeklymatchups\` to see exact names).`,
    );
    return;
  }

  // ── Find registered users for both teams ──────────────────────────────────
  const [homeUser] = await db.select().from(usersTable)
    .where(sql`lower(${usersTable.team}) = ${homeLower}`).limit(1);
  const [awayUser] = await db.select().from(usersTable)
    .where(sql`lower(${usersTable.team}) = ${awayLower}`).limit(1);

  // ── Locate the processed game record (multiple fallback strategies) ────────
  let processedGame = null as Awaited<ReturnType<typeof db.select>> extends (infer R)[] ? R | null : null;

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

  // Strategy 4: substring scan — find any processedGame whose gameId contains both team IDs
  // (covers constructed format for records pre-dating the lookup columns)
  if (!processedGame) {
    const hId = String(schedGame.homeTeamId);
    const aId = String(schedGame.awayTeamId);
    const candidates = await db.select().from(franchiseProcessedGamesTable)
      .where(and(
        like(franchiseProcessedGamesTable.gameId, `%${hId}%`),
        like(franchiseProcessedGamesTable.gameId, `%${aId}%`),
      ))
      .limit(20);
    // Take the first candidate that contains both IDs in the right order
    processedGame = candidates.find(c =>
      c.gameId.includes(`h${hId}`) && c.gameId.includes(`a${aId}`),
    ) ?? candidates[0] ?? null;
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
  const pg = processedGame as any;
  const oldType         = pg.payoutType ?? null;
  const oldWinnerId     = pg.winnerDiscordId ?? null;
  const oldLoserId      = pg.loserDiscordId  ?? null;
  const oldWinnerCoins  = pg.winnerCoins ?? 0;
  const oldLoserCoins   = pg.loserCoins  ?? 0;
  const oldPointDiff    = pg.appliedPointDiff ?? 0;

  // If no metadata (legacy record), infer from schedule and registration
  let inferredType        = oldType as string | null;
  let inferredWinnerId    = oldWinnerId as string | null;
  let inferredLoserId     = oldLoserId  as string | null;
  let inferredWinnerCoins = oldWinnerCoins as number;
  let inferredLoserCoins  = oldLoserCoins  as number;
  let inferredPointDiff   = oldPointDiff   as number;

  if (!inferredType) {
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

    // Remove most recent game log entries for this game
    const loserTeamForWinner = inferredLoserId === homeUser?.discordId ? schedGame.homeTeamName : schedGame.awayTeamName;
    const winnerTeamForLoser = inferredWinnerId === homeUser?.discordId ? schedGame.homeTeamName : schedGame.awayTeamName;

    const [winnerLog] = await db.select({ id: gameLogTable.id }).from(gameLogTable)
      .where(and(
        eq(gameLogTable.discordId, inferredWinnerId),
        eq(gameLogTable.seasonId,  season.id),
        sql`lower(${gameLogTable.opponentLabel}) = ${loserTeamForWinner.toLowerCase()}`,
      ))
      .orderBy(desc(gameLogTable.id)).limit(1);
    if (winnerLog) await db.delete(gameLogTable).where(eq(gameLogTable.id, winnerLog.id));

    const [loserLog] = await db.select({ id: gameLogTable.id }).from(gameLogTable)
      .where(and(
        eq(gameLogTable.discordId, inferredLoserId),
        eq(gameLogTable.seasonId,  season.id),
        sql`lower(${gameLogTable.opponentLabel}) = ${winnerTeamForLoser.toLowerCase()}`,
      ))
      .orderBy(desc(gameLogTable.id)).limit(1);
    if (loserLog) await db.delete(gameLogTable).where(eq(gameLogTable.id, loserLog.id));

    reversalLines.push("❌ Removed incorrect H2H game log entries");

  } else if (inferredType === "cpu" && inferredWinnerId) {
    if (inferredWinnerCoins > 0) {
      await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} - ${inferredWinnerCoins}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, inferredWinnerId));
      await logTransaction(inferredWinnerId, -inferredWinnerCoins, "removecoins",
        `[Correction Wk${week}] Reversed incorrect CPU win payout`);
      reversalLines.push(`❌ Removed ${inferredWinnerCoins} coins from prior winner`);
    }
  }

  // ── Apply the correct payout ───────────────────────────────────────────────
  const applyLines: string[] = [];
  let newPayoutMeta: {
    payoutType: string; winnerDiscordId?: string | null; loserDiscordId?: string | null;
    winnerCoins?: number | null; loserCoins?: number | null; appliedPointDiff?: number | null;
  } = { payoutType: newType };

  if (newType === "h2h" && winner && pointDiff !== null) {
    const winnerLower = winner.toLowerCase();
    const [winnerUser] = await db.select().from(usersTable)
      .where(sql`lower(${usersTable.team}) = ${winnerLower}`).limit(1);
    if (!winnerUser) {
      await interaction.editReply(`❌ Could not find a registered user for winner team **${winner}**.`);
      return;
    }
    const loserUser = winnerUser.discordId === homeUser?.discordId ? awayUser : homeUser;
    if (!loserUser) {
      await interaction.editReply(`❌ Could not find the loser user — both teams must be registered for an H2H correction.`);
      return;
    }
    const winnerTeamName = winnerUser.team ?? winner;
    const loserTeamName  = loserUser.team  ?? "Unknown";

    await addBalance(winnerUser.discordId, H2H_WIN_PAYOUT);
    await logTransaction(winnerUser.discordId, H2H_WIN_PAYOUT, "addcoins",
      `[Correction Wk${week}] H2H win vs ${loserTeamName} (+${pointDiff})`);
    await addBalance(loserUser.discordId, H2H_LOSS_PAYOUT);
    await logTransaction(loserUser.discordId, H2H_LOSS_PAYOUT, "addcoins",
      `[Correction Wk${week}] H2H loss vs ${winnerTeamName} (−${pointDiff})`);
    applyLines.push(`✅ +${H2H_WIN_PAYOUT} coins → **${winnerTeamName}** | +${H2H_LOSS_PAYOUT} coins → **${loserTeamName}**`);

    await upsertH2HRecord(winnerUser.discordId, season.id, true,   pointDiff);
    await upsertH2HRecord(loserUser.discordId,  season.id, false, -pointDiff);
    applyLines.push(`✅ Records: **${winnerTeamName}** +1W, **${loserTeamName}** +1L`);

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
    applyLines.push(`✅ +${CPU_WIN_PAYOUT} coins → **${winnerUser.team ?? winner}** *(no record change)*`);

    const winIsHome  = winnerLower === homeLower;
    const wScore     = winIsHome ? (schedGame.homeScore ?? 0) : (schedGame.awayScore ?? 0);
    const lScore     = winIsHome ? (schedGame.awayScore ?? 0) : (schedGame.homeScore ?? 0);
    await appendGameLog(winnerUser.discordId, season.id, "win", wScore - lScore, `[CPU] ${loserTeamName}`);

    newPayoutMeta = {
      payoutType: "cpu", winnerDiscordId: winnerUser.discordId,
      winnerCoins: CPU_WIN_PAYOUT, loserCoins: 0, appliedPointDiff: Math.abs(wScore - lScore),
    };

  } else if (newType === "none") {
    applyLines.push("✅ Game voided — no payouts applied");
  }

  // ── Update the processed game record with new metadata ────────────────────
  const gameIdToUpdate = (processedGame as any).gameId as string;
  await db.update(franchiseProcessedGamesTable)
    .set({
      payoutType:       newPayoutMeta.payoutType,
      winnerDiscordId:  newPayoutMeta.winnerDiscordId ?? null,
      loserDiscordId:   newPayoutMeta.loserDiscordId  ?? null,
      winnerCoins:      newPayoutMeta.winnerCoins     ?? null,
      loserCoins:       newPayoutMeta.loserCoins      ?? null,
      appliedPointDiff: newPayoutMeta.appliedPointDiff ?? null,
    })
    .where(eq(franchiseProcessedGamesTable.gameId, gameIdToUpdate));

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
