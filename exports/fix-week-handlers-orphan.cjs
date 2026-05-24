#!/usr/bin/env node
/**
 * fix-week-handlers-orphan.cjs
 *
 * Removes the two orphaned lines between showAdminDepartmentMenu and the
 * manage_economy if-block in src/lib/admin-week-handlers.ts:
 *
 *   Before:
 *     }                            ← closes showAdminDepartmentMenu
 *         return;                  ← ORPHAN
 *       }                          ← ORPHAN
 *
 *     if (selected === "manage_economy") { ...
 *
 *   After:
 *     }                            ← closes showAdminDepartmentMenu
 *
 *     if (selected === "manage_economy") { ...
 *
 * Run from project root:  node fix-week-handlers-orphan.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "src", "lib", "admin-week-handlers.ts");

if (!fs.existsSync(TARGET)) {
  console.error("ERROR: file not found:", TARGET);
  process.exit(1);
}

const bak = TARGET + ".bak-orphan";
if (!fs.existsSync(bak)) {
  fs.copyFileSync(TARGET, bak);
  console.log("Backup →", path.basename(bak));
}

const raw  = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");
let lines  = raw.split("\n");

// Find the anchor: line containing ONLY "if (selected === "manage_economy")"
const econIdx = lines.findIndex(l => l.trim() === `if (selected === "manage_economy") {`);
if (econIdx === -1) {
  console.error('ERROR: Could not find `if (selected === "manage_economy")` anchor line.');
  process.exit(1);
}

// Walk backwards from econIdx to find the two orphan lines.
// We expect a blank line, then "  }" then "    return;" just before econIdx.
let removed = 0;
let i = econIdx - 1;

// Skip any blank lines immediately before the manage_economy block
while (i >= 0 && lines[i].trim() === "") i--;

// Expect "  }" (2-space closing brace)
if (i >= 0 && /^\s+\}$/.test(lines[i])) {
  console.log(`  Removing orphan "}" at line ${i + 1}: ${JSON.stringify(lines[i])}`);
  lines.splice(i, 1);
  removed++;
  i--;
}

// Skip any blank lines again
while (i >= 0 && lines[i].trim() === "") i--;

// Expect "    return;" (indented return)
if (i >= 0 && /^\s+return\s*;\s*$/.test(lines[i])) {
  console.log(`  Removing orphan "return;" at line ${i + 1}: ${JSON.stringify(lines[i])}`);
  lines.splice(i, 1);
  removed++;
}

if (removed === 0) {
  console.log("ℹ  No orphan lines found — file may already be clean.");
  process.exit(0);
}

fs.writeFileSync(TARGET, lines.join("\n"), "utf8");
console.log(`\n✅  Done. Removed ${removed} orphan line(s). File is now ${lines.length} lines.\n`);
