/**
 * In-memory roster cache shared between leagueRead routes and the franchise/v2 processors.
 * Key pattern: `{namespace}:{id}` where namespace is "v1" or "v2" to prevent
 * serial-ID collisions between franchise_seasons and mca_seasons tables.
 * TTL: 10 minutes. Invalidated immediately after any roster import.
 */

import { logger } from "./logger.js";

const ROSTER_CACHE_TTL_MS = 10 * 60 * 1000;

interface RosterCacheEntry {
  data: unknown;
  expiresAt: number;
}

const _cache = new Map<string, RosterCacheEntry>();

function cacheKey(namespace: string, id: number): string {
  return `${namespace}:${id}`;
}

export function getRosterCache(namespace: string, id: number): unknown | null {
  const entry = _cache.get(cacheKey(namespace, id));
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

export function setRosterCache(namespace: string, id: number, data: unknown): void {
  _cache.set(cacheKey(namespace, id), { data, expiresAt: Date.now() + ROSTER_CACHE_TTL_MS });
}

export function invalidateRostersCache(namespace: string, id: number): void {
  _cache.delete(cacheKey(namespace, id));
  logger.info({ namespace, id }, "[rostersCache] Cache invalidated");
}
