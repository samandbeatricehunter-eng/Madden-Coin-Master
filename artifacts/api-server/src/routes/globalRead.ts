import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  globalUserRecordsTable,
  userSavingsTable,
  usersTable,
  seasonsTable,
  playerEaIdsTable,
  eaConnectionsTable,
} from "@workspace/db";
import { eq, desc, asc, inArray } from "drizzle-orm";
import { requireApiKey } from "../middleware/requireApiKey.js";

const router: IRouter = Router();

function extractParam(p: string | string[]): string {
  return Array.isArray(p) ? p[0]! : p;
}

router.get("/v1/leagues", requireApiKey, async (req: Request, res: Response) => {
  try {
    const [rows, connections] = await Promise.all([
      db
        .select({
          guildId: seasonsTable.guildId,
          seasonNumber: seasonsTable.seasonNumber,
          isActive: seasonsTable.isActive,
          currentWeek: seasonsTable.currentWeek,
          startedAt: seasonsTable.startedAt,
        })
        .from(seasonsTable)
        .orderBy(asc(seasonsTable.guildId), desc(seasonsTable.seasonNumber)),
      db
        .select({ guildId: eaConnectionsTable.guildId, leagueName: eaConnectionsTable.leagueName })
        .from(eaConnectionsTable),
    ]);

    const nameMap = new Map(connections.map((c) => [c.guildId, c.leagueName]));

    const leagueMap = new Map<string, {
      guildId: string;
      leagueName: string | null;
      activeSeason: number | null;
      currentWeek: string | null;
      totalSeasons: number;
    }>();

    for (const row of rows) {
      const existing = leagueMap.get(row.guildId);
      if (!existing) {
        leagueMap.set(row.guildId, {
          guildId: row.guildId,
          leagueName: nameMap.get(row.guildId) ?? null,
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

    if (records.length === 0) {
      res.json({ leaderboard: [] });
      return;
    }

    const discordIds = records.map((r) => r.discordId);
    const allUserRows = await db
      .select({
        discordId: usersTable.discordId,
        discordUsername: usersTable.discordUsername,
        serverNickname: usersTable.serverNickname,
        team: usersTable.team,
      })
      .from(usersTable)
      .where(inArray(usersTable.discordId, discordIds));

    const userMap = new Map<string, { discordUsername: string; serverNickname: string | null; team: string | null }>();
    for (const u of allUserRows) {
      if (!userMap.has(u.discordId)) {
        userMap.set(u.discordId, { discordUsername: u.discordUsername, serverNickname: u.serverNickname, team: u.team });
      }
    }

    const leaderboard = records.map((r) => ({
      ...r,
      discordUsername: userMap.get(r.discordId)?.discordUsername ?? null,
      serverNickname: userMap.get(r.discordId)?.serverNickname ?? null,
      team: userMap.get(r.discordId)?.team ?? null,
    }));

    res.json({ leaderboard });
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
