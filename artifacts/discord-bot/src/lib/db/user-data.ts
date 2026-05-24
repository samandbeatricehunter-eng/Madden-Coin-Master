import { db } from "@workspace/db";
import {
  usersTable, purchasesTable, inventoryTable,
  seasonStatsTable, userRecordsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Wipes every trace of a user from all economy tables.
 * Called by /addnewuser (clears old occupant) and /deletemember.
 */
export async function deleteAllUserData(discordId: string): Promise<void> {
  await db.delete(purchasesTable).where(eq(purchasesTable.discordId, discordId));
  await db.delete(inventoryTable).where(eq(inventoryTable.discordId, discordId));
  await db.delete(seasonStatsTable).where(eq(seasonStatsTable.discordId, discordId));
  await db.delete(userRecordsTable).where(eq(userRecordsTable.discordId, discordId));
  await db.delete(usersTable).where(eq(usersTable.discordId, discordId));
}

/**
 * Find a user row by team name (case-insensitive).
 */
export async function findUserByTeam(team: string) {
  const all = await db.select().from(usersTable);
  return all.find(u => u.team?.toLowerCase() === team.toLowerCase()) ?? null;
}
