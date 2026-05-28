/**
 * Phase 16 MCA import cleanup boundary.
 *
 * This file documents and exposes the intended source-of-truth contract for the
 * API-side import processors. It keeps processor cleanup separate from Discord
 * gameday behavior while preserving existing importer behavior until the large
 * franchise processor is fully split.
 */
export type McaImportReconciliationTarget =
  | "teams"
  | "schedule"
  | "rosters"
  | "standings"
  | "player_stats"
  | "draft_picks";

export type McaImportReconciliationResult = {
  target: McaImportReconciliationTarget;
  checked: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export function emptyReconciliationResult(target: McaImportReconciliationTarget): McaImportReconciliationResult {
  return { target, checked: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };
}

export const MCA_IMPORT_SOURCE_OF_TRUTH = {
  teams: "franchise_mca_teams",
  schedule: "franchise_schedule",
  rosters: "franchise_rosters",
  standings: "season_stats",
  playerStats: "player_stats",
  gameDiscordBridge: "guild_franchise_game_links",
} as const;
