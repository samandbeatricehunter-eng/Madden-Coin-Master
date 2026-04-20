import { db } from "@workspace/db";
import { payoutConfigTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { PRIMARY_GUILD_ID } from "./db-helpers.js";

export const PAYOUT_KEYS = {
  // ── Game result payouts ──────────────────────────────────────────────────────
  H2H_WIN:          "h2h_win",
  H2H_LOSS:         "h2h_loss",
  CPU_WIN:          "cpu_win",
  // ── Playoff game payouts ─────────────────────────────────────────────────────
  PLAYOFF_H2H_WIN:  "playoff_h2h_win",
  PLAYOFF_H2H_LOSS: "playoff_h2h_loss",
  PLAYOFF_CPU_WIN:  "playoff_cpu_win",
  // ── Playoff round bonuses ────────────────────────────────────────────────────
  WILDCARD_BONUS:           "wildcard_bonus",
  DIVISIONAL_BONUS:         "divisional_bonus",
  CONFERENCE_WIN_BONUS:     "conference_win_bonus",
  CONFERENCE_RUNNER_UP:     "conference_runner_up",
  SUPERBOWL_WIN_BONUS:      "superbowl_win_bonus",
  SUPERBOWL_RUNNER_UP:      "superbowl_runner_up",
  // ── Channel activity payouts ─────────────────────────────────────────────────
  STREAM_PAYOUT:           "stream_payout",           // Twitch stream post — each side
  HIGHLIGHT_PAYOUT:        "highlight_payout",         // Highlight video — regular season
  HIGHLIGHT_PLAYOFF_PAYOUT:"highlight_playoff_payout", // Highlight video — postseason
  HIGHLIGHT_LIMIT:         "highlight_limit",          // Max paid highlight videos per user per week
  // ── GOTW voter bonuses ────────────────────────────────────────────────────────
  GOTW_REGULAR_BONUS:      "gotw_regular_bonus",       // Correct GOTW guess — regular season
  GOTW_PLAYOFF_BONUS:      "gotw_playoff_bonus",       // Correct GOTW guess — playoffs
  // ── POTW bonus ───────────────────────────────────────────────────────────────
  POTW_BONUS:              "potw_bonus",               // Player of the Week winner bonus
  // ── New member bonus ─────────────────────────────────────────────────────────
  NEW_MEMBER_BONUS:        "new_member_bonus",          // Coins awarded when user is first linked to a team
  // ── Career win milestones ────────────────────────────────────────────────────
  MILESTONE_T1_WINS:  "milestone_t1_wins",   // Win threshold for tier 1 milestone
  MILESTONE_T1_BONUS: "milestone_t1_bonus",  // Coin bonus for tier 1 milestone
  MILESTONE_T2_WINS:  "milestone_t2_wins",
  MILESTONE_T2_BONUS: "milestone_t2_bonus",
  MILESTONE_T3_WINS:  "milestone_t3_wins",
  MILESTONE_T3_BONUS: "milestone_t3_bonus",
  MILESTONE_T4_WINS:  "milestone_t4_wins",
  MILESTONE_T4_BONUS: "milestone_t4_bonus",
  // ── End-of-season bonuses ────────────────────────────────────────────────────
  AWARD_WIN_BONUS:  "award_win_bonus",
  SEASON_PR_1:      "season_pr_1",
  SEASON_PR_2:      "season_pr_2",
  SEASON_PR_3_6:    "season_pr_3_6",
  SEASON_PR_7_8:    "season_pr_7_8",
  SEASON_PR_9_10:   "season_pr_9_10",
  GOTY_WINNER:      "goty_winner_coins",
  // ── End-of-season individual player bonuses ──────────────────────────────────
  EOS_RB_YPC_BONUS:    "eos_rb_ypc_bonus",
  EOS_QB_YPA_BONUS:    "eos_qb_ypa_bonus",
  EOS_DB_INT_BONUS:    "eos_db_int_bonus",
  // ── EOS stat minimum attempt thresholds (not coin values — attempt counts) ───
  EOS_QB_MIN_ATT:      "eos_qb_min_att",   // Min pass attempts to qualify for QB YPA bonus
  EOS_RB_MIN_ATT:      "eos_rb_min_att",   // Min rush attempts to qualify for RB YPC bonus
  // ── EOS individual bonus qualifying thresholds ────────────────────────────────
  EOS_QB_MIN_YPA:      "eos_qb_min_ypa",   // Min QB YPA×10 to earn bonus (e.g. 85 = 8.5 YPA)
  EOS_RB_MIN_YPC:      "eos_rb_min_ypc",   // Min RB YPC×10 to earn bonus (e.g. 70 = 7.0 YPC)
  EOS_DB_MIN_INTS:     "eos_db_min_ints",  // Min individual player INTs (any defensive position)
  // ── End-of-season missed-playoffs consolation ─────────────────────────────────
  EOS_MISSED_PLAYOFFS: "eos_missed_playoffs",
  // ── Stat reimport safe mode (1 = active, 0 = disabled) ───────────────────────
  STAT_SAFE_MODE: "stat.safe_mode",
} as const;

export type PayoutKey = (typeof PAYOUT_KEYS)[keyof typeof PAYOUT_KEYS];

const DEFAULTS: Record<PayoutKey, { value: number; description: string; category: string }> = {
  // ── Game result payouts ──────────────────────────────────────────────────────
  h2h_win:           { value: 50,  description: "H2H game win (both users played)",                           category: "Game Payouts"          },
  h2h_loss:          { value: 20,  description: "H2H game loss (both users played)",                           category: "Game Payouts"          },
  cpu_win:           { value: 20,  description: "CPU/force win (one-sided or simmed game)",                    category: "Game Payouts"          },
  // ── Playoff game payouts ─────────────────────────────────────────────────────
  playoff_h2h_win:   { value: 75,  description: "Playoff H2H game win",                                        category: "Game Payouts"          },
  playoff_h2h_loss:  { value: 25,  description: "Playoff H2H game loss",                                       category: "Game Payouts"          },
  playoff_cpu_win:   { value: 25,  description: "Playoff CPU/force win",                                       category: "Game Payouts"          },
  // ── Playoff round bonuses ────────────────────────────────────────────────────
  wildcard_bonus:         { value: 50,  description: "Wild Card round bonus (winner)",                          category: "Playoff Bonuses"       },
  divisional_bonus:       { value: 75,  description: "Divisional round bonus (winner)",                         category: "Playoff Bonuses"       },
  conference_win_bonus:   { value: 100, description: "Conference Championship winner bonus",                    category: "Playoff Bonuses"       },
  conference_runner_up:   { value: 50,  description: "Conference Championship runner-up bonus",                 category: "Playoff Bonuses"       },
  superbowl_win_bonus:    { value: 200, description: "Super Bowl winner bonus",                                 category: "Playoff Bonuses"       },
  superbowl_runner_up:    { value: 100, description: "Super Bowl runner-up bonus",                              category: "Playoff Bonuses"       },
  // ── Channel activity payouts ─────────────────────────────────────────────────
  stream_payout:            { value: 10,  description: "Twitch stream post — coins paid to each side (streamer + opponent)", category: "Activity Payouts" },
  highlight_payout:         { value: 20,  description: "Highlight video — regular season payout per video",              category: "Activity Payouts" },
  highlight_playoff_payout: { value: 40,  description: "Highlight video — postseason payout per video",                  category: "Activity Payouts" },
  highlight_limit:          { value: 2,   description: "Max paid highlight videos per user per week",                    category: "Activity Payouts" },
  // ── GOTW voter bonuses ────────────────────────────────────────────────────────
  gotw_regular_bonus: { value: 5,  description: "GOTW correct guess bonus — regular season",     category: "GOTW Bonuses" },
  gotw_playoff_bonus: { value: 10, description: "GOTW correct guess bonus — playoffs",            category: "GOTW Bonuses" },
  // ── POTW bonus ───────────────────────────────────────────────────────────────
  potw_bonus:         { value: 10, description: "Player of the Week winner bonus",                category: "GOTW Bonuses" },
  // ── New member bonus ─────────────────────────────────────────────────────────
  new_member_bonus:   { value: 0,  description: "Bonus coins awarded when a new user is first linked to a team", category: "Activity Payouts" },
  // ── Career win milestones ────────────────────────────────────────────────────
  milestone_t1_wins:  { value: 5,    description: "Career milestone tier 1 — win threshold",      category: "Milestones"   },
  milestone_t1_bonus: { value: 100,  description: "Career milestone tier 1 — coin bonus",         category: "Milestones"   },
  milestone_t2_wins:  { value: 12,   description: "Career milestone tier 2 — win threshold",      category: "Milestones"   },
  milestone_t2_bonus: { value: 250,  description: "Career milestone tier 2 — coin bonus",         category: "Milestones"   },
  milestone_t3_wins:  { value: 25,   description: "Career milestone tier 3 — win threshold",      category: "Milestones"   },
  milestone_t3_bonus: { value: 500,  description: "Career milestone tier 3 — coin bonus",         category: "Milestones"   },
  milestone_t4_wins:  { value: 50,   description: "Career milestone tier 4 — win threshold",      category: "Milestones"   },
  milestone_t4_bonus: { value: 1000, description: "Career milestone tier 4 — coin bonus",         category: "Milestones"   },
  // ── End-of-season bonuses ────────────────────────────────────────────────────
  award_win_bonus:   { value: 50,  description: "Coins per team with an in-game award winner",                 category: "Season Bonuses"        },
  season_pr_1:       { value: 150, description: "Season PR bonus — #1 ranked player",                          category: "Season Bonuses"        },
  season_pr_2:       { value: 125, description: "Season PR bonus — #2 ranked player",                          category: "Season Bonuses"        },
  season_pr_3_6:     { value: 100, description: "Season PR bonus — #3–6 ranked players",                       category: "Season Bonuses"        },
  season_pr_7_8:     { value: 75,  description: "Season PR bonus — #7–8 ranked players",                       category: "Season Bonuses"        },
  season_pr_9_10:    { value: 50,  description: "Season PR bonus — #9–10 ranked players",                      category: "Season Bonuses"        },
  goty_winner_coins: { value: 100, description: "Coins awarded to each GOTY award winner",                     category: "Season Bonuses"        },
  // ── Individual player bonuses ─────────────────────────────────────────────────
  eos_rb_ypc_bonus:    { value: 100, description: "EOS individual bonus — top RB qualifying YPC (coins)",       category: "Individual Bonuses"    },
  eos_qb_ypa_bonus:    { value: 100, description: "EOS individual bonus — top QB qualifying YPA (coins)",       category: "Individual Bonuses"    },
  eos_db_int_bonus:    { value: 100, description: "EOS individual bonus — DB individual player 8+ INTs",        category: "Individual Bonuses"    },
  // ── EOS stat minimum attempt thresholds ──────────────────────────────────────
  eos_qb_min_att:      { value: 300, description: "EOS QB YPA — minimum pass attempts to qualify",                    category: "Stat Minimums"    },
  eos_rb_min_att:      { value: 150, description: "EOS RB YPC — minimum rush attempts/carries to qualify",            category: "Stat Minimums"    },
  // ── EOS individual bonus qualifying thresholds (×10 for decimal stats) ────────
  eos_qb_min_ypa:      { value: 85,  description: "EOS QB YPA — minimum YPA to qualify (×10, e.g. 85 = 8.5 YPA)",   category: "Stat Thresholds"  },
  eos_rb_min_ypc:      { value: 70,  description: "EOS RB YPC — minimum YPC to qualify (×10, e.g. 70 = 7.0 YPC)",   category: "Stat Thresholds"  },
  eos_db_min_ints:     { value: 8,   description: "EOS DB INT — minimum individual player INTs to earn bonus",        category: "Stat Thresholds"  },
  // ── Missed-playoffs consolation ───────────────────────────────────────────────
  eos_missed_playoffs: { value: 400, description: "EOS consolation — user-controlled team that missed playoffs",       category: "Individual Bonuses" },
  // ── Stat reimport safe mode ────────────────────────────────────────────────────
  "stat.safe_mode":    { value: 0,   description: "Stat reimport safe mode (1 = active — EOS payouts blocked)",       category: "System"            },
};

// Cache key: "${guildId}:${payoutKey}" for per-guild isolation
const cache = new Map<string, number>();

export async function getPayoutValue(key: PayoutKey, guildId: string = PRIMARY_GUILD_ID): Promise<number> {
  const cacheKey = `${guildId}:${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  const [row] = await db.select({ value: payoutConfigTable.value })
    .from(payoutConfigTable)
    .where(and(eq(payoutConfigTable.guildId, guildId), eq(payoutConfigTable.key, key)))
    .limit(1);
  const value = row?.value ?? DEFAULTS[key].value;
  cache.set(cacheKey, value);
  return value;
}

export async function setPayoutValue(key: PayoutKey, value: number, updatedBy: string, guildId: string = PRIMARY_GUILD_ID): Promise<void> {
  const desc = DEFAULTS[key].description;
  await db.insert(payoutConfigTable)
    .values({ guildId, key, value, description: desc, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [payoutConfigTable.guildId, payoutConfigTable.key],
      set: { value, updatedBy, updatedAt: new Date() },
    });
  cache.set(`${guildId}:${key}`, value);
}

export async function getAllPayoutConfig(guildId: string = PRIMARY_GUILD_ID): Promise<Map<PayoutKey, number>> {
  const rows = await db.select().from(payoutConfigTable)
    .where(eq(payoutConfigTable.guildId, guildId));
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

// ── Milestone helpers ──────────────────────────────────────────────────────────
export async function getMilestoneTiers(guildId: string = PRIMARY_GUILD_ID): Promise<Array<{tier: number; wins: number; bonus: number}>> {
  const [t1w, t1b, t2w, t2b, t3w, t3b, t4w, t4b] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.MILESTONE_T1_WINS,  guildId),
    getPayoutValue(PAYOUT_KEYS.MILESTONE_T1_BONUS, guildId),
    getPayoutValue(PAYOUT_KEYS.MILESTONE_T2_WINS,  guildId),
    getPayoutValue(PAYOUT_KEYS.MILESTONE_T2_BONUS, guildId),
    getPayoutValue(PAYOUT_KEYS.MILESTONE_T3_WINS,  guildId),
    getPayoutValue(PAYOUT_KEYS.MILESTONE_T3_BONUS, guildId),
    getPayoutValue(PAYOUT_KEYS.MILESTONE_T4_WINS,  guildId),
    getPayoutValue(PAYOUT_KEYS.MILESTONE_T4_BONUS, guildId),
  ]);
  return [
    { tier: 1, wins: t1w, bonus: t1b },
    { tier: 2, wins: t2w, bonus: t2b },
    { tier: 3, wins: t3w, bonus: t3b },
    { tier: 4, wins: t4w, bonus: t4b },
  ];
}
