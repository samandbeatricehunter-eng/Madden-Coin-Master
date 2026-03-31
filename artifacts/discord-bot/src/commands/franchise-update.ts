import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable, franchiseProcessedGamesTable, franchiseScheduleTable, franchiseGameParticipantsTable } from "@workspace/db";
import { eq, sql, and, max } from "drizzle-orm";
import axios from "axios";
import AdmZip from "adm-zip";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  addBalance, logTransaction, getOrCreateActiveSeason,
  upsertH2HRecord, appendGameLog,
} from "../lib/db-helpers.js";

// ── Channel IDs ───────────────────────────────────────────────────────────────
const GENERAL_CHANNEL_ID = process.env["DISCORD_GENERAL_CHANNEL_ID"] ?? "1476321282868908052";

// ── Coin payouts ─────────────────────────────────────────────────────────────
const H2H_WIN_PAYOUT  = 50;
const H2H_LOSS_PAYOUT = 20;
const CPU_WIN_PAYOUT  = 20;

// ── Madden completed-game status code ────────────────────────────────────────
// Most Madden 24/25 franchise exports use status 2 for final games.
// Change to 3 if your export marks completed games as status 3.
const COMPLETED_STATUS = 2;

// ── Historical week cutoff ─────────────────────────────────────────────────────
// weekIndex is 0-based in the Madden export (weekIndex 0 = Week 1).
// Games with weekIndex <= this value are treated as historical:
// they are logged and the schedule is updated, but NO coin payouts are issued
// and NO records (wins/losses/PD) are changed.
// weekIndex 7 = Week 8 (last historical week); weekIndex 8 = Week 9 (first live week).
const HISTORICAL_WEEK_INDEX_CUTOFF = 7;

// ── Win milestones (mirrors interactionCreate.ts) ─────────────────────────────
const H2H_MILESTONES = [
  { tier: 4, wins: 50, bonus: 1000, label: "50 All-Time Wins" },
  { tier: 3, wins: 25, bonus: 500,  label: "25 All-Time Wins" },
  { tier: 2, wins: 12, bonus: 250,  label: "12 All-Time Wins" },
  { tier: 1, wins: 5,  bonus: 100,  label:  "5 All-Time Wins" },
] as const;

function checkMilestone(totalWins: number, currentTier: number) {
  for (const m of H2H_MILESTONES) {
    if (totalWins >= m.wins && currentTier < m.tier) return m;
  }
  return null;
}

// ── Power ranking helpers ─────────────────────────────────────────────────────
function calcPRScore(wins: number, losses: number, pd: number) {
  return 0.6 * (wins - losses) + 0.4 * pd;
}
function formatPD(n: number) { return n >= 0 ? `+${n}` : `${n}`; }
function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

// ── Command definition ────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("franchiseupdate")
  .setDescription("Admin: import a Madden franchise ZIP to sync records, award coins, and post rankings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addAttachmentOption(opt =>
    opt.setName("file")
      .setDescription("The Madden franchise export ZIP file")
      .setRequired(true)
  )
  .addBooleanOption(opt =>
    opt.setName("post_payouts")
      .setDescription("Post coin payout summary to this channel? (default: true)")
      .setRequired(false)
  )
  .addBooleanOption(opt =>
    opt.setName("post_rankings")
      .setDescription("Post updated power rankings to this channel? (default: true)")
      .setRequired(false)
  );

// ── Command handler ───────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const attachment   = interaction.options.getAttachment("file", true);
  const postPayouts  = interaction.options.getBoolean("post_payouts")  ?? true;
  const postRankings = interaction.options.getBoolean("post_rankings") ?? true;

  if (!attachment.name.toLowerCase().endsWith(".zip")) {
    return interaction.editReply({ content: "❌ Please upload a `.zip` file from your Madden franchise export." });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "franchise-"));

  try {
    await interaction.editReply({ content: "📥 Downloading and parsing franchise ZIP..." });

    // ── Download ZIP ──────────────────────────────────────────────────────────
    const resp = await axios({ url: attachment.url, method: "GET", responseType: "arraybuffer", timeout: 30000 });
    const zipBuf = Buffer.from(resp.data as ArrayBuffer);
    const zipPath = path.join(tmpDir, "franchise.zip");
    fs.writeFileSync(zipPath, zipBuf);

    // ── Extract ───────────────────────────────────────────────────────────────
    const zip = new AdmZip(zipPath);
    const extractDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);

    // ── Read JSON files ───────────────────────────────────────────────────────
    const teamsJson     = readJsonFile(extractDir, "teams.json");
    const schedulesJson = readJsonFile(extractDir, "schedules.json");

    if (!teamsJson) {
      return interaction.editReply({ content: "❌ `teams.json` not found in the ZIP. Make sure you're uploading a valid Madden franchise export." });
    }
    if (!schedulesJson) {
      return interaction.editReply({ content: "❌ `schedules.json` not found in the ZIP. Make sure you're uploading a valid Madden franchise export." });
    }

    // ── Build teamId → { name, nickname, userName } map ──────────────────────
    // name     = full "cityName teamName" (e.g. "Las Vegas Raiders")
    // nickname = just teamName field     (e.g. "Raiders")
    // The DB stores only the nickname (from NFL_TEAMS), so we need both for matching.
    const teamMap = new Map<number, { name: string; nickname: string; userName: string }>();
    for (const t of Object.values(teamsJson) as any[]) {
      const id = t?.teamId ?? t?.teamIndex;
      if (id == null) continue;
      const nickname = (t.teamName ?? "").trim();
      const name     = [t.cityName, nickname].filter(Boolean).join(" ").trim();
      teamMap.set(Number(id), { name, nickname, userName: t.userName || "CPU" });
    }

    // ── Build team name (lowercase) → discord user lookup ─────────────────────
    const registeredUsers = await db.select({
      discordId:       usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team:            usersTable.team,
    }).from(usersTable);

    const teamToUser = new Map<string, { discordId: string; discordUsername: string; team: string }>();
    for (const u of registeredUsers) {
      if (u.team) teamToUser.set(u.team.toLowerCase().trim(), { discordId: u.discordId, discordUsername: u.discordUsername, team: u.team });
    }

    // Try full name first ("las vegas raiders"), fall back to nickname ("raiders")
    function findUser(maddenFullName: string, maddenNickname: string) {
      return teamToUser.get(maddenFullName.toLowerCase().trim())
          ?? teamToUser.get(maddenNickname.toLowerCase().trim())
          ?? null;
    }

    // ── Get active season ──────────────────────────────────────────────────────
    const season = await getOrCreateActiveSeason();

    // ── Process schedule (regular season only) ────────────────────────────────
    const regSeason = schedulesJson?.reg ?? schedulesJson?.schedules?.reg;
    if (!regSeason) {
      return interaction.editReply({ content: "❌ No regular-season schedule (`schedules.reg`) found in `schedules.json`. Make sure you're uploading a valid Madden franchise export." });
    }

    // ── Pre-load all processed game IDs into memory (one query, not N) ─────────
    const allProcessed = await db
      .select({ gameId: franchiseProcessedGamesTable.gameId })
      .from(franchiseProcessedGamesTable);
    const processedSet = new Set(allProcessed.map(r => r.gameId));

    let gamesProcessed    = 0;
    let gamesDuplicate    = 0;
    let gamesCpuVsCpu     = 0;
    let gamesUnregistered = 0;
    let gamesHistorical   = 0;
    const skippedHumanTeams = new Set<string>();
    const payoutLines: string[] = [];
    const milestoneLines: string[] = [];

    // Iterate games flexibly (handles 2-level or 3-level nesting)
    for (const game of iterateGames(regSeason)) {
      if (!game || typeof game !== "object") continue;
      if (game.homeTeamId == null || game.awayTeamId == null) continue;
      if (Number(game.status) !== COMPLETED_STATUS) continue;

      const homeId = Number(game.homeTeamId);
      const awayId = Number(game.awayTeamId);
      const homeTeamData = teamMap.get(homeId);
      const awayTeamData = teamMap.get(awayId);
      if (!homeTeamData || !awayTeamData) continue;

      const homeScore = Number(game.homeScore ?? 0);
      const awayScore = Number(game.awayScore ?? 0);

      // Build a stable game ID
      const rawId   = game.gameId != null ? String(game.gameId) : null;
      const gameId  = rawId ?? `wk${game.weekIndex ?? "?"}-h${homeId}-a${awayId}-${homeScore}-${awayScore}`;

      // Dedup check — in-memory, no DB round-trip per game
      if (processedSet.has(gameId)) { gamesDuplicate++; continue; }

      // Historical mode: weeks 1-8 (weekIndex 0-7) are already accounted for manually.
      // Log the game and update the schedule, but skip coin payouts and record changes.
      const gameWeekIndex = Number(game.weekIndex ?? 0);
      const isHistorical  = gameWeekIndex <= HISTORICAL_WEEK_INDEX_CUTOFF;

      const homeIsHuman = homeTeamData.userName !== "CPU";
      const awayIsHuman = awayTeamData.userName !== "CPU";

      // CPU vs CPU — skip
      if (!homeIsHuman && !awayIsHuman) { gamesCpuVsCpu++; continue; }

      const homeUser = homeIsHuman ? findUser(homeTeamData.name, homeTeamData.nickname) : null;
      const awayUser = awayIsHuman ? findUser(awayTeamData.name, awayTeamData.nickname) : null;

      // Track human teams that have no registered Discord user
      if (homeIsHuman && !homeUser) skippedHumanTeams.add(homeTeamData.name);
      if (awayIsHuman && !awayUser) skippedHumanTeams.add(awayTeamData.name);

      // Skip game entirely if any human side has no registered Discord user
      // (avoids null dereference and keeps the summary honest)
      if ((homeIsHuman && !homeUser) || (awayIsHuman && !awayUser)) {
        gamesUnregistered++;
        continue;
      }

      const isTie   = homeScore === awayScore;
      const homeWon = homeScore > awayScore;

      // ── H2H: both players are humans ─────────────────────────────────────────
      if (homeUser && awayUser) {
        if (!isTie) {
          const winnerId   = homeWon ? homeUser.discordId   : awayUser.discordId;
          const loserId    = homeWon ? awayUser.discordId   : homeUser.discordId;
          const winnerTeam = homeWon ? homeTeamData.name    : awayTeamData.name;
          const loserTeam  = homeWon ? awayTeamData.name    : homeTeamData.name;
          const hiScore    = Math.max(homeScore, awayScore);
          const loScore    = Math.min(homeScore, awayScore);
          const spread     = hiScore - loScore;

          if (isHistorical) {
            // Historical week (1-8): log for display only — no coins, no record changes
            await appendGameLog(winnerId, season.id, "win",   spread,  loserTeam);
            await appendGameLog(loserId,  season.id, "loss", -spread, winnerTeam);
          } else {
            // Live week (9+): full payouts and record updates
            await addBalance(winnerId, H2H_WIN_PAYOUT);
            await logTransaction(winnerId, H2H_WIN_PAYOUT, "addcoins",
              `Franchise import: H2H win vs ${loserTeam} (${hiScore}–${loScore})`);
            await addBalance(loserId, H2H_LOSS_PAYOUT);
            await logTransaction(loserId, H2H_LOSS_PAYOUT, "addcoins",
              `Franchise import: H2H loss vs ${winnerTeam} (${loScore}–${hiScore})`);

            payoutLines.push(`🏆 **${winnerTeam}** +${H2H_WIN_PAYOUT} | 🎮 **${loserTeam}** +${H2H_LOSS_PAYOUT} *(${hiScore}–${loScore})*`);

            await upsertH2HRecord(winnerId, season.id, true,    spread);
            await upsertH2HRecord(loserId,  season.id, false,  -spread);

            await appendGameLog(winnerId, season.id, "win",   spread,  loserTeam);
            await appendGameLog(loserId,  season.id, "loss", -spread, winnerTeam);

            await db.update(usersTable)
              .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   + 1`, updatedAt: new Date() })
              .where(eq(usersTable.discordId, winnerId));
            await db.update(usersTable)
              .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
              .where(eq(usersTable.discordId, loserId));

            const winnerRow = await db.select({
              allTimeH2HWins:       usersTable.allTimeH2HWins,
              milestoneTierAwarded: usersTable.milestoneTierAwarded,
            }).from(usersTable).where(eq(usersTable.discordId, winnerId)).limit(1);

            const newWins     = (winnerRow[0]?.allTimeH2HWins ?? 0);
            const currentTier = winnerRow[0]?.milestoneTierAwarded ?? 0;
            const milestone   = checkMilestone(newWins, currentTier);

            if (milestone) {
              await addBalance(winnerId, milestone.bonus);
              await logTransaction(winnerId, milestone.bonus, "addcoins",
                `Career win milestone: ${milestone.label} (franchise import)`);
              await db.update(usersTable)
                .set({ milestoneTierAwarded: milestone.tier, updatedAt: new Date() })
                .where(eq(usersTable.discordId, winnerId));
              milestoneLines.push(`🎯 **${winnerTeam}** hit **${milestone.label}** → +${milestone.bonus} coins`);
            }
          }

        } else {
          // Tie — log but no coins (even for live weeks)
          await appendGameLog(homeUser.discordId, season.id, "loss", 0, awayTeamData.name);
          await appendGameLog(awayUser.discordId, season.id, "loss", 0, homeTeamData.name);
          if (!isHistorical) {
            payoutLines.push(`🤝 **${homeTeamData.name}** vs **${awayTeamData.name}** — Tie *(no payout)*`);
          }
        }

      // ── CPU game: one human, one CPU ──────────────────────────────────────────
      } else {
        const humanUser   = homeUser ?? awayUser!;
        const humanIsHome = !!homeUser;
        const humanScore  = humanIsHome ? homeScore : awayScore;
        const cpuScore    = humanIsHome ? awayScore : homeScore;
        const humanTeam   = humanIsHome ? homeTeamData.name : awayTeamData.name;
        const cpuTeam     = humanIsHome ? awayTeamData.name : homeTeamData.name;
        const humanWon    = humanScore > cpuScore && !isTie;
        const spread      = humanScore - cpuScore;

        if (!isHistorical && humanWon) {
          await addBalance(humanUser.discordId, CPU_WIN_PAYOUT);
          await logTransaction(humanUser.discordId, CPU_WIN_PAYOUT, "addcoins",
            `Franchise import: CPU win vs ${cpuTeam} (${humanScore}–${cpuScore})`);
          payoutLines.push(`🤖 **${humanTeam}** +${CPU_WIN_PAYOUT} coins *(CPU win vs ${cpuTeam} ${humanScore}–${cpuScore})*`);
        }

        // CPU games do NOT update user_records or power rankings — H2H only.
        // Only log to game_log for personal history.
        await appendGameLog(humanUser.discordId, season.id, humanWon ? "win" : "loss", spread, `[CPU] ${cpuTeam}`);
      }

      // Mark game as processed (DB + in-memory set for within-upload dedup)
      await db.insert(franchiseProcessedGamesTable)
        .values({ gameId })
        .onConflictDoNothing();
      processedSet.add(gameId);

      // ── Record participation (used for interview eligibility) ──────────────
      const currentWeek: string = (season as any).currentWeek ?? "1";
      if (homeUser && awayUser) {
        // H2H — both players participated
        for (const uid of [homeUser.discordId, awayUser.discordId]) {
          await db.insert(franchiseGameParticipantsTable)
            .values({ seasonId: season.id, week: currentWeek, discordId: uid, gameType: "h2h" })
            .onConflictDoNothing();
        }
      } else {
        // CPU — only the human player
        const humanUser2 = homeUser ?? awayUser!;
        await db.insert(franchiseGameParticipantsTable)
          .values({ seasonId: season.id, week: currentWeek, discordId: humanUser2.discordId, gameType: "cpu" })
          .onConflictDoNothing();
      }

      if (isHistorical) gamesHistorical++;
      else gamesProcessed++;
    }

    // ── Persist full schedule (all games, not just completed) ─────────────────
    const scheduleUpserts: Promise<any>[] = [];
    for (const game of iterateGames(regSeason)) {
      if (!game || typeof game !== "object") continue;
      if (game.homeTeamId == null || game.awayTeamId == null || game.weekIndex == null) continue;

      const hId  = Number(game.homeTeamId);
      const aId  = Number(game.awayTeamId);
      const hData = teamMap.get(hId);
      const aData = teamMap.get(aId);
      if (!hData || !aData) continue;

      const weekIdx    = Number(game.weekIndex);
      const hScore     = game.homeScore != null ? Number(game.homeScore) : null;
      const aScore     = game.awayScore != null ? Number(game.awayScore) : null;
      const gameStatus = game.status   != null ? Number(game.status)    : 0;

      scheduleUpserts.push(
        db.insert(franchiseScheduleTable)
          .values({
            seasonId:     season.id,
            weekIndex:    weekIdx,
            homeTeamId:   hId,
            awayTeamId:   aId,
            homeTeamName: hData.name,
            awayTeamName: aData.name,
            homeScore:    hScore,
            awayScore:    aScore,
            status:       gameStatus,
            importedAt:   new Date(),
          })
          .onConflictDoUpdate({
            target: [
              franchiseScheduleTable.seasonId,
              franchiseScheduleTable.weekIndex,
              franchiseScheduleTable.homeTeamId,
              franchiseScheduleTable.awayTeamId,
            ],
            set: {
              homeTeamName: hData.name,
              awayTeamName: aData.name,
              homeScore:    hScore,
              awayScore:    aScore,
              status:       gameStatus,
              importedAt:   new Date(),
            },
          })
      );
    }
    await Promise.all(scheduleUpserts);

    // ── Auto-post weekly results to general channel ────────────────────────────
    // Always derive the current week from persisted DB data so re-imports work correctly.
    try {
      const [maxWeekRow] = await db
        .select({ maxWeek: max(franchiseScheduleTable.weekIndex) })
        .from(franchiseScheduleTable)
        .where(and(
          eq(franchiseScheduleTable.seasonId, season.id),
          eq(franchiseScheduleTable.status,   COMPLETED_STATUS),
        ));
      const currentCompletedWeek = maxWeekRow?.maxWeek ?? null;

      const generalChannel = await interaction.client.channels.fetch(GENERAL_CHANNEL_ID).catch(() => null);

      if (currentCompletedWeek !== null) {
        // Post results for the most recently completed week (from DB)
        const weekGames = await db.select().from(franchiseScheduleTable)
          .where(and(
            eq(franchiseScheduleTable.seasonId,  season.id),
            eq(franchiseScheduleTable.weekIndex, currentCompletedWeek),
            eq(franchiseScheduleTable.status,    COMPLETED_STATUS),
          ));

        const h2hGames = weekGames.filter(g =>
          findUser(g.homeTeamName) && findUser(g.awayTeamName),
        );

        if (h2hGames.length > 0 && generalChannel?.isTextBased()) {
          const lines = h2hGames.map(g => {
            const hs      = g.homeScore ?? 0;
            const as_     = g.awayScore ?? 0;
            const tied    = hs === as_;
            const homeWon = hs > as_;
            if (tied) return `🤝 **${g.homeTeamName}** ${hs} — ${as_} **${g.awayTeamName}** *(Tie)*`;
            const winner = homeWon ? g.homeTeamName : g.awayTeamName;
            const loser  = homeWon ? g.awayTeamName : g.homeTeamName;
            const ws     = homeWon ? hs : as_;
            const ls     = homeWon ? as_ : hs;
            return `🏆 **${winner}** ${ws} — ${ls} **${loser}**`;
          });

          await (generalChannel as TextChannel).send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Gold)
                .setTitle(`🏈 Week ${currentCompletedWeek} Results`)
                .setDescription(lines.join("\n"))
                .setTimestamp(),
            ],
          });
        }
      } else if (scheduleUpserts.length > 0) {
        // No completed games in DB yet — post week 1 upcoming matchups as a preview
        const week1Games = await db.select().from(franchiseScheduleTable)
          .where(and(
            eq(franchiseScheduleTable.seasonId,  season.id),
            eq(franchiseScheduleTable.weekIndex, 1),
          ));

        const h2hWeek1 = week1Games.filter(g =>
          findUser(g.homeTeamName) && findUser(g.awayTeamName),
        );

        if (h2hWeek1.length > 0 && generalChannel?.isTextBased()) {
          const lines = h2hWeek1.map(g =>
            `⏳ **${g.homeTeamName}** vs **${g.awayTeamName}**`,
          );
          await (generalChannel as TextChannel).send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Blue)
                .setTitle("🏈 Week 1 Matchups")
                .setDescription(lines.join("\n"))
                .setFooter({ text: "Season schedule imported" })
                .setTimestamp(),
            ],
          });
        }
      }
    } catch (postErr) {
      console.error("Failed to post weekly matchups to general channel:", postErr);
    }

    // ── Build confirmation embed ───────────────────────────────────────────────
    const summaryParts: string[] = [
      `**Games processed (live):** ${gamesProcessed}`,
      `**Games logged (historical wk 1-8, no payout):** ${gamesHistorical}`,
      `**Already processed (duplicate):** ${gamesDuplicate}`,
      `**CPU vs CPU (skipped):** ${gamesCpuVsCpu}`,
      `**Unregistered team (skipped):** ${gamesUnregistered}`,
    ];
    if (skippedHumanTeams.size > 0) {
      summaryParts.push(`**Unregistered teams:** ${[...skippedHumanTeams].join(", ")}`);
    }
    if (milestoneLines.length > 0) {
      summaryParts.push("", "**🎯 Milestones hit:**", ...milestoneLines);
    }
    if (gamesProcessed === 0 && gamesDuplicate > 0) {
      summaryParts.push("\n*All games in this ZIP were already processed. No changes made.*");
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Franchise Update Complete")
          .setDescription(summaryParts.join("\n"))
          .setFooter({ text: `Imported by ${interaction.user.username}` })
          .setTimestamp(),
      ],
    });

    // ── Optional: post payout summary ─────────────────────────────────────────
    if (postPayouts && payoutLines.length > 0 && interaction.channel?.isTextBased()) {
      const chunks = chunkLines(payoutLines, 3800);
      for (const chunk of chunks) {
        await (interaction.channel as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle("💰 Franchise Import — Coin Payouts")
              .setDescription(chunk.join("\n"))
              .setTimestamp(),
          ],
        });
      }
    }

    // ── Optional: post power rankings ─────────────────────────────────────────
    if (postRankings && interaction.channel?.isTextBased()) {
      const records = await db
        .select()
        .from(userRecordsTable)
        .where(eq(userRecordsTable.seasonId, season.id));

      if (records.length > 0) {
        const ranked = records.map(r => ({
          ...r,
          prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
          label:   r.team ?? r.discordUsername,
        })).sort((a, b) => b.prScore - a.prScore);

        const medals = ["🥇", "🥈", "🥉"];
        const rows = ranked.map((r, i) => {
          const badge  = medals[i] ?? `**${ordinal(i + 1)}**`;
          const gp     = r.wins + r.losses;
          const winPct = gp > 0 ? ((r.wins / gp) * 100).toFixed(1) : "0.0";
          return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${formatPD(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}`;
        });

        await (interaction.channel as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Blurple)
              .setTitle(`🏈 Season ${season.seasonNumber} Power Rankings`)
              .setDescription(rows.join("\n"))
              .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
              .setTimestamp(),
          ],
        });
      }
    }

  } catch (err) {
    console.error("Franchise update error:", err);
    const msg = (err as any)?.message ?? "Unknown error";
    await interaction.editReply({ content: `❌ An error occurred during franchise import:\n\`${msg}\`` }).catch(() => {});
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Utility: find a file recursively in a directory ───────────────────────────
function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function readJsonFile(dir: string, name: string): any | null {
  const found = findFile(dir, name);
  if (!found) return null;
  try { return JSON.parse(fs.readFileSync(found, "utf-8")); } catch { return null; }
}

// ── Utility: iterate games from a Madden schedule structure ──────────────────
// Handles 2-level ({ weekKey: { gameKey: game } }) and
//         3-level ({ yearKey: { weekKey: { gameKey: game } } }) nesting.
function* iterateGames(schedule: any): Generator<any> {
  if (!schedule || typeof schedule !== "object") return;
  for (const level1 of Object.values(schedule)) {
    if (!level1 || typeof level1 !== "object") continue;
    // If this looks like a game object, yield it directly
    if ((level1 as any).homeTeamId != null) {
      yield level1;
    } else {
      for (const level2 of Object.values(level1 as any)) {
        if (!level2 || typeof level2 !== "object") continue;
        if ((level2 as any).homeTeamId != null) {
          yield level2;
        } else {
          for (const level3 of Object.values(level2 as any)) {
            if (!level3 || typeof level3 !== "object") continue;
            if ((level3 as any).homeTeamId != null) yield level3;
          }
        }
      }
    }
  }
}

// ── Utility: split lines into chunks that fit within Discord's embed limit ────
function chunkLines(lines: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
