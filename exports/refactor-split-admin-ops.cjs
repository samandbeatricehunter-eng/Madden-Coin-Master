#!/usr/bin/env node
/**
 * refactor-split-admin-ops.cjs
 *
 * Splits lib/admin-operations-handlers.ts into 3 focused files.
 *
 * Files created:
 *   src/lib/admin-week-handlers.ts   — Set Week + Advance Week core logic (~1,265 lines)
 *   src/lib/admin-rules-handlers.ts  — Rules Hub + Rules Modal Handlers + buildRulesPages (~370 lines)
 *
 * Files replaced (original backed up as .bak):
 *   src/lib/admin-operations-handlers.ts — stripped of week + rules sections
 *
 * Import chain updates:
 *   lib/actions-handlers.ts — buildRulesPages now comes from admin-rules-handlers.js
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT     = __dirname;
const LIB      = path.join(ROOT, "src", "lib");
const SRC_FILE = path.join(LIB, "admin-operations-handlers.ts");

if (!fs.existsSync(SRC_FILE)) {
  console.error(`ERROR: ${SRC_FILE} not found. Run from project root.`);
  process.exit(1);
}

console.log("Reading src/lib/admin-operations-handlers.ts …");
const src = fs.readFileSync(SRC_FILE, "utf8");

const bak = SRC_FILE + ".bak";
if (!fs.existsSync(bak)) { fs.writeFileSync(bak, src); console.log("  Backup → admin-operations-handlers.ts.bak"); }

// ── Anchor strings ────────────────────────────────────────────────────────────

const A = {
  IMPORTS_END:   "// ── Types ──────────────────────────────────────────────────────────────────────",
  RULES_PAGES:   "export function buildRulesPages",
  SET_WEEK:      "// ── Set Week ───────────────────────────────────────────────────────────────────",
  SET_SEASON:    "// ── Set Season Number ──────────────────────────────────────────────────────────",
  RULES_HUB:     "// ── Rules Hub ─────────────────────────────────────────────────────────────────",
};

function slice(text, startAnchor, endAnchor) {
  const si = text.indexOf(startAnchor);
  if (si === -1) return "";
  const ei = endAnchor ? text.indexOf(endAnchor, si) : text.length;
  return ei === -1 ? text.slice(si) : text.slice(si, ei);
}

function exportTopLevel(code) {
  return code.replace(/^((?!export\s))(async function |function )(\w)/gm, "export $2$3");
}

function writeFile(relPath, content) {
  const fullPath = path.join(ROOT, relPath);
  if (fs.existsSync(fullPath)) {
    const bk = fullPath + ".bak";
    if (!fs.existsSync(bk)) fs.writeFileSync(bk, fs.readFileSync(fullPath));
  }
  fs.writeFileSync(fullPath, content);
  console.log(`  ✅  Wrote ${relPath}  (${content.split("\n").length} lines)`);
}

// ── Extract original imports ───────────────────────────────────────────────────

const importBlockEnd = src.indexOf("\n// ── Types");
const originalImports = importBlockEnd > 0 ? src.slice(0, importBlockEnd) : src.slice(0, src.indexOf("\nexport "));

// ── Extract buildRulesPages (currently at line ~191, before main dispatch) ────

const rulesPagesFnStart = src.indexOf(A.RULES_PAGES);
const rulesPagesFnEnd   = src.indexOf("\nexport async function handleAdminOperationsInteraction");
const rulesPagesFn      = rulesPagesFnStart !== -1
  ? src.slice(rulesPagesFnStart, rulesPagesFnEnd > rulesPagesFnStart ? rulesPagesFnEnd : rulesPagesFnStart + 500)
  : "";

// ── Extract Set Week + Advance Week section ───────────────────────────────────

console.log("\n[1/3] Extracting admin-week-handlers.ts …");
const weekSection = slice(src, A.SET_WEEK, A.SET_SEASON);

// ── Extract Rules Hub section ─────────────────────────────────────────────────

console.log("[2/3] Extracting admin-rules-handlers.ts …");
const rulesSection = slice(src, A.RULES_HUB, null); // to end of file

// ── AoSession type — copy from types section so admin-week-handlers is standalone ─

const typesSection = slice(src, A.IMPORTS_END, A.RULES_PAGES);

// ── Write admin-week-handlers.ts ──────────────────────────────────────────────

const weekContent =
`/**
 * admin-week-handlers.ts
 * Set Week + Advance Week interactive flow + core advance-week logic.
 * Extracted from lib/admin-operations-handlers.ts.
 */
${originalImports}

// ── Local AoSession type (mirrors admin-operations-handlers.ts) ───────────────
${typesSection}

${exportTopLevel(weekSection)}
`;

writeFile("src/lib/admin-week-handlers.ts", weekContent);

// ── Write admin-rules-handlers.ts ─────────────────────────────────────────────

const rulesContent =
`/**
 * admin-rules-handlers.ts
 * Rules Hub display + Rules Modal Handlers (add/edit/delete/paginate).
 * Also exports buildRulesPages, previously on admin-operations-handlers.ts.
 * Extracted from lib/admin-operations-handlers.ts.
 */
${originalImports}

// ── Shared types ──────────────────────────────────────────────────────────────
${typesSection}

${rulesPagesFn.startsWith("export") ? rulesPagesFn : "export " + rulesPagesFn}

${exportTopLevel(rulesSection)}
`;

writeFile("src/lib/admin-rules-handlers.ts", rulesContent);

// ── Rebuild admin-operations-handlers.ts (stripped) ───────────────────────────

console.log("[3/3] Rebuilding slimmed admin-operations-handlers.ts …");

// The slimmed file keeps: imports + types/session + dispatch + hub routing + init sections (up to Set Week)
// Then: Set Season Number section
// And imports buildRulesPages from admin-rules-handlers + week fns from admin-week-handlers
const keepUpToSetWeek = src.slice(0, src.indexOf(A.SET_WEEK));
const setSeasonSection = slice(src, A.SET_SEASON, A.RULES_HUB);

// Find which week functions the dispatch calls
const weekFnNames = (() => {
  const re = /^export (?:async )?function (\w+)\s*\(/gm;
  const text = exportTopLevel(weekSection);
  const names = [];
  let m;
  while ((m = re.exec(text)) !== null) names.push(m[1]);
  return names;
})();
const dispatchWeekCalls = weekFnNames.filter(fn => {
  const re = new RegExp(`\\b${fn}\\s*\\(`);
  return re.test(src);
});

const weekImport   = dispatchWeekCalls.length
  ? `import { ${dispatchWeekCalls.join(", ")} } from "./admin-week-handlers.js";`
  : `import {} from "./admin-week-handlers.js"; // week handlers`;
const rulesImport  = `import { buildRulesPages, handleRulesHub, handleRulesSection, handleRulesAdd, handleRulesEdit, handleRulesEditSel, handleRulesDelete, handleRulesPage, handleModalRulesAdd, handleModalRulesEdit, handleModalRulesDelete } from "./admin-rules-handlers.js";`;

// Remove the buildRulesPages function from keepUpToSetWeek (it's moving to admin-rules-handlers)
let slimmedKeep = keepUpToSetWeek;
if (rulesPagesFn) {
  slimmedKeep = slimmedKeep.replace(rulesPagesFn, "// buildRulesPages → moved to admin-rules-handlers.ts\n");
}

const slimmedAdminOps =
`${slimmedKeep}
${weekImport}
${rulesImport}

${setSeasonSection}
`;

writeFile("src/lib/admin-operations-handlers.ts", slimmedAdminOps);

// ── Update import in actions-handlers.ts ──────────────────────────────────────

console.log("\nUpdating actions-handlers.ts: buildRulesPages import …");
const ahPath = path.join(LIB, "actions-handlers.ts");
if (fs.existsSync(ahPath)) {
  let ah = fs.readFileSync(ahPath, "utf8");
  const ahBak = ahPath + ".bak2";
  if (!fs.existsSync(ahBak)) fs.writeFileSync(ahBak, ah);
  ah = ah.replace(
    /import\s*\{\s*buildRulesPages\s*\}\s*from\s*["']\.\/admin-operations-handlers\.js["'];?/,
    `import { buildRulesPages } from "./admin-rules-handlers.js";`,
  );
  fs.writeFileSync(ahPath, ah);
  console.log("  ✅  Updated actions-handlers.ts");
}

console.log(`
Done.
  admin-week-handlers.ts   ← ${weekSection.split("\n").length} lines
  admin-rules-handlers.ts  ← ${rulesSection.split("\n").length} lines
  admin-operations-handlers.ts ← rebuilt (strips week + rules sections)
  actions-handlers.ts      ← buildRulesPages import updated
`);
