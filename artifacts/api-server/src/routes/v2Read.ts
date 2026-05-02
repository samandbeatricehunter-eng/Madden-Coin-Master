/**
 * v2 GET Routes — Madden-native, EA league ID scoped.
 * Reads purely from mca_* / app_* tables. Zero Discord/guild references.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  mcaLeaguesTable,
  mcaSeasonsTable,
  mcaTeamsTable,
  mcaRostersTable,
  mcaTeamStatsTable,
  mcaTeamWeekStatsTable,
  mcaSchedulesTable,
  mcaPlayerStatsTable,
  mcaPlayerWeekStatsTable,
  mcaDraftPicksTable,
  appUsersTable,
  appUserLeagueLinksTable,
} from "@workspace/db";
import { eq, and, desc, asc, max, sql } from "drizzle-orm";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { getRosterCache, setRosterCache } from "../lib/rosterCache.js";
import { getAppUserLeagues, registerAppUser } from "../lib/v2-processor.js";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseLeagueId(raw: string | string[] | undefined): number | null {
  const s = Array.isArray(raw) ? raw[0]! : (raw ?? "");
  const n = Number(s);
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
    const [leagues, seasons] = await Promise.all([
      db.select().from(mcaLeaguesTable).orderBy(asc(mcaLeaguesTable.leagueName)),
      db.select().from(mcaSeasonsTable).where(eq(mcaSeasonsTable.isActive, true)).orderBy(desc(mcaSeasonsTable.seasonNumber)),
    ]);
    const seasonByLeague = new Map(seasons.map(s => [s.eaLeagueId, s]));
    res.json({
      leagues: leagues.map(l => {
        const s = seasonByLeague.get(l.eaLeagueId);
        return { eaLeagueId: l.eaLeagueId, leagueName: l.leagueName, platform: l.platform, updatedAt: l.updatedAt, seasonId: s?.id ?? null, seasonNumber: s?.seasonNumber ?? null, currentWeek: s?.currentWeek ?? null };
      }),
    });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId ───────────────────────────────────────────────
router.get("/v2/leagues/:eaLeagueId", requireApiKey, async (req: Request, res: Response) => {
  const lid = parseLeagueId(req.params["eaLeagueId"]);
  if (!lid) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const [[league], season] = await Promise.all([
      db.select().from(mcaLeaguesTable).where(eq(mcaLeaguesTable.eaLeagueId, lid)).limit(1),
      getActiveSeason(lid),
    ]);
    if (!league || !season) { res.status(404).json({ error: "League not found or no active season" }); return; }
    res.json({ eaLeagueId: league.eaLeagueId, leagueName: league.leagueName, platform: league.platform, seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, isActive: season.isActive, startedAt: season.startedAt });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/teams — includes linked app user info ─────────
router.get("/v2/leagues/:eaLeagueId/teams", requireApiKey, async (req: Request, res: Response) => {
  const lid = parseLeagueId(req.params["eaLeagueId"]);
  if (!lid) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }

    const [teams, links, appUsers] = await Promise.all([
      db.select().from(mcaTeamsTable).where(eq(mcaTeamsTable.eaSeasonId, season.id)).orderBy(asc(mcaTeamsTable.fullName)),
      db.select().from(appUserLeagueLinksTable).where(eq(appUserLeagueLinksTable.eaLeagueId, lid)),
      db.select({ gamertag: appUsersTable.gamertag, displayName: appUsersTable.displayName }).from(appUsersTable),
    ]);

    const linkByTeam    = new Map(links.map(l => [l.teamId, l]));
    const userByGamertag = new Map(appUsers.map(u => [u.gamertag, u.displayName]));

    const enrichedTeams = teams.map(t => {
      const link = linkByTeam.get(t.teamId);
      return {
        ...t,
        linkedGamertag:    link?.gamertag    ?? null,
        linkedDisplayName: link ? (userByGamertag.get(link.gamertag) ?? link.gamertag) : null,
      };
    });

    res.json({ eaLeagueId: lid, seasonId: season.id, seasonNumber: season.seasonNumber, teams: enrichedTeams });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/teams");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/rosters (aggregate, cached) ───────────────────
router.get("/v2/leagues/:eaLeagueId/rosters", requireApiKey, async (req: Request, res: Response) => {
  const lid = parseLeagueId(req.params["eaLeagueId"]);
  if (!lid) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }

    const cached = getRosterCache(season.id, "v2");
    if (cached !== null) {
      res.setHeader("X-Cache", "HIT");
      res.json(cached);
      return;
    }

    const [players, [latestRow]] = await Promise.all([
      db.select().from(mcaRostersTable).where(eq(mcaRostersTable.eaSeasonId, season.id)).orderBy(asc(mcaRostersTable.teamId), desc(mcaRostersTable.overall)),
      db.select({ importedAt: max(mcaRostersTable.importedAt) }).from(mcaRostersTable).where(eq(mcaRostersTable.eaSeasonId, season.id)),
    ]);

    const payload = { eaLeagueId: lid, seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, playerCount: players.length, importedAt: latestRow?.importedAt ?? null, players };
    setRosterCache(season.id, payload, "v2");
    res.setHeader("X-Cache", "MISS");
    res.json(payload);
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/rosters");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/roster/:teamId ────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/roster/:teamId", requireApiKey, async (req: Request, res: Response) => {
  const lid    = parseLeagueId(req.params["eaLeagueId"]);
  const teamId = parseInt(String(req.params["teamId"] ?? "0"), 10);
  if (!lid || !teamId) { res.status(400).json({ error: "Invalid eaLeagueId or teamId" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const players = await db.select().from(mcaRostersTable).where(and(eq(mcaRostersTable.eaSeasonId, season.id), eq(mcaRostersTable.teamId, teamId))).orderBy(asc(mcaRostersTable.position), desc(mcaRostersTable.overall));
    res.json({ eaLeagueId: lid, seasonId: season.id, seasonNumber: season.seasonNumber, teamId, playerCount: players.length, players });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/roster/:teamId");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/standings ────────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/standings", requireApiKey, async (req: Request, res: Response) => {
  const lid = parseLeagueId(req.params["eaLeagueId"]);
  if (!lid) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const standings = await db.select().from(mcaTeamStatsTable).where(eq(mcaTeamStatsTable.eaSeasonId, season.id)).orderBy(desc(mcaTeamStatsTable.wins), desc(mcaTeamStatsTable.ptsFor));
    res.json({ eaLeagueId: lid, seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, standings });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/standings");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/team-stats ────────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/team-stats", requireApiKey, async (req: Request, res: Response) => {
  const lid = parseLeagueId(req.params["eaLeagueId"]);
  if (!lid) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const teamStats = await db.select().from(mcaTeamStatsTable).where(eq(mcaTeamStatsTable.eaSeasonId, season.id)).orderBy(desc(mcaTeamStatsTable.offYds));
    res.json({ eaLeagueId: lid, seasonId: season.id, seasonNumber: season.seasonNumber, teamStats });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/team-stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/team-stats/week/:weekType/:weekNum ────────────
router.get("/v2/leagues/:eaLeagueId/team-stats/week/:weekType/:weekNum", requireApiKey, async (req: Request, res: Response) => {
  const lid      = parseLeagueId(req.params["eaLeagueId"]);
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
  if (!lid || !weekNum) { res.status(400).json({ error: "Invalid params" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const teamStats = await db.select().from(mcaTeamWeekStatsTable).where(and(eq(mcaTeamWeekStatsTable.eaSeasonId, season.id), eq(mcaTeamWeekStatsTable.weekType, weekType), eq(mcaTeamWeekStatsTable.weekNum, weekNum))).orderBy(desc(mcaTeamWeekStatsTable.offYds));
    res.json({ eaLeagueId: lid, seasonId: season.id, weekType, weekNum, teamStats });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/team-stats/week");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/team-stats/week/:weekIndex (alias: weekType=reg) ─
router.get("/v2/leagues/:eaLeagueId/team-stats/week/:weekIndex", requireApiKey, async (req: Request, res: Response) => {
  const lid     = parseLeagueId(req.params["eaLeagueId"]);
  const weekNum = parseInt(String(req.params["weekIndex"] ?? "0"), 10);
  if (!lid || !weekNum) { res.status(400).json({ error: "Invalid params" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const teamStats = await db.select().from(mcaTeamWeekStatsTable)
      .where(and(eq(mcaTeamWeekStatsTable.eaSeasonId, season.id), eq(mcaTeamWeekStatsTable.weekNum, weekNum)))
      .orderBy(desc(mcaTeamWeekStatsTable.offYds));
    res.json({ eaLeagueId: lid, seasonId: season.id, weekNum, teamStats });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/team-stats/week/:weekIndex");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/player-stats/week/:weekIndex (alias: weekType=reg) ─
router.get("/v2/leagues/:eaLeagueId/player-stats/week/:weekIndex", requireApiKey, async (req: Request, res: Response) => {
  const lid     = parseLeagueId(req.params["eaLeagueId"]);
  const weekNum = parseInt(String(req.params["weekIndex"] ?? "0"), 10);
  const statType = typeof req.query["statType"] === "string" ? req.query["statType"] : undefined;
  if (!lid || !weekNum) { res.status(400).json({ error: "Invalid params" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const conditions = [eq(mcaPlayerWeekStatsTable.eaSeasonId, season.id), eq(mcaPlayerWeekStatsTable.weekNum, weekNum)];
    if (statType) conditions.push(eq(mcaPlayerWeekStatsTable.statType, statType));
    const stats = await db.select().from(mcaPlayerWeekStatsTable).where(and(...conditions))
      .orderBy(asc(mcaPlayerWeekStatsTable.statType), asc(mcaPlayerWeekStatsTable.teamName), asc(mcaPlayerWeekStatsTable.lastName));
    res.json({ eaLeagueId: lid, seasonId: season.id, weekNum, stats });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/player-stats/week/:weekIndex");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/schedule ─────────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/schedule", requireApiKey, async (req: Request, res: Response) => {
  const lid = parseLeagueId(req.params["eaLeagueId"]);
  if (!lid) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  const weekIndex = req.query["week"] !== undefined ? Number(req.query["week"]) : undefined;
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const conditions = [eq(mcaSchedulesTable.eaSeasonId, season.id)];
    if (weekIndex !== undefined && !isNaN(weekIndex)) conditions.push(eq(mcaSchedulesTable.weekIndex, weekIndex));
    const games = await db.select().from(mcaSchedulesTable).where(and(...conditions)).orderBy(asc(mcaSchedulesTable.weekIndex), asc(mcaSchedulesTable.id));
    res.json({ eaLeagueId: lid, seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, games });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/schedule");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/player-stats ─────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/player-stats", requireApiKey, async (req: Request, res: Response) => {
  const lid = parseLeagueId(req.params["eaLeagueId"]);
  if (!lid) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  const position = typeof req.query["position"] === "string" ? req.query["position"].toUpperCase() : undefined;
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const all = await db.select().from(mcaPlayerStatsTable).where(eq(mcaPlayerStatsTable.eaSeasonId, season.id)).orderBy(asc(mcaPlayerStatsTable.teamName), asc(mcaPlayerStatsTable.lastName));
    res.json({ eaLeagueId: lid, seasonId: season.id, seasonNumber: season.seasonNumber, stats: position ? all.filter(p => p.position === position) : all });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/player-stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/player-stats/week/:weekType/:weekNum ──────────
router.get("/v2/leagues/:eaLeagueId/player-stats/week/:weekType/:weekNum", requireApiKey, async (req: Request, res: Response) => {
  const lid      = parseLeagueId(req.params["eaLeagueId"]);
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
  const statType = typeof req.query["statType"] === "string" ? req.query["statType"] : undefined;
  if (!lid || !weekNum) { res.status(400).json({ error: "Invalid params" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const conditions = [eq(mcaPlayerWeekStatsTable.eaSeasonId, season.id), eq(mcaPlayerWeekStatsTable.weekType, weekType), eq(mcaPlayerWeekStatsTable.weekNum, weekNum)];
    if (statType) conditions.push(eq(mcaPlayerWeekStatsTable.statType, statType));
    const stats = await db.select().from(mcaPlayerWeekStatsTable).where(and(...conditions)).orderBy(asc(mcaPlayerWeekStatsTable.statType), asc(mcaPlayerWeekStatsTable.teamName), asc(mcaPlayerWeekStatsTable.lastName));
    res.json({ eaLeagueId: lid, seasonId: season.id, weekType, weekNum, stats });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/player-stats/week");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/leagues/:eaLeagueId/draft-picks ──────────────────────────────────
router.get("/v2/leagues/:eaLeagueId/draft-picks", requireApiKey, async (req: Request, res: Response) => {
  const lid = parseLeagueId(req.params["eaLeagueId"]);
  if (!lid) { res.status(400).json({ error: "Invalid eaLeagueId" }); return; }
  try {
    const season = await getActiveSeason(lid);
    if (!season) { res.status(404).json({ error: "No active season" }); return; }
    const picks = await db.select().from(mcaDraftPicksTable).where(eq(mcaDraftPicksTable.eaSeasonId, season.id)).orderBy(asc(mcaDraftPicksTable.draftYear), asc(mcaDraftPicksTable.round), asc(mcaDraftPicksTable.pickNum));
    res.json({ eaLeagueId: lid, seasonId: season.id, seasonNumber: season.seasonNumber, picks });
  } catch (err) {
    req.log.error(err, "GET /v2/leagues/:eaLeagueId/draft-picks");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /v2/users — register / upsert a gamertag ────────────────────────────
router.post("/v2/users", requireApiKey, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const gt   = String(body["gamertag"] ?? "").trim();
  if (!gt) { res.status(400).json({ ok: false, error: "gamertag is required" }); return; }
  const result = await registerAppUser(
    gt,
    String(body["displayName"] ?? ""),
    String(body["platform"]    ?? ""),
    body["email"] ? String(body["email"]) : undefined,
  ).catch(err => ({ ok: false, message: String(err) }));
  res.status(result.ok ? 200 : 500).json(result);
});

// ── GET /v2/users/:gamertag ───────────────────────────────────────────────────
router.get("/v2/users/:gamertag", requireApiKey, async (req: Request, res: Response) => {
  const gt = String(req.params["gamertag"] ?? "").toLowerCase().trim();
  if (!gt) { res.status(400).json({ error: "gamertag is required" }); return; }
  try {
    const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.gamertag, gt)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const leagues = await getAppUserLeagues(gt);
    res.json({ id: user.id, gamertag: user.gamertag, displayName: user.displayName, platform: user.platform, email: user.email, createdAt: user.createdAt, leagues });
  } catch (err) {
    req.log.error(err, "GET /v2/users/:gamertag");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /v2/users/:gamertag/leagues ──────────────────────────────────────────
router.get("/v2/users/:gamertag/leagues", requireApiKey, async (req: Request, res: Response) => {
  const gt = String(req.params["gamertag"] ?? "").toLowerCase().trim();
  if (!gt) { res.status(400).json({ error: "gamertag is required" }); return; }
  try {
    const leagues = await getAppUserLeagues(gt);
    res.json({ gamertag: gt, leagues });
  } catch (err) {
    req.log.error(err, "GET /v2/users/:gamertag/leagues");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
