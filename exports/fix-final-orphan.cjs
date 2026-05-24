#!/usr/bin/env node
/**
 * fix-final-orphan.cjs
 *
 * Removes the orphan `return;` + `}` lines that sit between
 * showAdminDepartmentMenu's closing brace and the next real statement.
 * Uses function-boundary tracking instead of exact-string matching so it
 * works regardless of surrounding blank lines or line-number shifts.
 *
 * Safe to run multiple times — idempotent.
 * Run from project root:  node fix-final-orphan.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "src", "lib", "admin-operations-handlers.ts");

if (!fs.existsSync(TARGET)) {
  console.error("ERROR: File not found:", TARGET);
  process.exit(1);
}

const bakPath = TARGET + ".bak-orphan";
if (!fs.existsSync(bakPath)) {
  fs.copyFileSync(TARGET, bakPath);
  console.log("Backup →", path.basename(bakPath));
}

const raw   = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");
const lines = raw.split("\n");

// ── Step 1: Locate showAdminDepartmentMenu ─────────────────────────────────────
const funcIdx = lines.findIndex(l =>
  l.trim().startsWith("async function showAdminDepartmentMenu(")
);

if (funcIdx === -1) {
  console.log("ℹ  showAdminDepartmentMenu not found in file — nothing to do.");
  process.exit(0);
}
console.log(`Found showAdminDepartmentMenu at line ${funcIdx + 1}`);

// ── Step 2: Brace-track to its closing } ──────────────────────────────────────
// Naive char-by-char count is sufficient; the function body has no unbalanced
// braces in string literals at this depth.
let depth      = 0;
let closingIdx = -1;

for (let i = funcIdx; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
  }
  if (depth === 0 && i > funcIdx) {
    closingIdx = i;
    break;
  }
}

if (closingIdx === -1) {
  console.warn("⚠  Could not find closing } of showAdminDepartmentMenu");
  process.exit(1);
}
console.log(`showAdminDepartmentMenu closes at line ${closingIdx + 1}: "${lines[closingIdx].trim()}"`);

// ── Step 3: Sweep forward and remove orphan lines ─────────────────────────────
// Rules:
//   • Blank lines — skip silently (don't break the loop)
//   • `return;` with indentation > 0 — orphan, remove
//   • `}` with indentation > 0 — orphan, remove
//   • Anything else — stop (first legitimate content after the function)
let idx     = closingIdx + 1;
let removed = 0;

while (idx < lines.length) {
  const line   = lines[idx];
  const t      = line.trim();
  const indent = line.length - line.trimStart().length;

  if (t === "") {
    // blank line — skip but don't remove
    idx++;
    continue;
  }

  if (t === "return;" && indent > 0) {
    console.log(`  ✅  Removing orphan \`return;\` (line ${idx + 1}): "${line}"`);
    lines.splice(idx, 1); // splice shifts everything up; don't increment idx
    removed++;
    continue;
  }

  if (t === "}" && indent > 0) {
    console.log(`  ✅  Removing orphan \`}\` (line ${idx + 1}): "${line}"`);
    lines.splice(idx, 1);
    removed++;
    continue;
  }

  // First non-blank, non-orphan line — stop
  console.log(`  ℹ  First legitimate line after function: line ${idx + 1} → "${t.slice(0, 60)}"`);
  break;
}

if (removed === 0) {
  console.log("ℹ  No orphan lines found — file may already be clean.");
  process.exit(0);
}

// ── Step 4: Write ──────────────────────────────────────────────────────────────
fs.writeFileSync(TARGET, lines.join("\n"), "utf8");
console.log(`\n✅  Wrote ${TARGET}`);
console.log(`   Removed ${removed} orphan line(s).\n`);
console.log("Try restarting the bot now.\n");
