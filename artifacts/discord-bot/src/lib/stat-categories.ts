export type StatDirection = "higher" | "lower";

export interface StatCategory {
  key:       string;
  label:     string;
  unit:      string;
  direction: StatDirection;
  jsonFields: string[];
}

// All configurable end-of-season stat categories.
// direction "higher" = higher value is better (offensive stats + def INTs)
// direction "lower"  = lower value is better (def yards/pts/redzone allowed)
export const STAT_CATEGORIES: StatCategory[] = [
  // ── Offense ──────────────────────────────────────────────────────────────────
  {
    key:        "off_pass_yds",
    label:      "Offensive Passing Yards",
    unit:       "yds",
    direction:  "higher",
    jsonFields: ["offPassYds", "passYds", "off_pass_yds", "passingYards"],
  },
  {
    key:        "off_rush_yds",
    label:      "Offensive Rushing Yards",
    unit:       "yds",
    direction:  "higher",
    jsonFields: ["offRushYds", "rushYds", "off_rush_yds", "rushingYards"],
  },
  {
    key:        "off_pass_tds",
    label:      "Offensive Passing TDs",
    unit:       "TDs",
    direction:  "higher",
    jsonFields: ["offPassTDs", "passTDs", "offPassingTDs", "passingTDs"],
  },
  {
    key:        "off_rush_tds",
    label:      "Offensive Rushing TDs",
    unit:       "TDs",
    direction:  "higher",
    jsonFields: ["offRushTDs", "rushTDs", "offRushingTDs", "rushingTDs"],
  },
  {
    key:        "off_pts_scored",
    label:      "Total Points Scored",
    unit:       "pts",
    direction:  "higher",
    jsonFields: ["offPtsScored", "ptsScored", "totalPtsScored", "pointsScored", "offTotalPts"],
  },
  {
    key:        "off_redzone_pct",
    label:      "Offensive Red Zone %",
    unit:       "%",
    direction:  "higher",
    jsonFields: ["offRedZonePct", "redZonePct", "offRZPct", "offensiveRedzonePct"],
  },
  // ── Defense ──────────────────────────────────────────────────────────────────
  {
    key:        "def_rush_yds",
    label:      "Defensive Rushing Yards Allowed",
    unit:       "yds",
    direction:  "lower",
    jsonFields: ["defRushYds", "defRushYdsAllowed", "def_rush_yds", "rushingYardsAllowed"],
  },
  {
    key:        "def_pass_yds",
    label:      "Defensive Passing Yards Allowed",
    unit:       "yds",
    direction:  "lower",
    jsonFields: ["defPassYds", "defPassYdsAllowed", "def_pass_yds", "passingYardsAllowed"],
  },
  {
    key:        "def_ints",
    label:      "Defensive Interceptions",
    unit:       "INTs",
    direction:  "higher",
    jsonFields: ["defInts", "defTotalInts", "totalInts", "def_ints", "interceptions"],
  },
  {
    key:        "def_redzone_pct",
    label:      "Defensive Red Zone % Allowed",
    unit:       "%",
    direction:  "lower",
    jsonFields: ["defRedZonePct", "defRZPct", "defRedZoneAllowedPct", "def_redzone_pct"],
  },
  {
    key:        "def_pts_allowed",
    label:      "Total Points Allowed",
    unit:       "pts",
    direction:  "lower",
    jsonFields: ["defPtsAllowed", "ptsAllowed", "totalPtsAllowed", "pointsAllowed", "defTotalPts"],
  },
];

export const STAT_CATEGORY_MAP = new Map(STAT_CATEGORIES.map(c => [c.key, c]));

export const STAT_CATEGORY_CHOICES = STAT_CATEGORIES.map(c => ({
  name:  c.label,
  value: c.key,
}));

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
