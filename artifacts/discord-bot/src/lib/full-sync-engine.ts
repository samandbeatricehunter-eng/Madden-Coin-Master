/**
 * Full league sync engine.
 * Phases:
 *   1. Auto-link economy_users to franchise_mca_teams
 *   2. Process stored GCS week-schedule files (issue missed game payouts)
 *   3. Use standings fallback for any team still missing season wins
 *   4. Sync all-time win counts + award any missed milestone bonuses
 */

import { db } from "@workspace/db";
import {
  usersTable,
  userRecordsTable,
  coinTransactionsTable,
  franchiseMcaTeamsTable,
  franchiseProcessedGamesTable,
  gameLogTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { getOrCreateActiveSeason, PRIMARY_GUILD_ID } from "./db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "./payout-config.js";
import { listMcaFilesSafe, readMcaJson, mcaFileExists } from "./gcs-reader.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const MIN_COMPLETED_STATUS = 2;

const H2H_MILESTONES = [
  { tier: 4, wins: 50, bonus: 1000, label: "50 All-Time H2H Wins" },
  { tier: 3, wins: 25, bonus: 500,  label: "25 All-Time H2H Wins" },
  { tier: 2, wins: 12, bonus: 250,  label: "12 All-Time H2H Wins" },
  { tier: 1, wins:  5, bonus: 100,  label:  "5 All-Time H2H Wins" },
] as const;

// Mirrors franchise-processor.ts MCA_ALIASES exactly
const MCA_ALIASES: Record<string, string[]> = {
  "niners":               ["49ers", "san francisco 49ers"],
  "san francisco niners": ["san francisco 49ers", "49ers"],
  "rams":                 ["rams", "los angeles rams"],
  "g-men":                ["giants", "new york giants"],
  "new york g-men":       ["new york giants", "giants"],
  "big blue":             ["giants", "new york giants"],
  "pack":                 ["packers", "green bay packers"],
  "green bay pack":       ["green bay packers", "packers"],
  "vikes":                ["vikings", "minnesota vikings"],
  "minnesota vikes":      ["minnesota vikings", "vikings"],
  "bucs":                 ["buccaneers", "tampa bay buccaneers"],
  "tampa bay bucs":       ["tampa bay buccaneers", "buccaneers"],
  "aints":                ["saints", "new orleans saints"],
  "phins":                ["dolphins", "miami dolphins"],
  "miami phins":          ["miami dolphins", "dolphins"],
  "fins":                 ["dolphins", "miami dolphins"],
  "miami fins":           ["miami dolphins", "dolphins"],
  "pats":                 ["patriots", "new england patriots"],
  "new england pats":     ["new england patriots", "patriots"],
  "jags":                 ["jaguars", "jacksonville jaguars"],
  "jacksonville jags":    ["jacksonville jaguars", "jaguars"],
  "bolts":                ["chargers", "los angeles chargers"],
  "los angeles bolts":    ["los angeles chargers", "chargers"],
  "la bolts":             ["los angeles chargers", "chargers"],
  "sd bolts":             ["los angeles chargers", "chargers"],
  "silver and black":     ["raiders", "las vegas raiders"],
  "chiefs":               ["chiefs", "kansas city chiefs"],
  "bears":                ["bears", "chicago bears"],
  "lions":                ["lions", "detroit lions"],
  "falcons":              ["falcons", "atlanta falcons"],
  "panthers":             ["panthers", "carolina panthers"],
  "saints":               ["saints", "new orleans saints"],
  "seahawks":             ["seahawks", "seattle seahawks"],
  "cardinals":            ["cardinals", "arizona cardinals"],
  "cowboys":              ["cowboys", "dallas cowboys"],
  "eagles":               ["eagles", "philadelphia eagles"],
  "commanders":           ["commanders", "washington commanders"],
  "redskins":             ["commanders", "washington commanders"],
  "bengals":              ["bengals", "cincinnati bengals"],
  "ravens":               ["ravens", "baltimore ravens"],
  "browns":               ["browns", "cleveland browns"],
  "steelers":             ["steelers", "pittsburgh steelers"],
  "texans":               ["texans", "houston texans"],
  "colts":                ["colts", "indianapolis colts"],
  "titans":               ["titans", "tennessee titans"],
  "broncos":              ["broncos", "denver broncos"],
  "bills":                ["bills", "buffalo bills"],
  "jets":                 ["jets", "new york jets"],
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractList(data: any, ...keys: string[]): any[] {
  for (const k of keys) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return Array.isArray(data) ? data : [];
}

function getN(obj: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

/** Resolve a standard NFL team name like "Patriots" to its canonical lowercase form
 *  by checking if any MCA alias maps to it. Returns null if not resolvable. */
function resolveTeamToMcaNames(standardName: string): string[] {
  const lower = standardName.toLowerCase().trim();
  // Return the original + any alias expansions so we match both custom and standard names
  const names = new Set<string>([lower]);
  for (const [alias, targets] of Object.entries(MCA_ALIASES)) {
    if (targets.some(t => t.toLowerCase() === lower)) {
      names.add(alias.toLowerCase());
    }
    if (alias.toLowerCase() === lower) {
      targets.forEach(t => names.add(t.toLowerCase()));
    }
  }
  return [...names];
}

async function addBalance(discordId: string, amount: number) {
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, discordId));
}

async function logTx(discordId: string, amount: number, desc: string) {
  await db.insert(coinTransactionsTable).values({
    discordId, amount, type: "addcoins", description: desc, relatedUserId: null,
  });
}

async function upsertRecord(discordId: string, username: string, team: string | null, seasonId: number, won: boolean, pointSpread: number) {
  const existing = await db.select({ id: userRecordsTable.id })
    .from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, seasonId)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userRecordsTable).set({
      wins:              won  ? sql`${userRecordsTable.wins} + 1`   : userRecordsTable.wins,
      losses:            !won ? sql`${userRecordsTable.losses} + 1` : userRecordsTable.losses,
      pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointSpread}`,
      updatedAt: new Date(),
    }).where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, seasonId)));
  } else {
    await db.insert(userRecordsTable).values({
      discordId, discordUsername: username, team, seasonId,
      wins: won ? 1 : 0, losses: won ? 0 : 1, pointDifferential: pointSpread,
    });
  }
}

// ── Report type ────────────────────────────────────────────────────────────────

export interface FullSyncReport {
  // Phase 1
  autoLinked:    { discordId: string; discordUsername: string; team: string; method: string }[];
  stillUnlinked: { discordId: string; discordUsername: string }[];
  alreadyLinked: number;
  // Phase 2
  filesFound:        string[];
  allMcaFiles:       string[];   // every file under mca/ (for GCS diagnostics)
  gcsError?:         string;     // set if GCS connection itself failed
  gamesProcessed:    number;
  gamesDuplicate:    number;
  gamesCpuVsCpu:     number;
  gamesUnregistered: number;
  payoutLines:       string[];
  unregisteredLines: string[];
  // Phase 3 (standings fallback)
  standingsFallback: string[];
  // Phase 4 (milestones)
  milestoneLines:  string[];
  winBackfillLines: string[];   // users whose allTimeH2HWins was bumped from user_records
  // Errors
  errors: string[];
}

// ── Phase 1: Auto-link teams ───────────────────────────────────────────────────

export async function runTeamAutoLink(
  guildMembers: Map<string, { username: string; displayName: string }>,
  report: FullSyncReport,
) {
  const allUsers = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  }).from(usersTable);

  const mcaTeams = await db.select().from(franchiseMcaTeamsTable);

  // Build lookup: normalized fullName/nickName → mca row
  const mcaByNick = new Map<string, typeof mcaTeams[0]>();
  for (const t of mcaTeams) {
    if (t.isHuman) {
      mcaByNick.set(t.nickName.toLowerCase().trim(), t);
      mcaByNick.set(t.fullName.toLowerCase().trim(), t);
    }
  }

  // Build lookup: normalized MCA userName → mca row (for username matching)
  const mcaByUser = new Map<string, typeof mcaTeams[0]>();
  for (const t of mcaTeams) {
    if (t.isHuman && t.userName && t.userName !== "CPU") {
      mcaByUser.set(t.userName.toLowerCase().trim(), t);
    }
  }

  for (const user of allUsers) {
    if (user.team) {
      // ── User already has a team assigned ─────────────────────────────────
      // Find the matching MCA team and ensure discord_id is set
      const searchNames = resolveTeamToMcaNames(user.team);
      let matched: typeof mcaTeams[0] | undefined;
      for (const name of searchNames) {
        matched = mcaByNick.get(name);
        if (matched) break;
      }

      if (matched && !matched.discordId) {
        await db.update(franchiseMcaTeamsTable)
          .set({ discordId: user.discordId, updatedAt: new Date() })
          .where(and(
            eq(franchiseMcaTeamsTable.seasonId, matched.seasonId),
            eq(franchiseMcaTeamsTable.teamId,   matched.teamId),
          ));
        matched.discordId = user.discordId; // keep local cache fresh
        report.autoLinked.push({
          discordId: user.discordId,
          discordUsername: user.discordUsername,
          team: user.team,
          method: "discord→MCA team name match",
        });
      } else {
        report.alreadyLinked++;
      }
      continue;
    }

    // ── User has NO team — try to auto-detect ─────────────────────────────
    let foundMca: typeof mcaTeams[0] | undefined;
    let foundTeamName = "";
    let method = "";

    // 1. Exact Discord username vs MCA userName
    const lower = user.discordUsername.toLowerCase().trim();
    foundMca = mcaByUser.get(lower);
    if (foundMca) { method = "Discord username ↔ MCA userName (exact)"; }

    // 2. Guild display name vs MCA userName
    if (!foundMca) {
      const member = guildMembers.get(user.discordId);
      if (member) {
        foundMca = mcaByUser.get(member.displayName.toLowerCase().trim());
        if (foundMca) method = "Guild display name ↔ MCA userName";
      }
    }

    // 3. Partial Discord username contained in MCA userName (or vice versa)
    if (!foundMca) {
      for (const [mcaUsername, t] of mcaByUser) {
        if (mcaUsername.includes(lower) || lower.includes(mcaUsername)) {
          foundMca = t;
          method = "Partial username match";
          break;
        }
      }
    }

    if (foundMca) {
      // Use the nickName as the canonical team name if it's a standard NFL team,
      // otherwise use fullName
      foundTeamName = foundMca.nickName || foundMca.fullName;

      // Update economy_users.team
      await db.update(usersTable)
        .set({ team: foundTeamName, updatedAt: new Date() })
        .where(eq(usersTable.discordId, user.discordId));

      // Update franchise_mca_teams.discord_id
      if (!foundMca.discordId) {
        await db.update(franchiseMcaTeamsTable)
          .set({ discordId: user.discordId, updatedAt: new Date() })
          .where(and(
            eq(franchiseMcaTeamsTable.seasonId, foundMca.seasonId),
            eq(franchiseMcaTeamsTable.teamId,   foundMca.teamId),
          ));
      }

      report.autoLinked.push({
        discordId: user.discordId,
        discordUsername: user.discordUsername,
        team: foundTeamName,
        method,
      });
    } else {
      report.stillUnlinked.push({
        discordId: user.discordId,
        discordUsername: user.discordUsername,
      });
    }
  }
}

// ── Phase 2: Process stored GCS week-schedule files ───────────────────────────

export async function runGcsScheduleProcessing(
  seasonId: number,
  report: FullSyncReport,
) {
  // Refresh team map after Phase 1 linking
  const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, seasonId));
  const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

  if (teamMap.size === 0) {
    report.errors.push("No MCA team data found — skipping game processing. Export /leagueteams from MCA first.");
    return;
  }

  // Load processed game dedup set
  const allProcessed = await db.select({ gameId: franchiseProcessedGamesTable.gameId })
    .from(franchiseProcessedGamesTable);
  const processedSet = new Set(allProcessed.map(r => r.gameId));

  // Load payout amounts
  const h2hWin  = await getPayoutValue(PAYOUT_KEYS.H2H_WIN);
  const h2hLoss = await getPayoutValue(PAYOUT_KEYS.H2H_LOSS);
  const cpuWin  = await getPayoutValue(PAYOUT_KEYS.CPU_WIN);

  // ── Scan GCS — surface connectivity errors instead of silently returning [] ──
  const { files: allWeekFiles, error: gcsErr } = await listMcaFilesSafe("mca/week-");
  if (gcsErr) {
    report.gcsError = gcsErr;
    report.errors.push(`GCS connectivity error: ${gcsErr}`);
  }

  // Also enumerate the full mca/ directory so admins can see what exists
  const { files: allMcaFiles } = await listMcaFilesSafe("mca/");
  report.allMcaFiles.push(...allMcaFiles);

  const schedFiles = allWeekFiles.filter(f => f.endsWith("-schedules.json"));
  report.filesFound.push(...schedFiles);

  if (schedFiles.length === 0) {
    if (gcsErr) {
      report.errors.push("Skipping game payout processing — could not reach object storage.");
    } else if (allMcaFiles.length === 0) {
      report.errors.push("No MCA files found in storage at all. Has the MCA webhook sent any data yet?");
    } else {
      report.errors.push(
        `No week schedule files found (checked ${allWeekFiles.length} week-* files). ` +
        `${allMcaFiles.length} total MCA files exist: ${allMcaFiles.slice(0, 5).join(", ")}`,
      );
    }
    return;
  }

  // Load all economy_users for username/team lookup
  const allUsers = await db.select({
    discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team,
  }).from(usersTable);
  const userMap = new Map(allUsers.map(u => [u.discordId, u]));

  for (const file of schedFiles) {
    // Extract week number from filename like "mca/week-reg-5-schedules.json"
    const match = file.match(/week-(\w+)-(\d+)-schedules\.json$/);
    const weekNum = match ? parseInt(match[2]!, 10) : 0;
    if (!weekNum) continue;

    let body: unknown;
    try {
      body = await readMcaJson(file);
    } catch (err) {
      report.errors.push(`Failed to read ${file}: ${err}`);
      continue;
    }

    const games = extractList(body, "gameScheduleInfoList", "scheduleInfoList", "games");
    if (games.length === 0) continue;

    const seenKeys = new Set<string>();

    for (const g of games) {
      if (!g || typeof g !== "object") continue;
      if (Number(g.scheduleStatus ?? g.status ?? 0) < MIN_COMPLETED_STATUS) continue;

      const hId = Number(g.homeTeamId ?? -1);
      const aId = Number(g.awayTeamId ?? -1);
      if (hId < 0 || aId < 0) continue;

      const runKey = `${hId}-${aId}`;
      if (seenKeys.has(runKey)) { report.gamesDuplicate++; continue; }
      seenKeys.add(runKey);

      const homeScore = Number(g.homeScore ?? 0);
      const awayScore = Number(g.awayScore ?? 0);
      const rawId     = g.scheduleId ?? g.gameId ?? null;
      const gameId    = rawId != null
        ? String(rawId)
        : `s${seasonId}-w${weekNum}-h${hId}-a${aId}-${homeScore}-${awayScore}`;

      if (processedSet.has(gameId)) { report.gamesDuplicate++; continue; }

      const hData = teamMap.get(hId);
      const aData = teamMap.get(aId);
      if (!hData || !aData) continue;
      if (!hData.isHuman && !aData.isHuman) { report.gamesCpuVsCpu++; continue; }

      const homeIsHuman = hData.isHuman;
      const awayIsHuman = aData.isHuman;
      const status      = Number(g.scheduleStatus ?? g.status ?? 3);
      const bothHuman   = homeIsHuman && awayIsHuman;
      const isTrueH2H   = bothHuman && status === 3;
      const isForcedCPU = bothHuman && status === 2;
      const isTie       = homeScore === awayScore;
      const homeWon     = homeScore > awayScore;

      // Flag unregistered human teams
      if ((homeIsHuman && !hData.discordId) || (awayIsHuman && !aData.discordId)) {
        report.gamesUnregistered++;
        const unregTeams: string[] = [];
        if (homeIsHuman && !hData.discordId) unregTeams.push(`**${hData.fullName}** (MCA user: \`${hData.userName}\`)`);
        if (awayIsHuman && !aData.discordId) unregTeams.push(`**${aData.fullName}** (MCA user: \`${aData.userName}\`)`);
        report.unregisteredLines.push(`⚠️ ${unregTeams.join(" & ")} not linked — no payout`);
        continue;
      }

      // ── H2H game ──────────────────────────────────────────────────────────
      if (isTrueH2H && !isTie) {
        const winnerId   = homeWon ? hData.discordId! : aData.discordId!;
        const loserId    = homeWon ? aData.discordId! : hData.discordId!;
        const winnerTeam = homeWon ? hData.fullName   : aData.fullName;
        const loserTeam  = homeWon ? aData.fullName   : hData.fullName;
        const hiScore    = Math.max(homeScore, awayScore);
        const loScore    = Math.min(homeScore, awayScore);
        const spread     = hiScore - loScore;

        const winnerUser = userMap.get(winnerId);
        const loserUser  = userMap.get(loserId);

        await addBalance(winnerId, h2hWin);
        await logTx(winnerId, h2hWin, `H2H win vs ${loserTeam} Wk${weekNum} (${hiScore}–${loScore}) [sync]`);
        await addBalance(loserId, h2hLoss);
        await logTx(loserId, h2hLoss, `H2H loss vs ${winnerTeam} Wk${weekNum} (${loScore}–${hiScore}) [sync]`);

        await upsertRecord(winnerId, winnerUser?.discordUsername ?? "", winnerUser?.team ?? null, seasonId, true,  spread);
        await upsertRecord(loserId,  loserUser?.discordUsername  ?? "", loserUser?.team  ?? null, seasonId, false, -spread);

        await db.update(usersTable)
          .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins} + 1`,   updatedAt: new Date() })
          .where(eq(usersTable.discordId, winnerId));
        await db.update(usersTable)
          .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, loserId));

        await db.insert(gameLogTable).values([
          { discordId: winnerId, seasonId, result: "win",  pointSpread:  spread, opponentLabel: loserTeam,  gameType: "regular_season" },
          { discordId: loserId,  seasonId, result: "loss", pointSpread: -spread, opponentLabel: winnerTeam, gameType: "regular_season" },
        ]);

        report.payoutLines.push(`🏆 **${winnerTeam}** +${h2hWin} | **${loserTeam}** +${h2hLoss} (Wk${weekNum} ${hiScore}–${loScore})`);
        report.gamesProcessed++;

        await db.insert(franchiseProcessedGamesTable).values({
          gameId, payoutType: "h2h",
          winnerDiscordId: winnerId, loserDiscordId: loserId,
          winnerCoins: h2hWin, loserCoins: h2hLoss, appliedPointDiff: spread,
          seasonIdRef: seasonId, weekIndexRef: weekNum - 1,
          homeTeamRef: hData.fullName.toLowerCase(), awayTeamRef: aData.fullName.toLowerCase(),
        }).onConflictDoNothing();
        processedSet.add(gameId);

      } else if (isTrueH2H && isTie) {
        // Tie — no payout, just log
        await db.insert(gameLogTable).values([
          { discordId: hData.discordId!, seasonId, result: "loss", pointSpread: 0, opponentLabel: aData.fullName, gameType: "regular_season" },
          { discordId: aData.discordId!, seasonId, result: "loss", pointSpread: 0, opponentLabel: hData.fullName, gameType: "regular_season" },
        ]);
        await db.insert(franchiseProcessedGamesTable).values({
          gameId, payoutType: "h2h_tie",
          seasonIdRef: seasonId, weekIndexRef: weekNum - 1,
          homeTeamRef: hData.fullName.toLowerCase(), awayTeamRef: aData.fullName.toLowerCase(),
        }).onConflictDoNothing();
        processedSet.add(gameId);
        report.gamesProcessed++;

      } else {
        // CPU win (forced or human vs CPU)
        const humanData  = homeIsHuman ? hData : aData;
        const cpuData    = homeIsHuman ? aData : hData;
        const humanScore = homeIsHuman ? homeScore : awayScore;
        const cpuScore   = homeIsHuman ? awayScore : homeScore;
        const humanWon   = humanScore > cpuScore && !isTie;

        if (humanWon && humanData.discordId) {
          await addBalance(humanData.discordId, cpuWin);
          await logTx(humanData.discordId, cpuWin, `CPU win vs ${cpuData.fullName} Wk${weekNum} [sync]`);
          await db.insert(gameLogTable).values({
            discordId: humanData.discordId, seasonId, result: "win",
            pointSpread: humanScore - cpuScore, opponentLabel: `[CPU] ${cpuData.fullName}`, gameType: "regular_season",
          });
          report.payoutLines.push(`🤖 **${humanData.fullName}** +${cpuWin} (CPU win Wk${weekNum})`);
        } else if (humanData.discordId) {
          await db.insert(gameLogTable).values({
            discordId: humanData.discordId, seasonId, result: "loss",
            pointSpread: humanScore - cpuScore, opponentLabel: `[CPU] ${cpuData.fullName}`, gameType: "regular_season",
          });
        }

        if (humanData.discordId) {
          await db.insert(franchiseProcessedGamesTable).values({
            gameId, payoutType: humanWon ? "cpu" : "none",
            winnerDiscordId: humanWon ? humanData.discordId : null, loserDiscordId: null,
            winnerCoins: humanWon ? cpuWin : 0, loserCoins: 0,
            appliedPointDiff: Math.abs(humanScore - cpuScore),
            seasonIdRef: seasonId, weekIndexRef: weekNum - 1,
            homeTeamRef: hData.fullName.toLowerCase(), awayTeamRef: aData.fullName.toLowerCase(),
          }).onConflictDoNothing();
          processedSet.add(gameId);
          report.gamesProcessed++;
        }
      }
    }
  }
}

// ── Phase 3: Standings fallback ────────────────────────────────────────────────
// For teams with no processed games, read mca/standings.json and set season records.

export async function runStandingsFallback(seasonId: number, report: FullSyncReport) {
  const standingsExists = await mcaFileExists("mca/standings.json");
  if (!standingsExists) return;

  let body: unknown;
  try { body = await readMcaJson("mca/standings.json"); }
  catch { return; }

  const entries = extractList(body, "standingsInfoList", "teamStandingsInfoList", "standings");
  if (entries.length === 0) return;

  const mcaTeams = await db.select().from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, seasonId));
  const teamMap = new Map(mcaTeams.map(t => [t.teamId, t]));

  const allUsers = await db.select({
    discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team,
  }).from(usersTable);
  const userMap = new Map(allUsers.map(u => [u.discordId, u]));

  // Find users who still have 0 processed games this season
  const recordRows = await db.select({ discordId: userRecordsTable.discordId })
    .from(userRecordsTable).where(eq(userRecordsTable.seasonId, seasonId));
  const usersWithRecords = new Set(recordRows.map(r => r.discordId));

  for (const entry of entries) {
    const teamId = Number(entry?.teamId ?? entry?.teamIndex ?? -1);
    const teamData = teamMap.get(teamId);
    if (!teamData?.discordId || !teamData.isHuman) continue;
    if (usersWithRecords.has(teamData.discordId)) continue; // already has records from phase 2

    const wins   = getN(entry, "wins",   "totalWins",   "seasonWins");
    const losses = getN(entry, "losses", "totalLosses", "seasonLosses");
    if (wins === 0 && losses === 0) continue;

    const user = userMap.get(teamData.discordId);
    await db.insert(userRecordsTable).values({
      discordId: teamData.discordId,
      discordUsername: user?.discordUsername ?? "",
      team: user?.team ?? null,
      seasonId, wins, losses, pointDifferential: 0,
    }).onConflictDoNothing();

    // Bump all_time_h2h_wins by the standings win count
    await db.update(usersTable)
      .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins} + ${wins}`,   updatedAt: new Date() })
      .where(eq(usersTable.discordId, teamData.discordId));
    await db.update(usersTable)
      .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + ${losses}`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, teamData.discordId));

    report.standingsFallback.push(
      `📊 **${teamData.fullName}** — standings fallback: ${wins}W–${losses}L (Season ${seasonId})`
    );
    usersWithRecords.add(teamData.discordId);
  }
}

// ── Phase 4: Milestone sync ────────────────────────────────────────────────────
// Uses MAX(allTimeH2HWins, SUM(user_records.wins)) — same as /admin-syncmilestones.
// This ensures milestones are caught even when the MCA webhook never ran.

export async function runMilestoneSync(report: FullSyncReport) {
  const allUsers = await db.select({
    discordId:            usersTable.discordId,
    discordUsername:      usersTable.discordUsername,
    team:                 usersTable.team,
    trackedWins:          usersTable.allTimeH2HWins,
    milestoneTierAwarded: usersTable.milestoneTierAwarded,
  }).from(usersTable);

  // Sum wins across every season from user_records (the authoritative source
  // when MCA hasn't populated allTimeH2HWins directly)
  const recordTotals = await db.select({
    discordId: userRecordsTable.discordId,
    totalWins: sql<number>`COALESCE(SUM(${userRecordsTable.wins}), 0)`.as("total_wins"),
  }).from(userRecordsTable).groupBy(userRecordsTable.discordId);

  const totalsMap = new Map(recordTotals.map(r => [r.discordId, Number(r.totalWins)]));

  for (const user of allUsers) {
    const recordsWins = totalsMap.get(user.discordId) ?? 0;
    const trackedWins = user.trackedWins ?? 0;
    // Take the higher of the two — guards against stale or never-incremented field
    const trueWins    = Math.max(recordsWins, trackedWins);
    const currentTier = user.milestoneTierAwarded ?? 0;
    const teamLabel   = user.team ?? user.discordUsername;

    // Backfill allTimeH2HWins if user_records has a higher value
    if (trueWins > trackedWins) {
      await db.update(usersTable)
        .set({ allTimeH2HWins: trueWins, updatedAt: new Date() })
        .where(eq(usersTable.discordId, user.discordId));
      report.winBackfillLines.push(
        `🔧 **${teamLabel}** all-time wins: ${trackedWins} → **${trueWins}** (from season records)`,
      );
    }

    const owedMilestones = [...H2H_MILESTONES]
      .reverse() // ascending tier order: 1 → 4
      .filter(m => trueWins >= m.wins && currentTier < m.tier);

    if (owedMilestones.length === 0) continue;

    let newTier = currentTier;
    for (const m of owedMilestones) {
      await addBalance(user.discordId, m.bonus);
      await logTx(user.discordId, m.bonus, `Career milestone: ${m.label} (full sync)`);
      report.milestoneLines.push(`🎯 **${teamLabel}** — **${m.label}** → +${m.bonus} coins`);
      newTier = m.tier;
    }

    await db.update(usersTable)
      .set({ milestoneTierAwarded: newTier, updatedAt: new Date() })
      .where(eq(usersTable.discordId, user.discordId));
  }
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function runFullSync(
  guildMembers: Map<string, { username: string; displayName: string }>,
): Promise<FullSyncReport> {
  const report: FullSyncReport = {
    autoLinked:        [],
    stillUnlinked:     [],
    alreadyLinked:     0,
    filesFound:        [],
    allMcaFiles:       [],
    gamesProcessed:    0,
    gamesDuplicate:    0,
    gamesCpuVsCpu:     0,
    gamesUnregistered: 0,
    payoutLines:       [],
    unregisteredLines: [],
    standingsFallback: [],
    milestoneLines:    [],
    winBackfillLines:  [],
    errors:            [],
  };

  const season = await getOrCreateActiveSeason(PRIMARY_GUILD_ID);

  await runTeamAutoLink(guildMembers, report);
  await runGcsScheduleProcessing(season.id, report);
  await runStandingsFallback(season.id, report);
  await runMilestoneSync(report);

  return report;
}
