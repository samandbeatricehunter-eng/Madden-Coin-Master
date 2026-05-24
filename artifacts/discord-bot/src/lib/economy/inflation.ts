/**
 * Per-guild economy inflation.
 *
 * Goal: gently scale every store PRICE up when a guild has accumulated too
 * many coins, so users can't stack unlimited balances and keep buying at the
 * old rate. Scales down (to a floor) when the economy is coin-poor.
 *
 * - Multiplier is stored on `server_settings.inflation_multiplier_bps`
 *   (basis points; 10000 = 1.00x).
 * - Computed daily by the savings-interest scheduler tick (one call per guild).
 * - Applied at exactly ONE chokepoint: `getSeasonRules()` multiplies every
 *   *Cost field before returning rules. That means every existing read &
 *   debit site automatically picks up the inflated price with no other edits.
 * - NOT applied to payouts — would create a runaway feedback loop.
 *
 * Formula:
 *   ratio       = max(median, 1) / max(target, 1)
 *   raw         = sqrt(ratio)              // softens the curve
 *   clamped     = clamp(raw, min, max)     // admin-tunable floor/ceiling
 *   roundedBps  = round(clamped * 10000 / 500) * 500   // snap to nearest 5%
 *
 * Median (not mean) is used so a handful of whales can't dominate the signal.
 * Only users with balance > 0 are sampled, so dead zero-balance accounts
 * don't dilute it.
 */

import { db, usersTable, serverSettingsTable } from "@workspace/db";
import { and, eq, gt } from "drizzle-orm";

const BPS = 10000;

export type InflationState = {
  enabled:       boolean;
  multiplier:    number;   // e.g. 1.25
  multiplierBps: number;   // e.g. 12500
  medianBalance: number;
  sampleSize:    number;
  targetMedian:  number;
  minBps:        number;
  maxBps:        number;
  computedAt:    Date | null;
};

/**
 * Apply the guild's inflation multiplier to a base price.
 * Always returns at least 1 coin so admins can't accidentally make items free.
 */
export function applyInflation(baseCost: number, multiplierBps: number): number {
  if (!Number.isFinite(baseCost) || baseCost <= 0) return baseCost;
  const adjusted = Math.round((baseCost * multiplierBps) / BPS);
  return Math.max(1, adjusted);
}

/**
 * Read the cached inflation multiplier (in basis points) for a guild.
 * Returns 10000 (= 1.00x, i.e. no scaling) when inflation is disabled, the
 * settings row is missing, or the cached value is non-positive.
 *
 * This is the hot-path read — called from `getSeasonRules` on every menu
 * render and purchase. Keep it cheap.
 */
export async function getInflationBpsForGuild(guildId: string): Promise<number> {
  if (!guildId) return BPS;
  const [row] = await db
    .select({
      enabled: serverSettingsTable.inflationEnabled,
      bps:     serverSettingsTable.inflationMultiplierBps,
    })
    .from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId))
    .limit(1);
  if (!row || !row.enabled) return BPS;
  const bps = row.bps ?? BPS;
  return bps > 0 ? bps : BPS;
}

/** Full state read — used by the admin UI and the store-overview badge. */
export async function getInflationState(guildId: string): Promise<InflationState> {
  const [row] = await db
    .select({
      enabled:       serverSettingsTable.inflationEnabled,
      bps:           serverSettingsTable.inflationMultiplierBps,
      median:        serverSettingsTable.inflationMedianBalance,
      sample:        serverSettingsTable.inflationSampleSize,
      target:        serverSettingsTable.inflationTargetMedian,
      minBps:        serverSettingsTable.inflationMinBps,
      maxBps:        serverSettingsTable.inflationMaxBps,
      computedAt:    serverSettingsTable.inflationComputedAt,
    })
    .from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId))
    .limit(1);
  const bps = row?.bps ?? BPS;
  return {
    enabled:       row?.enabled ?? true,
    multiplier:    bps / BPS,
    multiplierBps: bps,
    medianBalance: row?.median ?? 0,
    sampleSize:    row?.sample ?? 0,
    targetMedian:  row?.target ?? 500,
    minBps:        row?.minBps ?? 9000,
    maxBps:        row?.maxBps ?? 20000,
    computedAt:    row?.computedAt ?? null,
  };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return Math.round((sorted[n / 2 - 1]! + sorted[n / 2]!) / 2);
}

/**
 * Recompute the inflation multiplier for a single guild and write it to
 * server_settings. Safe to call multiple times — idempotent.
 *
 * Returns the new state. Never throws — logs and returns the previous state
 * on error so the scheduler keeps moving.
 */
export async function recomputeInflationForGuild(guildId: string): Promise<InflationState> {
  const prior = await getInflationState(guildId);

  // Skip when disabled — but still return prior state for the scheduler log.
  if (!prior.enabled) return prior;

  try {
    // Sample all non-zero balances for this guild. Median is robust to whales;
    // filtering out zero balances ignores dead accounts.
    const rows = await db
      .select({ balance: usersTable.balance })
      .from(usersTable)
      .where(and(
        eq(usersTable.guildId, guildId),
        gt(usersTable.balance, 0),
      ));

    const sorted = rows
      .map(r => Number(r.balance))
      .filter(n => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    const sampleSize    = sorted.length;
    const medianBalance = median(sorted);

    // Need a non-trivial sample to compute anything meaningful. Below this,
    // hold at 1.00x so brand-new guilds don't get hit by noise.
    const MIN_SAMPLE = 5;
    let multiplierBps: number;
    if (sampleSize < MIN_SAMPLE || medianBalance <= 0) {
      multiplierBps = BPS;
    } else {
      const target = Math.max(1, prior.targetMedian);
      const ratio  = medianBalance / target;
      const raw    = Math.sqrt(ratio);  // softens the curve
      const rawBps = Math.round(raw * BPS);
      const clamped = Math.min(prior.maxBps, Math.max(prior.minBps, rawBps));
      // Snap to nearest 5% step (500 bps) so the displayed multiplier moves
      // in clean increments and small day-to-day balance drift doesn't churn
      // the price.
      multiplierBps = Math.round(clamped / 500) * 500;
    }

    await db.update(serverSettingsTable)
      .set({
        inflationMultiplierBps: multiplierBps,
        inflationMedianBalance: medianBalance,
        inflationSampleSize:    sampleSize,
        inflationComputedAt:    new Date(),
        updatedAt:              new Date(),
      })
      .where(eq(serverSettingsTable.guildId, guildId));

    return {
      ...prior,
      multiplierBps,
      multiplier:    multiplierBps / BPS,
      medianBalance,
      sampleSize,
      computedAt:    new Date(),
    };
  } catch (err) {
    console.error(`[inflation] recompute failed for guild ${guildId}:`, err);
    return prior;
  }
}

/** Recompute every guild that has a server_settings row. */
export async function recomputeAllGuildInflation(): Promise<{ guildsProcessed: number }> {
  const guilds = await db
    .select({ guildId: serverSettingsTable.guildId })
    .from(serverSettingsTable);
  let processed = 0;
  for (const g of guilds) {
    if (!g.guildId || g.guildId === "global") continue;
    await recomputeInflationForGuild(g.guildId);
    processed++;
  }
  return { guildsProcessed: processed };
}

/** Format the multiplier for display, e.g. 1.0000 → "1.00x", 0.95 → "0.95x". */
export function formatMultiplier(bps: number): string {
  return `${(bps / BPS).toFixed(2)}x`;
}

/** "📈 1.25x" / "📉 0.90x" / "➖ 1.00x" prefixed indicator for embeds. */
export function inflationBadge(bps: number): string {
  if (bps > BPS) return `📈 ${formatMultiplier(bps)}`;
  if (bps < BPS) return `📉 ${formatMultiplier(bps)}`;
  return `➖ ${formatMultiplier(bps)}`;
}
