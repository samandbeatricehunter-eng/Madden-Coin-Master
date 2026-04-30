import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  globalUserRecordsTable,
  userSavingsTable,
  usersTable,
  seasonsTable,
  playerEaIdsTable,
} from "@workspace/db";
import { eq, desc, asc } from "drizzle-orm";
import { requireApiKey } from "../middleware/requireApiKey.js";

const router: IRouter = Router();

function extractParam(p: string | string[]): string {
  return Array.isArray(p) ? p[0]! : p;
}

router.get("/v1/leagues", requireApiKey, async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        guildId: seasonsTable.guildId,
        seasonNumber: seasonsTable.seasonNumber,
        isActive: seasonsTable.isActive,
        currentWeek: seasonsTable.currentWeek,
        startedAt: seasonsTable.startedAt,
      })
      .from(seasonsTable)
      .orderBy(asc(seasonsTable.guildId), desc(seasonsTable.seasonNumber));

    const leagueMap = new Map<string, {
      guildId: string;
      activeSeason: number | null;
      currentWeek: string | null;
      totalSeasons: number;
    }>();

    for (const row of rows) {
      const existing = leagueMap.get(row.guildId);
      if (!existing) {
        leagueMap.set(row.guildId, {
          guildId: row.guildId,
          activeSeason: row.isActive ? row.seasonNumber : null,
          currentWeek: row.isActive ? row.currentWeek : null,
          totalSeasons: 1,
        });
      } else {
        existing.totalSeasons += 1;
        if (row.isActive) {
          existing.activeSeason = row.seasonNumber;
          existing.currentWeek = row.currentWeek;
        }
      }
    }

    res.json({ leagues: Array.from(leagueMap.values()) });
  } catch (err) {
    req.log.error(err, "GET /v1/leagues failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/records", requireApiKey, async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  try {
    const records = await db
      .select()
      .from(globalUserRecordsTable)
      .orderBy(desc(globalUserRecordsTable.wins), desc(globalUserRecordsTable.pointDifferential))
      .limit(limit);
    res.json({ leaderboard: records });
  } catch (err) {
    req.log.error(err, "GET /v1/records failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/users/:discordId", requireApiKey, async (req: Request, res: Response) => {
  const discordId = extractParam(req.params["discordId"]!);
  try {
    const [globalRecord] = await db
      .select()
      .from(globalUserRecordsTable)
      .where(eq(globalUserRecordsTable.discordId, discordId))
      .limit(1);

    const [savings] = await db
      .select()
      .from(userSavingsTable)
      .where(eq(userSavingsTable.discordId, discordId))
      .limit(1);

    const guildProfiles = await db
      .select({
        guildId: usersTable.guildId,
        discordUsername: usersTable.discordUsername,
        serverNickname: usersTable.serverNickname,
        team: usersTable.team,
        balance: usersTable.balance,
        isAdmin: usersTable.isAdmin,
        eaId: usersTable.eaId,
        allTimeH2HWins: usersTable.allTimeH2HWins,
        allTimeH2HLosses: usersTable.allTimeH2HLosses,
        allTimeSuperbowlWins: usersTable.allTimeSuperbowlWins,
        allTimeSuperbowlLosses: usersTable.allTimeSuperbowlLosses,
      })
      .from(usersTable)
      .where(eq(usersTable.discordId, discordId))
      .orderBy(asc(usersTable.guildId));

    const eaIds = await db
      .select({ eaId: playerEaIdsTable.eaId, console: playerEaIdsTable.console, slot: playerEaIdsTable.slot })
      .from(playerEaIdsTable)
      .where(eq(playerEaIdsTable.discordId, discordId))
      .orderBy(asc(playerEaIdsTable.slot));

    if (!globalRecord && guildProfiles.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      discordId,
      globalRecord: globalRecord ?? null,
      savingsBalance: savings?.balance ?? 0,
      guildProfiles,
      eaIds,
    });
  } catch (err) {
    req.log.error(err, "GET /v1/users/:discordId failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
