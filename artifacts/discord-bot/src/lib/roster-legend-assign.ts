import { db } from "@workspace/db";
import { legendsTable, inventoryTable, franchiseRostersTable } from "@workspace/db";
import { eq, and, or, ilike, isNull, sql } from "drizzle-orm";

const PERMANENT_CAP = 4;

export interface LegendAssignResult {
  added:       string[];
  skipped:     string[];
  capBlocked:  string[];
  rosterEmpty: boolean;
}

/**
 * Scans a team's active roster and automatically assigns any matching guild legends
 * to the user's permanent vault (respecting the 4-legend cap).
 *
 * A legend matches a roster player when:
 *   `legend.name` === `${firstName} ${lastName}` (case-insensitive)
 *
 * Already-vaulted legends (matched by legendId OR by name) are skipped silently.
 */
export async function assignRosterLegends(
  discordId: string,
  guildId:   string,
  teamName:  string,
  seasonId:  number,
): Promise<LegendAssignResult> {
  const result: LegendAssignResult = { added: [], skipped: [], capBlocked: [], rosterEmpty: false };

  const allLegends = await db.select().from(legendsTable)
    .where(eq(legendsTable.guildId, guildId));
  if (allLegends.length === 0) return result;

  const roster = await db.select({
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    position:  franchiseRostersTable.position,
  })
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, seasonId),
      ilike(franchiseRostersTable.teamName, `%${teamName.trim()}%`),
    ));

  if (roster.length === 0) {
    result.rosterEmpty = true;
    return result;
  }

  const rosterNames = new Set(
    roster.map(p => `${p.firstName} ${p.lastName}`.toLowerCase().trim()),
  );

  const existingVault = await db.select({
    legendId:   inventoryTable.legendId,
    legendName: inventoryTable.legendName,
  })
    .from(inventoryTable)
    .where(and(
      or(
        teamName ? ilike(inventoryTable.team, teamName) : undefined,
        and(isNull(inventoryTable.team), eq(inventoryTable.discordId, discordId)),
      ),
      eq(inventoryTable.itemType, "legend"),
      sql`${inventoryTable.legendCategory} = 'permanent'`,
    ));

  const vaultIds   = new Set(existingVault.map(v => v.legendId).filter((id): id is number => id !== null));
  const vaultNames = new Set(existingVault.map(v => v.legendName?.toLowerCase().trim()).filter(Boolean));
  let slotsUsed = existingVault.length;

  for (const legend of allLegends) {
    const normName = legend.name.toLowerCase().trim();
    if (!rosterNames.has(normName)) continue;

    if (vaultIds.has(legend.id) || vaultNames.has(normName)) {
      result.skipped.push(legend.name);
      continue;
    }

    if (slotsUsed >= PERMANENT_CAP) {
      result.capBlocked.push(legend.name);
      continue;
    }

    await db.insert(inventoryTable).values({
      discordId,
      seasonId,
      purchaseId:     0,
      itemType:       "legend",
      legendId:       legend.id,
      legendName:     legend.name,
      playerPosition: legend.position,
      legendCategory: "permanent",
      team:           teamName,
    });

    slotsUsed++;
    result.added.push(legend.name);
  }

  return result;
}

/**
 * Formats a LegendAssignResult into a human-readable embed field value.
 */
export function formatLegendAssignResult(result: LegendAssignResult, teamName: string): string {
  if (result.rosterEmpty) {
    return `⚠️ No roster data found for **${teamName}** — import the franchise roster first.`;
  }
  const lines: string[] = [];
  if (result.added.length > 0) {
    lines.push(`✅ **Added to vault:** ${result.added.map(n => `*${n}*`).join(", ")}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`ℹ️ **Already vaulted:** ${result.skipped.map(n => `*${n}*`).join(", ")}`);
  }
  if (result.capBlocked.length > 0) {
    lines.push(`⛔ **Cap full (${result.capBlocked.join(", ")})** — vault is at 4/4`);
  }
  if (lines.length === 0) {
    lines.push("No legends found matching current roster.");
  }
  return lines.join("\n");
}
