export type RecRoleDisplay = {
  name: string;
  kind: "structural" | "badge" | "metric";
  description: string;
  threshold: string;
};

export const REC_ALL_ROLES_FOR_DISPLAY: RecRoleDisplay[] = [
  {
    name: "Commissioner",
    kind: "structural",
    description: "League operations and commissioner-office access.",
    threshold: "Assigned by server staff.",
  },
  {
    name: "Co-Commissioner",
    kind: "structural",
    description: "Shared commissioner operations access.",
    threshold: "Assigned by server staff.",
  },
  {
    name: "Super Bowl Champion",
    kind: "badge",
    description: "Permanent championship recognition.",
    threshold: "Awarded after a Super Bowl win.",
  },
  {
    name: "Steady Streamer",
    kind: "metric",
    description: "Consistently streams games for league accountability.",
    threshold: "60%+ approved stream rate with 5+ tracked H2H games, or 9+ recent approved streams.",
  },
  {
    name: "Elite Competitor",
    kind: "metric",
    description: "High-performing H2H user identity role.",
    threshold: "Based on league-defined wins, standings, and performance metrics.",
  },
  {
    name: "Content Creator",
    kind: "metric",
    description: "Recognizes consistent media/highlight participation.",
    threshold: "Based on approved stream/highlight activity.",
  },
];
