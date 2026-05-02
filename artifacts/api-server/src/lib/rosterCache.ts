/**
 * In-memory roster cache shared between leagueRead routes and the franchise/v2 processors.
 * Key pattern: `{namespace}:{id}` when namespace is provided, else just `id`.
 * v1 callers pass only `id`; v2 callers pass `(id, "v2")` so serial IDs from
 * different tables (franchise_seasons vs mca_seasons) can never collide.
 * TTL: 10 minutes. Invalidated immediately after any roster import.
 */

import { logger } from "./logger.js";

const ROSTER_CACHE_TTL_MS = 10 * 60 * 1000;

interface RosterCacheEntry {
  data: unknown;
  expiresAt: number;
}

const _cache = new Map<string, RosterCacheEntry>();

function cacheKey(id: number, namespace: string): string {
  return namespace ? `${namespace}:${id}` : String(id);
}

export function getRosterCache(id: number, namespace = ""): unknown | null {
  const entry = _cache.get(cacheKey(id, namespace));
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

export function setRosterCache(id: number, data: unknown, namespace = ""): void {
  _cache.set(cacheKey(id, namespace), { data, expiresAt: Date.now() + ROSTER_CACHE_TTL_MS });
}

export function invalidateRostersCache(id: number, namespace = ""): void {
  _cache.delete(cacheKey(id, namespace));
  logger.info({ namespace, id }, "[rostersCache] Cache invalidated");
}
