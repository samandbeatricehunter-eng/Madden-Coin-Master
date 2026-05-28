import { cleanupGamedayState } from "../lib/gameday/domain/cleanup.js";
import { reconcileImportedGameResults } from "../lib/gameday/domain/reconciliation.js";

async function main() {
  const sync = await reconcileImportedGameResults({ limit: 1000 });
  const cleanup = await cleanupGamedayState();
  console.log(JSON.stringify({ sync, cleanup }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
