import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  seasonsTable,
  franchiseMcaTeamsTable,
  franchiseRostersTable,
  franchiseScheduleTable,
  franchiseDraftPicksTable,
  teamSeasonStatsTable,
  playerSeasonStatsTable,
  leagueNewsTable,
} from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import { requireApiKey } from "../middleware/requireApiKey.js";

const router: IRouter = Router();

function extractParam(p: string | string[]): string {
  return Array.isArray(p) ? p[0]! : p;
}

async function getActiveSeason(guildId: string) {
  const [season] = await db
    .select()
    .from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .orderBy(desc(seasonsTable.seasonNumber))
    .limit(1);
  return season ?? null;
}

router.get("/v1/leagues/:guildId", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const season = await getActiveSeason(guildId);
    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }
    res.json({ season });
  } catch (err) {
    req.log.error(err, "GET /leagues/:guildId failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/teams", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const season = await getActiveSeason(guildId);
    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }
    const teams = await db
      .select({
        teamId:     franchiseMcaTeamsTable.teamId,
        fullName:   franchiseMcaTeamsTable.fullName,
        nickName:   franchiseMcaTeamsTable.nickName,
        conference: franchiseMcaTeamsTable.conference,
        userName:   franchiseMcaTeamsTable.userName,
        isHuman:    franchiseMcaTeamsTable.isHuman,
        discordId:  franchiseMcaTeamsTable.discordId,
        updatedAt:  franchiseMcaTeamsTable.updatedAt,
      })
      .from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id))
      .orderBy(asc(franchiseMcaTeamsTable.fullName));
    res.json({ seasonId: season.id, seasonNumber: season.seasonNumber, teams });
  } catch (err) {
    req.log.error(err, "GET /teams failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/standings", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const season = await getActiveSeason(guildId);
    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }
    const standings = await db
      .select({
        teamId: teamSeasonStatsTable.teamId,
        teamName: teamSeasonStatsTable.teamName,
        discordId: teamSeasonStatsTable.discordId,
        wins: teamSeasonStatsTable.wins,
        losses: teamSeasonStatsTable.losses,
        offYds: teamSeasonStatsTable.offYds,
        offPassYds: teamSeasonStatsTable.offPassYds,
        offRushYds: teamSeasonStatsTable.offRushYds,
        offTDs: teamSeasonStatsTable.offTDs,
        offPtsPerGame: teamSeasonStatsTable.offPtsPerGame,
        defPassYds: teamSeasonStatsTable.defPassYds,
        defRushYds: teamSeasonStatsTable.defRushYds,
        defTDs: teamSeasonStatsTable.defTDs,
        teamSacks: teamSeasonStatsTable.teamSacks,
        teamInts: teamSeasonStatsTable.teamInts,
        offRedZonePct: teamSeasonStatsTable.offRedZonePct,
        defRedZonePct: teamSeasonStatsTable.defRedZonePct,
        turnoverDiff: teamSeasonStatsTable.turnoverDiff,
      })
      .from(teamSeasonStatsTable)
      .where(eq(teamSeasonStatsTable.seasonId, season.id))
      .orderBy(desc(teamSeasonStatsTable.wins));
    res.json({ seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, standings });
  } catch (err) {
    req.log.error(err, "GET /standings failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/schedule", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const weekIndex = req.query["week"] !== undefined ? Number(req.query["week"]) : undefined;
  try {
    const season = await getActiveSeason(guildId);
    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }
    const conditions = [eq(franchiseScheduleTable.seasonId, season.id)];
    if (weekIndex !== undefined && !isNaN(weekIndex)) {
      conditions.push(eq(franchiseScheduleTable.weekIndex, weekIndex));
    }
    const games = await db
      .select()
      .from(franchiseScheduleTable)
      .where(and(...conditions))
      .orderBy(asc(franchiseScheduleTable.weekIndex), asc(franchiseScheduleTable.id));
    res.json({ seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, games });
  } catch (err) {
    req.log.error(err, "GET /schedule failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/roster/:teamId", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const teamId = extractParam(req.params["teamId"]!);
  const teamIdNum = Number(teamId);
  if (isNaN(teamIdNum)) {
    res.status(400).json({ error: "Invalid teamId" });
    return;
  }
  try {
    const season = await getActiveSeason(guildId);
    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }
    const roster = await db
      .select()
      .from(franchiseRostersTable)
      .where(and(eq(franchiseRostersTable.seasonId, season.id), eq(franchiseRostersTable.teamId, teamIdNum)))
      .orderBy(desc(franchiseRostersTable.overall));
    if (roster.length === 0) {
      res.status(404).json({ error: "Team not found or roster not imported yet" });
      return;
    }
    res.json({ seasonId: season.id, seasonNumber: season.seasonNumber, teamId: teamIdNum, roster });
  } catch (err) {
    req.log.error(err, "GET /roster/:teamId failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/player-stats", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const position = typeof req.query["position"] === "string" ? req.query["position"].toUpperCase() : undefined;
  try {
    const season = await getActiveSeason(guildId);
    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }
    const allStats = await db
      .select()
      .from(playerSeasonStatsTable)
      .where(eq(playerSeasonStatsTable.seasonId, season.id))
      .orderBy(asc(playerSeasonStatsTable.teamName), asc(playerSeasonStatsTable.lastName));
    const stats = position ? allStats.filter((p) => p.position === position) : allStats;
    res.json({ seasonId: season.id, seasonNumber: season.seasonNumber, stats });
  } catch (err) {
    req.log.error(err, "GET /player-stats failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/draft-picks", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const season = await getActiveSeason(guildId);
    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }
    const picks = await db
      .select()
      .from(franchiseDraftPicksTable)
      .where(eq(franchiseDraftPicksTable.seasonId, season.id))
      .orderBy(asc(franchiseDraftPicksTable.draftYear), asc(franchiseDraftPicksTable.round), asc(franchiseDraftPicksTable.pickNum));
    res.json({ seasonId: season.id, seasonNumber: season.seasonNumber, picks });
  } catch (err) {
    req.log.error(err, "GET /draft-picks failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/news", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const limit = Math.min(Number(req.query["limit"] ?? 25), 200);
  try {
    const season = await getActiveSeason(guildId);
    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }
    const news = await db
      .select()
      .from(leagueNewsTable)
      .where(eq(leagueNewsTable.seasonId, season.id))
      .orderBy(desc(leagueNewsTable.createdAt))
      .limit(limit);
    res.json({ seasonId: season.id, seasonNumber: season.seasonNumber, news });
  } catch (err) {
    req.log.error(err, "GET /news failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
