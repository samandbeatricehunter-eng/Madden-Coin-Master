import type { AdminAction } from "./admin-actions.js";

export interface PendingCoCommAction {
  id: string;
  action: AdminAction;
  issuerId: string;
  issuerDisplayName: string;
  guildId: string;
  originalChannelId: string;
  summaryText: string;
  expiresAt: number;
}

export const pendingCoCommActions = new Map<string, PendingCoCommAction>();

export function purgeExpiredCoCommActions(): void {
  const now = Date.now();
  for (const [id, entry] of pendingCoCommActions) {
    if (entry.expiresAt < now) pendingCoCommActions.delete(id);
  }
}
