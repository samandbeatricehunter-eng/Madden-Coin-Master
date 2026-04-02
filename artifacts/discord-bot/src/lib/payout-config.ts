import { db } from "@workspace/db";
import { payoutConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const PAYOUT_KEYS = {
  // ── Game result payouts ──────────────────────────────────────────────────────
  H2H_WIN:          "h2h_win",
  H2H_LOSS:         "h2h_loss",
  CPU_WIN:          "cpu_win",
  // ── End-of-season bonuses ────────────────────────────────────────────────────
  AWARD_WIN_BONUS:  "award_win_bonus",
  SEASON_PR_1:      "season_pr_1",
  SEASON_PR_2:      "season_pr_2",
  SEASON_PR_3_6:    "season_pr_3_6",
  SEASON_PR_7_8:    "season_pr_7_8",
  SEASON_PR_9_10:   "season_pr_9_10",
  GOTY_WINNER:      "goty_winner_coins",
} as const;

export type PayoutKey = (typeof PAYOUT_KEYS)[keyof typeof PAYOUT_KEYS];

const DEFAULTS: Record<PayoutKey, { value: number; description: string; category: string }> = {
  // ── Game result payouts ──────────────────────────────────────────────────────
  h2h_win:           { value: 50,  description: "H2H game win (both users played)",            category: "Game Payouts"          },
  h2h_loss:          { value: 20,  description: "H2H game loss (both users played)",            category: "Game Payouts"          },
  cpu_win:           { value: 20,  description: "CPU/force win (one-sided or simmed game)",     category: "Game Payouts"          },
  // ── End-of-season bonuses ────────────────────────────────────────────────────
  award_win_bonus:   { value: 50,  description: "Coins per team with an in-game award winner",  category: "Season Bonuses"        },
  season_pr_1:       { value: 150, description: "Season PR bonus — #1 ranked player",           category: "Season Bonuses"        },
  season_pr_2:       { value: 125, description: "Season PR bonus — #2 ranked player",           category: "Season Bonuses"        },
  season_pr_3_6:     { value: 100, description: "Season PR bonus — #3–6 ranked players",        category: "Season Bonuses"        },
  season_pr_7_8:     { value: 75,  description: "Season PR bonus — #7–8 ranked players",        category: "Season Bonuses"        },
  season_pr_9_10:    { value: 50,  description: "Season PR bonus — #9–10 ranked players",       category: "Season Bonuses"        },
  goty_winner_coins: { value: 100, description: "Coins awarded to each GOTY award winner",      category: "Season Bonuses"        },
};

const cache = new Map<PayoutKey, number>();

export async function getPayoutValue(key: PayoutKey): Promise<number> {
  if (cache.has(key)) return cache.get(key)!;
  const [row] = await db.select({ value: payoutConfigTable.value })
    .from(payoutConfigTable)
    .where(eq(payoutConfigTable.key, key))
    .limit(1);
  const value = row?.value ?? DEFAULTS[key].value;
  cache.set(key, value);
  return value;
}

export async function setPayoutValue(key: PayoutKey, value: number, updatedBy: string): Promise<void> {
  const desc = DEFAULTS[key].description;
  await db.insert(payoutConfigTable)
    .values({ key, value, description: desc, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: payoutConfigTable.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
  cache.set(key, value);
}

export async function getAllPayoutConfig(): Promise<Map<PayoutKey, number>> {
  const rows = await db.select().from(payoutConfigTable);
  const result = new Map<PayoutKey, number>();
  for (const key of Object.values(PAYOUT_KEYS) as PayoutKey[]) {
    const row = rows.find(r => r.key === key);
    result.set(key, row?.value ?? DEFAULTS[key].value);
  }
  return result;
}

export function getPayoutKeyMeta(key: PayoutKey) {
  return DEFAULTS[key];
}

export function getAllPayoutKeys(): Array<{ key: PayoutKey; description: string; defaultValue: number; category: string }> {
  return (Object.values(PAYOUT_KEYS) as PayoutKey[]).map(k => ({
    key:          k,
    description:  DEFAULTS[k].description,
    defaultValue: DEFAULTS[k].value,
    category:     DEFAULTS[k].category,
  }));
}
