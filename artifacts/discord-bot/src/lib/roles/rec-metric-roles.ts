export type RecRoleKind = "structural" | "badge" | "metric";

export type RecRoleDisplay = {
  name: string;
  kind: RecRoleKind;
  description: string;
  threshold: string;
};

/**
 * Display-only registry used by the member role breakdown panel.
 *
 * These names should match the REC League Discord role language, but this file
 * intentionally does not mutate roles. Role syncing remains handled by the
 * dedicated league-role systems.
 */
export const REC_ALL_ROLES_FOR_DISPLAY: readonly RecRoleDisplay[] = [
  {
    name: "Commissioner",
    kind: "structural",
    description: "Full league administration and commissioner office access.",
    threshold: "Assigned by league ownership.",
  },
  {
    name: "Co-Commissioner",
    kind: "structural",
    description: "Trusted commissioner support role with moderation/review access.",
    threshold: "Assigned by commissioner.",
  },
  {
    name: "Team Owner",
    kind: "structural",
    description: "Linked franchise user with access to league member tools.",
    threshold: "Linked to an active REC team.",
  },
  {
    name: "Super Bowl Champion",
    kind: "badge",
    description: "Permanent recognition for winning a REC Super Bowl.",
    threshold: "Win a REC Super Bowl.",
  },
  {
    name: "Conference Champion",
    kind: "badge",
    description: "Recognition for reaching and winning a conference title game.",
    threshold: "Win a conference championship.",
  },
  {
    name: "Playoff Team",
    kind: "badge",
    description: "Recognition for qualifying for the postseason.",
    threshold: "Make the playoffs.",
  },
  {
    name: "Elite Winner",
    kind: "metric",
    description: "High-volume winner identity role based on H2H success.",
    threshold: "Top-tier all-time H2H win total.",
  },
  {
    name: "Hot Streak",
    kind: "metric",
    description: "Awarded when recent game results show a strong active streak.",
    threshold: "Multi-game win streak.",
  },
  {
    name: "Clutch Performer",
    kind: "metric",
    description: "Recognition for late-season or playoff performance.",
    threshold: "Strong playoff or high-leverage wins.",
  },
  {
    name: "Offensive Menace",
    kind: "metric",
    description: "Identity role for users producing elite offensive results.",
    threshold: "Top offensive production tier.",
  },
  {
    name: "Defensive Dawg",
    kind: "metric",
    description: "Identity role for users producing elite defensive results.",
    threshold: "Top defensive production tier.",
  },
  {
    name: "Turnover King",
    kind: "metric",
    description: "Recognition for strong turnover differential or takeaways.",
    threshold: "Top turnover/takeaway tier.",
  },
  {
    name: "Air Raid",
    kind: "metric",
    description: "Passing-heavy production identity role.",
    threshold: "Top passing production tier.",
  },
  {
    name: "Ground And Pound",
    kind: "metric",
    description: "Run-game production identity role.",
    threshold: "Top rushing production tier.",
  },
  {
    name: "Legacy Builder",
    kind: "metric",
    description: "Long-term recognition for accumulated league success.",
    threshold: "All-time milestone tier.",
  },
] as const;
