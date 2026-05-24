#!/usr/bin/env node
/**
 * remove-season-recap.cjs
 *
 * Removes all season-recap references from wildcard-automation.ts:
 *   1. Static import line for ./season-recap.js
 *   2. The "2. AI season recap" try/catch block (~lines 240-245)
 *   3. The "Season recap (historical channel only)" try/catch block (~lines 843-849)
 *
 * Content-based matching — works regardless of local line numbers.
 * Run from project root:  node remove-season-recap.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "src", "lib", "wildcard-automation.ts");

if (!fs.existsSync(TARGET)) {
  console.error("ERROR: file not found:", TARGET);
  process.exit(1);
}

const bak = TARGET + ".bak-no-recap";
if (!fs.existsSync(bak)) {
  fs.copyFileSync(TARGET, bak);
  console.log("Backup →", path.basename(bak));
}

const raw   = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");
let lines   = raw.split("\n");
let removed = 0;

// ── Helper: remove a contiguous block anchored by a start-line test ───────────
// Scans for the first line matching `startTest`, then removes from that line
// (or from `preLines` blank/comment lines before it) through the first line
// matching `endTest` (inclusive), plus any immediately following blank lines.
function removeBlock(startTest, endTest, label) {
  const startIdx = lines.findIndex(l => startTest(l));
  if (startIdx === -1) {
    console.log(`  ℹ  "${label}" not found — already removed or never present.`);
    return;
  }

  // Walk backwards to include a leading comment / blank line if present
  let blockStart = startIdx;
  if (blockStart > 0 && (lines[blockStart - 1].trim().startsWith("// ──") || lines[blockStart - 1].trim() === "")) {
    blockStart--;
  }

  // Walk forwards to find the end line
  let blockEnd = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    if (endTest(lines[i])) { blockEnd = i; break; }
  }

  // Also eat one trailing blank line
  if (blockEnd + 1 < lines.length && lines[blockEnd + 1].trim() === "") blockEnd++;

  const count = blockEnd - blockStart + 1;
  console.log(`  ✅  Removing "${label}" — lines ${blockStart + 1}–${blockEnd + 1} (${count} lines)`);
  lines.splice(blockStart, count);
  removed += count;
}

// ── 1. Static import ─────────────────────────────────────────────────────────
{
  const idx = lines.findIndex(l => l.includes("season-recap.js") && l.trim().startsWith("import "));
  if (idx === -1) {
    console.log("  ℹ  Static import for season-recap not found.");
  } else {
    console.log(`  ✅  Removing static import at line ${idx + 1}`);
    lines.splice(idx, 1);
    removed++;
  }
}

// ── 2. runOffseasonHistoricalPost — "AI season recap" try/catch ───────────────
removeBlock(
  l => l.includes("// ── 2. AI season recap"),
  l => l.trim() === "}" && l.startsWith("  }"),   // closes the try/catch at 2-space indent
  "2. AI season recap block",
);

// ── 3. rebuildHistoricalChannel — dynamic import try/catch ────────────────────
removeBlock(
  l => l.includes("Season recap (historical channel only"),
  l => l.trim() === "}" && l.startsWith("  }"),
  "Season recap (historical channel only) block",
);

// ── Write ────────────────────────────────────────────────────────────────────
if (removed === 0) {
  console.log("\nℹ  Nothing was changed — file may already be clean.");
  process.exit(0);
}

fs.writeFileSync(TARGET, lines.join("\n"), "utf8");
console.log(`\n✅  Done. Removed ${removed} line(s). File is now ${lines.length} lines.\n`);
