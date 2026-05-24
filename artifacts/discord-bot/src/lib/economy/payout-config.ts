import { db } from "@workspace/db";
import { payoutConfigTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { PRIMARY_GUILD_ID } from "../db/db-helpers.js";

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
  DIVISION_WINNER_BONUS:    "division_winner_bonus",
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
  // ── Referral bonuses ─────────────────────────────────────────────────────────
  REFERRAL_BONUS_NEW:      "referral_bonus_new",        // Coins awarded to a newly linked user who was referred
  REFERRAL_BONUS_MEMBER:   "referral_bonus_member",     // Coins awarded to the existing member who made the referral
  // ── Career win milestones (25 tiers, 0 wins = inactive) ──────────────────────
  MILESTONE_T1_WINS:  "milestone_t1_wins",   MILESTONE_T1_BONUS:  "milestone_t1_bonus",
  MILESTONE_T2_WINS:  "milestone_t2_wins",   MILESTONE_T2_BONUS:  "milestone_t2_bonus",
  MILESTONE_T3_WINS:  "milestone_t3_wins",   MILESTONE_T3_BONUS:  "milestone_t3_bonus",
  MILESTONE_T4_WINS:  "milestone_t4_wins",   MILESTONE_T4_BONUS:  "milestone_t4_bonus",
  MILESTONE_T5_WINS:  "milestone_t5_wins",   MILESTONE_T5_BONUS:  "milestone_t5_bonus",
  MILESTONE_T6_WINS:  "milestone_t6_wins",   MILESTONE_T6_BONUS:  "milestone_t6_bonus",
  MILESTONE_T7_WINS:  "milestone_t7_wins",   MILESTONE_T7_BONUS:  "milestone_t7_bonus",
  MILESTONE_T8_WINS:  "milestone_t8_wins",   MILESTONE_T8_BONUS:  "milestone_t8_bonus",
  MILESTONE_T9_WINS:  "milestone_t9_wins",   MILESTONE_T9_BONUS:  "milestone_t9_bonus",
  MILESTONE_T10_WINS: "milestone_t10_wins",  MILESTONE_T10_BONUS: "milestone_t10_bonus",
  MILESTONE_T11_WINS: "milestone_t11_wins",  MILESTONE_T11_BONUS: "milestone_t11_bonus",
  MILESTONE_T12_WINS: "milestone_t12_wins",  MILESTONE_T12_BONUS: "milestone_t12_bonus",
  MILESTONE_T13_WINS: "milestone_t13_wins",  MILESTONE_T13_BONUS: "milestone_t13_bonus",
  MILESTONE_T14_WINS: "milestone_t14_wins",  MILESTONE_T14_BONUS: "milestone_t14_bonus",
  MILESTONE_T15_WINS: "milestone_t15_wins",  MILESTONE_T15_BONUS: "milestone_t15_bonus",
  MILESTONE_T16_WINS: "milestone_t16_wins",  MILESTONE_T16_BONUS: "milestone_t16_bonus",
  MILESTONE_T17_WINS: "milestone_t17_wins",  MILESTONE_T17_BONUS: "milestone_t17_bonus",
  MILESTONE_T18_WINS: "milestone_t18_wins",  MILESTONE_T18_BONUS: "milestone_t18_bonus",
  MILESTONE_T19_WINS: "milestone_t19_wins",  MILESTONE_T19_BONUS: "milestone_t19_bonus",
  MILESTONE_T20_WINS: "milestone_t20_wins",  MILESTONE_T20_BONUS: "milestone_t20_bonus",
  MILESTONE_T21_WINS: "milestone_t21_wins",  MILESTONE_T21_BONUS: "milestone_t21_bonus",
  MILESTONE_T22_WINS: "milestone_t22_wins",  MILESTONE_T22_BONUS: "milestone_t22_bonus",
  MILESTONE_T23_WINS: "milestone_t23_wins",  MILESTONE_T23_BONUS: "milestone_t23_bonus",
  MILESTONE_T24_WINS: "milestone_t24_wins",  MILESTONE_T24_BONUS: "milestone_t24_bonus",
  MILESTONE_T25_WINS: "milestone_t25_wins",  MILESTONE_T25_BONUS: "milestone_t25_bonus",
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
  // ── Member activity payouts ──────────────────────────────────────────────────
  INTERVIEW_PAYOUT:    "interview_payout",      // coins per interview submission (default 10)
} as const;

export type PayoutKey = (typeof PAYOUT_KEYS)[keyof typeof PAYOUT_KEYS];

const DEFAULTS: Record<PayoutKey, { value: number; description: string; category: string }> = {
  // ── Game result payouts ──────────────────────────────────────────────────────
  h2h_win:           { value: 50,  description: "H2H game win",                                                 category: "Game Payouts"          },
  h2h_loss:          { value: 25,  description: "H2H game loss participation payout",                            category: "Game Payouts"          },
  cpu_win:           { value: 25,  description: "CPU win (losses and ties vs CPU still receive 0)",              category: "Game Payouts"          },
  // ── Playoff game payouts ─────────────────────────────────────────────────────
  playoff_h2h_win:   { value: 25,  description: "Playoff game win",                                            category: "Game Payouts"          },
  playoff_h2h_loss:  { value: 0,   description: "Playoff game loss (no payout)",                               category: "Game Payouts"          },
  playoff_cpu_win:   { value: 25,  description: "Playoff CPU/force win",                                       category: "Game Payouts"          },
  // ── Playoff round bonuses ────────────────────────────────────────────────────
  division_winner_bonus:  { value: 25,  description: "Division winner bonus (seeds 1–4 each conference)",       category: "Playoff Bonuses"       },
  wildcard_bonus:         { value: 50,  description: "Wild Card round bonus (winner)",                          category: "Playoff Bonuses"       },
  divisional_bonus:       { value: 75,  description: "Divisional round bonus (winner)",                         category: "Playoff Bonuses"       },
  conference_win_bonus:   { value: 100, description: "Conference Championship winner bonus",                    category: "Playoff Bonuses"       },
  conference_runner_up:   { value: 50,  description: "Conference Championship runner-up bonus",                 category: "Playoff Bonuses"       },
  superbowl_win_bonus:    { value: 200, description: "Super Bowl winner bonus",                                 category: "Playoff Bonuses"       },
  superbowl_runner_up:    { value: 100, description: "Super Bowl runner-up bonus",                              category: "Playoff Bonuses"       },
  // ── Channel activity payouts ─────────────────────────────────────────────────
  stream_payout:            { value: 25,  description: "Twitch stream post — coins paid to the streamer only",            category: "Activity Payouts" },
  highlight_payout:         { value: 25,  description: "Highlight video — regular season payout per video",              category: "Activity Payouts" },
  highlight_playoff_payout: { value: 5,   description: "Highlight video — postseason payout per video",                  category: "Activity Payouts" },
  highlight_limit:          { value: 2,   description: "Max paid highlight videos per user per week",                    category: "Activity Payouts" },
  // ── GOTW voter bonuses ────────────────────────────────────────────────────────
  gotw_regular_bonus: { value: 25, description: "GOTW correct guess bonus — regular season",     category: "GOTW Bonuses" },
  gotw_playoff_bonus: { value: 25, description: "GOTW correct guess bonus — playoffs",            category: "GOTW Bonuses" },
  // ── POTW bonus ───────────────────────────────────────────────────────────────
  potw_bonus:         { value: 10, description: "Player of the Week winner bonus",                category: "GOTW Bonuses" },
  // ── New member bonus ─────────────────────────────────────────────────────────
  new_member_bonus:   { value: 0,  description: "Bonus coins awarded when a new user is first linked to a team", category: "Activity Payouts" },
  referral_bonus_new:    { value: 100, description: "Coins awarded to a newly linked user who was referred by an existing member",        category: "Activity Payouts" },
  referral_bonus_member: { value: 100, description: "Coins awarded to the existing member who successfully referred a new player",        category: "Activity Payouts" },
  // ── Career win milestones ────────────────────────────────────────────────────
  milestone_t1_wins:  { value: 5,     description: "Career milestone tier 1 — win threshold",  category: "Milestones" },
  milestone_t1_bonus: { value: 50,    description: "Career milestone tier 1 — coin bonus",     category: "Milestones" },
  milestone_t2_wins:  { value: 10,    description: "Career milestone tier 2 — win threshold",  category: "Milestones" },
  milestone_t2_bonus: { value: 100,   description: "Career milestone tier 2 — coin bonus",     category: "Milestones" },
  milestone_t3_wins:  { value: 20,    description: "Career milestone tier 3 — win threshold",  category: "Milestones" },
  milestone_t3_bonus: { value: 150,   description: "Career milestone tier 3 — coin bonus",     category: "Milestones" },
  milestone_t4_wins:  { value: 35,    description: "Career milestone tier 4 — win threshold",  category: "Milestones" },
  milestone_t4_bonus: { value: 200,   description: "Career milestone tier 4 — coin bonus",     category: "Milestones" },
  milestone_t5_wins:  { value: 50,    description: "Career milestone tier 5 — win threshold",  category: "Milestones" },
  milestone_t5_bonus: { value: 300,   description: "Career milestone tier 5 — coin bonus",     category: "Milestones" },
  milestone_t6_wins:  { value: 75,    description: "Career milestone tier 6 — win threshold",  category: "Milestones" },
  milestone_t6_bonus: { value: 400,   description: "Career milestone tier 6 — coin bonus",     category: "Milestones" },
  milestone_t7_wins:  { value: 100,   description: "Career milestone tier 7 — win threshold",  category: "Milestones" },
  milestone_t7_bonus: { value: 500,   description: "Career milestone tier 7 — coin bonus",     category: "Milestones" },
  milestone_t8_wins:  { value: 150,   description: "Career milestone tier 8 — win threshold",  category: "Milestones" },
  milestone_t8_bonus: { value: 700,   description: "Career milestone tier 8 — coin bonus",     category: "Milestones" },
  milestone_t9_wins:  { value: 200,   description: "Career milestone tier 9 — win threshold",  category: "Milestones" },
  milestone_t9_bonus: { value: 900,   description: "Career milestone tier 9 — coin bonus",     category: "Milestones" },
  milestone_t10_wins: { value: 250,   description: "Career milestone tier 10 — win threshold", category: "Milestones" },
  milestone_t10_bonus:{ value: 1100,  description: "Career milestone tier 10 — coin bonus",    category: "Milestones" },
  milestone_t11_wins: { value: 300,   description: "Career milestone tier 11 — win threshold", category: "Milestones" },
  milestone_t11_bonus:{ value: 1300,  description: "Career milestone tier 11 — coin bonus",    category: "Milestones" },
  milestone_t12_wins: { value: 350,   description: "Career milestone tier 12 — win threshold", category: "Milestones" },
  milestone_t12_bonus:{ value: 1500,  description: "Career milestone tier 12 — coin bonus",    category: "Milestones" },
  milestone_t13_wins: { value: 400,   description: "Career milestone tier 13 — win threshold", category: "Milestones" },
  milestone_t13_bonus:{ value: 1800,  description: "Career milestone tier 13 — coin bonus",    category: "Milestones" },
  milestone_t14_wins: { value: 450,   description: "Career milestone tier 14 — win threshold", category: "Milestones" },
  milestone_t14_bonus:{ value: 2100,  description: "Career milestone tier 14 — coin bonus",    category: "Milestones" },
  milestone_t15_wins: { value: 500,   description: "Career milestone tier 15 — win threshold", category: "Milestones" },
  milestone_t15_bonus:{ value: 2500,  description: "Career milestone tier 15 — coin bonus",    category: "Milestones" },
  milestone_t16_wins: { value: 550,   description: "Career milestone tier 16 — win threshold", category: "Milestones" },
  milestone_t16_bonus:{ value: 3000,  description: "Career milestone tier 16 — coin bonus",    category: "Milestones" },
  milestone_t17_wins: { value: 600,   description: "Career milestone tier 17 — win threshold", category: "Milestones" },
  milestone_t17_bonus:{ value: 3500,  description: "Career milestone tier 17 — coin bonus",    category: "Milestones" },
  milestone_t18_wins: { value: 650,   description: "Career milestone tier 18 — win threshold", category: "Milestones" },
  milestone_t18_bonus:{ value: 4000,  description: "Career milestone tier 18 — coin bonus",    category: "Milestones" },
  milestone_t19_wins: { value: 700,   description: "Career milestone tier 19 — win threshold", category: "Milestones" },
  milestone_t19_bonus:{ value: 4500,  description: "Career milestone tier 19 — coin bonus",    category: "Milestones" },
  milestone_t20_wins: { value: 750,   description: "Career milestone tier 20 — win threshold", category: "Milestones" },
  milestone_t20_bonus:{ value: 5000,  description: "Career milestone tier 20 — coin bonus",    category: "Milestones" },
  milestone_t21_wins: { value: 800,   description: "Career milestone tier 21 — win threshold", category: "Milestones" },
  milestone_t21_bonus:{ value: 6000,  description: "Career milestone tier 21 — coin bonus",    category: "Milestones" },
  milestone_t22_wins: { value: 850,   description: "Career milestone tier 22 — win threshold", category: "Milestones" },
  milestone_t22_bonus:{ value: 7000,  description: "Career milestone tier 22 — coin bonus",    category: "Milestones" },
  milestone_t23_wins: { value: 900,   description: "Career milestone tier 23 — win threshold", category: "Milestones" },
  milestone_t23_bonus:{ value: 8000,  description: "Career milestone tier 23 — coin bonus",    category: "Milestones" },
  milestone_t24_wins: { value: 950,   description: "Career milestone tier 24 — win threshold", category: "Milestones" },
  milestone_t24_bonus:{ value: 9000,  description: "Career milestone tier 24 — coin bonus",    category: "Milestones" },
  milestone_t25_wins: { value: 1000,  description: "Career milestone tier 25 — win threshold", category: "Milestones" },
  milestone_t25_bonus:{ value: 10000, description: "Career milestone tier 25 — coin bonus",    category: "Milestones" },
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
  // ── Member activity payouts ───────────────────────────────────────────────────
  interview_payout:    { value: 10,  description: "Coins awarded per approved interview submission",                    category: "Activity Payouts"  },
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
const MILESTONE_TIER_KEYS: Array<{ wins: PayoutKey; bonus: PayoutKey }> = [
  { wins: PAYOUT_KEYS.MILESTONE_T1_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T1_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T2_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T2_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T3_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T3_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T4_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T4_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T5_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T5_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T6_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T6_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T7_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T7_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T8_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T8_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T9_WINS,  bonus: PAYOUT_KEYS.MILESTONE_T9_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T10_WINS, bonus: PAYOUT_KEYS.MILESTONE_T10_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T11_WINS, bonus: PAYOUT_KEYS.MILESTONE_T11_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T12_WINS, bonus: PAYOUT_KEYS.MILESTONE_T12_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T13_WINS, bonus: PAYOUT_KEYS.MILESTONE_T13_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T14_WINS, bonus: PAYOUT_KEYS.MILESTONE_T14_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T15_WINS, bonus: PAYOUT_KEYS.MILESTONE_T15_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T16_WINS, bonus: PAYOUT_KEYS.MILESTONE_T16_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T17_WINS, bonus: PAYOUT_KEYS.MILESTONE_T17_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T18_WINS, bonus: PAYOUT_KEYS.MILESTONE_T18_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T19_WINS, bonus: PAYOUT_KEYS.MILESTONE_T19_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T20_WINS, bonus: PAYOUT_KEYS.MILESTONE_T20_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T21_WINS, bonus: PAYOUT_KEYS.MILESTONE_T21_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T22_WINS, bonus: PAYOUT_KEYS.MILESTONE_T22_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T23_WINS, bonus: PAYOUT_KEYS.MILESTONE_T23_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T24_WINS, bonus: PAYOUT_KEYS.MILESTONE_T24_BONUS },
  { wins: PAYOUT_KEYS.MILESTONE_T25_WINS, bonus: PAYOUT_KEYS.MILESTONE_T25_BONUS },
];
export { MILESTONE_TIER_KEYS };

export async function getMilestoneTiers(guildId: string = PRIMARY_GUILD_ID): Promise<Array<{tier: number; wins: number; bonus: number}>> {
  const values = await Promise.all(
    MILESTONE_TIER_KEYS.flatMap(({ wins, bonus }) => [
      getPayoutValue(wins,  guildId),
      getPayoutValue(bonus, guildId),
    ])
  );
  const result: Array<{ tier: number; wins: number; bonus: number }> = [];
  for (let i = 0; i < MILESTONE_TIER_KEYS.length; i++) {
    const w = values[i * 2]!;
    const b = values[i * 2 + 1]!;
    if (i < 4 || w > 0) {
      result.push({ tier: i + 1, wins: w, bonus: b });
    }
  }
  return result;
}
