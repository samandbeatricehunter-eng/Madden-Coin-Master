#!/usr/bin/env node
/**
 * cleanup-dead-files.cjs
 *
 * Moves confirmed-dead command files into src/_archive/ so they stop
 * cluttering the codebase. Nothing is permanently deleted — just relocated.
 *
 * Run from the project root:  node cleanup-dead-files.cjs
 *
 * Files archived (15 total, ~3,390 lines):
 *   commands/purchase.ts            — replaced by actions hub
 *   commands/userstats.ts           — replaced by actions hub
 *   commands/viewroster.ts          — replaced by actions hub
 *   commands/buy-devup.ts           — replaced by actions hub
 *   commands/buy-agereset.ts        — replaced by actions hub
 *   commands/buy-legend.ts          — replaced by actions hub
 *   commands/purchasecustomplayer.ts— only used by other dead files
 *   commands/buy-customplayer.ts    — empty stub
 *   commands/admin-deleteuser.ts    — replaced by admin-user-data hub
 *   commands/admin-clearteam.ts     — replaced by admin-user-data hub
 *   commands/admin-transactions.ts  — no references anywhere
 *   commands/admin-gotw.ts          — replaced by admin-menu
 *   commands/adminserver.ts         — re-exports only, no callers
 *   commands/admin-seed-emojis.ts   — one-time utility, no callers
 *   commands/rules.ts               — replaced by actions hub
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const SRC_DIR     = path.join(__dirname, "src");
const ARCHIVE_DIR = path.join(SRC_DIR, "_archive");
const COMMANDS_DIR = path.join(SRC_DIR, "commands");

const DEAD_FILES = [
  "purchase.ts",
  "userstats.ts",
  "viewroster.ts",
  "buy-devup.ts",
  "buy-agereset.ts",
  "buy-legend.ts",
  "purchasecustomplayer.ts",
  "buy-customplayer.ts",
  "admin-deleteuser.ts",
  "admin-clearteam.ts",
  "admin-transactions.ts",
  "admin-gotw.ts",
  "adminserver.ts",
  "admin-seed-emojis.ts",
  "rules.ts",
];

if (!fs.existsSync(SRC_DIR)) {
  throw new Error(`src/ not found at ${SRC_DIR} — run this script from the project root.`);
}

if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR);
  console.log(`Created ${path.relative(__dirname, ARCHIVE_DIR)}/`);
}

let moved = 0;
let skipped = 0;
let alreadyArchived = 0;

console.log("\nArchiving dead command files…\n");

for (const file of DEAD_FILES) {
  const src  = path.join(COMMANDS_DIR, file);
  const dest = path.join(ARCHIVE_DIR, file);

  if (!fs.existsSync(src)) {
    console.log(`  ⚠️  SKIP   ${file} — not found (already removed?)`);
    skipped++;
    continue;
  }

  if (fs.existsSync(dest)) {
    console.log(`  ⚠️  SKIP   ${file} — already in _archive/`);
    alreadyArchived++;
    continue;
  }

  fs.renameSync(src, dest);
  const lines = fs.readFileSync(dest, "utf8").split("\n").length;
  console.log(`  ✅  MOVED  ${file.padEnd(36)} (${lines} lines)`);
  moved++;
}

const totalLines = DEAD_FILES.reduce((sum, f) => {
  const p = path.join(ARCHIVE_DIR, f);
  return sum + (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").length : 0);
}, 0);

console.log(`
Done.
  Moved:    ${moved} file(s)
  Skipped:  ${skipped + alreadyArchived} file(s)
  Total lines removed from active codebase: ~${totalLines.toLocaleString()}

Files are in src/_archive/ — permanently delete that folder
once you've confirmed the bot still runs correctly.

─────────────────────────────────────────────────────────────
Next steps (manual refactoring — see recbot-refactor-analysis.md):
  1. Split lib/actions-handlers.ts (7,114 lines) into 7 focused files
  2. Split events/messageCreate.ts — move AI logic to lib/ai-chat.ts
  3. Split lib/admin-operations-handlers.ts — extract week + rules handlers
  4. Move interaction handlers OUT of commands/ INTO lib/
─────────────────────────────────────────────────────────────
`);
