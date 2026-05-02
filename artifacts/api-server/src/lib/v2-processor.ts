/**
 * v2 Madden-native data processor.
 * Reads MCA webhook payloads and writes into mca_* tables.
 * Zero Discord/guild references — everything keyed by eaLeagueId.
 *
 * Season handling: EA embeds `seasonIndex` (0-based) in every payload item.
 * We extract it and use `seasonNumber = seasonIndex + 1` to find or create
 * the correct season, preventing different franchise years from mixing.
 *
 * Every record is stored with its full `rawJson` so no MCA field is ever lost.
 */
import { db } from "@workspace/db";
import {
  mcaLeaguesTable,
  mcaSeasonsTable,
  mcaTeamsTable,
  mcaRostersTable,
  mcaTeamStatsTable,
  mcaTeamWeekStatsTable,
  mcaSchedulesTable,
  mcaPlayerStatsTable,
  mcaPlayerWeekStatsTable,
  mcaWeekProcessedTable,
  mcaDraftPicksTable,
  appUsersTable,
  appUserLeagueLinksTable,
} from "@workspace/db";
import { eq, and, desc, sql, inArray, ne } from "drizzle-orm";
import { invalidateRostersCache } from "./rosterCache.js";
import { logger } from "./logger.js";

export interface V2Result {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

// ── Type-safe field extraction helpers ───────────────────────────────────────

function getN(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== "") {
      const n = Number(v);
      if (!isNaN(n)) return n;
    }
  }
  return 0;
}

function getStr(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== "") return String(v);
  }
  return "";
}

function extractList(body: unknown, ...keys: string[]): Record<string, unknown>[] {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const b = body as Record<string, unknown>;
  for (const k of keys) {
    const v = b[k];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

/**
 * Extract seasonIndex (0-based) from an MCA payload.
 * EA embeds it at the payload level or on each item.
 */
function extractSeasonIndex(
  body: unknown,
  items: Record<string, unknown>[],
): number | undefined {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const k of ["seasonIndex","leagueSeasonIndex","cfmSeasonIndex","season","seasonNum"]) {
      if (b[k] != null) return Number(b[k]);
    }
  }
  if (items.length > 0) {
    const first = items[0];
    for (const k of ["seasonIndex","leagueSeasonIndex","cfmSeasonIndex"]) {
      if (first[k] != null) return Number(first[k]);
    }
  }
  return undefined;
}

// ── Roster position lookup (numeric → string) ─────────────────────────────────
const POS_NUM: Record<number, string> = {
  0:"QB",1:"HB",2:"FB",3:"WR",4:"TE",5:"LT",6:"LG",7:"C",8:"RG",9:"RT",
  10:"LE",11:"RE",12:"DT",13:"LOLB",14:"MLB",15:"ROLB",16:"CB",17:"FS",18:"SS",
  19:"K",20:"P",21:"KR",22:"PR",23:"LS",
};

// ── Known wrapper keys for roster payloads ────────────────────────────────────
const ROSTER_LIST_KEYS = [
  "rosterInfoList","playerArray","teamRosterInfoList","activeRosterInfoList",
  "playerInfoList","rosters","players","rosterArray","teamPlayerInfoList",
  "playerRosterInfoList",
];

// ── Known wrapper keys for player stat payloads, keyed by statType ────────────
export type WeekStatType =
  | "passing" | "rushing" | "receiving" | "defense"
  | "kicking" | "punting" | "kickreturn" | "kickreturning"
  | "puntreturn" | "puntreturning";

const STAT_LIST_KEYS: Record<string, string[]> = {
  passing:       ["playerPassingStatInfoList","playerPassStatInfoList","playerPassingStatsInfoList","passingStats","playerStatInfoList"],
  rushing:       ["playerRushingStatInfoList","playerRushStatInfoList","playerRushingStatsInfoList","rushingStats","playerStatInfoList"],
  receiving:     ["playerReceivingStatInfoList","playerRecStatInfoList","playerReceivingStatsInfoList","receivingStats","playerStatInfoList"],
  defense:       [
    "playerDefensiveStatInfoList","playerDefenseStatInfoList","playerDefStatInfoList",
    "playerDefensiveStatsInfoList","playerDefenceStatInfoList","playerDefenseStatsInfoList",
    "playerDefenciveStatInfoList","defensiveStatInfoList","defenseStatInfoList",
    "defStatInfoList","playerStatInfoList",
  ],
  kicking:       ["playerKickingStatInfoList","playerKickStatInfoList","kickingStatInfoList","kickingStats","playerStatInfoList"],
  punting:       ["playerPuntingStatInfoList","playerPuntStatInfoList","puntingStatInfoList","puntingStats","playerStatInfoList"],
  kickreturn:    ["playerKickReturnStatInfoList","kickReturnStatInfoList","krStatInfoList","kickReturnStats","playerStatInfoList"],
  kickreturning: ["playerKickReturnStatInfoList","kickReturnStatInfoList","krStatInfoList","kickReturnStats","playerStatInfoList"],
  puntreturn:    ["playerPuntReturnStatInfoList","puntReturnStatInfoList","prStatInfoList","puntReturnStats","playerStatInfoList"],
  puntreturning: ["playerPuntReturnStatInfoList","puntReturnStatInfoList","prStatInfoList","puntReturnStats","playerStatInfoList"],
};

// ── Season management ─────────────────────────────────────────────────────────

/**
 * Find or create the season matching the given seasonIndex (0-based from EA).
 * If no seasonIndex is provided, falls back to the active season for the league.
 * Activates the target season and deactivates others when switching years.
 */
export async function getOrCreateV2Season(
  eaLeagueId: number,
  seasonIndex?: number,
  leagueName?: string,
  platform?: string,
): Promise<typeof mcaSeasonsTable.$inferSelect> {
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

  if (seasonIndex !== undefined) {
    const targetNumber = seasonIndex + 1;         // convert EA 0-based → 1-based

    const [existing] = await db
      .select()
      .from(mcaSeasonsTable)
      .where(and(
        eq(mcaSeasonsTable.eaLeagueId,   eaLeagueId),
        eq(mcaSeasonsTable.seasonNumber, targetNumber),
      ))
      .limit(1);

    if (existing) {
      if (!existing.isActive) {
        await db.update(mcaSeasonsTable)
          .set({ isActive: false })
          .where(and(eq(mcaSeasonsTable.eaLeagueId, eaLeagueId), eq(mcaSeasonsTable.isActive, true)));
        const [updated] = await db.update(mcaSeasonsTable)
          .set({ isActive: true, updatedAt: new Date() })
          .where(eq(mcaSeasonsTable.id, existing.id))
          .returning();
        return updated!;
      }
      return existing;
    }

    // Create the season for this index, deactivate others first
    await db.update(mcaSeasonsTable)
      .set({ isActive: false })
      .where(and(eq(mcaSeasonsTable.eaLeagueId, eaLeagueId), eq(mcaSeasonsTable.isActive, true)));

    const [created] = await db
      .insert(mcaSeasonsTable)
      .values({ eaLeagueId, seasonNumber: targetNumber, isActive: true, currentWeek: "1" })
      .returning();
    return created!;
  }

  // No seasonIndex — use active season or create the first one
  const [active] = await db
    .select()
    .from(mcaSeasonsTable)
    .where(and(eq(mcaSeasonsTable.eaLeagueId, eaLeagueId), eq(mcaSeasonsTable.isActive, true)))
    .orderBy(desc(mcaSeasonsTable.seasonNumber))
    .limit(1);

  if (active) return active;

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

export async function setV2CurrentWeek(eaLeagueId: number, currentWeek: string): Promise<V2Result> {
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

// ── Gamertag auto-link ────────────────────────────────────────────────────────

async function autoLinkGamertag(
  userName: string,
  eaLeagueId: number,
  teamId: number,
  teamName: string,
): Promise<void> {
  if (!userName || userName === "CPU") return;
  const gt = userName.toLowerCase().trim();
  const user = await db
    .select({ gamertag: appUsersTable.gamertag })
    .from(appUsersTable)
    .where(eq(appUsersTable.gamertag, gt))
    .limit(1);
  if (user.length === 0) return;
  await db
    .insert(appUserLeagueLinksTable)
    .values({ gamertag: gt, eaLeagueId, teamId, teamName, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [appUserLeagueLinksTable.gamertag, appUserLeagueLinksTable.eaLeagueId],
      set: { teamId, teamName, updatedAt: new Date() },
    });
}

// ── processV2LeagueTeams ──────────────────────────────────────────────────────

export async function processV2LeagueTeams(
  body: unknown,
  eaLeagueId: number,
  leagueName?: string,
  platform?: string,
): Promise<V2Result> {
  try {
    const rawTeams = extractList(body, "leagueTeamInfoList", "teamInfoList", "teams", "leagueTeams");
    const seasonIndex = extractSeasonIndex(body, rawTeams);
    const season = await getOrCreateV2Season(eaLeagueId, seasonIndex, leagueName, platform);

    if (rawTeams.length === 0) {
      logger.warn(`[v2/leagueteams/${eaLeagueId}] No teams found`);
      return { ok: true, message: "No teams in payload" };
    }

    const linkOps: Promise<void>[] = [];

    for (const t of rawTeams) {
      const teamId = getN(t, "teamId", "id", "rosterId");
      if (!teamId) continue;

      const cityName = getStr(t, "cityName");
      const nickName = getStr(t, "nickName", "teamName");
      const fullName = cityName && nickName ? `${cityName} ${nickName}` : nickName || cityName || `Team ${teamId}`;
      const userName = getStr(t, "userName", "user");
      const isHuman  = Boolean(t["isUserControlled"] ?? t["isHuman"] ?? false);

      await db
        .insert(mcaTeamsTable)
        .values({
          eaSeasonId:     season.id,
          eaLeagueId,
          teamId,
          fullName,
          nickName,
          abbrName:       getStr(t, "abbrName", "teamAbbr") || null,
          conference:     getStr(t, "conferenceName", "conference") || null,
          divName:        getStr(t, "divisionName", "divName") || null,
          userName,
          isHuman,
          offScheme:      getStr(t, "offensiveScheme", "offScheme") || null,
          defScheme:      getStr(t, "defensiveScheme",  "defScheme") || null,
          ovrRating:      t["ovrRating"]   != null ? getN(t, "ovrRating", "teamOvr")   : null,
          primaryColor:   t["primaryColor"]   != null ? getN(t, "primaryColor")   : null,
          secondaryColor: t["secondaryColor"] != null ? getN(t, "secondaryColor") : null,
          logoId:         (t["logoId"] ?? t["teamLogoId"]) != null ? getN(t, "logoId", "teamLogoId") : null,
          rawJson:        t,
          updatedAt:      new Date(),
        })
        .onConflictDoUpdate({
          target: [mcaTeamsTable.eaSeasonId, mcaTeamsTable.teamId],
          set: {
            fullName, nickName,
            abbrName:       getStr(t, "abbrName", "teamAbbr") || null,
            conference:     getStr(t, "conferenceName", "conference") || null,
            divName:        getStr(t, "divisionName", "divName") || null,
            userName, isHuman,
            offScheme:      getStr(t, "offensiveScheme", "offScheme") || null,
            defScheme:      getStr(t, "defensiveScheme",  "defScheme") || null,
            ovrRating:      t["ovrRating"] != null ? getN(t, "ovrRating", "teamOvr") : null,
            rawJson:        t,
            updatedAt:      new Date(),
          },
        });

      if (userName && userName !== "CPU") {
        linkOps.push(autoLinkGamertag(userName, eaLeagueId, teamId, fullName));
      }
    }

    await Promise.allSettled(linkOps);
    return { ok: true, message: `${rawTeams.length} teams upserted for league ${eaLeagueId} (season ${season.seasonNumber})` };
  } catch (err) {
    logger.error({ err }, "[v2/leagueteams]");
    return { ok: false, message: String(err) };
  }
}

// ── Roster helpers ────────────────────────────────────────────────────────────

function resolvePosition(p: Record<string, unknown>): string {
  const raw = p["position"] ?? p["pos"] ?? p["positionId"] ?? "";
  if (typeof raw === "number") return POS_NUM[raw] ?? String(raw);
  return String(raw).trim().toUpperCase();
}

function resolveContractYearsLeft(p: Record<string, unknown>): number | null {
  if (p["contractYearsLeft"] != null) return Number(p["contractYearsLeft"]);
  if (p["yearsLeft"]         != null) return Number(p["yearsLeft"]);
  if (p["contractLeft"]      != null) return Number(p["contractLeft"]);
  const len = p["contractLength"] ?? p["contractLen"] ?? null;
  const yr  = p["contractYear"]   ?? p["contractYr"]  ?? null;
  if (len != null && yr != null) return Math.max(0, Number(len) - Number(yr) + 1);
  return null;
}

interface PlayerAbilities { zone?: string; superstar?: string[] }

function resolveAbilities(p: Record<string, unknown>): PlayerAbilities | null {
  const slotList = p["signatureSlotList"];
  if (Array.isArray(slotList) && slotList.length > 0) {
    const slots = slotList as Record<string, unknown>[];
    const zone       = slots.find(s => s["isZoneAbility"] === true);
    const superstars = slots.filter(s => s["isZoneAbility"] !== true);
    const result: PlayerAbilities = {};
    if (zone)               result.zone      = getStr(zone, "signatureTitle", "title", "name");
    if (superstars.length > 0) result.superstar = superstars.map(s => getStr(s, "signatureTitle", "title", "name")).filter(Boolean);
    return Object.keys(result).length > 0 ? result : null;
  }
  return null;
}

const SKIP_ATTRS = new Set([
  "playerId","rosterId","playerIndex","id","firstName","lastName",
  "position","pos","positionId","playerBestOvr","overallRating","overallRatings",
  "overall","ovr","bestOverall","playerSkillRating","devTrait","devTraitId",
  "playerDevTrait","age","jerseyNum","jersey","uniformNumber",
  "contractYearsLeft","yearsLeft","contractLeft","contractLength","contractLen",
  "contractYear","contractYr","archetype","archetypeAbbrev","playerArchetype",
  "experiencePoints","xpTotal","xp","teamId","teamName","signatureSlotList",
  "abilities","seasonIndex","leagueSeasonIndex","stageIndex",
]);

function buildRosterRow(
  p: Record<string, unknown>,
  eaSeasonId: number,
  eaLeagueId: number,
  teamId: number,
  teamName: string,
): typeof mcaRostersTable.$inferInsert | null {
  const playerId = getN(p, "playerId", "rosterId", "playerIndex", "id");
  if (!playerId) return null;

  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v == null || SKIP_ATTRS.has(k)) continue;
    if (Array.isArray(v) || (typeof v === "object" && v !== null)) continue;
    attributes[k] = v;
  }

  return {
    eaSeasonId,
    eaLeagueId,
    teamId,
    teamName,
    playerId,
    firstName:         getStr(p, "firstName", "fname", "first_name"),
    lastName:          getStr(p, "lastName",  "lname", "last_name"),
    position:          resolvePosition(p),
    overall:           Math.max(0, Math.min(99, getN(p, "playerBestOvr","overallRating","overallRatings","overall","ovr","bestOverall","playerSkillRating"))),
    devTrait:          getN(p, "devTrait","devTraitId","playerDevTrait"),
    age:               p["age"]       != null ? getN(p, "age")       : null,
    jerseyNum:         p["jerseyNum"] != null ? getN(p, "jerseyNum","jersey","uniformNumber") : null,
    contractYearsLeft: resolveContractYearsLeft(p),
    archetypeAbbrev:   getStr(p, "archetype","archetypeAbbrev","playerArchetype") || null,
    xpTotal:           p["experiencePoints"] != null ? getN(p, "experiencePoints","xpTotal","xp") : null,
    attributes:        Object.keys(attributes).length > 0 ? attributes : null,
    abilities:         resolveAbilities(p),
    rawJson:           p,
    portraitUrl:       null,
    importedAt:        new Date(),
  };
}

// ── processV2Roster ───────────────────────────────────────────────────────────

const V2_FA_TEAM_ID = 999;

export async function processV2Roster(
  body: unknown,
  mcaTeamId: number,
  eaLeagueId: number,
): Promise<V2Result> {
  try {
    const rawPlayers = extractList(body, ...ROSTER_LIST_KEYS);
    const seasonIndex = extractSeasonIndex(body, rawPlayers);
    const season      = await getOrCreateV2Season(eaLeagueId, seasonIndex);

    if (rawPlayers.length === 0) {
      return { ok: true, message: `No players in payload for team ${mcaTeamId}` };
    }

    const [teamRow] = await db
      .select({ fullName: mcaTeamsTable.fullName })
      .from(mcaTeamsTable)
      .where(and(eq(mcaTeamsTable.eaSeasonId, season.id), eq(mcaTeamsTable.teamId, mcaTeamId)))
      .limit(1);
    const teamName = teamRow?.fullName ?? `Team ${mcaTeamId}`;

    // Store ALL players — including practice squad and IR
    const rows: (typeof mcaRostersTable.$inferInsert)[] = [];
    for (const p of rawPlayers) {
      const row = buildRosterRow(p, season.id, eaLeagueId, mcaTeamId, teamName);
      if (row) rows.push(row);
    }
    if (rows.length === 0) return { ok: true, message: `No valid players for team ${mcaTeamId}` };

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

    invalidateRostersCache(season.id, "v2");
    return { ok: true, message: `${rows.length} players imported for team ${mcaTeamId} (season ${season.seasonNumber})` };
  } catch (err) {
    logger.error({ err }, `[v2/roster/team/${mcaTeamId}]`);
    return { ok: false, message: String(err) };
  }
}

export async function processV2FreeAgents(body: unknown, eaLeagueId: number): Promise<V2Result> {
  try {
    const rawPlayers = extractList(body, ...ROSTER_LIST_KEYS);
    const seasonIndex = extractSeasonIndex(body, rawPlayers);
    const season      = await getOrCreateV2Season(eaLeagueId, seasonIndex);

    if (rawPlayers.length === 0) return { ok: true, message: "Free agent payload empty" };

    const rows: (typeof mcaRostersTable.$inferInsert)[] = [];
    for (const p of rawPlayers) {
      const row = buildRosterRow(p, season.id, eaLeagueId, V2_FA_TEAM_ID, "Free Agents");
      if (row) rows.push(row);
    }
    if (rows.length === 0) return { ok: true, message: "No valid free agents" };

    await db.delete(mcaRostersTable).where(
      and(eq(mcaRostersTable.eaSeasonId, season.id), eq(mcaRostersTable.teamId, V2_FA_TEAM_ID)),
    );
    await db.insert(mcaRostersTable).values(rows);
    invalidateRostersCache(season.id, "v2");
    return { ok: true, message: `${rows.length} free agents imported (season ${season.seasonNumber})` };
  } catch (err) {
    logger.error({ err }, "[v2/freeagents]");
    return { ok: false, message: String(err) };
  }
}

// ── processV2Standings ────────────────────────────────────────────────────────

export async function processV2Standings(body: unknown, eaLeagueId: number): Promise<V2Result> {
  try {
    const rawTeams = extractList(body, "teamStandingInfoList","standings","teamStandings","standingInfoList");
    const seasonIndex = extractSeasonIndex(body, rawTeams);
    const season      = await getOrCreateV2Season(eaLeagueId, seasonIndex);

    if (rawTeams.length === 0) {
      logger.warn(`[v2/standings/${eaLeagueId}] No standings data found`);
      return { ok: true, message: "No standings data in payload" };
    }

    const ops: Promise<unknown>[] = [];
    for (const t of rawTeams) {
      const teamId = getN(t, "teamId", "rosterId");
      if (!teamId) continue;

      const wins         = getN(t, "wins",   "totalWins",   "seasonWins");
      const losses       = getN(t, "losses", "totalLosses", "seasonLosses");
      const ties         = getN(t, "ties",   "totalTies",   "seasonTies");
      const total        = wins + losses + ties;
      const ptsFor       = getN(t, "ptsFor",     "pointsFor",     "pts");
      const ptsAgainst   = getN(t, "ptsAgainst", "pointsAgainst", "ptsA");
      const offPassYds   = getN(t, "offPassYds","offensivePassYards","passYds","passingYards");
      const offRushYds   = getN(t, "offRushYds","offensiveRushYards","rushYds","rushingYards");
      const offYds       = offPassYds + offRushYds > 0 ? offPassYds + offRushYds : getN(t, "offTotalYds","totalOffYards","offYards","totalOffensiveYards");
      const defPassYds   = getN(t, "defPassYds","defPassYards","passingYardsAllowed","defPassingYards");
      const defRushYds   = getN(t, "defRushYds","defRushYards","rushingYardsAllowed","defRushingYards");
      const teamSacks    = getN(t, "defSacks","totalSacks","sacks","teamSacks");
      const teamInts     = getN(t, "defInterceptions","totalInts","ints","teamInts");
      const defFumblesRec = getN(t, "defFumblesRec","fumblesRecovered","fumRec");
      const tOTakeaways  = getN(t, "tOTakeaways","defTurnovers","takeaways");
      const tOGiveaways  = getN(t, "tOGiveaways","offTurnovers","giveaways");
      const turnoverDiff = (() => {
        const d = getN(t, "tODiff","turnOverDiff","turnoverDiff","toDiff","tOMargin");
        if (d !== 0) return d;
        if (tOTakeaways !== 0 || tOGiveaways !== 0) return tOTakeaways - tOGiveaways;
        return 0;
      })();
      const offRedZonePct = getN(t, "offRedZonePct","offensiveRedZonePct","redZonePct","offRZPct");
      const defRedZonePct = getN(t, "defRedZonePct","defensiveRedZonePct","defRedZoneAllowedPct","defRZPct");
      const seed          = t["seed"] != null ? getN(t, "seed","conferenceRank") : null;
      const rank          = t["rank"] != null ? getN(t, "rank","overallRank")    : null;
      const playoffStatus = getStr(t, "playoffStatus","clinchStatus") || null;
      const winPct        = total > 0 ? (wins + ties * 0.5) / total : 0;
      const netPts        = ptsFor - ptsAgainst;
      const teamName      = getStr(t, "teamName","cityName","nickName");

      ops.push(
        db.insert(mcaTeamStatsTable)
          .values({
            eaSeasonId: season.id, eaLeagueId, teamId, teamName,
            wins, losses, ties, ptsFor, ptsAgainst,
            offYds, offPassYds, offRushYds,
            offTDs:     getN(t, "offTDs","tds"),
            offPtsPerGame: total > 0 ? ptsFor / total : 0,
            defPassYds, defRushYds,
            defTDs:     getN(t, "defTDs","ptsAgainst"),
            teamSacks, teamInts, defFumblesRec, offRedZonePct, defRedZonePct,
            tOTakeaways, tOGiveaways, turnoverDiff,
            homeWins:   getN(t, "homeWins"),   homeLosses: getN(t, "homeLosses"),
            awayWins:   getN(t, "awayWins"),   awayLosses: getN(t, "awayLosses"),
            confWins:   getN(t, "confWins","divisionWins"),   confLosses: getN(t, "confLosses","divisionLosses"),
            divWins:    getN(t, "divWins"),    divLosses:  getN(t, "divLosses"),
            seed, rank, playoffStatus, winPct, netPts, rawJson: t, updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [mcaTeamStatsTable.eaSeasonId, mcaTeamStatsTable.teamId],
            set: {
              wins, losses, ties, ptsFor, ptsAgainst,
              homeWins: getN(t, "homeWins"), homeLosses: getN(t, "homeLosses"),
              awayWins: getN(t, "awayWins"), awayLosses: getN(t, "awayLosses"),
              confWins: getN(t, "confWins","divisionWins"), confLosses: getN(t, "confLosses","divisionLosses"),
              divWins:  getN(t, "divWins"), divLosses:  getN(t, "divLosses"),
              seed, rank, playoffStatus, winPct, netPts, rawJson: t, updatedAt: new Date(),
            },
          }),
      );
    }
    await Promise.all(ops);
    return { ok: true, message: `Standings upserted for ${rawTeams.length} teams (season ${season.seasonNumber})` };
  } catch (err) {
    logger.error({ err }, "[v2/standings]");
    return { ok: false, message: String(err) };
  }
}

// ── processV2TeamWeekStats ────────────────────────────────────────────────────

export async function processV2TeamWeekStats(
  body: unknown,
  weekType: string,
  weekNum: number,
  eaLeagueId: number,
): Promise<V2Result> {
  if (weekType === "pre") {
    return { ok: true, message: `Preseason Week ${weekNum} team stats — skipped` };
  }
  try {
    const rawStats = extractList(body, "teamStatInfoList","teamStatsInfoList","teamStats");
    const seasonIndex = extractSeasonIndex(body, rawStats);
    const season      = await getOrCreateV2Season(eaLeagueId, seasonIndex);

    if (rawStats.length === 0) {
      logger.warn(`[v2/week${weekNum}/team/${eaLeagueId}] No team stats in payload`);
      return { ok: true, message: "No team stats in payload" };
    }

    const teams = await db
      .select({ teamId: mcaTeamsTable.teamId, fullName: mcaTeamsTable.fullName })
      .from(mcaTeamsTable)
      .where(eq(mcaTeamsTable.eaSeasonId, season.id));
    const teamNameMap = new Map(teams.map(t => [t.teamId, t.fullName]));

    type TeamWeekRow = typeof mcaTeamWeekStatsTable.$inferInsert;
    const weekRows: TeamWeekRow[] = [];
    let upserted = 0;

    for (const t of rawStats) {
      const teamId     = getN(t, "teamId", "teamIndex");
      if (!teamId) continue;

      const offPassYds    = getN(t, "offPassYds","offensivePassYards","passYds","passingYards");
      const offRushYds    = getN(t, "offRushYds","offensiveRushYards","rushYds","rushingYards");
      const offYds        = offPassYds + offRushYds > 0 ? offPassYds + offRushYds : getN(t, "offTotalYds","totalOffYards","offYards");
      const defPassYds    = getN(t, "defPassYds","defPassYards","passingYardsAllowed");
      const defRushYds    = getN(t, "defRushYds","defRushYards","rushingYardsAllowed");
      const teamSacks     = getN(t, "defSacks","totalSacks","sacks","teamSacks");
      const teamInts      = getN(t, "defInterceptions","totalInts","ints","teamInts");
      const defFumblesRec = getN(t, "defFumblesRec","fumblesRecovered","fumRec");
      const tOTakeaways   = getN(t, "tOTakeaways","defTurnovers","takeaways");
      const tOGiveaways   = getN(t, "tOGiveaways","offTurnovers","giveaways");
      const turnoverDiff  = (() => {
        const d = getN(t, "tODiff","turnOverDiff","turnoverDiff","toDiff","tOMargin");
        if (d !== 0) return d;
        if (tOTakeaways !== 0 || tOGiveaways !== 0) return tOTakeaways - tOGiveaways;
        return 0;
      })();
      const teamName = teamNameMap.get(teamId) ?? getStr(t, "teamName","cityName");

      weekRows.push({
        eaSeasonId: season.id, eaLeagueId, weekType, weekNum, teamId, teamName,
        offPassYds, offRushYds, offYds,
        offTDs:      getN(t, "ptsFor","ptsScored","pointsFor"),
        defPassYds, defRushYds,
        defTDs:      getN(t, "ptsAgainst","pointsAgainst"),
        teamSacks, teamInts, defFumblesRec, turnoverDiff, tOTakeaways, tOGiveaways,
        rawJson: t, processedAt: new Date(),
      });
      upserted++;
    }

    await db.transaction(async (tx) => {
      // 1. Upsert all week rows (idempotent replace on re-import)
      await Promise.all(weekRows.map(row =>
        tx.insert(mcaTeamWeekStatsTable)
          .values(row)
          .onConflictDoUpdate({
            target: [mcaTeamWeekStatsTable.eaSeasonId, mcaTeamWeekStatsTable.weekType, mcaTeamWeekStatsTable.weekNum, mcaTeamWeekStatsTable.teamId],
            set: { offPassYds: row.offPassYds, offRushYds: row.offRushYds, offYds: row.offYds, offTDs: row.offTDs, defPassYds: row.defPassYds, defRushYds: row.defRushYds, defTDs: row.defTDs, teamSacks: row.teamSacks, teamInts: row.teamInts, defFumblesRec: row.defFumblesRec, turnoverDiff: row.turnoverDiff, tOTakeaways: row.tOTakeaways, tOGiveaways: row.tOGiveaways, rawJson: row.rawJson, processedAt: row.processedAt },
          })
      ));

      // 2. Re-aggregate season yardage/turnover stats from ALL week rows (fully idempotent)
      const W = mcaTeamWeekStatsTable;
      const teamSums = await tx
        .select({
          teamId:        W.teamId,
          offPassYds:    sql<number>`CAST(SUM(${W.offPassYds}) AS INT)`,
          offRushYds:    sql<number>`CAST(SUM(${W.offRushYds}) AS INT)`,
          offYds:        sql<number>`CAST(SUM(${W.offYds}) AS INT)`,
          offTDs:        sql<number>`CAST(SUM(${W.offTDs}) AS INT)`,
          defPassYds:    sql<number>`CAST(SUM(${W.defPassYds}) AS INT)`,
          defRushYds:    sql<number>`CAST(SUM(${W.defRushYds}) AS INT)`,
          defTDs:        sql<number>`CAST(SUM(${W.defTDs}) AS INT)`,
          teamSacks:     sql<number>`CAST(SUM(${W.teamSacks}) AS INT)`,
          teamInts:      sql<number>`CAST(SUM(${W.teamInts}) AS INT)`,
          defFumblesRec: sql<number>`CAST(SUM(${W.defFumblesRec}) AS INT)`,
          tOTakeaways:   sql<number>`CAST(SUM(${W.tOTakeaways}) AS INT)`,
          tOGiveaways:   sql<number>`CAST(SUM(${W.tOGiveaways}) AS INT)`,
          turnoverDiff:  sql<number>`CAST(SUM(${W.turnoverDiff}) AS INT)`,
        })
        .from(W)
        .where(and(eq(W.eaSeasonId, season.id), ne(W.weekType, "pre")))
        .groupBy(W.teamId);

      // 3. Upsert yardage/turnover columns only — wins/losses come from processV2Standings
      await Promise.all(teamSums.map(ts => {
        const tn = teamNameMap.get(ts.teamId) ?? "";
        return tx.insert(mcaTeamStatsTable)
          .values({
            eaSeasonId: season.id, eaLeagueId, teamId: ts.teamId, teamName: tn,
            wins: 0, losses: 0, ties: 0, ptsFor: 0, ptsAgainst: 0,
            offYds: ts.offYds ?? 0, offPassYds: ts.offPassYds ?? 0, offRushYds: ts.offRushYds ?? 0,
            offTDs: ts.offTDs ?? 0, offPtsPerGame: 0,
            defPassYds: ts.defPassYds ?? 0, defRushYds: ts.defRushYds ?? 0, defTDs: ts.defTDs ?? 0,
            teamSacks: ts.teamSacks ?? 0, teamInts: ts.teamInts ?? 0, defFumblesRec: ts.defFumblesRec ?? 0,
            offRedZonePct: 0, defRedZonePct: 0,
            tOTakeaways: ts.tOTakeaways ?? 0, tOGiveaways: ts.tOGiveaways ?? 0, turnoverDiff: ts.turnoverDiff ?? 0,
            winPct: 0, netPts: 0, updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [mcaTeamStatsTable.eaSeasonId, mcaTeamStatsTable.teamId],
            set: {
              offYds: ts.offYds ?? 0, offPassYds: ts.offPassYds ?? 0, offRushYds: ts.offRushYds ?? 0,
              offTDs: ts.offTDs ?? 0,
              defPassYds: ts.defPassYds ?? 0, defRushYds: ts.defRushYds ?? 0, defTDs: ts.defTDs ?? 0,
              teamSacks: ts.teamSacks ?? 0, teamInts: ts.teamInts ?? 0, defFumblesRec: ts.defFumblesRec ?? 0,
              tOTakeaways: ts.tOTakeaways ?? 0, tOGiveaways: ts.tOGiveaways ?? 0, turnoverDiff: ts.turnoverDiff ?? 0,
              updatedAt: new Date(),
            },
          });
      }));
    });

    return { ok: true, message: `${upserted} team week stats recorded for week ${weekNum}` };
  } catch (err) {
    logger.error({ err }, `[v2/week${weekNum}/team/${eaLeagueId}]`);
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
    const rawGames = extractList(body, "scheduleInfoList","gameScheduleInfoList","games","weeklyScheduleInfoList","schedules");
    const seasonIndex = extractSeasonIndex(body, rawGames);
    const season      = await getOrCreateV2Season(eaLeagueId, seasonIndex);

    if (rawGames.length === 0) {
      logger.warn(`[v2/schedules/${eaLeagueId}] No schedule data found`);
      return { ok: true, message: "No schedule data in payload" };
    }

    const teams = await db
      .select({ teamId: mcaTeamsTable.teamId, fullName: mcaTeamsTable.fullName })
      .from(mcaTeamsTable)
      .where(eq(mcaTeamsTable.eaSeasonId, season.id));
    const teamNameMap = new Map(teams.map(t => [t.teamId, t.fullName]));

    const ops: Promise<unknown>[] = [];
    let upserted = 0;

    for (const g of rawGames) {
      const homeTeamId = getN(g, "homeTeamId", "homeRosterId");
      const awayTeamId = getN(g, "awayTeamId", "awayRosterId");
      if (!homeTeamId || !awayTeamId) continue;

      const wi = weekNum != null
        ? weekNum - 1
        : getN(g, "weekIndex", "week") || (getN(g, "weekNum") - 1);
      const wt = weekType || getStr(g, "weekType","seasonType","stageType").toLowerCase() || "reg";
      const homeScore: number | null = g["homeScore"] != null ? getN(g, "homeScore") : null;
      const awayScore: number | null = g["awayScore"] != null ? getN(g, "awayScore") : null;
      const status = getN(g, "status") || (homeScore != null ? 2 : 0);

      ops.push(
        db.insert(mcaSchedulesTable)
          .values({
            eaSeasonId: season.id, eaLeagueId, weekIndex: wi, weekType: wt,
            homeTeamId, awayTeamId,
            homeTeamName: teamNameMap.get(homeTeamId) ?? getStr(g, "homeTeamName"),
            awayTeamName: teamNameMap.get(awayTeamId) ?? getStr(g, "awayTeamName"),
            homeScore, awayScore, status, rawJson: g,
          })
          .onConflictDoUpdate({
            target: [mcaSchedulesTable.eaSeasonId, mcaSchedulesTable.weekIndex, mcaSchedulesTable.homeTeamId, mcaSchedulesTable.awayTeamId],
            set: { homeScore, awayScore, status, rawJson: g },
          }),
      );
      upserted++;
    }
    await Promise.all(ops);
    return { ok: true, message: `${upserted} schedule games upserted (season ${season.seasonNumber})` };
  } catch (err) {
    logger.error({ err }, "[v2/schedules]");
    return { ok: false, message: String(err) };
  }
}

// ── processV2PlayerWeekStats ──────────────────────────────────────────────────

export async function processV2PlayerWeekStats(
  body: unknown,
  statType: WeekStatType,
  weekType: string,
  weekNum: number,
  eaLeagueId: number,
): Promise<V2Result> {
  if (weekType === "pre") {
    return { ok: true, message: `Preseason Week ${weekNum} ${statType} — skipped` };
  }
  try {
    const listKeys = STAT_LIST_KEYS[statType] ?? ["playerStatInfoList"];
    const players  = extractList(body, ...listKeys);
    const seasonIndex = extractSeasonIndex(body, players);
    const season   = await getOrCreateV2Season(eaLeagueId, seasonIndex);

    if (players.length === 0) {
      const topKeys = body && typeof body === "object" ? Object.keys(body as object).join(", ") : "";
      logger.warn(`[v2/week${weekNum}/${statType}/${eaLeagueId}] No records. Tried: [${listKeys.join(",")}]. Keys: ${topKeys}`);
      return { ok: true, message: `No ${statType} records — tried: ${listKeys.join(", ")}` };
    }

    if (Number((players[0] as Record<string, unknown>)["stageIndex"] ?? -1) === 0) {
      return { ok: true, message: `Preseason Week ${weekNum} ${statType} — rejected (stageIndex=0)` };
    }

    const [rosterRows, priorStatRows, mcaTeams] = await Promise.all([
      db.select({ playerId: mcaRostersTable.playerId, firstName: mcaRostersTable.firstName, lastName: mcaRostersTable.lastName, position: mcaRostersTable.position })
        .from(mcaRostersTable).where(eq(mcaRostersTable.eaSeasonId, season.id)),
      db.select({ playerId: mcaPlayerStatsTable.playerId, firstName: mcaPlayerStatsTable.firstName, lastName: mcaPlayerStatsTable.lastName, position: mcaPlayerStatsTable.position })
        .from(mcaPlayerStatsTable).where(eq(mcaPlayerStatsTable.eaSeasonId, season.id)),
      db.select({ teamId: mcaTeamsTable.teamId, fullName: mcaTeamsTable.fullName })
        .from(mcaTeamsTable).where(eq(mcaTeamsTable.eaSeasonId, season.id)),
    ]);

    const rosterMap   = new Map(rosterRows.map(r => [r.playerId, r]));
    const priorMap    = new Map(priorStatRows.map(r => [r.playerId, r]));
    const teamNameMap = new Map(mcaTeams.map(t => [t.teamId, t.fullName]));

    type WeekRow   = typeof mcaPlayerWeekStatsTable.$inferInsert;
    type SeasonRow = typeof mcaPlayerStatsTable.$inferInsert;

    const weekRows: { row: WeekRow; conflictSet: Partial<WeekRow> }[] = [];
    const seasonExtra = new Map<number, Partial<SeasonRow>>();
    const playerMeta  = new Map<number, { teamId: number; teamName: string; firstName: string; lastName: string; position: string }>();
    let upserted = 0;

    for (const p of players) {
      const playerId  = getN(p, "rosterId","playerId","rosterid","playerid");
      if (!playerId) continue;

      const teamId   = getN(p, "teamId","teamid");
      const teamName = teamNameMap.get(teamId) ?? getStr(p, "teamName","teamname");
      const roster   = rosterMap.get(playerId);
      const prior    = !roster ? priorMap.get(playerId) : undefined;
      const firstName = roster?.firstName ?? prior?.firstName ?? getStr(p, "firstName","firstname","first_name","playerFirstName");
      const lastName  = roster?.lastName  ?? prior?.lastName  ?? getStr(p, "lastName","lastname","last_name","playerLastName");
      const position  = roster?.position  ?? prior?.position  ?? getStr(p, "position","pos","playerPosition");

      if (!firstName && !lastName) {
        logger.warn(`[v2/week${weekNum}/${statType}] Player ${playerId} (team ${teamName}) not in roster`);
      }

      const { weekFields, seasonInsert } = buildStatFields(p, statType);

      weekRows.push({
        row: {
          eaSeasonId: season.id, eaLeagueId, weekType, weekNum, statType,
          playerId, teamId, teamName, firstName, lastName, position,
          rawJson: p, processedAt: new Date(),
          ...weekFields,
        },
        conflictSet: { teamId, teamName, ...weekFields, rawJson: p, processedAt: new Date() },
      });

      seasonExtra.set(playerId, { ...seasonInsert, teamName, firstName, lastName, position });
      playerMeta.set(playerId, { teamId, teamName, firstName, lastName, position });
      upserted++;
    }

    if (upserted === 0) {
      return { ok: true, message: `No valid ${statType} rows for week ${weekNum}` };
    }

    const playerIds = [...playerMeta.keys()];

    await db.transaction(async (tx) => {
      // 1. Upsert all week rows (idempotent replace on re-import)
      await Promise.all(weekRows.map(({ row, conflictSet }) =>
        tx.insert(mcaPlayerWeekStatsTable)
          .values(row)
          .onConflictDoUpdate({
            target: [mcaPlayerWeekStatsTable.eaSeasonId, mcaPlayerWeekStatsTable.weekType, mcaPlayerWeekStatsTable.weekNum, mcaPlayerWeekStatsTable.statType, mcaPlayerWeekStatsTable.playerId],
            set: conflictSet,
          })
      ));

      // 2. Re-aggregate season counting stats from ALL week rows for affected players
      const W = mcaPlayerWeekStatsTable;
      const agg = await tx
        .select({
          playerId:      W.playerId,
          teamId:        W.teamId,
          passYds:       sql<number>`CAST(SUM(${W.passYds}) AS INT)`,
          passTDs:       sql<number>`CAST(SUM(${W.passTDs}) AS INT)`,
          passAtt:       sql<number>`CAST(SUM(${W.passAtt}) AS INT)`,
          passComp:      sql<number>`CAST(SUM(${W.passComp}) AS INT)`,
          passInts:      sql<number>`CAST(SUM(${W.passInts}) AS INT)`,
          timesSacked:   sql<number>`CAST(SUM(${W.timesSacked}) AS INT)`,
          rushYds:       sql<number>`CAST(SUM(${W.rushYds}) AS INT)`,
          rushTDs:       sql<number>`CAST(SUM(${W.rushTDs}) AS INT)`,
          rushAtt:       sql<number>`CAST(SUM(${W.rushAtt}) AS INT)`,
          fumbles:       sql<number>`CAST(SUM(${W.fumbles}) AS INT)`,
          recYds:        sql<number>`CAST(SUM(${W.recYds}) AS INT)`,
          recTDs:        sql<number>`CAST(SUM(${W.recTDs}) AS INT)`,
          recRec:        sql<number>`CAST(SUM(${W.recRec}) AS INT)`,
          recDrops:      sql<number>`CAST(SUM(${W.recDrops}) AS INT)`,
          sacks:         sql<number>`SUM(${W.sacks})`,
          defInts:       sql<number>`CAST(SUM(${W.defInts}) AS INT)`,
          totalTackles:  sql<number>`CAST(SUM(${W.totalTackles}) AS INT)`,
          forcedFumbles: sql<number>`CAST(SUM(${W.forcedFumbles}) AS INT)`,
          defTDs:        sql<number>`CAST(SUM(${W.defTDs}) AS INT)`,
          fgMade:        sql<number>`CAST(SUM(${W.fgMade}) AS INT)`,
          fgAtt:         sql<number>`CAST(SUM(${W.fgAtt}) AS INT)`,
          xpMade:        sql<number>`CAST(SUM(${W.xpMade}) AS INT)`,
          xpAtt:         sql<number>`CAST(SUM(${W.xpAtt}) AS INT)`,
          puntAtt:       sql<number>`CAST(SUM(${W.puntAtt}) AS INT)`,
          puntYds:       sql<number>`CAST(SUM(${W.puntYds}) AS INT)`,
          krYds:         sql<number>`CAST(SUM(${W.krYds}) AS INT)`,
          krTDs:         sql<number>`CAST(SUM(${W.krTDs}) AS INT)`,
          prYds:         sql<number>`CAST(SUM(${W.prYds}) AS INT)`,
          prTDs:         sql<number>`CAST(SUM(${W.prTDs}) AS INT)`,
        })
        .from(W)
        .where(and(
          eq(W.eaSeasonId, season.id),
          inArray(W.playerId, playerIds),
          ne(W.weekType, "pre"),
        ))
        .groupBy(W.playerId, W.teamId);

      // 3. Merge aggregated counts with latest rate/longest stats; upsert season totals
      const P = mcaPlayerStatsTable;
      await Promise.all(agg.map(a => {
        const extra = seasonExtra.get(a.playerId) ?? {};
        const row = {
          eaSeasonId:    season.id,
          eaLeagueId,
          playerId:      a.playerId,
          teamId:        a.teamId,
          teamName:      "",
          firstName:     "",
          lastName:      "",
          position:      "",
          ...extra,
          // Aggregated counting stats override any per-import values from extra
          passYds:       a.passYds       ?? 0,
          passTDs:       a.passTDs       ?? 0,
          passAtt:       a.passAtt       ?? 0,
          passComp:      a.passComp      ?? 0,
          passInts:      a.passInts      ?? 0,
          timesSacked:   a.timesSacked   ?? 0,
          rushYds:       a.rushYds       ?? 0,
          rushTDs:       a.rushTDs       ?? 0,
          rushAtt:       a.rushAtt       ?? 0,
          fumbles:       a.fumbles       ?? 0,
          recYds:        a.recYds        ?? 0,
          recTDs:        a.recTDs        ?? 0,
          recRec:        a.recRec        ?? 0,
          recDrops:      a.recDrops      ?? 0,
          sacks:         a.sacks         ?? 0,
          defInts:       a.defInts       ?? 0,
          totalTackles:  a.totalTackles  ?? 0,
          forcedFumbles: a.forcedFumbles ?? 0,
          defTDs:        a.defTDs        ?? 0,
          fgMade:        a.fgMade        ?? 0,
          fgAtt:         a.fgAtt         ?? 0,
          xpMade:        a.xpMade        ?? 0,
          xpAtt:         a.xpAtt         ?? 0,
          puntAtt:       a.puntAtt       ?? 0,
          puntYds:       a.puntYds       ?? 0,
          krYds:         a.krYds         ?? 0,
          krTDs:         a.krTDs         ?? 0,
          prYds:         a.prYds         ?? 0,
          prTDs:         a.prTDs         ?? 0,
          updatedAt: new Date(),
        } as typeof P.$inferInsert;

        return tx.insert(P).values(row)
          .onConflictDoUpdate({
            target: [P.eaSeasonId, P.playerId, P.teamId],
            set: {
              ...(extra as Record<string, unknown>),
              passYds:       row.passYds,       passTDs:       row.passTDs,
              passAtt:       row.passAtt,       passComp:      row.passComp,
              passInts:      row.passInts,      timesSacked:   row.timesSacked,
              rushYds:       row.rushYds,       rushTDs:       row.rushTDs,
              rushAtt:       row.rushAtt,       fumbles:       row.fumbles,
              recYds:        row.recYds,        recTDs:        row.recTDs,
              recRec:        row.recRec,        recDrops:      row.recDrops,
              sacks:         row.sacks,         defInts:       row.defInts,
              totalTackles:  row.totalTackles,  forcedFumbles: row.forcedFumbles,
              defTDs:        row.defTDs,
              fgMade:        row.fgMade,        fgAtt:         row.fgAtt,
              xpMade:        row.xpMade,        xpAtt:         row.xpAtt,
              puntAtt:       row.puntAtt,       puntYds:       row.puntYds,
              krYds:         row.krYds,         krTDs:         row.krTDs,
              prYds:         row.prYds,         prTDs:         row.prTDs,
              updatedAt: new Date(),
            },
          });
      }));
    });

    return { ok: true, message: `${upserted} ${statType} stats stored for week ${weekNum}` };
  } catch (err) {
    logger.error({ err }, `[v2/week${weekNum}/${statType}/${eaLeagueId}]`);
    return { ok: false, message: String(err) };
  }
}

// ── Stat field builders ───────────────────────────────────────────────────────

type StatFields = {
  weekFields:   Partial<typeof mcaPlayerWeekStatsTable.$inferInsert>;
  seasonInsert: Partial<typeof mcaPlayerStatsTable.$inferInsert>;
  seasonAccum:  Record<string, unknown>;
};

function buildStatFields(p: Record<string, unknown>, statType: string): StatFields {
  const T = mcaPlayerStatsTable;

  if (statType === "passing") {
    const passYds = getN(p,"passYds","passingYards","passyds");
    const passTDs = getN(p,"passTDs","passingTds","passtds");
    const passAtt = getN(p,"passAtt","passAttempts","passattempts","passatt","attempts");
    const passComp = getN(p,"passComp","passCompletions","completions","passcomp","completionAttempts");
    const passInts = getN(p,"passInts","passingInts","interceptions","passInt","passingInterceptions","intsThrown");
    const timesSacked = getN(p,"passSacks","sackYdsLost","timesSacked","sacksRec","sacksAllowed","sacksReceived","qbSacks");
    const passLongest = getN(p,"passLongest","passLng","passingLongest");
    const passPts = getN(p,"passPts","passingPts","passingPoints");
    const passerRating = getN(p,"passerRating","qbRating","passRating","passer_rating");
    const passCompPct = getN(p,"passCompPct","completionPct","passCompletion");
    const passYdsPerAtt = getN(p,"passYdsPerAtt","yardsPerAttempt","passYPA");
    const passYdsPerGame = getN(p,"passYdsPerGame","passingYardsPerGame");
    const weekFields: Partial<typeof mcaPlayerWeekStatsTable.$inferInsert> = { passYds, passTDs, passAtt, passComp, passInts, timesSacked, passerRating };
    const seasonInsert: Partial<typeof T.$inferInsert> = { passYds, passTDs, passAtt, passComp, passInts, timesSacked, passLongest, passPts, passerRating, passCompPct, passYdsPerAtt, passYdsPerGame };
    const seasonAccum: Record<string, unknown> = {
      passYds: sql`${T.passYds}+${passYds}`, passTDs: sql`${T.passTDs}+${passTDs}`,
      passAtt: sql`${T.passAtt}+${passAtt}`, passComp: sql`${T.passComp}+${passComp}`,
      passInts: sql`${T.passInts}+${passInts}`, timesSacked: sql`${T.timesSacked}+${timesSacked}`,
      passLongest: sql`GREATEST(${T.passLongest},${passLongest})`, passPts: sql`${T.passPts}+${passPts}`,
      passerRating, passCompPct, passYdsPerAtt, passYdsPerGame,
    };
    return { weekFields, seasonInsert, seasonAccum };
  }

  if (statType === "rushing") {
    const rushYds = getN(p,"rushYds","rushingYards","rushyds");
    const rushTDs = getN(p,"rushTDs","rushingTds","rushtds");
    const rushAtt = getN(p,"rushAtt","rushAttempts","rushatt","carries","rushCarries");
    const fumbles = getN(p,"rushFum","fumbles","fumLost","fumblesLost","offFumbles","fumTotal","fum");
    const rush20PlusYds = getN(p,"rush20PlusYds","rushingTwentyPlusYards","rush20Plus");
    const rushBrokenTackles = getN(p,"rushBrokenTackles","brokenTackles");
    const rushLongest = getN(p,"rushLongest","rushLng","rushingLongest");
    const rushPts = getN(p,"rushPts","rushingPts","rushingPoints");
    const rushYdsAfterContact = getN(p,"rushYdsAfterContact","yardsAfterContact");
    const rushToPct = getN(p,"rushToPct","rushTouchdownPct");
    const rushYdsPerAtt = getN(p,"rushYdsPerAtt","rushingYardsPerAtt","yardsPerCarry");
    const rushYdsPerGame = getN(p,"rushYdsPerGame","rushingYardsPerGame");
    const weekFields: Partial<typeof mcaPlayerWeekStatsTable.$inferInsert> = { rushYds, rushTDs, rushAtt, fumbles };
    const seasonInsert: Partial<typeof T.$inferInsert> = { rushYds, rushTDs, rushAtt, fumbles, rush20PlusYds, rushBrokenTackles, rushLongest, rushPts, rushYdsAfterContact, rushToPct, rushYdsPerAtt, rushYdsPerGame };
    const seasonAccum: Record<string, unknown> = {
      rushYds: sql`${T.rushYds}+${rushYds}`, rushTDs: sql`${T.rushTDs}+${rushTDs}`,
      rushAtt: sql`${T.rushAtt}+${rushAtt}`, fumbles: sql`${T.fumbles}+${fumbles}`,
      rush20PlusYds: sql`${T.rush20PlusYds}+${rush20PlusYds}`,
      rushBrokenTackles: sql`${T.rushBrokenTackles}+${rushBrokenTackles}`,
      rushLongest: sql`GREATEST(${T.rushLongest},${rushLongest})`,
      rushPts: sql`${T.rushPts}+${rushPts}`,
      rushYdsAfterContact: sql`${T.rushYdsAfterContact}+${rushYdsAfterContact}`,
      rushToPct, rushYdsPerAtt, rushYdsPerGame,
    };
    return { weekFields, seasonInsert, seasonAccum };
  }

  if (statType === "receiving") {
    const recYds = getN(p,"recYds","receivingYards","recyds");
    const recTDs = getN(p,"recTDs","receivingTds","rectds");
    const recRec = getN(p,"recRec","receptions","catches","receptionsTotal","recCatches");
    const recDrops = getN(p,"recDrops","drops","receivingDrops");
    const recLongest = getN(p,"recLongest","recLng","receivingLongest");
    const recPts = getN(p,"recPts","receivingPts","receivingPoints");
    const recYdsAfterCatch = getN(p,"recYdsAfterCatch");
    const recCatchPct = getN(p,"recCatchPct");
    const recToPct = getN(p,"recToPct","receivingTouchdownPct");
    const recYacPerCatch = getN(p,"recYacPerCatch","yacPerCatch");
    const recYdsPerCatch = getN(p,"recYdsPerCatch","yardsPerCatch","receivingYardsPerCatch");
    const recYdsPerGame = getN(p,"recYdsPerGame","receivingYardsPerGame");
    const weekFields: Partial<typeof mcaPlayerWeekStatsTable.$inferInsert> = { recYds, recTDs, recRec, recDrops };
    const seasonInsert: Partial<typeof T.$inferInsert> = { recYds, recTDs, recRec, recDrops, recLongest, recPts, recYdsAfterCatch, recCatchPct, recToPct, recYacPerCatch, recYdsPerCatch, recYdsPerGame };
    const seasonAccum: Record<string, unknown> = {
      recYds: sql`${T.recYds}+${recYds}`, recTDs: sql`${T.recTDs}+${recTDs}`,
      recRec: sql`${T.recRec}+${recRec}`, recDrops: sql`${T.recDrops}+${recDrops}`,
      recLongest: sql`GREATEST(${T.recLongest},${recLongest})`, recPts: sql`${T.recPts}+${recPts}`,
      recYdsAfterCatch: sql`${T.recYdsAfterCatch}+${recYdsAfterCatch}`,
      recCatchPct, recToPct, recYacPerCatch, recYdsPerCatch, recYdsPerGame,
    };
    return { weekFields, seasonInsert, seasonAccum };
  }

  if (statType === "defense") {
    const sacks = getN(p,"defSacks","sacks","sack");
    const defInts = getN(p,"defInts","defInterceptions","interceptions","ints");
    const totalTackles = getN(p,"defTotalTackles","totalTackles","tackleTotal","tackles");
    const tackleSolo = getN(p,"defTackleSolo","tackleSolo","soloTackles");
    const tackleAssist = getN(p,"defTackleAssist","tackleAssist","assistTackles");
    const defFumblesRec = getN(p,"defFumblesRec","fumblesRecovered","fumRec","fumbleRecoveries","fumbRec");
    const forcedFumbles = getN(p,"defForcedFumbles","forcedFumbles","ffum","fumForced","defFF","defForcedFum");
    const tacklesForLoss = getN(p,"defTacklesForLoss","tacklesForLoss","tfl","defTFL","tackleForLoss");
    const defTDs = getN(p,"defTDs","defTouchdowns","defTD","defensiveTDs","defTdsTotal");
    const defCatchAllowed = getN(p,"defCatchAllowed");
    const defDeflections = getN(p,"defDeflections","passDeflections","pbu","passesDefended");
    const defIntReturnYds = getN(p,"defIntReturnYds","intReturnYards");
    const defPts = getN(p,"defPts","defensivePts");
    const defSafeties = getN(p,"defSafeties","safeties");
    const weekFields: Partial<typeof mcaPlayerWeekStatsTable.$inferInsert> = { sacks, defInts, totalTackles, forcedFumbles, defTDs };
    const seasonInsert: Partial<typeof T.$inferInsert> = { sacks, defInts, totalTackles, tackleSolo, tackleAssist, defFumblesRec, forcedFumbles, tacklesForLoss, defTDs, defCatchAllowed, defDeflections, defIntReturnYds, defPts, defSafeties };
    const seasonAccum: Record<string, unknown> = {
      sacks: sql`${T.sacks}+${sacks}`, defInts: sql`${T.defInts}+${defInts}`,
      totalTackles: sql`${T.totalTackles}+${totalTackles}`, tackleSolo: sql`${T.tackleSolo}+${tackleSolo}`,
      tackleAssist: sql`${T.tackleAssist}+${tackleAssist}`, defFumblesRec: sql`${T.defFumblesRec}+${defFumblesRec}`,
      forcedFumbles: sql`${T.forcedFumbles}+${forcedFumbles}`, tacklesForLoss: sql`${T.tacklesForLoss}+${tacklesForLoss}`,
      defTDs: sql`${T.defTDs}+${defTDs}`, defCatchAllowed: sql`${T.defCatchAllowed}+${defCatchAllowed}`,
      defDeflections: sql`${T.defDeflections}+${defDeflections}`, defIntReturnYds: sql`${T.defIntReturnYds}+${defIntReturnYds}`,
      defPts: sql`${T.defPts}+${defPts}`, defSafeties: sql`${T.defSafeties}+${defSafeties}`,
    };
    return { weekFields, seasonInsert, seasonAccum };
  }

  if (statType === "kicking") {
    const fgMade = getN(p,"fGMade","fgMade","fgm","fieldGoalsMade","fg_made");
    const fgAtt = getN(p,"fGAtt","fgAtt","fga","fieldGoalAttempts","fg_att","fgAttempts");
    const fgLong = getN(p,"fGLongest","fgLong","fglg","fgLng","fgLongestMade","fg_long");
    const xpMade = getN(p,"xPMade","xpMade","xpm","extraPointsMade","epMade","xp_made");
    const xpAtt = getN(p,"xPAtt","xpAtt","xpa","extraPointAttempts","epAtt","xp_att","xpAttempts");
    const fg50PlusAtt = getN(p,"fG50PlusAtt","fg50PlusAtt");
    const fg50PlusMade = getN(p,"fG50PlusMade","fg50PlusMade");
    const kickPts = getN(p,"kickPts");
    const kickoffAtt = getN(p,"kickoffAtt");
    const kickoffTBs = getN(p,"kickoffTBs");
    const fgCompPct = getN(p,"fGCompPct","fgCompPct");
    const xpCompPct = getN(p,"xPCompPct","xpCompPct");
    const weekFields: Partial<typeof mcaPlayerWeekStatsTable.$inferInsert> = { fgMade, fgAtt, xpMade, xpAtt };
    const seasonInsert: Partial<typeof T.$inferInsert> = { fgMade, fgAtt, fgLong, xpMade, xpAtt, fg50PlusAtt, fg50PlusMade, kickPts, kickoffAtt, kickoffTBs, fgCompPct, xpCompPct };
    const seasonAccum: Record<string, unknown> = {
      fgMade: sql`${T.fgMade}+${fgMade}`, fgAtt: sql`${T.fgAtt}+${fgAtt}`,
      fgLong: sql`GREATEST(${T.fgLong},${fgLong})`, xpMade: sql`${T.xpMade}+${xpMade}`,
      xpAtt: sql`${T.xpAtt}+${xpAtt}`, fg50PlusAtt: sql`${T.fg50PlusAtt}+${fg50PlusAtt}`,
      fg50PlusMade: sql`${T.fg50PlusMade}+${fg50PlusMade}`, kickPts: sql`${T.kickPts}+${kickPts}`,
      kickoffAtt: sql`${T.kickoffAtt}+${kickoffAtt}`, kickoffTBs: sql`${T.kickoffTBs}+${kickoffTBs}`,
      fgCompPct, xpCompPct,
    };
    return { weekFields, seasonInsert, seasonAccum };
  }

  if (statType === "punting") {
    const puntAtt = getN(p,"puntAtt","punts","puntCount","puntAttempts","punt_att");
    const puntYds = getN(p,"puntYds","puntingYds","puntYdsTotal","punt_yds");
    const puntLong = getN(p,"puntLong","puntLng","puntLongest","punt_long");
    const puntIn20 = getN(p,"puntIn20","puntsIn20","puntInsideTwenty","punt_in_20");
    const puntTouchbacks = getN(p,"puntTouchbacks","puntTBs","puntTouchback","punt_touchbacks");
    const puntNetYds = getN(p,"puntNetYds");
    const puntsBlocked = getN(p,"puntsBlocked");
    const puntNetYdsPerAtt = getN(p,"puntNetYdsPerAtt");
    const weekFields: Partial<typeof mcaPlayerWeekStatsTable.$inferInsert> = { puntAtt, puntYds };
    const seasonInsert: Partial<typeof T.$inferInsert> = { puntAtt, puntYds, puntLong, puntIn20, puntTouchbacks, puntNetYds, puntsBlocked, puntNetYdsPerAtt };
    const seasonAccum: Record<string, unknown> = {
      puntAtt: sql`${T.puntAtt}+${puntAtt}`, puntYds: sql`${T.puntYds}+${puntYds}`,
      puntLong: sql`GREATEST(${T.puntLong},${puntLong})`, puntIn20: sql`${T.puntIn20}+${puntIn20}`,
      puntTouchbacks: sql`${T.puntTouchbacks}+${puntTouchbacks}`, puntNetYds: sql`${T.puntNetYds}+${puntNetYds}`,
      puntsBlocked: sql`${T.puntsBlocked}+${puntsBlocked}`, puntNetYdsPerAtt,
    };
    return { weekFields, seasonInsert, seasonAccum };
  }

  if (statType === "kickreturn" || statType === "kickreturning") {
    const krAtt = getN(p,"krAtt","kickReturnAtt","krReturns","kickReturnAttempts","kr_att");
    const krYds = getN(p,"krYds","kickReturnYds","kickRetYds","kr_yds");
    const krTDs = getN(p,"krTDs","kickReturnTDs","kickRetTDs","krTouchdowns","kr_tds");
    const weekFields: Partial<typeof mcaPlayerWeekStatsTable.$inferInsert> = { krYds, krTDs };
    const seasonInsert: Partial<typeof T.$inferInsert> = { krAtt, krYds, krTDs };
    const seasonAccum: Record<string, unknown> = {
      krAtt: sql`${T.krAtt}+${krAtt}`, krYds: sql`${T.krYds}+${krYds}`, krTDs: sql`${T.krTDs}+${krTDs}`,
    };
    return { weekFields, seasonInsert, seasonAccum };
  }

  if (statType === "puntreturn" || statType === "puntreturning") {
    const prAtt = getN(p,"prAtt","puntReturnAtt","prReturns","puntReturnAttempts","pr_att");
    const prYds = getN(p,"prYds","puntReturnYds","puntRetYds","pr_yds");
    const prTDs = getN(p,"prTDs","puntReturnTDs","puntRetTDs","prTouchdowns","pr_tds");
    const weekFields: Partial<typeof mcaPlayerWeekStatsTable.$inferInsert> = { prYds, prTDs };
    const seasonInsert: Partial<typeof T.$inferInsert> = { prAtt, prYds, prTDs };
    const seasonAccum: Record<string, unknown> = {
      prAtt: sql`${T.prAtt}+${prAtt}`, prYds: sql`${T.prYds}+${prYds}`, prTDs: sql`${T.prTDs}+${prTDs}`,
    };
    return { weekFields, seasonInsert, seasonAccum };
  }

  return { weekFields: {}, seasonInsert: {}, seasonAccum: {} };
}

// ── processV2DraftPicks ───────────────────────────────────────────────────────

export async function processV2DraftPicks(body: unknown, eaLeagueId: number): Promise<V2Result> {
  try {
    const rawPicks = extractList(body, "draftPickInfoList","draftPicks","picks","leagueDraftPickList");
    const seasonIndex = extractSeasonIndex(body, rawPicks);
    const season      = await getOrCreateV2Season(eaLeagueId, seasonIndex);

    if (rawPicks.length === 0) {
      logger.warn(`[v2/draftpicks/${eaLeagueId}] No picks found`);
      return { ok: true, message: "No draft picks in payload" };
    }

    const teams = await db
      .select({ teamId: mcaTeamsTable.teamId, fullName: mcaTeamsTable.fullName })
      .from(mcaTeamsTable)
      .where(eq(mcaTeamsTable.eaSeasonId, season.id));
    const teamNameMap = new Map(teams.map(t => [t.teamId, t.fullName]));

    const rows: (typeof mcaDraftPicksTable.$inferInsert)[] = [];
    for (const p of rawPicks) {
      const teamId    = getN(p, "teamId","currentTeamId");
      const draftYear = getN(p, "draftYear","year");
      const round     = getN(p, "round","roundNum");
      if (!teamId || !draftYear || !round) continue;

      const originalTeamId  = getN(p, "originalTeamId","origTeamId") || null;
      const effectiveOrigId = originalTeamId && originalTeamId !== teamId ? originalTeamId : null;

      rows.push({
        eaSeasonId:       season.id,
        eaLeagueId,
        teamId,
        teamName:         teamNameMap.get(teamId) ?? getStr(p, "teamName"),
        draftYear,
        round,
        pickNum:          getN(p, "pickNum","normalizedPickNumber"),
        originalTeamId:   effectiveOrigId,
        originalTeamName: effectiveOrigId ? (teamNameMap.get(effectiveOrigId) ?? null) : null,
        rawJson:          p,
        importedAt:       new Date(),
      });
    }

    if (rows.length === 0) return { ok: true, message: "No valid picks parsed" };

    await db.delete(mcaDraftPicksTable).where(eq(mcaDraftPicksTable.eaSeasonId, season.id));
    await db.insert(mcaDraftPicksTable).values(rows);

    return { ok: true, message: `${rows.length} draft picks imported (season ${season.seasonNumber})` };
  } catch (err) {
    logger.error({ err }, "[v2/draftpicks]");
    return { ok: false, message: String(err) };
  }
}

// ── App user helpers ──────────────────────────────────────────────────────────

export async function registerAppUser(
  gamertag: string,
  displayName?: string,
  platform?: string,
  email?: string,
): Promise<V2Result> {
  try {
    const gt = gamertag.toLowerCase().trim();
    if (!gt) return { ok: false, message: "Gamertag is required" };
    await db.insert(appUsersTable)
      .values({
        gamertag: gt,
        displayName: displayName ?? gt,
        platform: platform ?? "",
        email: email ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: appUsersTable.gamertag,
        set: {
          ...(displayName ? { displayName } : {}),
          ...(platform    ? { platform }    : {}),
          ...(email       ? { email }       : {}),
          updatedAt: new Date(),
        },
      });
    return { ok: true, message: `User ${gt} registered` };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

export async function getAppUserLeagues(gamertag: string) {
  const gt    = gamertag.toLowerCase().trim();
  const links = await db
    .select()
    .from(appUserLeagueLinksTable)
    .where(eq(appUserLeagueLinksTable.gamertag, gt));

  if (links.length === 0) return [];

  const leagueIds = links.map(l => l.eaLeagueId);
  const leagues   = await db
    .select()
    .from(mcaLeaguesTable)
    .where(inArray(mcaLeaguesTable.eaLeagueId, leagueIds));
  const leagueMap = new Map(leagues.map(l => [l.eaLeagueId, l]));

  // For each linked league, fetch the team's standings/stats
  const teamInfoResults = await Promise.allSettled(
    links.map(async (link) => {
      if (!link.teamId) return null;
      const season = await db
        .select()
        .from(mcaSeasonsTable)
        .where(and(eq(mcaSeasonsTable.eaLeagueId, link.eaLeagueId), eq(mcaSeasonsTable.isActive, true)))
        .orderBy(desc(mcaSeasonsTable.seasonNumber))
        .limit(1)
        .then(r => r[0] ?? null);
      if (!season) return null;

      const [teamInfo, teamStats] = await Promise.all([
        db.select().from(mcaTeamsTable)
          .where(and(eq(mcaTeamsTable.eaSeasonId, season.id), eq(mcaTeamsTable.teamId, link.teamId!)))
          .limit(1)
          .then(r => r[0] ?? null),
        db.select().from(mcaTeamStatsTable)
          .where(and(eq(mcaTeamStatsTable.eaSeasonId, season.id), eq(mcaTeamStatsTable.teamId, link.teamId!)))
          .limit(1)
          .then(r => r[0] ?? null),
      ]);
      return { teamInfo, teamStats };
    }),
  );

  return links.map((link, i) => {
    const league   = leagueMap.get(link.eaLeagueId);
    const teamData = teamInfoResults[i]?.status === "fulfilled" ? teamInfoResults[i].value : null;
    return {
      eaLeagueId:   link.eaLeagueId,
      leagueName:   league?.leagueName ?? "",
      platform:     league?.platform   ?? "",
      teamId:       link.teamId,
      teamName:     link.teamName ?? teamData?.teamInfo?.fullName ?? "",
      conference:   teamData?.teamInfo?.conference ?? null,
      divName:      teamData?.teamInfo?.divName    ?? null,
      ovrRating:    teamData?.teamInfo?.ovrRating  ?? null,
      wins:         teamData?.teamStats?.wins      ?? null,
      losses:       teamData?.teamStats?.losses    ?? null,
      ties:         teamData?.teamStats?.ties      ?? null,
      ptsFor:       teamData?.teamStats?.ptsFor    ?? null,
      ptsAgainst:   teamData?.teamStats?.ptsAgainst ?? null,
      linkedAt:     link.linkedAt,
    };
  });
}
