export type StatDirection = "higher" | "lower";

export interface StatCategory {
  key:       string;
  label:     string;
  unit:      string;
  direction: StatDirection;
  jsonFields: string[];
}

// All end-of-season stat tier categories.
// direction "higher" = higher value is better (offensive stats + def sacks/INTs/TO diff)
// direction "lower"  = lower value is better (def yards/pts/redzone allowed)
export const STAT_CATEGORIES: StatCategory[] = [
  // ── Offense ──────────────────────────────────────────────────────────────────
  {
    key:        "off_pass_yds",
    label:      "Passing Yards",
    unit:       "yds",
    direction:  "higher",
    jsonFields: ["offPassYds", "passYds", "off_pass_yds", "passingYards"],
  },
  {
    key:        "off_rush_yds",
    label:      "Rushing Yards",
    unit:       "yds",
    direction:  "higher",
    jsonFields: ["offRushYds", "rushYds", "off_rush_yds", "rushingYards"],
  },
  {
    key:        "off_pts_per_game",
    label:      "Points Per Game",
    unit:       "PPG",
    direction:  "higher",
    jsonFields: ["offPtsPerGame", "ptsPerGame", "pointsPerGame", "off_pts_per_game"],
  },
  {
    key:        "off_redzone_pct",
    label:      "Offensive Red Zone %",
    unit:       "%",
    direction:  "higher",
    jsonFields: ["offRedZonePct", "offensiveRedZonePct", "redZonePct", "offRZPct", "offensiveRedzonePct", "offRedzonePct", "offenseRedZonePct"],
  },
  // ── Defense ──────────────────────────────────────────────────────────────────
  {
    key:        "def_pass_yds",
    label:      "Passing Yards Allowed",
    unit:       "yds",
    direction:  "lower",
    jsonFields: ["defPassYds", "defPassYdsAllowed", "def_pass_yds", "passingYardsAllowed"],
  },
  {
    key:        "def_rush_yds",
    label:      "Rushing Yards Allowed",
    unit:       "yds",
    direction:  "lower",
    jsonFields: ["defRushYds", "defRushYdsAllowed", "def_rush_yds", "rushingYardsAllowed"],
  },
  {
    key:        "def_pts_allowed",
    label:      "Points Allowed",
    unit:       "pts",
    direction:  "lower",
    jsonFields: ["defPtsAllowed", "ptsAllowed", "totalPtsAllowed", "pointsAllowed", "defTotalPts"],
  },
  {
    key:        "def_sacks",
    label:      "Sacks",
    unit:       "sacks",
    direction:  "higher",
    jsonFields: ["defSacks", "totalSacks", "def_sacks", "sacks"],
  },
  {
    key:        "def_ints",
    label:      "Interceptions",
    unit:       "INTs",
    direction:  "higher",
    jsonFields: ["defInts", "defTotalInts", "totalInts", "def_ints", "interceptions"],
  },
  {
    key:        "def_redzone_pct",
    label:      "Defensive Red Zone % Allowed",
    unit:       "%",
    direction:  "lower",
    jsonFields: ["defRedZonePct", "defensiveRedZonePct", "defRedZoneAllowedPct", "defRZPct", "defenseRedZonePct", "defRedzonePct", "def_redzone_pct"],
  },
  // ── Turnover margin ──────────────────────────────────────────────────────────
  {
    key:        "turnover_diff",
    label:      "Turnover Differential",
    unit:       "+/-",
    direction:  "higher",
    jsonFields: ["turnoverDiff", "turnOverDiff", "turnoverDifferential", "turnoverMargin", "turnover_diff", "toMargin", "toDiff"],
  },
];
// NOTE: QB YPA and RB YPC are flat individual bonuses (not tiered) handled
// separately in the EOS auto-post via payout-config thresholds, not STAT_CATEGORIES.

export const STAT_CATEGORY_MAP = new Map(STAT_CATEGORIES.map(c => [c.key, c]));

export const STAT_CATEGORY_CHOICES = STAT_CATEGORIES.map(c => ({
  name:  c.label,
  value: c.key,
}));

// ── HARDWIRED tier configurations ────────────────────────────────────────────
// Uniform payouts across every category: T1=50, T2=100, T3=150, T4=250.
// Tiers are ordered 1→4 (worst→best payout).
// For "lower" categories (yards/pts allowed, def RZ%), lower threshold = better tier.
// No admin override — these are the league's locked-in EOS bonus tiers.
// QB YPA / RB YPC are NOT tiered — they're flat individual bonuses; see
// PAYOUT_KEYS.EOS_QB_YPA_BONUS / EOS_RB_YPC_BONUS in payout-config.
export const STAT_TIER_DEFAULTS: Record<string, { threshold: number; payout: number }[]> = {
  off_pass_yds: [
    { threshold: 3500, payout: 50  },
    { threshold: 4250, payout: 100 },
    { threshold: 4750, payout: 150 },
    { threshold: 5500, payout: 250 },
  ],
  off_rush_yds: [
    { threshold: 1250, payout: 50  },
    { threshold: 1750, payout: 100 },
    { threshold: 2100, payout: 150 },
    { threshold: 2350, payout: 250 },
  ],
  off_pts_per_game: [
    { threshold: 28, payout: 50  },
    { threshold: 32, payout: 100 },
    { threshold: 36, payout: 150 },
    { threshold: 40, payout: 250 },
  ],
  off_redzone_pct: [
    { threshold: 50, payout: 50  },
    { threshold: 60, payout: 100 },
    { threshold: 70, payout: 150 },
    { threshold: 80, payout: 250 },
  ],
  def_pass_yds: [
    { threshold: 4200, payout: 50  },
    { threshold: 3800, payout: 100 },
    { threshold: 3400, payout: 150 },
    { threshold: 3000, payout: 250 },
  ],
  def_rush_yds: [
    { threshold: 1900, payout: 50  },
    { threshold: 1650, payout: 100 },
    { threshold: 1400, payout: 150 },
    { threshold: 1150, payout: 250 },
  ],
  def_pts_allowed: [
    { threshold: 550, payout: 50  },
    { threshold: 450, payout: 100 },
    { threshold: 350, payout: 150 },
    { threshold: 250, payout: 250 },
  ],
  def_redzone_pct: [
    { threshold: 60, payout: 50  },
    { threshold: 52, payout: 100 },
    { threshold: 46, payout: 150 },
    { threshold: 40, payout: 250 },
  ],
  def_sacks: [
    { threshold: 28, payout: 50  },
    { threshold: 38, payout: 100 },
    { threshold: 48, payout: 150 },
    { threshold: 60, payout: 250 },
  ],
  def_ints: [
    { threshold: 12, payout: 50  },
    { threshold: 18, payout: 100 },
    { threshold: 24, payout: 150 },
    { threshold: 30, payout: 250 },
  ],
  turnover_diff: [
    { threshold: 5,  payout: 50  },
    { threshold: 10, payout: 100 },
    { threshold: 15, payout: 150 },
    { threshold: 20, payout: 250 },
  ],
};

// Given tiers (array of {tier, threshold, payout}) and a stat value,
// returns the tier number and payout that applies, or null if none.
export function evaluateTier(
  tiers: { tier: number; threshold: number; payout: number }[],
  statValue: number,
  direction: StatDirection,
): { tier: number; payout: number } | null {
  if (!tiers.length) return null;

  // Sort by tier descending so we check the best tier first
  const sorted = [...tiers].sort((a, b) => b.tier - a.tier);

  if (direction === "higher") {
    // Higher is better: qualify for the highest tier where value >= threshold
    for (const t of sorted) {
      if (statValue >= t.threshold) return { tier: t.tier, payout: t.payout };
    }
    return null;
  } else {
    // Lower is better: qualify for the highest tier where value <= threshold
    for (const t of sorted) {
      if (statValue <= t.threshold) return { tier: t.tier, payout: t.payout };
    }
    return null;
  }
}

// Extract a stat value from a team object by trying multiple possible field names
export function extractStat(teamObj: any, fields: string[]): number | null {
  for (const f of fields) {
    const v = teamObj?.[f];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

// Build the runtime tiersByCategory map used by EOS auto-post + the user-facing
// stat-tier viewer. Indexed as tier 1..N with the threshold + payout straight
// from STAT_TIER_DEFAULTS — no DB read.
export function getTiersByCategory(): Map<string, { tier: number; threshold: number; payout: number }[]> {
  const m = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const [key, tiers] of Object.entries(STAT_TIER_DEFAULTS)) {
    m.set(key, tiers.map((t, i) => ({ tier: i + 1, threshold: t.threshold, payout: t.payout })));
  }
  return m;
}
