#!/usr/bin/env node
/**
 * run-all-refactors.cjs
 *
 * Master runner — executes ALL refactor scripts in the correct order.
 *
 * Run from the project root:  node run-all-refactors.cjs
 *
 * Order:
 *   1. cleanup-dead-files.cjs         — archive 15 dead command files
 *   2. fix-arch-and-startup.cjs       — fix 2 startup crashes + create lib/ barrels
 *   3. remove-features.cjs            — remove AI / league-twitter / tweets / interviews
 *   4. refactor-split-actions.cjs     — split actions-handlers.ts into 8 files
 *   5. refactor-split-admin-ops.cjs   — split admin-operations-handlers.ts into 3 files
 *   6. refactor-split-message.cjs     — split messageCreate.ts + move hub builders to lib/
 *
 * Each script writes .bak backups before touching any file.
 * If a script fails, the remaining scripts are skipped.
 */

"use strict";
const { execSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const ROOT = __dirname;

const SCRIPTS = [
  { file: "cleanup-dead-files.cjs",        desc: "Archive 15 dead command files" },
  { file: "fix-arch-and-startup.cjs",       desc: "Fix startup crashes + create lib/ barrels" },
  { file: "remove-features.cjs",            desc: "Remove AI / league-twitter / tweets / interviews" },
  { file: "refactor-split-actions.cjs",     desc: "Split actions-handlers.ts into 8 files" },
  { file: "refactor-split-admin-ops.cjs",   desc: "Split admin-operations-handlers.ts into 3 files" },
  { file: "refactor-split-message.cjs",     desc: "Split messageCreate.ts + move hub builders" },
];

const BAR = "─".repeat(70);
let passed = 0;
let failed = 0;

console.log(`\n${"═".repeat(70)}`);
console.log("  recbot — Full Refactor Runner");
console.log(`${"═".repeat(70)}\n`);

for (const { file, desc } of SCRIPTS) {
  const scriptPath = path.join(ROOT, file);
  if (!fs.existsSync(scriptPath)) {
    console.log(`${BAR}\n⚠️  SKIP  [${file}]\n  Script not found in ${ROOT}\n`);
    continue;
  }
  console.log(`${BAR}`);
  console.log(`▶  ${desc}`);
  console.log(`   ${file}\n`);
  try {
    execSync(`node "${scriptPath}"`, { cwd: ROOT, stdio: "inherit" });
    console.log(`\n✅  Done: ${file}\n`);
    passed++;
  } catch (err) {
    console.error(`\n❌  FAILED: ${file}`);
    console.error(`   Exit code: ${err.status}`);
    console.error(`   ${err.message}\n`);
    failed++;
    console.error("Stopping — fix the error above, then re-run this script or the individual script.\n");
    break;
  }
}

console.log(`${"═".repeat(70)}`);
console.log(`  Completed: ${passed} script(s)   Failed: ${failed} script(s)`);
console.log(`${"═".repeat(70)}\n`);

if (failed === 0) {
  console.log(`All refactors complete. Next steps:
  1. Run: pnpm --filter @workspace/discord-bot run typecheck
     (expect some "unused import" warnings — clean them up per file or ignore)
  2. Start the bot: pnpm --filter @workspace/discord-bot run dev
  3. Spot-check a few commands in your test server
  4. Once satisfied, delete all the .bak files:
       node -e "require('fs').readdirSync('src', {recursive:true}).filter(f=>f.endsWith('.bak')).forEach(f=>require('fs').unlinkSync('src/'+f))"
`);
}
