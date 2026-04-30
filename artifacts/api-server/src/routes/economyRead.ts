import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  usersTable,
  seasonsTable,
  coinTransactionsTable,
  wagersTable,
  payoutConfigTable,
  purchasesTable,
  inventoryTable,
  legendsTable,
  userRecordsTable,
} from "@workspace/db";
import { eq, and, desc, asc, or } from "drizzle-orm";
import { requireApiKey } from "../middleware/requireApiKey.js";

const router: IRouter = Router();

function extractParam(p: string | string[]): string {
  return Array.isArray(p) ? p[0]! : p;
}

router.use("/v1/leagues/:guildId/economy", requireApiKey);

router.get("/v1/leagues/:guildId/economy/leaderboard", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const members = await db
      .select({
        discordId: usersTable.discordId,
        discordUsername: usersTable.discordUsername,
        serverNickname: usersTable.serverNickname,
        team: usersTable.team,
        balance: usersTable.balance,
        allTimeH2HWins: usersTable.allTimeH2HWins,
        allTimeH2HLosses: usersTable.allTimeH2HLosses,
        allTimeSuperbowlWins: usersTable.allTimeSuperbowlWins,
      })
      .from(usersTable)
      .where(eq(usersTable.guildId, guildId))
      .orderBy(desc(usersTable.balance));
    res.json({ guildId, leaderboard: members });
  } catch (err) {
    req.log.error(err, "GET /economy/leaderboard failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/economy/users/:discordId", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!); const discordId = extractParam(req.params["discordId"]!);
  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.guildId, guildId), eq(usersTable.discordId, discordId)))
      .limit(1);
    if (!user) {
      res.status(404).json({ error: "User not found in this guild" });
      return;
    }

    const [season] = await db
      .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
      .from(seasonsTable)
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
      .orderBy(desc(seasonsTable.seasonNumber))
      .limit(1);

    let seasonRecord = null;
    if (season) {
      const [record] = await db
        .select()
        .from(userRecordsTable)
        .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
        .limit(1);
      seasonRecord = record ?? null;
    }

    const recentTx = await db
      .select()
      .from(coinTransactionsTable)
      .where(and(eq(coinTransactionsTable.guildId, guildId), eq(coinTransactionsTable.discordId, discordId)))
      .orderBy(desc(coinTransactionsTable.createdAt))
      .limit(20);

    res.json({ user, currentSeasonRecord: seasonRecord, recentTransactions: recentTx });
  } catch (err) {
    req.log.error(err, "GET /economy/users/:discordId failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/economy/transactions", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const discordId = typeof req.query["discordId"] === "string" ? req.query["discordId"] : undefined;
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  try {
    const conditions = [eq(coinTransactionsTable.guildId, guildId)];
    if (discordId) {
      conditions.push(eq(coinTransactionsTable.discordId, discordId));
    }
    const transactions = await db
      .select()
      .from(coinTransactionsTable)
      .where(and(...conditions))
      .orderBy(desc(coinTransactionsTable.createdAt))
      .limit(limit);
    res.json({ guildId, transactions });
  } catch (err) {
    req.log.error(err, "GET /economy/transactions failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/economy/wagers", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  const discordId = typeof req.query["discordId"] === "string" ? req.query["discordId"] : undefined;
  try {
    let wagers;
    if (discordId) {
      const conditions = [
        eq(wagersTable.guildId, guildId),
        or(eq(wagersTable.challengerId, discordId), eq(wagersTable.opponentId, discordId))!,
      ];
      if (status) conditions.push(eq(wagersTable.status, status));
      wagers = await db
        .select()
        .from(wagersTable)
        .where(and(...conditions))
        .orderBy(desc(wagersTable.createdAt))
        .limit(100);
    } else {
      const conditions = [eq(wagersTable.guildId, guildId)];
      if (status) conditions.push(eq(wagersTable.status, status));
      wagers = await db
        .select()
        .from(wagersTable)
        .where(and(...conditions))
        .orderBy(desc(wagersTable.createdAt))
        .limit(100);
    }
    res.json({ guildId, wagers });
  } catch (err) {
    req.log.error(err, "GET /economy/wagers failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/economy/payout-config", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const config = await db
      .select({ key: payoutConfigTable.key, value: payoutConfigTable.value, description: payoutConfigTable.description })
      .from(payoutConfigTable)
      .where(eq(payoutConfigTable.guildId, guildId))
      .orderBy(asc(payoutConfigTable.key));
    res.json({ guildId, payoutConfig: config });
  } catch (err) {
    req.log.error(err, "GET /economy/payout-config failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/economy/legends", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const legends = await db
      .select()
      .from(legendsTable)
      .where(eq(legendsTable.guildId, guildId))
      .orderBy(asc(legendsTable.name));
    res.json({ guildId, legends });
  } catch (err) {
    req.log.error(err, "GET /economy/legends failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/economy/purchases", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const discordId = typeof req.query["discordId"] === "string" ? req.query["discordId"] : undefined;
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  try {
    const [season] = await db
      .select({ id: seasonsTable.id })
      .from(seasonsTable)
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
      .orderBy(desc(seasonsTable.seasonNumber))
      .limit(1);

    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }

    const conditions = [eq(purchasesTable.seasonId, season.id)];
    if (discordId) conditions.push(eq(purchasesTable.discordId, discordId));
    if (status) conditions.push(eq(purchasesTable.status, status as "pending" | "approved" | "refunded"));

    const purchases = await db
      .select()
      .from(purchasesTable)
      .where(and(...conditions))
      .orderBy(desc(purchasesTable.createdAt))
      .limit(limit);
    res.json({ guildId, seasonId: season.id, purchases });
  } catch (err) {
    req.log.error(err, "GET /economy/purchases failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/economy/inventory", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const discordId = typeof req.query["discordId"] === "string" ? req.query["discordId"] : undefined;
  try {
    const [season] = await db
      .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
      .from(seasonsTable)
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
      .orderBy(desc(seasonsTable.seasonNumber))
      .limit(1);

    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }

    const conditions = [eq(inventoryTable.seasonId, season.id)];
    if (discordId) conditions.push(eq(inventoryTable.discordId, discordId));

    const inventory = await db
      .select()
      .from(inventoryTable)
      .where(and(...conditions))
      .orderBy(asc(inventoryTable.discordId));
    res.json({ guildId, seasonId: season.id, seasonNumber: season.seasonNumber, inventory });
  } catch (err) {
    req.log.error(err, "GET /economy/inventory failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/economy/records", async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const [season] = await db
      .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber, currentWeek: seasonsTable.currentWeek })
      .from(seasonsTable)
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
      .orderBy(desc(seasonsTable.seasonNumber))
      .limit(1);

    if (!season) {
      res.status(404).json({ error: "No active season found for this guild" });
      return;
    }

    const records = await db
      .select()
      .from(userRecordsTable)
      .where(eq(userRecordsTable.seasonId, season.id))
      .orderBy(desc(userRecordsTable.wins));
    res.json({ guildId, seasonId: season.id, seasonNumber: season.seasonNumber, currentWeek: season.currentWeek, records });
  } catch (err) {
    req.log.error(err, "GET /economy/records failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
