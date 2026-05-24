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
