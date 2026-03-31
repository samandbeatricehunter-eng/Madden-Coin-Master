import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable, franchiseProcessedGamesTable, franchiseScheduleTable, franchiseGameParticipantsTable, franchiseRostersTable } from "@workspace/db";
import { eq, sql, and, max, inArray } from "drizzle-orm";
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

// weekIndex mapping: Madden uses 0-based weekIndex (weekIndex 0 = Week 1).
// The admin sets season.currentWeek as a 1-based string ("1", "2", ... "18").
// We only process games whose weekIndex === targetWeekIndex to avoid
// double-counting any week the admin has not explicitly unlocked.

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
    const teamsResult     = readJsonFile(extractDir, "teams.json");
    const schedulesResult = readJsonFile(extractDir, "schedules.json");
    const rostersResult   = readJsonFile(extractDir, "rosters.json");

    const teamsJson     = teamsResult?.data     ?? null;
    const schedulesJson = schedulesResult?.data  ?? null;
    const rostersJson   = rostersResult?.data    ?? null;

    // ── Log all JSON files found in the ZIP for debugging ────────────────────
    const zipFileList = listJsonFilenames(extractDir);
    console.log(`[franchiseupdate] ZIP contents:\n${zipFileList}`);
    console.log(`[franchiseupdate] Matched: teams=${teamsResult?.matchedFile ?? "NOT FOUND"}, schedules=${schedulesResult?.matchedFile ?? "NOT FOUND"}, rosters=${rostersResult?.matchedFile ?? "NOT FOUND"}`);

    if (!teamsJson) {
      return interaction.editReply({
        content: `❌ No teams file found in the ZIP (looked for any filename containing "teams").\n\n**Files found in ZIP:**\n${zipFileList}`,
      });
    }
    if (!schedulesJson) {
      return interaction.editReply({
        content: `❌ No schedule file found in the ZIP (looked for any filename containing "schedule").\n\n**Files found in ZIP:**\n${zipFileList}`,
      });
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

    // Try full name first ("las vegas raiders"), fall back to nickname ("raiders") if provided
    function findUser(maddenFullName: string, maddenNickname?: string) {
      return teamToUser.get(maddenFullName.toLowerCase().trim())
          ?? (maddenNickname ? teamToUser.get(maddenNickname.toLowerCase().trim()) : null)
          ?? null;
    }

    // ── Get active season ──────────────────────────────────────────────────────
    const season = await getOrCreateActiveSeason();

    // ── Determine the target week from the admin-set current week ─────────────
    // season.currentWeek is a 1-based string ("1" … "18"); Madden weekIndex is 0-based.
    // We ONLY process games whose weekIndex === targetWeekIndex.
    // Non-numeric weeks (wildcard, playoffs, offseason) skip regular-season processing.
    const currentWeekStr  = season.currentWeek ?? "1";
    const currentWeekNum  = parseInt(currentWeekStr, 10);
    const isRegularWeek   = !isNaN(currentWeekNum) && currentWeekNum >= 1 && currentWeekNum <= 18;
    const targetWeekIndex = isRegularWeek ? currentWeekNum - 1 : -1; // 0-based; -1 = no regular games

    if (!isRegularWeek) {
      return interaction.editReply({
        content: `⚠️ The league is currently set to **${currentWeekStr}** (a playoff/offseason week). Use \`/franchiseupdate\` only during regular season weeks 1–18. Set the week with \`/advanceweek\` first.`,
      });
    }

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
    let gamesWrongWeek    = 0;   // completed but not the admin-set week
    const skippedHumanTeams = new Set<string>();
    const payoutLines: string[] = [];
    const milestoneLines: string[] = [];

    // Log the first few completed game objects for weekIndex debugging
    let _debugGameCount = 0;
    // Iterate games flexibly (handles 2-level or 3-level nesting)
    for (const game of iterateGames(regSeason)) {
      if (!game || typeof game !== "object") continue;
      if (game.homeTeamId == null || game.awayTeamId == null) continue;
      if (Number(game.status) !== COMPLETED_STATUS) continue;
      if (_debugGameCount < 5) {
        console.log(`[franchiseupdate] Game sample #${_debugGameCount}: weekIndex=${game.weekIndex} status=${game.status} h=${game.homeTeamId} a=${game.awayTeamId} score=${game.homeScore}-${game.awayScore}`);
        _debugGameCount++;
      }

      const homeId = Number(game.homeTeamId);
      const awayId = Number(game.awayTeamId);
      const homeTeamData = teamMap.get(homeId);
      const awayTeamData = teamMap.get(awayId);
      if (!homeTeamData || !awayTeamData) continue;

      const homeScore = Number(game.homeScore ?? 0);
      const awayScore = Number(game.awayScore ?? 0);

      // Build a stable game ID — do NOT include weekIndex in the fallback because
      // Madden can report a different weekIndex for the same game across imports.
      // Using seasonId + both teamIds + final score gives a stable key.
      const rawId   = game.gameId != null ? String(game.gameId) : null;
      const gameId  = rawId ?? `s${season.id}-h${homeId}-a${awayId}-${homeScore}-${awayScore}`;

      // Week-exact filter: only process games from the admin-set current week
      const gameWeekIndex = Number(game.weekIndex ?? -99);
      if (gameWeekIndex !== targetWeekIndex) { gamesWrongWeek++; continue; }

      // Dedup check — in-memory, no DB round-trip per game
      if (processedSet.has(gameId)) { gamesDuplicate++; continue; }

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

          // Award coins
          await addBalance(winnerId, H2H_WIN_PAYOUT);
          await logTransaction(winnerId, H2H_WIN_PAYOUT, "addcoins",
            `Franchise import: H2H win vs ${loserTeam} (${hiScore}–${loScore})`);
          await addBalance(loserId, H2H_LOSS_PAYOUT);
          await logTransaction(loserId, H2H_LOSS_PAYOUT, "addcoins",
            `Franchise import: H2H loss vs ${winnerTeam} (${loScore}–${hiScore})`);

          payoutLines.push(`🏆 **${winnerTeam}** +${H2H_WIN_PAYOUT} | 🎮 **${loserTeam}** +${H2H_LOSS_PAYOUT} *(${hiScore}–${loScore})*`);

          // Update records
          await upsertH2HRecord(winnerId, season.id, true,    spread);
          await upsertH2HRecord(loserId,  season.id, false,  -spread);

          // Game log
          await appendGameLog(winnerId, season.id, "win",   spread,  loserTeam);
          await appendGameLog(loserId,  season.id, "loss", -spread, winnerTeam);

          // All-time tracking
          await db.update(usersTable)
            .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, winnerId));
          await db.update(usersTable)
            .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, loserId));

          // Milestone check for winner
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

        } else {
          // Tie — log but no coins
          await appendGameLog(homeUser.discordId, season.id, "loss", 0, awayTeamData.name);
          await appendGameLog(awayUser.discordId, season.id, "loss", 0, homeTeamData.name);
          payoutLines.push(`🤝 **${homeTeamData.name}** vs **${awayTeamData.name}** — Tie *(no payout)*`);
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

        if (humanWon) {
          await addBalance(humanUser.discordId, CPU_WIN_PAYOUT);
          await logTransaction(humanUser.discordId, CPU_WIN_PAYOUT, "addcoins",
            `Franchise import: CPU win vs ${cpuTeam} (${humanScore}–${cpuScore})`);
          payoutLines.push(`🤖 **${humanTeam}** +${CPU_WIN_PAYOUT} coins *(CPU win vs ${cpuTeam} ${humanScore}–${cpuScore})*`);
        }

        // CPU games do NOT update user_records or power rankings — H2H only.
        await appendGameLog(humanUser.discordId, season.id, humanWon ? "win" : "loss", spread, `[CPU] ${cpuTeam}`);
      }

      // Mark game as processed (DB + in-memory set for within-upload dedup)
      await db.insert(franchiseProcessedGamesTable)
        .values({ gameId })
        .onConflictDoNothing();
      processedSet.add(gameId);

      // ── Record participation (used for interview eligibility) ──────────────
      if (homeUser && awayUser) {
        for (const uid of [homeUser.discordId, awayUser.discordId]) {
          await db.insert(franchiseGameParticipantsTable)
            .values({ seasonId: season.id, week: currentWeekStr, discordId: uid, gameType: "h2h" })
            .onConflictDoNothing();
        }
      } else {
        const humanUser2 = homeUser ?? awayUser!;
        await db.insert(franchiseGameParticipantsTable)
          .values({ seasonId: season.id, week: currentWeekStr, discordId: humanUser2.discordId, gameType: "cpu" })
          .onConflictDoNothing();
      }

      gamesProcessed++;
    }

    // ── Persist full schedule (wipe + re-insert each time) ────────────────────
    // We delete all rows for this season and re-insert from the ZIP on every
    // import. This prevents stale duplicate rows when Madden shifts a game's
    // weekIndex between exports (which broke the unique-constraint upsert).
    await db.delete(franchiseScheduleTable)
      .where(eq(franchiseScheduleTable.seasonId, season.id));

    let scheduleRowsSaved = 0;
    const scheduleInserts: Promise<any>[] = [];
    for (const game of iterateGames(regSeason)) {
      if (!game || typeof game !== "object") continue;
      if (game.homeTeamId == null || game.awayTeamId == null || game.weekIndex == null) continue;

      const hId  = Number(game.homeTeamId);
      const aId  = Number(game.awayTeamId);
      const hData = teamMap.get(hId);
      const aData = teamMap.get(aId);
      if (!hData || !aData) continue;

      // Store the registered team nickname for human teams so queries by user.team work.
      // Fall back to Madden's nickname (no city prefix) for CPU teams.
      const hUser = findUser(hData.name, hData.nickname);
      const aUser = findUser(aData.name, aData.nickname);
      const hTeamName = hUser?.team ?? hData.nickname;
      const aTeamName = aUser?.team ?? aData.nickname;

      const weekIdx    = Number(game.weekIndex);
      const hScore     = game.homeScore != null ? Number(game.homeScore) : null;
      const aScore     = game.awayScore != null ? Number(game.awayScore) : null;
      const gameStatus = game.status   != null ? Number(game.status)    : 0;

      scheduleRowsSaved++;
      scheduleInserts.push(
        db.insert(franchiseScheduleTable)
          .values({
            seasonId:     season.id,
            weekIndex:    weekIdx,
            homeTeamId:   hId,
            awayTeamId:   aId,
            homeTeamName: hTeamName,
            awayTeamName: aTeamName,
            homeScore:    hScore,
            awayScore:    aScore,
            status:       gameStatus,
            importedAt:   new Date(),
          })
          .onConflictDoNothing()  // safety net only — table was just cleared
      );
    }
    await Promise.all(scheduleInserts);

    // ── Sync rosters from rosters.json ────────────────────────────────────────
    // ── Position number → string map (Madden 24/25 roster export format) ──────
    const POS_NUM: Record<number, string> = {
      0: "QB",  1: "HB",  2: "FB",  3: "WR",  4: "TE",
      5: "LT",  6: "LG",  7: "C",   8: "RG",  9: "RT",
      10: "LE", 11: "RE", 12: "DT", 13: "LOLB", 14: "MLB", 15: "ROLB",
      16: "CB", 17: "FS", 18: "SS", 19: "K",  20: "P",
      21: "KR", 22: "PR", 23: "LS",
    };

    // rosType (roster type) values — only rosType 0 = 53-man active roster.
    // rosType 1 = practice squad, 2 = IR, 3 = NFI/DNR, etc.
    // If the field is missing we assume active roster.
    const ACTIVE_ROS_TYPE = 0;

    let rostersSynced = 0;
    if (rostersJson) {
      // Normalise: flatten the JSON into an array of player objects
      let rawPlayers: any[] = [];
      if (Array.isArray(rostersJson)) {
        rawPlayers = rostersJson;
      } else if (Array.isArray(rostersJson.rosters)) {
        rawPlayers = rostersJson.rosters;
      } else if (Array.isArray(rostersJson.players)) {
        rawPlayers = rostersJson.players;
      } else {
        // Dictionary of players (key → player object) — common in MaddenCFMFiddler exports
        for (const v of Object.values(rostersJson)) {
          if (!v || typeof v !== "object" || Array.isArray(v)) continue;
          // If the value itself is a dict of players, flatten one more level
          const vObj = v as any;
          if (vObj.firstName != null || vObj.lastName != null || vObj.position != null) {
            rawPlayers.push(vObj);
          } else {
            for (const inner of Object.values(vObj)) {
              if (inner && typeof inner === "object" && !Array.isArray(inner)) {
                rawPlayers.push(inner);
              }
            }
          }
        }
      }

      // Log first player for debugging
      if (rawPlayers.length > 0) {
        console.log("[franchiseupdate] Sample player fields:", JSON.stringify(rawPlayers[0]).slice(0, 400));
      }

      const rosterUpserts: Promise<any>[] = [];
      for (const p of rawPlayers) {
        if (!p || typeof p !== "object") continue;

        // ── Filter: active 53-man roster only (skip practice squad / IR / etc.) ──
        const rosType = p.rosType ?? p.rosterType ?? p.rostStatus ?? p.rosStatus ?? null;
        if (rosType != null && Number(rosType) !== ACTIVE_ROS_TYPE) continue;

        const teamId = Number(p.teamId ?? p.teamIndex ?? -1);
        if (teamId < 0) continue;

        const rawId  = p.playerId ?? p.rosterId ?? p.playerIndex ?? p.id;
        const playerId = rawId != null ? Number(rawId) : null;
        if (playerId == null || isNaN(playerId)) continue;

        const teamData = teamMap.get(teamId);
        if (!teamData) continue;

        const user = findUser(teamData.name, teamData.nickname);

        // ── Resolve overall rating — try every known field name ──────────────
        const ovrRaw =
          p.overallRating   ??  // standard Madden export
          p.overallRatings  ??  // alternate spelling
          p.overall         ??  // short form
          p.ovr             ??  // acronym
          p.playerBestOvr   ??  // Madden 22 CFM export
          p.bestOverall     ??  // another variant
          p.playerSkillRating ?? null;
        const overall = ovrRaw != null ? Math.max(0, Math.min(99, Number(ovrRaw))) : 0;

        const devTrait = p.devTrait ?? p.devTraitId ?? p.playerDevTrait ?? 0;

        // ── Resolve position — may be a string ("QB") or a number (0 = QB) ──
        const posRaw = p.position ?? p.pos ?? p.positionId ?? "";
        const position = typeof posRaw === "number"
          ? (POS_NUM[posRaw] ?? String(posRaw))
          : String(posRaw).trim().toUpperCase();

        rosterUpserts.push(
          db.insert(franchiseRostersTable)
            .values({
              seasonId:  season.id,
              teamId,
              teamName:  teamData.name,
              discordId: user?.discordId ?? null,
              playerId,
              firstName: String(p.firstName ?? "").trim(),
              lastName:  String(p.lastName  ?? "").trim(),
              position,
              overall,
              devTrait:  Number(devTrait),
              age:       p.age != null ? Number(p.age) : null,
              jerseyNum: (p.jerseyNum ?? p.jersey ?? p.uniformNumber) != null
                ? Number(p.jerseyNum ?? p.jersey ?? p.uniformNumber)
                : null,
              importedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                franchiseRostersTable.seasonId,
                franchiseRostersTable.teamId,
                franchiseRostersTable.playerId,
              ],
              set: {
                teamName:  teamData.name,
                discordId: user?.discordId ?? null,
                firstName: String(p.firstName ?? "").trim(),
                lastName:  String(p.lastName  ?? "").trim(),
                position,
                overall,
                devTrait:  Number(devTrait),
                age:       p.age != null ? Number(p.age) : null,
                jerseyNum: (p.jerseyNum ?? p.jersey ?? p.uniformNumber) != null
                  ? Number(p.jerseyNum ?? p.jersey ?? p.uniformNumber)
                  : null,
                importedAt: new Date(),
              },
            })
        );
        rostersSynced++;
      }
      await Promise.all(rosterUpserts);
    }

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
                .setTitle(`🏈 Week ${currentCompletedWeek + 1} Results`)
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
      `**Current week:** Week ${currentWeekStr} (weekIndex ${targetWeekIndex})`,
      `**Games processed:** ${gamesProcessed}`,
      `**Already processed (duplicate):** ${gamesDuplicate}`,
      `**Other weeks (skipped):** ${gamesWrongWeek}`,
      `**CPU vs CPU (skipped):** ${gamesCpuVsCpu}`,
      `**Unregistered team (skipped):** ${gamesUnregistered}`,
      `**Schedule rows saved:** ${scheduleRowsSaved}`,
      `**Roster players synced:** ${rostersSynced > 0 ? rostersSynced : "none (rosters.json not found in ZIP)"}`,
      `**ZIP files matched:** teams=\`${teamsResult?.matchedFile ?? "N/A"}\` schedules=\`${schedulesResult?.matchedFile ?? "N/A"}\` rosters=\`${rostersResult?.matchedFile ?? "not found"}\``,
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

// ── Utility: collect all file paths recursively ───────────────────────────────
function listAllFiles(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listAllFiles(full, results);
    else results.push(full);
  }
  return results;
}

// Find a file by exact name match first, then by keyword contained in name.
// Returns the first match, preferring exact over partial.
function findFile(dir: string, nameOrKeyword: string): string | null {
  const all = listAllFiles(dir);
  const lower = nameOrKeyword.toLowerCase();
  // 1. exact match (e.g. "schedules.json")
  const exact = all.find(f => path.basename(f).toLowerCase() === lower);
  if (exact) return exact;
  // 2. partial match: strip extension and trailing 's' so "schedules" matches "leagueSchedule.json", etc.
  const keyword = lower.replace(/\.json$/, "").replace(/s$/, ""); // "schedules" → "schedule"
  const partial = all.find(f => path.basename(f).toLowerCase().includes(keyword) && f.endsWith(".json"));
  return partial ?? null;
}

function readJsonFile(dir: string, name: string): { data: any; matchedFile: string } | null {
  const found = findFile(dir, name);
  if (!found) return null;
  try {
    const data = JSON.parse(fs.readFileSync(found, "utf-8"));
    return { data, matchedFile: path.basename(found) };
  } catch { return null; }
}

// Return a human-readable list of all JSON filenames found in the ZIP directory
function listJsonFilenames(dir: string): string {
  const files = listAllFiles(dir).filter(f => f.endsWith(".json"));
  if (files.length === 0) return "*(no .json files found)*";
  return files.map(f => `• \`${path.relative(dir, f)}\``).join("\n");
}

// ── Utility: iterate games from a Madden schedule structure ──────────────────
// Madden exports nest games like: { weekKey: { gameKey: { ...game } } }
// OR three levels:               { yearKey: { weekKey: { gameKey: { ...game } } } }
// weekKey is "0"–"17" for regular season.
// The game object itself may OR MAY NOT include a weekIndex field — we inject
// it from the parent key so downstream code can rely on game.weekIndex reliably.
function* iterateGames(schedule: any): Generator<any> {
  if (!schedule || typeof schedule !== "object") return;

  for (const [key1, level1] of Object.entries(schedule)) {
    if (!level1 || typeof level1 !== "object") continue;

    // Level1 looks like a game object → flat array, yield it using its own weekIndex
    if ((level1 as any).homeTeamId != null) {
      yield level1;
      continue;
    }

    // Otherwise dig one level deeper
    for (const [key2, level2] of Object.entries(level1 as any)) {
      if (!level2 || typeof level2 !== "object") continue;

      // Level2 is a game — key1 is the week key
      if ((level2 as any).homeTeamId != null) {
        const weekIdx = parseInt(key1, 10);
        yield { ...(level2 as any), weekIndex: isNaN(weekIdx) ? (level2 as any).weekIndex : weekIdx };
        continue;
      }

      // Level2 is another nesting layer — key2 is the week key, level3 is the game
      for (const [, level3] of Object.entries(level2 as any)) {
        if (!level3 || typeof level3 !== "object") continue;
        if ((level3 as any).homeTeamId != null) {
          const weekIdx = parseInt(key2, 10);
          yield { ...(level3 as any), weekIndex: isNaN(weekIdx) ? (level3 as any).weekIndex : weekIdx };
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
