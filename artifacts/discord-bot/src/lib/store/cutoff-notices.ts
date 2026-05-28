/**
 * Store purchase cutoff helpers.
 *
 * These helpers are intentionally tiny and dependency-free so both the legacy
 * actions handler and the extracted store routers can share the same cutoff
 * policy without reintroducing circular imports.
 */

function normalizeWeek(currentWeek: unknown): string {
  return String(currentWeek ?? "").trim().toLowerCase();
}

function numericWeek(currentWeek: unknown): number | null {
  const raw = normalizeWeek(currentWeek);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Legends close at the advance to Week 16.
 * Weeks 1-15 are open. Playoff/offseason labels are closed.
 */
export function legendPurchasesOpen(currentWeek: unknown): boolean {
  const n = numericWeek(currentWeek);
  return n !== null && n < 16;
}

/**
 * Custom player submissions close at the advance to Divisional Round.
 * Regular season, Wild Card, and non-numeric labels before divisional remain open.
 */
export function customPlayersOpen(currentWeek: unknown): boolean {
  const raw = normalizeWeek(currentWeek);
  if (!raw) return true;
  if (["divisional", "conference", "superbowl", "offseason", "super bowl"].includes(raw)) return false;
  return true;
}
