import { db } from "@workspace/db";
import {
  usersTable, seasonsTable, seasonStatsTable, purchasesTable,
  inventoryTable, legendsTable, coinTransactionsTable, rulesTable,
  userRecordsTable, gameLogTable,
  type User, type Season, type SeasonStats,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

// ── Default rules (seeds the DB if a section has never been set) ───────────────
export const SECTION_META: Record<string, { title: string; color: number }> = {
  sportsmanship: { title: "🤝 Sportsmanship",     color: 0x57f287 },
  activity:      { title: "📅 Activity",            color: 0x5865f2 },
  settings:      { title: "⚙️ Settings",            color: 0xfee75c },
  "4th_down":    { title: "4️⃣ 4th Down Rules",     color: 0xeb6f31 },
  trade_policy:  { title: "🔄 Trade Policy",        color: 0xa855f7 },
  off_season:    { title: "🏖️ Off-Season Rules",    color: 0xff73fa },
};

export const DEFAULT_RULES: Record<string, string[]> = {
  sportsmanship: [
    "Treat all league members with respect at all times.",
    "No trash talk that crosses into personal attacks — keep it competitive, not personal.",
    "Rage quitting or intentionally disconnecting to avoid a loss is not tolerated.",
    "Do not exploit glitches, cheese plays, or any mechanics considered unsportsmanlike by the league.",
    "Disputes must be brought to a commissioner — do not handle conflicts in public channels.",
    "Any member found to be acting in bad faith may be removed from the league.",
  ],
  activity: [
    "All games must be completed by the weekly deadline set by the commissioner.",
    "Members must be reachable and responsive — check in at least every 48 hours during the season.",
    "If you cannot play your game on time, notify your opponent AND a commissioner as early as possible.",
    "Two unexcused missed deadlines in a season may result in replacement.",
    "CPU games are not a substitute for playing your opponent — schedule your games.",
    "If a member goes inactive without notice, their team may be simmed or reassigned.",
  ],
  settings: [
    "The league plays on [difficulty] with [quarter length] minute quarters.",
    "Injuries are set to [on/off]. Fatigue is set to [on/off].",
    "Home team controls stadium and weather settings — no extreme conditions without mutual agreement.",
    "All games are played on the default playbook unless both players agree otherwise.",
    "No pausing the game excessively to slow down momentum or frustrate your opponent.",
    "Any settings disputes should be reported to a commissioner before the game is played.",
  ],
  "4th_down": [
    "Going for it on 4th down is allowed in all situations — no restrictions.",
    "However, repeatedly going for it on 4th down early in the game while blowing out an opponent is considered unsportsmanlike.",
    "Onside kicks are only allowed if you are trailing in the 4th quarter.",
    "Fake punts and fake field goals are always allowed.",
    "Use good judgment — if a commissioner rules a 4th down decision as poor sportsmanship, a warning may be issued.",
  ],
  trade_policy: [
    "All trades must be submitted to the commissioner for review before being accepted in-game.",
    "Trades suspected of being collusion (intentionally unbalanced to benefit one team) will be vetoed.",
    "The trade deadline is set each season by the commissioner — no trades after the deadline.",
    "CPU trades are not allowed without commissioner approval.",
    "A trade vetoed by the commissioner is final — do not attempt to re-submit the same trade.",
    "Both parties must confirm a trade in the league Discord before it is submitted in-game.",
  ],
  off_season: [
    "The draft order is determined by reverse standings (worst record picks first).",
    "Free agency begins after the draft — all signings must follow the salary cap rules.",
    "Salary cap penalties carry over from the previous season if applicable.",
    "Re-signing windows open before free agency — take advantage of these before your players hit the market.",
    "Fantasy draft rules apply if the league resets — all players are eligible regardless of previous team.",
    "Off-season coin purchases (attribute upgrades, dev ups, etc.) reset at the start of each new season.",
  ],
};

export async function getOrSeedRules(section: string): Promise<string[]> {
  const row = await db.select().from(rulesTable).where(eq(rulesTable.section, section)).limit(1);
  if (row.length > 0) return row[0]!.rules;
  const defaults = DEFAULT_RULES[section] ?? [];
  await db.insert(rulesTable).values({ section, rules: defaults }).onConflictDoNothing();
  return defaults;
}

export async function setRules(section: string, rules: string[], updatedBy: string): Promise<void> {
  await db.insert(rulesTable)
    .values({ section, rules, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: rulesTable.section,
      set: { rules, updatedBy, updatedAt: new Date() },
    });
}

export async function isAdminUser(discordId: string): Promise<boolean> {
  const user = await db.select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.discordId, discordId))
    .limit(1);
  return user[0]?.isAdmin ?? false;
}

export async function logTransaction(
  discordId: string,
  amount: number,
  type: "purchase" | "purchase_refund" | "addcoins" | "removecoins" | "sendcoins_sent" | "sendcoins_received" | "season_adjustment" | "setbalance",
  description: string,
  relatedUserId?: string,
): Promise<void> {
  await db.insert(coinTransactionsTable).values({
    discordId,
    amount,
    type,
    description,
    relatedUserId: relatedUserId ?? null,
  });
}

export async function getOrCreateUser(discordId: string, discordUsername: string): Promise<User> {
  const existing = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
  if (existing.length > 0) {
    // Update username in case it changed
    await db.update(usersTable).set({ discordUsername, updatedAt: new Date() }).where(eq(usersTable.discordId, discordId));
    return existing[0]!;
  }
  const [user] = await db.insert(usersTable).values({ discordId, discordUsername }).returning();
  return user!;
}

export async function getActiveSeason(): Promise<Season | null> {
  const seasons = await db.select().from(seasonsTable).where(eq(seasonsTable.isActive, true)).limit(1);
  return seasons[0] ?? null;
}

export async function getOrCreateActiveSeason(): Promise<Season> {
  const existing = await getActiveSeason();
  if (existing) return existing;
  const [season] = await db.insert(seasonsTable).values({ seasonNumber: 1, isActive: true }).returning();
  return season!;
}

export async function getSeasonStats(discordId: string, seasonId: number): Promise<SeasonStats> {
  const stats = await db.select().from(seasonStatsTable)
    .where(and(eq(seasonStatsTable.discordId, discordId), eq(seasonStatsTable.seasonId, seasonId)))
    .limit(1);
  if (stats.length > 0) return stats[0]!;
  const [newStats] = await db.insert(seasonStatsTable).values({ discordId, seasonId }).returning();
  return newStats!;
}

export async function getUserBalance(discordId: string): Promise<number> {
  const user = await db.select({ balance: usersTable.balance }).from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
  return user[0]?.balance ?? 0;
}

export async function deductBalance(discordId: string, amount: number): Promise<boolean> {
  const user = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
  if (!user[0] || user[0].balance < amount) return false;
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} - ${amount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, discordId));
  return true;
}

export async function addBalance(discordId: string, amount: number): Promise<void> {
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, discordId));
}

export async function getInventoryCount(discordId: string, seasonId: number) {
  const items = await db.select().from(inventoryTable)
    .where(and(eq(inventoryTable.discordId, discordId), eq(inventoryTable.seasonId, seasonId)));
  const legends = items.filter(i => i.itemType === "legend").length;
  const customs = items.filter(i =>
    i.itemType === "custom_player_gold" || i.itemType === "custom_player_silver" || i.itemType === "custom_player_bronze"
  ).length;
  return { legends, customs, total: items.length };
}

export async function getSeasonRules(season: Season) {
  const { COSTS, LIMITS } = await import("./constants.js");
  return {
    coreAttrCost:    season.coreAttrCostOverride    ?? COSTS.core_attribute,
    coreAttrCap:     season.coreAttrCapOverride     ?? LIMITS.coreAttrPerSeason,
    nonCoreAttrCost: season.nonCoreAttrCostOverride ?? COSTS.non_core_attribute,
    nonCoreAttrCap:  season.nonCoreAttrCapOverride  ?? LIMITS.nonCoreAttrPerSeason,
    devUpsCap:       season.devUpsCapOverride       ?? LIMITS.devUpsPerSeason,
    devUpsCost:      season.devUpsCostOverride      ?? COSTS.dev_up,
    ageResetsCap:    season.ageResetsCapOverride    ?? LIMITS.ageResetsPerSeason,
    ageResetCost:    season.ageResetsCostOverride   ?? COSTS.age_reset,
  };
}

export async function upsertH2HRecord(
  discordId: string,
  seasonId: number,
  won: boolean,
  pointSpread: number,
): Promise<void> {
  const userInfo = await db.select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
  if (!userInfo[0]) return;

  const existing = await db.select({ id: userRecordsTable.id })
    .from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, seasonId)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userRecordsTable).set({
      wins:              won  ? sql`${userRecordsTable.wins}   + 1` : userRecordsTable.wins,
      losses:            !won ? sql`${userRecordsTable.losses} + 1` : userRecordsTable.losses,
      pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointSpread}`,
      updatedAt: new Date(),
    }).where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, seasonId)));
  } else {
    await db.insert(userRecordsTable).values({
      discordId,
      discordUsername: userInfo[0].discordUsername,
      team:            userInfo[0].team ?? null,
      seasonId,
      wins:              won ? 1 : 0,
      losses:            won ? 0 : 1,
      pointDifferential: pointSpread,
    });
  }
}

export async function appendGameLog(
  discordId: string,
  seasonId: number,
  result: "win" | "loss",
  pointSpread: number,
  opponentLabel: string,
  gameType: "regular_season" | "playoff" | "superbowl" = "regular_season",
): Promise<void> {
  await db.insert(gameLogTable).values({ discordId, seasonId, result, pointSpread, opponentLabel, gameType });
}

export async function getLegendPurchaseHistory(discordId: string) {
  const purchases = await db.select().from(purchasesTable)
    .where(and(
      eq(purchasesTable.discordId, discordId),
      eq(purchasesTable.purchaseType, "legend"),
    ));
  const approved = purchases.filter(p => p.status === "approved" || p.status === "pending");
  const refunded = purchases.filter(p => p.status === "refunded");
  return { total: approved.length, refunded: refunded.length, purchases };
}

/**
 * Normalize all positions to consolidated categories:
 *   OL — all offensive linemen (LT, LG, C, RG, RT)
 *   DL — all defensive linemen (LE, RE, DT, NT, DE, E)
 *   LB — all linebackers (LOLB, MLB, ROLB, OLB, ILB)
 *   DB — all defensive backs (CB, FS, SS, S, NCB)
 *
 * Safe to run on every startup — only updates rows that still have old names.
 */
export async function normalizeDefensivePositions(): Promise<void> {
  const OL_SET = ["LT", "LG", "C", "RG", "RT"];
  const DL_SET = ["LE", "RE", "DT", "NT", "DE", "E"];
  const LB_SET = ["LOLB", "MLB", "ROLB", "OLB", "ILB"];
  const DB_SET = ["CB", "FS", "SS", "S", "NCB"];

  const toSql = (vals: string[]) => vals.map(v => `'${v}'`).join(", ");

  for (const [newPos, oldSet] of [["OL", OL_SET], ["DL", DL_SET], ["LB", LB_SET], ["DB", DB_SET]] as const) {
    const inClause = toSql(oldSet);
    await db.execute(sql.raw(`UPDATE legends   SET position        = '${newPos}' WHERE position        IN (${inClause})`));
    await db.execute(sql.raw(`UPDATE inventory SET player_position = '${newPos}' WHERE player_position IN (${inClause})`));
    await db.execute(sql.raw(`UPDATE purchases SET player_position = '${newPos}' WHERE player_position IN (${inClause})`));
  }

  console.log("✅ Positions normalized (OL / DL / LB / DB)");
}
