export type StatDirection = "higher" | "lower";

export interface StatCategory {
  key:       string;
  label:     string;
  unit:      string;
  direction: StatDirection;
  jsonFields: string[];
}

// All configurable end-of-season stat categories.
// direction "higher" = higher value is better (offensive stats + def sacks/INTs/fumbles)
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
    key:        "def_fumbles_rec",
    label:      "Recovered Fumbles",
    unit:       "fumbles",
    direction:  "higher",
    jsonFields: ["defFumblesRec", "fumblesRecovered", "fumRec", "fumRecovered", "totalFumRec", "defensiveFumblesRec", "def_fumbles_rec", "recoveredFumbles", "fumbleRecoveries"],
  },
  {
    key:        "def_redzone_pct",
    label:      "Defensive Red Zone % Allowed",
    unit:       "%",
    direction:  "lower",
    jsonFields: ["defRedZonePct", "defensiveRedZonePct", "defRedZoneAllowedPct", "defRZPct", "defenseRedZonePct", "defRedzonePct", "def_redzone_pct"],
  },
  // ── Player-level stats (computed from playerSeasonStatsTable by EOS handler) ──
  // Thresholds stored as integer × 10 (e.g. 75 = 7.5 YPA, 50 = 5.0 YPC).
  // EOS auto-post computes these from the team's top QB / top RB and evaluates
  // the scaled value against the stored threshold.
  {
    key:        "qb_ypa",
    label:      "QB Yards Per Attempt",
    unit:       "YPA",
    direction:  "higher",
    jsonFields: ["qbYpa", "ypa", "passYardsPerAttempt"],
  },
  {
    key:        "rb_ypc",
    label:      "RB Yards Per Carry",
    unit:       "YPC",
    direction:  "higher",
    jsonFields: ["rbYpc", "ypc", "rushYardsPerCarry"],
  },
];

export const STAT_CATEGORY_MAP = new Map(STAT_CATEGORIES.map(c => [c.key, c]));

export const STAT_CATEGORY_CHOICES = STAT_CATEGORIES.map(c => ({
  name:  c.label,
  value: c.key,
}));

// ── Default tier configurations (from league settings) ───────────────────────
// threshold is the qualifying value; tiers are ordered 1→4 (worst→best payout).
// For "lower" categories (yards/pts allowed, def RZ%), lower threshold = better tier.
export const STAT_TIER_DEFAULTS: Record<string, { threshold: number; payout: number }[]> = {
  off_pass_yds: [
    { threshold: 4500, payout: 25 },
    { threshold: 5000, payout: 50 },
    { threshold: 5500, payout: 75 },
    { threshold: 6000, payout: 100 },
  ],
  off_rush_yds: [
    { threshold: 1750, payout: 25 },
    { threshold: 2100, payout: 50 },
    { threshold: 2400, payout: 75 },
    { threshold: 2750, payout: 100 },
  ],
  off_pts_per_game: [
    { threshold: 28, payout: 25 },
    { threshold: 32, payout: 50 },
    { threshold: 36, payout: 75 },
    { threshold: 40, payout: 100 },
  ],
  off_redzone_pct: [
    { threshold: 68, payout: 25 },
    { threshold: 74, payout: 50 },
    { threshold: 80, payout: 75 },
    { threshold: 86, payout: 100 },
  ],
  def_pass_yds: [
    { threshold: 4000, payout: 25 },
    { threshold: 3600, payout: 50 },
    { threshold: 3200, payout: 75 },
    { threshold: 2800, payout: 100 },
  ],
  def_rush_yds: [
    { threshold: 1800, payout: 25 },
    { threshold: 1500, payout: 50 },
    { threshold: 1250, payout: 75 },
    { threshold: 1000, payout: 100 },
  ],
  def_pts_allowed: [
    { threshold: 550, payout: 25 },
    { threshold: 450, payout: 50 },
    { threshold: 350, payout: 75 },
    { threshold: 250, payout: 100 },
  ],
  def_sacks: [
    { threshold: 35, payout: 25 },
    { threshold: 45, payout: 50 },
    { threshold: 55, payout: 75 },
    { threshold: 65, payout: 100 },
  ],
  def_ints: [
    { threshold: 15, payout: 25 },
    { threshold: 20, payout: 50 },
    { threshold: 25, payout: 75 },
    { threshold: 30, payout: 100 },
  ],
  def_fumbles_rec: [
    { threshold: 5, payout: 25 },
    { threshold: 8, payout: 50 },
    { threshold: 11, payout: 75 },
    { threshold: 15, payout: 100 },
  ],
  def_redzone_pct: [
    { threshold: 58, payout: 25 },
    { threshold: 52, payout: 50 },
    { threshold: 46, payout: 75 },
    { threshold: 40, payout: 100 },
  ],
  // Thresholds are integer × 10 (e.g. 70 = 7.0 YPA, 45 = 4.5 YPC)
  qb_ypa: [
    { threshold: 70, payout: 25 },
    { threshold: 75, payout: 50 },
    { threshold: 80, payout: 75 },
    { threshold: 85, payout: 100 },
  ],
  rb_ypc: [
    { threshold: 45, payout: 25 },
    { threshold: 50, payout: 50 },
    { threshold: 55, payout: 75 },
    { threshold: 60, payout: 100 },
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
