/**
 * In-memory roster cache shared between leagueRead routes and the franchise processor.
 * Key pattern: `league_rosters:{seasonId}`
 * TTL: 10 minutes. Invalidated immediately after any roster import.
 */

const ROSTER_CACHE_TTL_MS = 10 * 60 * 1000;

interface RosterCacheEntry {
  data: unknown;
  expiresAt: number;
}

const _cache = new Map<string, RosterCacheEntry>();

function cacheKey(seasonId: number): string {
  return `league_rosters:${seasonId}`;
}

export function getRosterCache(seasonId: number): unknown | null {
  const entry = _cache.get(cacheKey(seasonId));
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

export function setRosterCache(seasonId: number, data: unknown): void {
  _cache.set(cacheKey(seasonId), { data, expiresAt: Date.now() + ROSTER_CACHE_TTL_MS });
}

export function invalidateRostersCache(seasonId: number): void {
  _cache.delete(cacheKey(seasonId));
  console.log(`[rostersCache] Invalidated cache for seasonId=${seasonId}`);
}
