export const WEEK_SEQUENCE = [
  "1","2","3","4","5","6","7","8","9","10",
  "11","12","13","14","15","16","17","18",
  "wildcard","divisional","conference","superbowl","offseason","training_camp",
];

export function weekLabel(week: string): string {
  if (/^\d+$/.test(week)) return `Week ${week}`;
  if (week === "training_camp") return "Training Camp";
  return week.charAt(0).toUpperCase() + week.slice(1);
}

// Canonical numeric weekIndex used by game_schedules / gotw_history.
// Regular season "1".."18" → 0..17. Playoff sentinels match the constants in
// franchise/playoff-matchups-runner.ts. Returns null for non-game weeks
// (training_camp, offseason).
export function currentWeekIndexFor(currentWeek: string | null | undefined): number | null {
  if (!currentWeek) return null;
  if (/^\d+$/.test(currentWeek)) {
    const n = parseInt(currentWeek, 10);
    if (n >= 1 && n <= 18) return n - 1;
    return null;
  }
  if (currentWeek === "wildcard")   return 1018;
  if (currentWeek === "divisional") return 1019;
  if (currentWeek === "conference") return 1020;
  if (currentWeek === "superbowl")  return 1022;
  return null;
}

// Inverse of currentWeekIndexFor: render a label from a numeric weekIndex.
export function weekLabelForIndex(weekIndex: number): string {
  if (weekIndex >= 0 && weekIndex <= 17) return `Week ${weekIndex + 1}`;
  if (weekIndex === 1018) return "Wildcard";
  if (weekIndex === 1019) return "Divisional";
  if (weekIndex === 1020) return "Conference Championship";
  if (weekIndex === 1022) return "Super Bowl";
  return `Week ${weekIndex + 1}`;
}
