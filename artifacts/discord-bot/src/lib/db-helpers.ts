import { db } from "@workspace/db";
import {
  usersTable, seasonsTable, seasonStatsTable, purchasesTable,
  inventoryTable, legendsTable, coinTransactionsTable,
  type User, type Season, type SeasonStats,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

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
