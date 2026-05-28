export type WagerSide = "home" | "away";

export type WagerDraft = {
  guildId: string;
  userId: string;
  scheduleGameId?: string;
  wagerTeam?: string;
  wagerOpponentId?: string;
  wagerOpponentTeam?: string;
  wagerAmount?: number;
  wagerSpread?: number;
  wagerSide?: WagerSide;
  wagerHomeTeam?: string;
  wagerAwayTeam?: string;
  wagerHomeDiscordId?: string;
  wagerAwayDiscordId?: string;
  updatedAt: number;
};

const WAGER_DRAFT_TTL_MS = 15 * 60 * 1000;
const wagerDrafts = new Map<string, WagerDraft>();

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function sweepExpiredDrafts() {
  const now = Date.now();
  for (const [draftKey, draft] of wagerDrafts.entries()) {
    if (now - draft.updatedAt > WAGER_DRAFT_TTL_MS) wagerDrafts.delete(draftKey);
  }
}

export function getWagerDraft(guildId: string, userId: string): WagerDraft {
  sweepExpiredDrafts();
  const draftKey = key(guildId, userId);
  const existing = wagerDrafts.get(draftKey);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }
  const draft: WagerDraft = { guildId, userId, updatedAt: Date.now() };
  wagerDrafts.set(draftKey, draft);
  return draft;
}

export function patchWagerDraft(guildId: string, userId: string, patch: Partial<WagerDraft>): WagerDraft {
  const draft = { ...getWagerDraft(guildId, userId), ...patch, guildId, userId, updatedAt: Date.now() };
  wagerDrafts.set(key(guildId, userId), draft);
  return draft;
}

export function clearWagerDraft(guildId: string, userId: string): void {
  wagerDrafts.delete(key(guildId, userId));
}
