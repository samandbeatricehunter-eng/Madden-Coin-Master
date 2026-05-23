#!/usr/bin/env node
/**
 * fix-routing-bugs.cjs
 *
 * Applies all six routing fixes identified in the code review.
 * Run from the project root:  node fix-routing-bugs.cjs
 *
 * Fixes applied
 * ─────────────
 * 1. Missing braces on ac_ dispatch in handleButton, handleSelectMenu, handleModal
 *    (unconditional return was making ao_, ccp_, vca_, interview_, wager_ etc. dead code)
 * 2. Missing import for handleMenuDepartmentInteraction + wires dept router into ac_ select path
 * 3. Dead code after inline `return` in commissioner-office intercept blocks
 * 4. adminOperations slash command not registered in commands array (index.ts)
 * 5. Operator-precedence bug in isActionsInteraction (go_ clause was unguarded)
 */

"use strict";
const fs   = require("fs");
const path = require("path");

// ── File paths (relative to project root) ─────────────────────────────────────
const IC_FILE    = path.join(__dirname, "src", "events", "interactionCreate.ts");
const INDEX_FILE = path.join(__dirname, "src", "index.ts");

if (!fs.existsSync(IC_FILE))    throw new Error(`Not found: ${IC_FILE}`);
if (!fs.existsSync(INDEX_FILE)) throw new Error(`Not found: ${INDEX_FILE}`);

function backup(file) {
  const dest = file + ".bak-fix-routing-" + Date.now();
  fs.copyFileSync(file, dest);
  console.log(`  Backed up → ${path.basename(dest)}`);
}

function apply(label, content, search, replace, opts = {}) {
  const isRegex  = search instanceof RegExp;
  const found    = isRegex ? search.test(content) : content.includes(search);

  if (!found) {
    if (opts.required !== false) {
      console.warn(`  ⚠️  [${label}] Pattern not found — skipping (may already be fixed)`);
    }
    return content;
  }

  const count = isRegex
    ? (content.match(new RegExp(search.source, search.flags + (search.flags.includes("g") ? "" : "g"))) || []).length
    : content.split(search).length - 1;

  const result = isRegex
    ? content.replace(search, replace)
    : (opts.replaceAll ? content.split(search).join(replace) : content.replace(search, replace));

  console.log(`  ✅ [${label}] Applied (${count} occurrence${count !== 1 ? "s" : ""})`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH interactionCreate.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nPatching src/events/interactionCreate.ts …");
backup(IC_FILE);
let ic = fs.readFileSync(IC_FILE, "utf8");

// ── Fix 2 — add missing import for handleMenuDepartmentInteraction ────────────
// Insert right after the existing new-server-setup-handlers import block.
const NSS_IMPORT = `import {
  handleNewServerSetupInteraction,
  isNewServerSetupCustomId,
} from "../lib/new-server-setup-handlers.js";`;

const DEPT_IMPORT = `import { handleMenuDepartmentInteraction } from "../lib/menu-department-router.js";`;

if (!ic.includes("menu-department-router")) {
  ic = apply(
    "Fix 2 — import handleMenuDepartmentInteraction",
    ic,
    NSS_IMPORT,
    NSS_IMPORT + "\n" + DEPT_IMPORT,
  );
} else {
  console.log("  ✅ [Fix 2] menu-department-router already imported — skipping");
}

// ── Fix 1 — add braces to ac_ dispatch (handleButton) ────────────────────────
// Pattern appears inside handleButton — just needs braces, no dept router needed
// (the dept router guards itself: returns false for non-SelectMenu interactions)
const BROKEN_AC_DISPATCH =
  "  if (action?.startsWith(\"ac_\")) await handleActionsInteraction(interaction); return;";

const FIXED_AC_DISPATCH =
  "  if (action?.startsWith(\"ac_\")) {\n" +
  "    const handledDept = await handleMenuDepartmentInteraction(interaction as any);\n" +
  "    if (handledDept) return;\n" +
  "    await handleActionsInteraction(interaction);\n" +
  "    return;\n" +
  "  }";

const occurrencesBefore = ic.split(BROKEN_AC_DISPATCH).length - 1;
if (occurrencesBefore === 0) {
  console.warn("  ⚠️  [Fix 1] Broken ac_ dispatch pattern not found — may already be fixed");
} else {
  ic = ic.split(BROKEN_AC_DISPATCH).join(FIXED_AC_DISPATCH);
  console.log(`  ✅ [Fix 1] Fixed missing braces on ac_ dispatch (${occurrencesBefore} occurrence${occurrencesBefore !== 1 ? "s" : ""})`);
}

// ── Fix 3a — dead code in commissioner-office intercept (handleButton) ────────
ic = apply(
  "Fix 3a — dead code in commissioner-office intercept",
  ic,
  `    const handled = await handleActionsInteraction(interaction); return;\n    if (handled) return;\n  }\n\n  // ── Actions hub`,
  `    await handleActionsInteraction(interaction);\n    return;\n  }\n\n  // ── Actions hub`,
);

// ── Fix 3b — dead code in ac_office_select intercept (handleSelectMenu) ───────
ic = apply(
  "Fix 3b — dead code in ac_office_select intercept",
  ic,
  `    const handled = await handleActionsInteraction(interaction); return;\n    if (handled) return;\n  }\n\n  const parts`,
  `    await handleActionsInteraction(interaction);\n    return;\n  }\n\n  const parts`,
);

// ── Fix 5 — operator precedence in isActionsInteraction ──────────────────────
const BROKEN_IS_ACTIONS =
  "  const isActionsInteraction = (interaction.isButton() || interaction.isStringSelectMenu())\n" +
  "    && typeof (interaction as any).customId === \"string\"\n" +
  "    && (interaction as any).customId.startsWith(\"ac_\") || (\"customId\" in interaction && interaction.customId?.startsWith(\"go_\")); ";

const FIXED_IS_ACTIONS =
  "  const isActionsInteraction = (\n" +
  "    (interaction.isButton() || interaction.isStringSelectMenu()) &&\n" +
  "    typeof (interaction as any).customId === \"string\" &&\n" +
  "    (\n" +
  "      (interaction as any).customId.startsWith(\"ac_\") ||\n" +
  "      (interaction as any).customId.startsWith(\"go_\")\n" +
  "    )\n" +
  "  );";

ic = apply("Fix 5 — isActionsInteraction operator precedence", ic, BROKEN_IS_ACTIONS, FIXED_IS_ACTIONS);

fs.writeFileSync(IC_FILE, ic.replace(/\r\n/g, "\n"), "utf8");
console.log("  Saved.\n");

// ─────────────────────────────────────────────────────────────────────────────
// PATCH src/index.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("Patching src/index.ts …");
backup(INDEX_FILE);
let idx = fs.readFileSync(INDEX_FILE, "utf8");

// ── Fix 4 — add adminOperations to commands array ────────────────────────────
// It's imported but missing from the array; the slash command name is "admin-menu".
if (!idx.includes("import * as adminOperations")) {
  console.warn("  ⚠️  [Fix 4] adminOperations import not found in index.ts — skipping");
} else if (/commands\s*=\s*\[[\s\S]*?\badminOperations\b/.test(idx)) {
  console.log("  ✅ [Fix 4] adminOperations already in commands array — skipping");
} else {
  // Find the last entry before the closing ] of the commands array
  idx = apply(
    "Fix 4 — register adminOperations slash command",
    idx,
    "adminRepostBanners, lottery,",
    "adminRepostBanners, lottery, adminOperations,",
  );
}

fs.writeFileSync(INDEX_FILE, idx.replace(/\r\n/g, "\n"), "utf8");
console.log("  Saved.\n");

// ─────────────────────────────────────────────────────────────────────────────
console.log("Done. Summary:");
console.log("  Fix 1 — missing braces on ac_ dispatch (handleButton / handleSelectMenu / handleModal)");
console.log("  Fix 2 — import + wire handleMenuDepartmentInteraction into ac_ select path");
console.log("  Fix 3 — removed dead `if (handled) return` after unconditional returns");
console.log("  Fix 4 — adminOperations added to commands array in index.ts");
console.log("  Fix 5 — isActionsInteraction go_ clause now correctly parenthesized");
console.log("\nNext step: run `pnpm run typecheck` (or tsc --noEmit) to confirm no type errors.");
