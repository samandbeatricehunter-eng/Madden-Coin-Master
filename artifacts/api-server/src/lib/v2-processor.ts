/**
 * v2 Madden-native data processor.
 * Reads MCA webhook payloads and writes into mca_* tables.
 * Zero Discord/guild references — everything keyed by eaLeagueId.
 */
import { db } from "@workspace/db";
import {
  mcaLeaguesTable,
  mcaSeasonsTable,
  mcaTeamsTable,
  mcaRostersTable,
  mcaTeamStatsTable,
  mcaSchedulesTable,
  mcaPlayerStatsTable,
  mcaWeekProcessedTable,
  mcaDraftPicksTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { invalidateRostersCache } from "./rosterCache.js";

export interface V2Result {
  ok: boolean;
  message: string;
}

// ── Season management ─────────────────────────────────────────────────────────

export async function getOrCreateV2Season(
  eaLeagueId: number,
  leagueName?: string,
  platform?: string,
): Promise<typeof mcaSeasonsTable.$inferSelect> {
  // Ensure league row exists
  await db
    .insert(mcaLeaguesTable)
    .values({
      eaLeagueId,
      leagueName: leagueName ?? "",
      platform:   platform  ?? "pc",
      updatedAt:  new Date(),
    })
    .onConflictDoUpdate({
      target: mcaLeaguesTable.eaLeagueId,
      set: {
        ...(leagueName ? { leagueName } : {}),
        ...(platform   ? { platform }   : {}),
        updatedAt: new Date(),
      },
    });

  // Get active season
  const [active] = await db
    .select()
    .from(mcaSeasonsTable)
    .where(and(eq(mcaSeasonsTable.eaLeagueId, eaLeagueId), eq(mcaSeasonsTable.isActive, true)))
    .orderBy(sql`${mcaSeasonsTable.seasonNumber} desc`)
    .limit(1);

  if (active) return active;

  // No active season — create season 1 (or next number)
  const [maxRow] = await db
    .select({ maxNum: sql<number>`coalesce(max(${mcaSeasonsTable.seasonNumber}), 0)` })
    .from(mcaSeasonsTable)
    .where(eq(mcaSeasonsTable.eaLeagueId, eaLeagueId));

  const nextNum = (maxRow?.maxNum ?? 0) + 1;

  const [created] = await db
    .insert(mcaSeasonsTable)
    .values({ eaLeagueId, seasonNumber: nextNum, isActive: true, currentWeek: "1" })
    .returning();

  return created!;
}

// ── Player extraction helpers ─────────────────────────────────────────────────

function extractPlayers(body: unknown): any[] {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  for (const key of [
    "rosterInfoList", "playerInfoList", "players", "roster",
    "leagueRosterInfoList", "teamRosterInfoList",
  ]) {
    if (Array.isArray(b[key])) return b[key] as any[];
  }
  // Fallback: largest array under any key
  let best: any[] = [];
  for (const v of Object.values(b)) {
    if (Array.isArray(v) && v.length > best.length) best = v;
  }
  return best;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function str(v: unknown, fallback = ""): string {
  return v != null ? String(v) : fallback;
}

function buildRosterRow(
  p: any,
  eaSeasonId: number,
  eaLeagueId: number,
  teamId: number,
  teamName: string,
): typeof mcaRostersTable.$inferInsert | null {
  const rawId = p.playerId ?? p.rosterId ?? p.playerIndex ?? p.id;
  const playerId = rawId != null ? num(rawId) : NaN;
  if (isNaN(playerId) || playerId <= 0) return null;

  // Collect all *Rating fields into attributes object
  const attributes: Record<string, number> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (k.endsWith("Rating") && v != null) {
      const n = Number(v);
      if (!isNaN(n)) attributes[k] = n;
    }
  }

  // Ability names
  const abilitiesRaw = p.signatureSlotList ?? p.abilities ?? null;
  const abilities = abilitiesRaw != null ? abilitiesRaw : null;

  // Dev trait: 0=Normal 1=Impact 2=Star 3=Superstar 4=X-Factor
  const devTrait = num(
    p.devTrait ?? p.traitDevelopment ?? p.developmentTrait ?? p.devLevel ?? 0,
  );

  return {
    eaSeasonId,
    eaLeagueId,
    teamId,
    teamName,
    playerId,
    firstName:         str(p.firstName  ?? p.fname ?? p.first_name),
    lastName:          str(p.lastName   ?? p.lname ?? p.last_name),
    position:          str(p.position   ?? p.pos ?? p.positionId),
    overall:           num(p.overall    ?? p.overallRating ?? p.playerBestOvr ?? p.ovr),
    devTrait,
    age:               p.age            != null ? num(p.age) : null,
    jerseyNum:         p.jerseyNum      != null ? num(p.jerseyNum ?? p.jersey) : null,
    contractYearsLeft: p.contractYearsLeft ?? p.yearsLeft ?? p.contractLength != null
      ? num(p.contractYearsLeft ?? p.yearsLeft ?? p.contractLength)
      : null,
    archetypeAbbrev:   p.archetype ?? p.archetypeAbbrev ?? p.playerArchetype ?? null,
    xpTotal:           p.experiencePoints ?? p.xpTotal ?? p.xp != null
      ? num(p.experiencePoints ?? p.xpTotal ?? p.xp)
      : null,
    attributes:  Object.keys(attributes).length > 0 ? attributes : null,
    abilities,
    portraitUrl: null,
    importedAt:  new Date(),
  };
}

// ── processV2LeagueTeams ──────────────────────────────────────────────────────

export async function processV2LeagueTeams(
  body: unknown,
  eaLeagueId: number,
  leagueName?: string,
  platform?: string,
): Promise<V2Result> {
  try {
    const season = await getOrCreateV2Season(eaLeagueId, leagueName, platform);

    const b = body as Record<string, unknown>;
    let rawTeams: any[] = [];
    for (const key of ["leagueTeamInfoList", "teamInfoList", "teams", "leagueTeams"]) {
      if (Array.isArray(b[key])) { rawTeams = b[key]; break; }
    }
    if (rawTeams.length === 0) {
      for (const v of Object.values(b)) {
        if (Array.isArray(v) && v.length > rawTeams.length) rawTeams = v as any[];
      }
    }

    if (rawTeams.length === 0) return { ok: true, message: "No teams in payload" };

    for (const t of rawTeams) {
      if (!t || typeof t !== "object") continue;
      const teamId = num(t.teamId ?? t.id ?? t.rosterId ?? -1);
      if (teamId <= 0) continue;

      await db
        .insert(mcaTeamsTable)
        .values({
          eaSeasonId:     season.id,
          eaLeagueId,
          teamId,
          fullName:       str(t.cityName ?? t.fullName ?? t.teamName ?? "") + (t.nickName ? ` ${t.nickName}` : ""),
          nickName:       str(t.nickName ?? t.teamName ?? ""),
          abbrName:       t.abbrName ?? t.teamAbbr ?? t.abbreviation ?? null,
          conference:     t.conferenceName ?? t.conference ?? null,
          divName:        t.divisionName ?? t.divName ?? null,
          userName:       str(t.userName ?? t.user ?? "CPU"),
          isHuman:        Boolean(t.isUserControlled ?? t.isHuman ?? false),
          offScheme:      t.offensiveScheme ?? t.offScheme ?? null,
          defScheme:      t.defensiveScheme ?? t.defScheme ?? null,
          ovrRating:      t.ovrRating ?? t.teamOvr ?? null,
          primaryColor:   t.primaryColor ?? null,
          secondaryColor: t.secondaryColor ?? null,
          logoId:         t.logoId ?? t.teamLogoId ?? null,
          updatedAt:      new Date(),
        })
        .onConflictDoUpdate({
          target: [mcaTeamsTable.eaSeasonId, mcaTeamsTable.teamId],
          set: {
            fullName:       str(t.cityName ?? t.fullName ?? t.teamName ?? "") + (t.nickName ? ` ${t.nickName}` : ""),
            nickName:       str(t.nickName ?? t.teamName ?? ""),
            abbrName:       t.abbrName ?? t.teamAbbr ?? t.abbreviation ?? null,
            conference:     t.conferenceName ?? t.conference ?? null,
            divName:        t.divisionName ?? t.divName ?? null,
            userName:       str(t.userName ?? t.user ?? "CPU"),
            isHuman:        Boolean(t.isUserControlled ?? t.isHuman ?? false),
            offScheme:      t.offensiveScheme ?? t.offScheme ?? null,
            defScheme:      t.defensiveScheme ?? t.defScheme ?? null,
            ovrRating:      t.ovrRating ?? t.teamOvr ?? null,
            primaryColor:   t.primaryColor ?? null,
            secondaryColor: t.secondaryColor ?? null,
            logoId:         t.logoId ?? t.teamLogoId ?? null,
            updatedAt:      new Date(),
          },
        });
    }

    return { ok: true, message: `${rawTeams.length} teams upserted for league ${eaLeagueId}` };
  } catch (err) {
    console.error("[v2/leagueteams]", err);
    return { ok: false, message: String(err) };
  }
}

// ── processV2Roster ───────────────────────────────────────────────────────────

const V2_FA_TEAM_ID = 999;

export async function processV2Roster(
  body: unknown,
  mcaTeamId: number,
  eaLeagueId: number,
): Promise<V2Result> {
  try {
    const season = await getOrCreateV2Season(eaLeagueId);
    const rawPlayers = extractPlayers(body);
    if (rawPlayers.length === 0) return { ok: true, message: `No players in payload for team ${mcaTeamId}` };

    // Get team name from mcaTeams
    const [teamRow] = await db
      .select({ fullName: mcaTeamsTable.fullName })
      .from(mcaTeamsTable)
      .where(and(eq(mcaTeamsTable.eaSeasonId, season.id), eq(mcaTeamsTable.teamId, mcaTeamId)))
      .limit(1);
    const teamName = teamRow?.fullName ?? `Team ${mcaTeamId}`;

    const ACTIVE_ROS_TYPE = 0;
    const rows: (typeof mcaRostersTable.$inferInsert)[] = [];

    for (const p of rawPlayers) {
      if (!p || typeof p !== "object") continue;
      if (p.isOnPracticeSquad === true || p.isOnIR === true) continue;
      const rosType = p.rosType ?? p.rosterType ?? p.rostStatus ?? null;
      if (rosType != null && Number(rosType) !== ACTIVE_ROS_TYPE) continue;

      const row = buildRosterRow(p, season.id, eaLeagueId, mcaTeamId, teamName);
      if (row) rows.push(row);
    }

    if (rows.length === 0) return { ok: true, message: `No active players for team ${mcaTeamId}` };

    // Preserve portrait URLs across delete+reinsert
    const existing = await db
      .select({ playerId: mcaRostersTable.playerId, portraitUrl: mcaRostersTable.portraitUrl })
      .from(mcaRostersTable)
      .where(and(eq(mcaRostersTable.eaSeasonId, season.id), eq(mcaRostersTable.teamId, mcaTeamId)));
    const portraitMap = new Map(
      existing.filter(r => r.portraitUrl != null).map(r => [r.playerId, r.portraitUrl as string]),
    );

    await db.delete(mcaRostersTable).where(
      and(eq(mcaRostersTable.eaSeasonId, season.id), eq(mcaRostersTable.teamId, mcaTeamId)),
    );
    await db.insert(mcaRostersTable).values(
      rows.map(r => ({ ...r, portraitUrl: portraitMap.get(r.playerId!) ?? null })),
    );

    invalidateRostersCache(season.id);
    return { ok: true, message: `${rows.length} players imported for team ${mcaTeamId}` };
  } catch (err) {
    console.error(`[v2/roster/team/${mcaTeamId}]`, err);
    return { ok: false, message: String(err) };
  }
}

// ── processV2FreeAgents ───────────────────────────────────────────────────────

export async function processV2FreeAgents(body: unknown, eaLeagueId: number): Promise<V2Result> {
  try {
    const season = await getOrCreateV2Season(eaLeagueId);
    const rawPlayers = extractPlayers(body);
    if (rawPlayers.length === 0) return { ok: true, message: "Free agent payload empty" };

    const rows: (typeof mcaRostersTable.$inferInsert)[] = [];
    for (const p of rawPlayers) {
      if (!p || typeof p !== "object") continue;
      const row = buildRosterRow(p, season.id, eaLeagueId, V2_FA_TEAM_ID, "Free Agents");
      if (row) rows.push(row);
    }
    if (rows.length === 0) return { ok: true, message: "No valid free agents" };

    await db.delete(mcaRostersTable).where(
      and(eq(mcaRostersTable.eaSeasonId, season.id), eq(mcaRostersTable.teamId, V2_FA_TEAM_ID)),
    );
    await db.insert(mcaRostersTable).values(rows);

    invalidateRostersCache(season.id);
    return { ok: true, message: `${rows.length} free agents imported` };
  } catch (err) {
    console.error("[v2/freeagents]", err);
    return { ok: false, message: String(err) };
  }
}

// ── processV2Standings ────────────────────────────────────────────────────────

export async function processV2Standings(body: unknown, eaLeagueId: number): Promise<V2Result> {
  try {
    const season = await getOrCreateV2Season(eaLeagueId);
    const b = body as Record<string, unknown>;

    let rawTeams: any[] = [];
    for (const key of ["teamStandingInfoList", "standings", "teamStandings", "standingInfoList"]) {
      if (Array.isArray(b[key])) { rawTeams = b[key]; break; }
    }
    if (rawTeams.length === 0) {
      for (const v of Object.values(b)) {
        if (Array.isArray(v) && v.length > rawTeams.length) rawTeams = v as any[];
      }
    }
    if (rawTeams.length === 0) return { ok: true, message: "No standings data in payload" };

    for (const t of rawTeams) {
      if (!t || typeof t !== "object") continue;
      const teamId = num(t.teamId ?? t.rosterId ?? -1);
      if (teamId <= 0) continue;

      const wins   = num(t.wins   ?? t.totalWins    ?? 0);
      const losses = num(t.losses ?? t.totalLosses  ?? 0);
      const ties   = num(t.ties   ?? t.totalTies    ?? 0);
      const total  = wins + losses + ties;

      await db
        .insert(mcaTeamStatsTable)
        .values({
          eaSeasonId:    season.id,
          eaLeagueId,
          teamId,
          teamName:      str(t.teamName ?? t.cityName ?? t.nickName ?? ""),
          wins,
          losses,
          ties,
          ptsFor:        num(t.ptsFor    ?? t.pointsFor     ?? t.pts    ?? 0),
          ptsAgainst:    num(t.ptsAgainst ?? t.pointsAgainst ?? t.ptsA  ?? 0),
          offYds:        num(t.offTotalYds ?? t.offYds ?? t.totalOffensiveYards ?? 0),
          offPassYds:    num(t.offPassYds  ?? t.passOffensiveYards ?? 0),
          offRushYds:    num(t.offRushYds  ?? t.rushOffensiveYards ?? 0),
          offTDs:        num(t.offTDs      ?? t.tds ?? 0),
          offPtsPerGame: total > 0 ? num(t.offPtsPerGame ?? t.ptsFor ?? 0) / (total > 0 ? total : 1) : 0,
          defPassYds:    num(t.defPassYds  ?? t.passDefensiveYards ?? 0),
          defRushYds:    num(t.defRushYds  ?? t.rushDefensiveYards ?? 0),
          defTDs:        num(t.defTDs      ?? t.ptsAgainst ?? 0),
          teamSacks:     num(t.sacks       ?? t.defSacks   ?? 0),
          teamInts:      num(t.interceptions ?? t.defInts  ?? 0),
          offRedZonePct: num(t.offRedZonePct ?? t.redZoneAttempts ?? 0),
          defRedZonePct: num(t.defRedZonePct ?? 0),
          turnoverDiff:  num(t.toPlusMinus  ?? t.turnoverDiff ?? 0),
          homeWins:      num(t.homeWins  ?? 0),
          homeLosses:    num(t.homeLosses ?? 0),
          awayWins:      num(t.awayWins   ?? 0),
          awayLosses:    num(t.awayLosses ?? 0),
          confWins:      num(t.confWins   ?? t.divisionWins   ?? 0),
          confLosses:    num(t.confLosses ?? t.divisionLosses ?? 0),
          divWins:       num(t.divWins    ?? 0),
          divLosses:     num(t.divLosses  ?? 0),
          seed:          t.seed           ?? t.conferenceRank   ?? null,
          rank:          t.rank           ?? t.overallRank      ?? null,
          playoffStatus: t.playoffStatus  ?? t.clinchStatus     ?? null,
          winPct:        total > 0 ? (wins + ties * 0.5) / total : 0,
          netPts:        num(t.netPts ?? (t.ptsFor ?? 0) - (t.ptsAgainst ?? 0), 0),
          updatedAt:     new Date(),
        })
        .onConflictDoUpdate({
          target: [mcaTeamStatsTable.eaSeasonId, mcaTeamStatsTable.teamId],
          set: {
            wins, losses, ties,
            ptsFor:     num(t.ptsFor    ?? 0),
            ptsAgainst: num(t.ptsAgainst ?? 0),
            offYds:     num(t.offTotalYds ?? t.offYds ?? 0),
            offPassYds: num(t.offPassYds  ?? 0),
            offRushYds: num(t.offRushYds  ?? 0),
            defPassYds: num(t.defPassYds  ?? 0),
            defRushYds: num(t.defRushYds  ?? 0),
            teamSacks:  num(t.sacks ?? t.defSacks ?? 0),
            teamInts:   num(t.interceptions ?? t.defInts ?? 0),
            seed:       t.seed ?? t.conferenceRank ?? null,
            rank:       t.rank ?? t.overallRank    ?? null,
            playoffStatus: t.playoffStatus ?? null,
            winPct:     total > 0 ? (wins + ties * 0.5) / total : 0,
            netPts:     num(t.netPts ?? (t.ptsFor ?? 0) - (t.ptsAgainst ?? 0), 0),
            updatedAt:  new Date(),
          },
        });
    }

    return { ok: true, message: `Standings upserted for ${rawTeams.length} teams` };
  } catch (err) {
    console.error("[v2/standings]", err);
    return { ok: false, message: String(err) };
  }
}

// ── processV2Schedules ────────────────────────────────────────────────────────

export async function processV2Schedules(
  body: unknown,
  eaLeagueId: number,
  weekNum?: number,
  weekType = "reg",
): Promise<V2Result> {
  try {
    const season = await getOrCreateV2Season(eaLeagueId);
    const b = body as Record<string, unknown>;

    let rawGames: any[] = [];
    for (const key of [
      "scheduleInfoList", "gameScheduleInfoList", "games",
      "weeklyScheduleInfoList", "schedules",
    ]) {
      if (Array.isArray(b[key])) { rawGames = b[key]; break; }
    }
    if (rawGames.length === 0) {
      for (const v of Object.values(b)) {
        if (Array.isArray(v) && v.length > rawGames.length) rawGames = v as any[];
      }
    }
    if (rawGames.length === 0) return { ok: true, message: "No schedule data in payload" };

    // Get team name map
    const teams = await db
      .select({ teamId: mcaTeamsTable.teamId, fullName: mcaTeamsTable.fullName })
      .from(mcaTeamsTable)
      .where(eq(mcaTeamsTable.eaSeasonId, season.id));
    const teamNameMap = new Map(teams.map(t => [t.teamId, t.fullName]));

    let upserted = 0;
    for (const g of rawGames) {
      if (!g || typeof g !== "object") continue;

      const homeTeamId = num(g.homeTeamId ?? g.homeRosterId ?? -1);
      const awayTeamId = num(g.awayTeamId ?? g.awayRosterId ?? -1);
      if (homeTeamId <= 0 || awayTeamId <= 0) continue;

      const wi = weekNum != null
        ? weekNum - 1
        : num(g.weekIndex ?? g.week ?? (g.weekNum != null ? g.weekNum - 1 : 0));

      const wt = weekType ?? str(g.weekType ?? g.seasonType ?? "reg").toLowerCase();

      const homeScore: number | null = g.homeScore != null ? num(g.homeScore) : null;
      const awayScore: number | null = g.awayScore != null ? num(g.awayScore) : null;
      const status = num(g.status ?? (homeScore != null ? 2 : 0));

      await db
        .insert(mcaSchedulesTable)
        .values({
          eaSeasonId:   season.id,
          eaLeagueId,
          weekIndex:    wi,
          weekType:     wt,
          homeTeamId,
          awayTeamId,
          homeTeamName: teamNameMap.get(homeTeamId) ?? str(g.homeTeamName ?? ""),
          awayTeamName: teamNameMap.get(awayTeamId) ?? str(g.awayTeamName ?? ""),
          homeScore,
          awayScore,
          status,
        })
        .onConflictDoUpdate({
          target: [
            mcaSchedulesTable.eaSeasonId,
            mcaSchedulesTable.weekIndex,
            mcaSchedulesTable.homeTeamId,
            mcaSchedulesTable.awayTeamId,
          ],
          set: { homeScore, awayScore, status },
        });
      upserted++;
    }

    return { ok: true, message: `${upserted} schedule games upserted` };
  } catch (err) {
    console.error("[v2/schedules]", err);
    return { ok: false, message: String(err) };
  }
}

// ── processV2PlayerWeekStats ──────────────────────────────────────────────────

const STAT_TYPE_MAP: Record<string, string[]> = {
  passing:    ["passingStatInfoList", "passing", "passStatInfoList"],
  rushing:    ["rushingStatInfoList", "rushing", "rushStatInfoList"],
  receiving:  ["receivingStatInfoList", "receiving", "recStatInfoList"],
  defense:    ["defensiveStatInfoList", "defense", "defStatInfoList", "defenseStatInfoList"],
  kicking:    ["kickingStatInfoList",   "kicking",  "kickStatInfoList"],
  punting:    ["puntingStatInfoList",   "punting",  "puntStatInfoList"],
  kickreturn: ["kickReturnStatInfoList","kickreturn"],
  puntreturn: ["puntReturnStatInfoList","puntreturn"],
};

function extractStatPlayers(body: unknown, statType: string): any[] {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const keys = STAT_TYPE_MAP[statType] ?? [];
  for (const k of keys) {
    if (Array.isArray(b[k])) return b[k] as any[];
  }
  for (const v of Object.values(b)) {
    if (Array.isArray(v) && (v as any[]).length > 0) return v as any[];
  }
  return [];
}

export async function processV2PlayerWeekStats(
  body: unknown,
  statType: string,
  weekType: string,
  weekNum: number,
  eaLeagueId: number,
): Promise<V2Result> {
  try {
    const season = await getOrCreateV2Season(eaLeagueId);

    // Dedup guard — skip if already processed
    const existing = await db
      .select()
      .from(mcaWeekProcessedTable)
      .where(and(
        eq(mcaWeekProcessedTable.eaSeasonId, season.id),
        eq(mcaWeekProcessedTable.weekType,   weekType),
        eq(mcaWeekProcessedTable.weekNum,    weekNum),
        eq(mcaWeekProcessedTable.statType,   statType),
      ))
      .limit(1);

    if (existing.length > 0) {
      return { ok: true, message: `Already processed ${statType} week ${weekNum} — skipped` };
    }

    const rawPlayers = extractStatPlayers(body, statType);
    if (rawPlayers.length === 0) return { ok: true, message: `No ${statType} stats in payload` };

    for (const p of rawPlayers) {
      if (!p || typeof p !== "object") continue;
      const playerId = num(p.rosterId ?? p.playerId ?? -1);
      const teamId   = num(p.teamId   ?? p.rosterId ?? -1);
      if (playerId <= 0) continue;

      const delta = buildStatDelta(p, statType);

      await db
        .insert(mcaPlayerStatsTable)
        .values({
          eaSeasonId: season.id,
          eaLeagueId,
          playerId,
          teamId:     teamId > 0 ? teamId : playerId,
          teamName:   str(p.teamName ?? ""),
          firstName:  str(p.firstName ?? p.fname ?? ""),
          lastName:   str(p.lastName  ?? p.lname ?? ""),
          position:   str(p.position  ?? p.pos   ?? ""),
          ...delta,
          updatedAt:  new Date(),
        })
        .onConflictDoUpdate({
          target: [mcaPlayerStatsTable.eaSeasonId, mcaPlayerStatsTable.playerId, mcaPlayerStatsTable.teamId],
          set: addDeltaSet(delta),
        });
    }

    // Mark week processed
    await db.insert(mcaWeekProcessedTable)
      .values({ eaSeasonId: season.id, weekType, weekNum, statType })
      .onConflictDoNothing();

    return { ok: true, message: `${rawPlayers.length} ${statType} stats accumulated for week ${weekNum}` };
  } catch (err) {
    console.error(`[v2/stats/${statType}/week${weekNum}]`, err);
    return { ok: false, message: String(err) };
  }
}

function buildStatDelta(p: any, statType: string): Partial<typeof mcaPlayerStatsTable.$inferInsert> {
  switch (statType) {
    case "passing":   return { passYds: num(p.passYds ?? p.passingYards ?? 0), passTDs: num(p.passTDs ?? p.passingTouchdowns ?? 0), passAtt: num(p.passAtt ?? p.passingAttempts ?? 0), passComp: num(p.passComp ?? p.passingCompletions ?? 0), passInts: num(p.passInts ?? p.passingInterceptions ?? 0) };
    case "rushing":   return { rushYds: num(p.rushYds ?? p.rushingYards ?? 0), rushTDs: num(p.rushTDs ?? p.rushingTouchdowns ?? 0), rushAtt: num(p.rushAtt ?? p.rushingAttempts ?? 0) };
    case "receiving": return { recYds: num(p.recYds ?? p.receivingYards ?? 0), recTDs: num(p.recTDs ?? p.receivingTouchdowns ?? 0), recRec: num(p.recCatches ?? p.receptions ?? 0) };
    case "defense":   return { sacks: num(p.defSacks ?? p.sacks ?? 0), defInts: num(p.defInts ?? p.interceptions ?? 0), totalTackles: num(p.totalTackles ?? p.tackles ?? 0), defTDs: num(p.defTDs ?? p.defensiveTouchdowns ?? 0) };
    case "kicking":   return { fgMade: num(p.fGMade ?? p.fgMade ?? p.fieldGoalsMade ?? 0), fgAtt: num(p.fGAtt ?? p.fgAtt ?? p.fieldGoalsAttempted ?? 0) };
    default:          return {};
  }
}

function addDeltaSet(delta: Partial<typeof mcaPlayerStatsTable.$inferInsert>): Record<string, any> {
  const set: Record<string, any> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(delta)) {
    if (v == null) continue;
    if (k === "sacks") {
      set[k] = sql`${mcaPlayerStatsTable[k as keyof typeof mcaPlayerStatsTable]} + ${v}`;
    } else if (typeof v === "number") {
      set[k] = sql`${mcaPlayerStatsTable[k as keyof typeof mcaPlayerStatsTable]} + ${v}`;
    }
  }
  return set;
}

// ── processV2DraftPicks ───────────────────────────────────────────────────────

export async function processV2DraftPicks(body: unknown, eaLeagueId: number): Promise<V2Result> {
  try {
    const season = await getOrCreateV2Season(eaLeagueId);
    const b = body as Record<string, unknown>;

    let rawPicks: any[] = [];
    for (const key of ["draftPickInfoList", "draftPicks", "picks", "leagueDraftPickList"]) {
      if (Array.isArray(b[key])) { rawPicks = b[key]; break; }
    }
    if (rawPicks.length === 0) {
      for (const v of Object.values(b)) {
        if (Array.isArray(v) && v.length > rawPicks.length) rawPicks = v as any[];
      }
    }
    if (rawPicks.length === 0) return { ok: true, message: "No draft picks in payload" };

    // Get team names
    const teams = await db
      .select({ teamId: mcaTeamsTable.teamId, fullName: mcaTeamsTable.fullName })
      .from(mcaTeamsTable)
      .where(eq(mcaTeamsTable.eaSeasonId, season.id));
    const teamNameMap = new Map(teams.map(t => [t.teamId, t.fullName]));

    const rows: (typeof mcaDraftPicksTable.$inferInsert)[] = [];
    for (const p of rawPicks) {
      if (!p || typeof p !== "object") continue;
      const teamId    = num(p.teamId ?? p.currentTeamId ?? -1);
      const draftYear = num(p.draftYear ?? p.year ?? 0);
      const round     = num(p.round ?? p.roundNum ?? 0);
      if (teamId <= 0 || !draftYear || !round) continue;

      const originalTeamId = (() => {
        const raw = p.originalTeamId ?? p.origTeamId ?? null;
        if (raw == null) return null;
        const n = num(raw);
        return n > 0 && n !== teamId ? n : null;
      })();

      rows.push({
        eaSeasonId:       season.id,
        eaLeagueId,
        teamId,
        teamName:         teamNameMap.get(teamId) ?? str(p.teamName ?? ""),
        draftYear,
        round,
        pickNum:          num(p.pickNum ?? p.normalizedPickNumber ?? 0),
        originalTeamId,
        originalTeamName: originalTeamId ? (teamNameMap.get(originalTeamId) ?? null) : null,
        importedAt:       new Date(),
      });
    }

    if (rows.length === 0) return { ok: true, message: "No valid picks parsed" };

    await db.delete(mcaDraftPicksTable).where(eq(mcaDraftPicksTable.eaSeasonId, season.id));
    await db.insert(mcaDraftPicksTable).values(rows);

    return { ok: true, message: `${rows.length} draft picks imported` };
  } catch (err) {
    console.error("[v2/draftpicks]", err);
    return { ok: false, message: String(err) };
  }
}

// ── setV2CurrentWeek ──────────────────────────────────────────────────────────

export async function setV2CurrentWeek(
  eaLeagueId: number,
  currentWeek: string,
): Promise<V2Result> {
  try {
    const season = await getOrCreateV2Season(eaLeagueId);
    await db
      .update(mcaSeasonsTable)
      .set({ currentWeek, updatedAt: new Date() })
      .where(eq(mcaSeasonsTable.id, season.id));
    return { ok: true, message: `Current week set to ${currentWeek}` };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}
