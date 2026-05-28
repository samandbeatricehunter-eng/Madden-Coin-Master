import { db } from "@workspace/db";
import { and, eq, notInArray } from "drizzle-orm";
import {
  legendsTable,
  purchasesTable,
} from "@workspace/db";
import {
  getOrCreateActiveSeason,
  getOrCreateUser,
  getPurchasedLegendIds,
  getTeamLegendCount,
  deductBalance,
  logTransaction,
} from "../../../../db/db-helpers.js";
import { LIMITS, LEGEND_CUSTOM_PURCHASE_WEEKS } from "../../../../constants.js";

export type LegendCatalogItem = {
  id: number;
  name: string;
  position: string;
  cost: number;
};

export type LegendPurchaseValidation = {
  ok: true;
  legend: LegendCatalogItem;
  seasonId: number;
  cost: number;
  userBalance: number;
} | {
  ok: false;
  reason: string;
};

export const LEGEND_POSITION_LABELS: Record<string, string> = {
  QB: "QB — Quarterback",
  HB: "HB — Halfback",
  FB: "FB — Fullback",
  WR: "WR — Wide Receiver",
  TE: "TE — Tight End",
  OL: "OL — Offensive Line",
  LT: "LT — Left Tackle",
  LG: "LG — Left Guard",
  C: "C — Center",
  RG: "RG — Right Guard",
  RT: "RT — Right Tackle",
  DB: "DB — Defensive Back",
  LE: "LE — Left Defensive End",
  RE: "RE — Right Defensive End",
  DT: "DT — Defensive Tackle",
  DL: "DL — Defensive Line",
  LOLB: "LOLB — Left Outside LB",
  LB: "LB — Linebacker",
  MLB: "MLB — Middle Linebacker",
  ROLB: "ROLB — Right Outside LB",
  CB: "CB — Cornerback",
  FS: "FS — Free Safety",
  SS: "SS — Strong Safety",
  K: "K — Kicker",
  P: "P — Punter",
};

const LEGEND_POSITION_ORDER = ["QB", "HB", "FB", "WR", "TE", "OL", "DL", "LB", "DB"];

function sortLegendPositions(positions: string[]): string[] {
  const set = new Set(positions.filter(Boolean));
  return [
    ...LEGEND_POSITION_ORDER.filter((position) => set.has(position)),
    ...[...set].filter((position) => !LEGEND_POSITION_ORDER.includes(position)).sort(),
  ];
}

export async function listAvailableLegendPositions(guildId: string): Promise<string[]> {
  const purchasedIds = await getPurchasedLegendIds(guildId);
  const rows = await db
    .selectDistinct({ position: legendsTable.position })
    .from(legendsTable)
    .where(and(
      eq(legendsTable.guildId, guildId),
      eq(legendsTable.isAvailable, true),
      ...(purchasedIds.length > 0 ? [notInArray(legendsTable.id, purchasedIds)] : []),
    ));

  return sortLegendPositions(rows.map((row) => row.position));
}

export async function listAvailableLegendsByPosition(guildId: string, position: string): Promise<LegendCatalogItem[]> {
  const purchasedIds = await getPurchasedLegendIds(guildId);
  const rows = await db
    .select({
      id: legendsTable.id,
      name: legendsTable.name,
      position: legendsTable.position,
      cost: legendsTable.cost,
    })
    .from(legendsTable)
    .where(and(
      eq(legendsTable.guildId, guildId),
      eq(legendsTable.isAvailable, true),
      eq(legendsTable.position, position),
      ...(purchasedIds.length > 0 ? [notInArray(legendsTable.id, purchasedIds)] : []),
    ))
    .orderBy(legendsTable.name);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    position: row.position,
    cost: row.cost ?? 0,
  }));
}

export async function getLegendCatalogItem(guildId: string, legendId: number): Promise<LegendCatalogItem | null> {
  const row = await db
    .select({
      id: legendsTable.id,
      name: legendsTable.name,
      position: legendsTable.position,
      cost: legendsTable.cost,
      isAvailable: legendsTable.isAvailable,
    })
    .from(legendsTable)
    .where(and(eq(legendsTable.guildId, guildId), eq(legendsTable.id, legendId)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!row || !row.isAvailable) return null;
  return { id: row.id, name: row.name, position: row.position, cost: row.cost ?? 0 };
}

export async function validateLegendPurchase(input: {
  guildId: string;
  discordId: string;
  username: string;
  legendId: number;
}): Promise<LegendPurchaseValidation> {
  const [legend, season, user] = await Promise.all([
    getLegendCatalogItem(input.guildId, input.legendId),
    getOrCreateActiveSeason(input.guildId),
    getOrCreateUser(input.discordId, input.username, input.guildId),
  ]);

  if (!legend) return { ok: false, reason: "❌ Legend no longer available." };

  if (!LEGEND_CUSTOM_PURCHASE_WEEKS.has(season.currentWeek ?? "")) {
    return {
      ok: false,
      reason: `❌ Legend purchases must be submitted before Wildcard week. Current week: **Week ${season.currentWeek ?? "?"}**.`,
    };
  }

  const existingPending = await db
    .select({ id: purchasesTable.id })
    .from(purchasesTable)
    .where(and(
      eq(purchasesTable.guildId, input.guildId),
      eq(purchasesTable.discordId, input.discordId),
      eq(purchasesTable.seasonId, season.id),
      eq(purchasesTable.purchaseType, "legend"),
      eq(purchasesTable.legendId, legend.id),
      eq(purchasesTable.status, "pending"),
    ))
    .limit(1)
    .then((rows) => rows[0]);

  if (existingPending) {
    return { ok: false, reason: "❌ You already have a pending commissioner review for this legend." };
  }

  const teamCount = await getTeamLegendCount(user.team, input.discordId, season.id);
  if (teamCount.legends >= LIMITS.legendsPerTeam) {
    return {
      ok: false,
      reason: `❌ Your team has reached the maximum of **${LIMITS.legendsPerTeam} legends** allowed.`,
    };
  }

  const cost = legend.cost ?? 0;
  if (user.balance < cost) {
    return {
      ok: false,
      reason: `❌ Insufficient coins. You need **${cost.toLocaleString()}** but only have **${user.balance.toLocaleString()}**.`,
    };
  }

  return {
    ok: true,
    legend,
    seasonId: season.id,
    cost,
    userBalance: user.balance,
  };
}

export async function submitLegendPurchase(input: {
  guildId: string;
  discordId: string;
  username: string;
  legendId: number;
}): Promise<{ ok: true; purchaseId: number; legend: LegendCatalogItem; cost: number } | { ok: false; reason: string }> {
  const validation = await validateLegendPurchase(input);
  if (!validation.ok) return validation;

  await deductBalance(input.discordId, validation.cost, input.guildId);
  await logTransaction(input.discordId, -validation.cost, "purchase", `Legend purchase — ${validation.legend.name}`, input.guildId);

  const [inserted] = await db
    .insert(purchasesTable)
    .values({
      guildId: input.guildId,
      discordId: input.discordId,
      seasonId: validation.seasonId,
      purchaseType: "legend",
      legendId: validation.legend.id,
      playerName: validation.legend.name,
      playerPosition: validation.legend.position ?? "",
      cost: validation.cost,
      status: "pending",
      notes: `Legend: ${validation.legend.name}`,
    })
    .returning({ id: purchasesTable.id });

  return {
    ok: true,
    purchaseId: inserted!.id,
    legend: validation.legend,
    cost: validation.cost,
  };
}
