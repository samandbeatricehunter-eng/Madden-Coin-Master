import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  usersTable,
  seasonsTable,
  coinTransactionsTable,
  wagersTable,
  payoutConfigTable,
  inventoryTable,
  userSavingsTable,
  globalUserRecordsTable,
  userRecordsTable,
} from "@workspace/db";
import { eq, and, or, desc, asc } from "drizzle-orm";
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

router.get("/v1/leagues/:guildId/users", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const season = await getActiveSeason(guildId);

    const members = await db
      .select({
        id: usersTable.id,
        discordId: usersTable.discordId,
        discordUsername: usersTable.discordUsername,
        serverNickname: usersTable.serverNickname,
        team: usersTable.team,
        balance: usersTable.balance,
        eaId: usersTable.eaId,
        isAdmin: usersTable.isAdmin,
        allTimeSuperbowlWins: usersTable.allTimeSuperbowlWins,
        allTimeSuperbowlLosses: usersTable.allTimeSuperbowlLosses,
        allTimeH2HWins: usersTable.allTimeH2HWins,
        allTimeH2HLosses: usersTable.allTimeH2HLosses,
        playoffSeed: usersTable.playoffSeed,
        playoffConference: usersTable.playoffConference,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.guildId, guildId))
      .orderBy(asc(usersTable.discordUsername));

    let records: typeof userRecordsTable.$inferSelect[] = [];
    if (season) {
      records = await db
        .select()
        .from(userRecordsTable)
        .where(eq(userRecordsTable.seasonId, season.id));
    }

    const recordMap = new Map(records.map((r) => [r.discordId, r]));
    const users = members.map((m) => ({
      ...m,
      currentSeasonRecord: recordMap.get(m.discordId) ?? null,
    }));

    res.json({ guildId, seasonId: season?.id ?? null, users });
  } catch (err) {
    req.log.error(err, "GET /leagues/:guildId/users failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/users/:discordId", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const discordId = extractParam(req.params["discordId"]!);
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

    const season = await getActiveSeason(guildId);

    let currentSeasonRecord = null;
    let inventory: typeof inventoryTable.$inferSelect[] = [];

    if (season) {
      const [record] = await db
        .select()
        .from(userRecordsTable)
        .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
        .limit(1);
      currentSeasonRecord = record ?? null;

      inventory = await db
        .select()
        .from(inventoryTable)
        .where(and(eq(inventoryTable.discordId, discordId), eq(inventoryTable.seasonId, season.id)));
    }

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

    res.json({
      user,
      currentSeasonRecord,
      inventory,
      globalRecord: globalRecord ?? null,
      savingsBalance: savings?.balance ?? 0,
    });
  } catch (err) {
    req.log.error(err, "GET /leagues/:guildId/users/:discordId failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/users/:discordId/transactions", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const discordId = extractParam(req.params["discordId"]!);
  try {
    const transactions = await db
      .select()
      .from(coinTransactionsTable)
      .where(and(eq(coinTransactionsTable.guildId, guildId), eq(coinTransactionsTable.discordId, discordId)))
      .orderBy(desc(coinTransactionsTable.createdAt))
      .limit(50);
    res.json({ guildId, discordId, transactions });
  } catch (err) {
    req.log.error(err, "GET /leagues/:guildId/users/:discordId/transactions failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/wagers", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  try {
    const conditions = [eq(wagersTable.guildId, guildId)];
    if (status) conditions.push(eq(wagersTable.status, status));
    const wagers = await db
      .select()
      .from(wagersTable)
      .where(and(...conditions))
      .orderBy(desc(wagersTable.createdAt))
      .limit(100);
    res.json({ guildId, wagers });
  } catch (err) {
    req.log.error(err, "GET /leagues/:guildId/wagers failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/v1/leagues/:guildId/store", requireApiKey, async (req: Request, res: Response) => {
  const guildId = extractParam(req.params["guildId"]!);
  try {
    const season = await getActiveSeason(guildId);

    const payoutConfig = await db
      .select({ key: payoutConfigTable.key, value: payoutConfigTable.value, description: payoutConfigTable.description })
      .from(payoutConfigTable)
      .where(eq(payoutConfigTable.guildId, guildId))
      .orderBy(asc(payoutConfigTable.key));

    const seasonOverrides = season
      ? {
          coreAttrCost: season.coreAttrCostOverride,
          coreAttrCap: season.coreAttrCapOverride,
          nonCoreAttrCost: season.nonCoreAttrCostOverride,
          nonCoreAttrCap: season.nonCoreAttrCapOverride,
          devUpsCost: season.devUpsCostOverride,
          devUpsCap: season.devUpsCapOverride,
          ageResetsCost: season.ageResetsCostOverride,
          ageResetsCap: season.ageResetsCapOverride,
          legendCost: season.legendCostOverride,
          legendsPerSeasonCap: season.legendsPerSeasonCapOverride,
          customGoldCost: season.customGoldCostOverride,
          customSilverCost: season.customSilverCostOverride,
          customBronzeCost: season.customBronzeCostOverride,
          contractExtensionCost: season.contractExtensionCostOverride,
          contractExtensionCap: season.contractExtensionCapOverride,
          salaryReductionCost: season.salaryReductionCostOverride,
          salaryReductionCap: season.salaryReductionCapOverride,
          bonusReductionCost: season.bonusReductionCostOverride,
          bonusReductionCap: season.bonusReductionCapOverride,
        }
      : null;

    res.json({ guildId, payoutConfig, seasonOverrides });
  } catch (err) {
    req.log.error(err, "GET /leagues/:guildId/store failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
