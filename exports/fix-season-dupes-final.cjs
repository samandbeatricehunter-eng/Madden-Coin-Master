#!/usr/bin/env node
/**
 * fix-season-dupes-final.cjs
 *
 * Finds EVERY occurrence of the duplicate block
 *   import {} from "./admin-week-handlers.js"; // week handlers
 *   import { buildRulesPages … } from "./admin-rules-handlers.js";
 *   // ── Set Season Number …
 *   async function getMaxSeasons(…) { … }
 *   async function handleSetSeasonNum(…) { … }
 *   async function handleSetSeasonNumSel(…) { … }
 *   async function handleSetSeasonNumConfirm(…) { … }
 *
 * Keeps the LAST complete occurrence (the original) and deletes all earlier
 * copies in a single pass, working from the bottom of the file upward so
 * line-number shifts don't affect earlier removals.
 *
 * Run from project root:  node fix-season-dupes-final.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "src", "lib", "admin-operations-handlers.ts");

if (!fs.existsSync(TARGET)) {
  console.error("ERROR: file not found:", TARGET);
  process.exit(1);
}

const bak = TARGET + ".bak-dedup";
if (!fs.existsSync(bak)) {
  fs.copyFileSync(TARGET, bak);
  console.log("Backup →", path.basename(bak));
}

const raw   = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");
const lines = raw.split("\n");

// ── Step 1: find every 0-indexed line where getMaxSeasons is declared ─────────
const SENTINEL = "async function getMaxSeasons(";
const occurrences = [];   // 0-indexed line numbers of each declaration
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(SENTINEL)) occurrences.push(i);
}

console.log(`Found ${occurrences.length} declaration(s) of getMaxSeasons at lines: ${occurrences.map(n => n + 1).join(", ")}`);

if (occurrences.length <= 1) {
  console.log("Nothing to remove — file is already clean.");
  process.exit(0);
}

// ── Step 2: for every occurrence except the LAST, find and delete the whole block
// Process from the LAST duplicate down to the second, so earlier indices stay valid.
const toKeep = occurrences[occurrences.length - 1];  // last = original

for (let k = occurrences.length - 2; k >= 0; k--) {
  const fnLine = occurrences[k];

  // ── 2a. Walk backwards to find the real start of the duplicate block.
  //    The block starts at the nearest "import {} from" or "import {" line
  //    that precedes this function declaration (within 10 lines).
  let blockStart = fnLine;
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 15); i--) {
    const t = lines[i].trim();
    if (t.startsWith("import ") || t.startsWith("// ──")) {
      blockStart = i;
    } else if (t === "" && blockStart !== fnLine) {
      break;  // stop at blank line after we've already moved backwards
    }
  }
  // Also eat any blank lines immediately before blockStart
  while (blockStart > 0 && lines[blockStart - 1].trim() === "") blockStart--;

  // ── 2b. Walk forwards to find the end of handleSetSeasonNumConfirm.
  //    The block contains exactly 4 functions; find the close of the last one.
  const LAST_FN = "async function handleSetSeasonNumConfirm(";
  let inLastFn   = false;
  let depth      = 0;
  let blockEnd   = fnLine;

  for (let i = fnLine; i < lines.length; i++) {
    if (lines[i].includes(LAST_FN)) inLastFn = true;
    if (inLastFn) {
      for (const ch of lines[i]) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (depth === 0 && i > fnLine) {
        blockEnd = i;
        break;
      }
    }
    // Safety: don't run past the keeper occurrence
    if (i >= toKeep - 1) { blockEnd = i; break; }
  }

  // Also eat trailing blank lines
  while (blockEnd + 1 < lines.length && lines[blockEnd + 1].trim() === "") blockEnd++;

  const count = blockEnd - blockStart + 1;
  console.log(`  Removing duplicate block at lines ${blockStart + 1}–${blockEnd + 1} (${count} lines)`);
  lines.splice(blockStart, count);

  // Adjust remaining occurrence indices (all earlier ones are unaffected
  // since we process from the bottom; the keeper index shifts down)
  // We don't need to adjust `toKeep` because we process from bottom up.
}

// ── Step 3: write ─────────────────────────────────────────────────────────────
fs.writeFileSync(TARGET, lines.join("\n"), "utf8");
console.log(`\n✅  Done. File is now ${lines.length} lines.`);
console.log("Try starting the bot now.\n");
