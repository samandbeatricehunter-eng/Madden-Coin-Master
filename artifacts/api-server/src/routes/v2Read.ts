/**
 * v2 GET Routes — Madden-native, EA league ID scoped.
 * Reads purely from mca_* tables. Zero Discord/guild references.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  mcaLeaguesTable,
  mcaSeasonsTable,
  mcaTeamsTable,
  mcaRostersTable,
  mcaTeamStatsTable,
  mcaSchedulesTable,
  mcaPlayerStatsTable,
  mcaDraftPicksTable,
} from "@workspace/db";
import { eq, and, desc, asc, max, sql } from "drizzle-orm";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { getRosterCache, setRosterCache } from "../lib/rosterCache.js";

const router: IRouter = Router();

function extractParam(p: string | string[]): string {
  return Array.isArray(p) ? p[0]! : p;
}

function parseLeagueId(raw: string | string[]): number | null {
  const n = Number(extractParam(raw));
  return isNaN(n) || n <= 0 ? null : n;
}

async function getActiveSeason(eaLeagueId: number) {
  const [season] = await db
    .select()
    .from(mcaSeasonsTable)
    .where(and(eq(mcaSeasonsTable.eaLeagueId, eaLeagueId), eq(mcaSeasonsTable.isActive, true)))
    .orderBy(desc(mcaSeasonsTable.seasonNumber))
    .limit(1);
  return season ?? null;
}

// ── GET /v2/leagues ───────────────────────────────────────────────────────────
router.get("/v2/leagues", requireApiKey, async (req: Request, res: Response) => {
  try {
    const leagues = await db
      .select({
        eaLeagueId:   mcaLeaguesTable.eaLeagueId,
        leagueName:   mcaLeaguesTable.leagueName,
        platform:     mcaLeaguesTable.platform,
        updatedAt:    mcaLeaguesTable.updatedAt,
      })
      .from(mcaLeaguesTable)
      .orderBy(asc(mcaLeaguesTable.leagueName));

    // Attach active season info for each
    const seasonRows = await db
      .select()
      .from(mcaSeasonsTable)
      .where(eq(mcaSeasonsTable.isActive, true))
      .orderBy(desc(mcaSeasonsTable.seasonNumber));

    const seasonByLeague = new Map(seasonRows.map(s => [s.eaLeagueId, s]));

    const result = leagues.map(l => {
      const s = seasonByLeague.get(l.eaLeagueId);
      return {
        eaLeagueId:   l.eaLeagueId,
        leagueName:   l.leagueName,
        platform:     l.platform,
        updatedAt:    l.updatedAt,
        seasonId:     s?.id            ?? null,
        seasonNumber: s?.seasonNumber  ?? null,
        currentWeek:  s?.currentWeek   ?? null,
      };
    });

    res.json({ leagues: result });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId ───────────────────────────────────────────────
router.get("/v2/leagues/:eaLeagueId", requireApiKey, async (req: Request, res: Response) => {
  const eaLeagueId = parseLeagueId(req.params["eaLeagueId"]!);
  if (!eaLeagueId) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const [league, season] = await Promise.all([
      db.select().from(mcaLeaguesTable).where(eq(mcaLeaguesTable.eaLeagueId, eaLeagueId)).limit(1),
      getActiveSeason(eaLeagueId),
    ]);
    if (!league[0] || !season) {
      res.status(404).json({ error: "League not found or no active season" });
      return;
    }
    res.json({
      eaLeagueId:   league[0].eaLeagueId,
      leagueName:   league[0].leagueName,
      platform:     league[0].platform,
      seasonId:     season.id,
      seasonNumber: season.seasonNumber,
      currentWeek:  season.currentWeek,
      isActive:     season.isActive,
      startedAt:    season.startedAt,
    });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/teams ─────────────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/teams", requireApiKey, async (req: Request, res: Response) => {
  const eaLeagueId = parseLeagueId(req.params["eaLeagueId"]!);
  if (!eaLeagueId) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(eaLeagueId);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }

    const teams = await db
      .select()
      .from(mcaTeamsTable)
      .where(eq(mcaTeamsTable.eaSeasonId, season.id))
      .orderBy(asc(mcaTeamsTable.fullName));

    res.json({ eaLeagueId, seasonId: season.id, seasonNumber: season.seasonNumber, teams });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/teams failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/rosters (aggregate, cached) ───────────────────
router.get("/v2/leagues/:eaLeagueId/rosters", requireApiKey, async (req: Request, res: Response) => {
  const eaLeagueId = parseLeagueId(req.params["eaLeagueId"]!);
  if (!eaLeagueId) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(eaLeagueId);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }

    const cached = getRosterCache(season.id);
    if (cached !== null) {
      res.setHeader("X-Cache", "HIT");
      res.json(cached);
      return;
    }

    const [players, latestImport] = await Promise.all([
      db
        .select()
        .from(mcaRostersTable)
        .where(eq(mcaRostersTable.eaSeasonId, season.id))
        .orderBy(asc(mcaRostersTable.teamId), desc(mcaRostersTable.overall)),
      db
        .select({ importedAt: max(mcaRostersTable.importedAt) })
        .from(mcaRostersTable)
        .where(eq(mcaRostersTable.eaSeasonId, season.id)),
    ]);

    const payload = {
      eaLeagueId,
      seasonId:     season.id,
      seasonNumber: season.seasonNumber,
      currentWeek:  season.currentWeek,
      playerCount:  players.length,
      importedAt:   latestImport[0]?.importedAt ?? null,
      players,
    };

    setRosterCache(season.id, payload);
    res.setHeader("X-Cache", "MISS");
    res.json(payload);
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/rosters failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/standings ────────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/standings", requireApiKey, async (req: Request, res: Response) => {
  const eaLeagueId = parseLeagueId(req.params["eaLeagueId"]!);
  if (!eaLeagueId) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(eaLeagueId);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }

    const standings = await db
      .select()
      .from(mcaTeamStatsTable)
      .where(eq(mcaTeamStatsTable.eaSeasonId, season.id))
      .orderBy(desc(mcaTeamStatsTable.wins), desc(mcaTeamStatsTable.ptsFor));

    res.json({ eaLeagueId, seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, standings });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/standings failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/schedule ─────────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/schedule", requireApiKey, async (req: Request, res: Response) => {
  const eaLeagueId = parseLeagueId(req.params["eaLeagueId"]!);
  if (!eaLeagueId) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  const weekIndex = req.query["week"] !== undefined ? Number(req.query["week"]) : undefined;
  try {
    const season = await getActiveSeason(eaLeagueId);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }

    const conditions = [eq(mcaSchedulesTable.eaSeasonId, season.id)];
    if (weekIndex !== undefined && !isNaN(weekIndex)) {
      conditions.push(eq(mcaSchedulesTable.weekIndex, weekIndex));
    }

    const games = await db
      .select()
      .from(mcaSchedulesTable)
      .where(and(...conditions))
      .orderBy(asc(mcaSchedulesTable.weekIndex), asc(mcaSchedulesTable.id));

    res.json({ eaLeagueId, seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, games });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/schedule failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/player-stats ─────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/player-stats", requireApiKey, async (req: Request, res: Response) => {
  const eaLeagueId = parseLeagueId(req.params["eaLeagueId"]!);
  if (!eaLeagueId) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  const position = typeof req.query["position"] === "string" ? req.query["position"].toUpperCase() : undefined;
  try {
    const season = await getActiveSeason(eaLeagueId);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }

    const allStats = await db
      .select()
      .from(mcaPlayerStatsTable)
      .where(eq(mcaPlayerStatsTable.eaSeasonId, season.id))
      .orderBy(asc(mcaPlayerStatsTable.teamName), asc(mcaPlayerStatsTable.lastName));

    const stats = position ? allStats.filter(p => p.position === position) : allStats;
    res.json({ eaLeagueId, seasonId: season.id, seasonNumber: season.seasonNumber, stats });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/player-stats failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/draft-picks ──────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/draft-picks", requireApiKey, async (req: Request, res: Response) => {
  const eaLeagueId = parseLeagueId(req.params["eaLeagueId"]!);
  if (!eaLeagueId) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(eaLeagueId);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }

    const picks = await db
      .select()
      .from(mcaDraftPicksTable)
      .where(eq(mcaDraftPicksTable.eaSeasonId, season.id))
      .orderBy(
        asc(mcaDraftPicksTable.draftYear),
        asc(mcaDraftPicksTable.round),
        asc(mcaDraftPicksTable.pickNum),
      );

    res.json({ eaLeagueId, seasonId: season.id, seasonNumber: season.seasonNumber, picks });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/draft-picks failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
