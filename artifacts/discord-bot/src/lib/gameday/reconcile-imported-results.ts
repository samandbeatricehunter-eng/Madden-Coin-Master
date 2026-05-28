import type { Client } from "discord.js";
import { cleanupGamedayState } from "./domain/cleanup.js";
import { reconcileImportedGameResults } from "./domain/reconciliation.js";

let running = false;

export async function processGamedayReconciliationTick(_client?: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const sync = await reconcileImportedGameResults({ limit: 500 });
    const cleanup = await cleanupGamedayState();

    if (sync.updated > 0 || cleanup.expiredOffers > 0 || cleanup.orphanChannelsMarked > 0) {
      console.log("[gameday-reconciliation]", JSON.stringify({ sync, cleanup }));
    }
  } catch (err) {
    console.error("[gameday-reconciliation] tick failed:", err);
  } finally {
    running = false;
  }
}

export function startGamedayReconciliationScheduler(client: Client): NodeJS.Timeout {
  processGamedayReconciliationTick(client).catch((err) =>
    console.error("[gameday-reconciliation] initial tick failed:", err),
  );

  return setInterval(() => {
    processGamedayReconciliationTick(client).catch((err) =>
      console.error("[gameday-reconciliation] interval tick failed:", err),
    );
  }, 15 * 60 * 1000);
}
