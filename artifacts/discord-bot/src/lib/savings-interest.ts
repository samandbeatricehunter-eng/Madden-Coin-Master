import { db } from "@workspace/db";
import { userSavingsTable, payoutConfigTable } from "@workspace/db";
import { gt, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logTransaction, PRIMARY_GUILD_ID } from "./db-helpers.js";

const RATE_KEY      = "savings_interest_rate";   // stored as basis points (100 = 1%)
const LAST_RUN_KEY  = "savings_last_interest_at"; // stored as unix epoch seconds
const DEFAULT_RATE  = 0;                          // 0 = no interest until admin sets it
const INTERVAL_MS   = 60 * 60 * 1000;            // check every hour

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getConfigInt(key: string): Promise<number | null> {
  const row = await db.select({ value: payoutConfigTable.value })
    .from(payoutConfigTable)
    .where(eq(payoutConfigTable.key, key))
    .limit(1);
  return row[0]?.value ?? null;
}

async function setConfigInt(key: string, value: number, description: string): Promise<void> {
  await db.insert(payoutConfigTable)
    .values({ key, value, description, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: payoutConfigTable.key,
      set: { value, updatedAt: new Date() },
    });
}

// ── Interest helpers (exported for the /savings command) ──────────────────────

export async function getSavingsInterestRateBps(): Promise<number> {
  return (await getConfigInt(RATE_KEY)) ?? DEFAULT_RATE;
}

export async function setSavingsInterestRateBps(
  rateBps: number,
  adminId: string,
): Promise<void> {
  await db.insert(payoutConfigTable)
    .values({
      key:         RATE_KEY,
      value:       rateBps,
      description: "Daily savings interest rate (basis points — 100 = 1%)",
      updatedAt:   new Date(),
      updatedBy:   adminId,
    })
    .onConflictDoUpdate({
      target: payoutConfigTable.key,
      set: { value: rateBps, updatedAt: new Date(), updatedBy: adminId },
    });
}

// ── Daily interest payout ─────────────────────────────────────────────────────

async function runInterestPayout(): Promise<{ usersRewarded: number; totalCoins: number }> {
  const rateBps = await getSavingsInterestRateBps();
  if (rateBps <= 0) return { usersRewarded: 0, totalCoins: 0 };

  const holders = await db.select({
    discordId: userSavingsTable.discordId,
    balance:   userSavingsTable.balance,
  })
    .from(userSavingsTable)
    .where(gt(userSavingsTable.balance, 0));

  let usersRewarded = 0;
  let totalCoins    = 0;

  for (const holder of holders) {
    // Round up so every saver earns at least 1 coin (avoids perpetual zero)
    const interest = Math.ceil(holder.balance * rateBps / 10000);
    if (interest <= 0) continue;

    await db.update(userSavingsTable)
      .set({
        balance:   sql`${userSavingsTable.balance} + ${interest}`,
        updatedAt: new Date(),
      })
      .where(eq(userSavingsTable.discordId, holder.discordId));

    await logTransaction(
      holder.discordId,
      interest,
      "savings_interest",
      `Daily savings interest: ${(rateBps / 100).toFixed(2)}% on ${holder.balance.toLocaleString()} coins`,
      PRIMARY_GUILD_ID,
    );

    usersRewarded++;
    totalCoins += interest;
  }

  return { usersRewarded, totalCoins };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startSavingsInterestScheduler(): void {
  async function tick() {
    try {
      const lastRunSecs = await getConfigInt(LAST_RUN_KEY);
      const nowSecs     = Math.floor(Date.now() / 1000);
      const secondsAgo  = lastRunSecs !== null ? nowSecs - lastRunSecs : Infinity;

      if (secondsAgo < 86400) return; // not 24 hours yet

      console.log(`[savings-interest] 24h elapsed — running daily interest payout…`);
      const { usersRewarded, totalCoins } = await runInterestPayout();
      await setConfigInt(LAST_RUN_KEY, nowSecs, "Unix timestamp of last daily savings interest payout");
      console.log(`[savings-interest] Done — ${usersRewarded} users rewarded, ${totalCoins} total coins distributed`);
    } catch (err) {
      console.error("[savings-interest] Scheduler error:", err);
    }
  }

  // Run once on startup, then every hour
  void tick();
  setInterval(tick, INTERVAL_MS);
}
