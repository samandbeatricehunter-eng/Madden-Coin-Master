#!/usr/bin/env node
/**
 * refactor-split-actions.cjs
 *
 * Reads lib/actions-handlers.ts, slices it into 8 focused files, and writes
 * the slimmed-down replacement for actions-handlers.ts. Run AFTER
 * remove-features.cjs (interview/tweet sections may or may not exist — handled).
 *
 * Files created:
 *   src/lib/actions-shared.ts          — types, session, shared helpers, roster card
 *   src/lib/purchase-flow-handlers.ts  — age reset, dev up, legend, custom, training
 *   src/lib/wager-handlers.ts          — wager flow steps 1-4
 *   src/lib/player-browser-handlers.ts — view player cards, free agents, all players
 *   src/lib/team-stats-handlers.ts     — team stats interaction section
 *   src/lib/rule-violation-handlers.ts — rule violation flow
 *   src/lib/team-request-handlers.ts   — request open team, waitlist
 *
 * Files replaced (original backed up as .bak):
 *   src/lib/actions-handlers.ts        — slimmed to: imports + dispatch + coins + ROW-2 display
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT    = __dirname;
const LIB     = path.join(ROOT, "src", "lib");
const SRC_FILE = path.join(LIB, "actions-handlers.ts");

if (!fs.existsSync(SRC_FILE)) {
  console.error(`ERROR: ${SRC_FILE} not found. Run from project root.`);
  process.exit(1);
}

console.log("Reading src/lib/actions-handlers.ts …");
const src = fs.readFileSync(SRC_FILE, "utf8");

// Backup
const bak = SRC_FILE + ".bak";
if (!fs.existsSync(bak)) { fs.writeFileSync(bak, src); console.log("  Backup → actions-handlers.ts.bak"); }

// ── Anchor strings ────────────────────────────────────────────────────────────

const A = {
  TYPES:          "// ── Types ──────────────────────────────────────────────────────────────────────",
  MAIN_DISPATCH:  "// ── Main dispatch ──────────────────────────────────────────────────────────────",
  ROW1_OPEN:      "// ═══════════════════════════════════════════════════════════════════════════════\n//  ROW 1",
  WAGER:          "// ── Wager ─────────────────────────────────────────────────────────────────────",
  COINS:          "// ── Coins ─────────────────────────────────────────────────────────────────────",
  VIEW_PC:        "// ── Roster Card — View Player Cards flow ──────────────────────────────────────",
  TEAM_STATS:     "// ── Team Stats ────────────────────────────────────────────────────────────────",
  RULE_VIO:       "// ── Rule Violation ─────────────────────────────────────────────────────────────",
  TEAM_REQ:       "// ── Helpers: build open-team and all-team dual dropdowns ─────────────────────",
};

// ── Helper: slice between two anchors (inclusive of start, exclusive of end) ──

function slice(text, startAnchor, endAnchor) {
  const si = text.indexOf(startAnchor);
  if (si === -1) return "";
  const ei = endAnchor ? text.indexOf(endAnchor, si) : text.length;
  return ei === -1 ? text.slice(si) : text.slice(si, ei);
}

// ── Helper: add 'export' to every top-level function declaration ──────────────

function exportTopLevel(code) {
  // Match: (async )?function name( — at start of a line not already exported
  return code.replace(/^((?!export\s))(async function |function )(\w)/gm, "export $2$3");
}

// ── Helper: find which functions from a code block are called in the dispatch ─

function neededImports(dispatchText, exportedFns) {
  return exportedFns.filter(fn => {
    const re = new RegExp(`\\b${fn}\\s*\\(`);
    return re.test(dispatchText);
  });
}

function extractFnNames(code) {
  const re = /^export (?:async )?function (\w+)\s*\(/gm;
  const names = [];
  let m;
  while ((m = re.exec(code)) !== null) names.push(m[1]);
  return names;
}

// ── Build the shared imports header for split files ───────────────────────────
// (Copy entire original import block + add actions-shared import)

const importBlockEnd = src.indexOf("\n// ── Types");
const originalImports = importBlockEnd > 0 ? src.slice(0, importBlockEnd) : "";

const SHARED_EXTRA = `
import type { ActionsSession } from "./actions-shared.js";
import {
  getSession, touchSession, backToHubRow, cancelRow,
  buildRosterEmbed, buildRosterNavRows, buildRosterPageEmbed,
  buildRosterCardEmbed, buildRosterCardNavRow,
  ROSTER_POSITIONS, POSITION_GROUPS, POSITIONS_PER_GROUP,
  ATTR_GROUPS, ATTR_LABELS, ATTR_PAGES, ATTR_EMOJI,
  DEV_LABEL_LONG, devBadgeFromTrait,
} from "./actions-shared.js";
`;

function splitFileHeader(extra = "") {
  return originalImports + "\n" + SHARED_EXTRA + (extra ? "\n" + extra : "") + "\n";
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXTRACT SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n[1/8] Extracting shared section → actions-shared.ts …");
const sharedSection = slice(src, A.TYPES, A.MAIN_DISPATCH);

console.log("[2/8] Extracting purchase-flow section → purchase-flow-handlers.ts …");
const purchaseSection = slice(src, A.ROW1_OPEN, A.WAGER);

console.log("[3/8] Extracting wager section → wager-handlers.ts …");
const wagerSection = slice(src, A.WAGER, A.COINS);

// Coins section stays in actions-handlers — find its end
// End of coins = start of interview section OR start of ROW 2 (if interview already removed)
const coinsEnd = (() => {
  const interviewAnchor = "// ── Interview ─────────────────────────────────────────────────────────────────";
  const row2Anchor      = "// ═══════════════════════════════════════════════════════════════════════════════\n//  ROW 2";
  const interviewIdx = src.indexOf(interviewAnchor);
  const row2Idx      = src.indexOf(row2Anchor);
  // Pick whichever comes first after Coins start
  const coinsStart = src.indexOf(A.COINS);
  if (interviewIdx > coinsStart) return interviewIdx;
  if (row2Idx > coinsStart) return row2Idx;
  return src.indexOf(A.VIEW_PC, coinsStart); // fallback
})();
const coinsSection = slice(src, A.COINS, src.slice(coinsEnd).split("\n")[0]).length > 0
  ? src.slice(src.indexOf(A.COINS), coinsEnd)
  : "";

// "ROW 2 main" — everything between coins section (or interview/tweet removal) and VIEW_PC
const row2MainStart = (() => {
  const row2Anchor = "// ═══════════════════════════════════════════════════════════════════════════════\n//  ROW 2";
  const idx = src.indexOf(row2Anchor);
  if (idx !== -1) return idx;
  // fallback: use VIEW_PC as boundary (no ROW 2 header because only the View Player Cards flow is there)
  return src.indexOf(A.VIEW_PC);
})();
const row2MainSection = row2MainStart >= 0 ? src.slice(row2MainStart, src.indexOf(A.VIEW_PC, row2MainStart)) : "";

console.log("[4/8] Extracting player-browser section → player-browser-handlers.ts …");
const playerBrowserSection = slice(src, A.VIEW_PC, A.TEAM_STATS);

console.log("[5/8] Extracting team-stats section → team-stats-handlers.ts …");
const teamStatsSection = slice(src, A.TEAM_STATS, A.RULE_VIO);

console.log("[6/8] Extracting rule-violation section → rule-violation-handlers.ts …");
const ruleVioSection = slice(src, A.RULE_VIO, A.TEAM_REQ);

console.log("[7/8] Extracting team-request section → team-request-handlers.ts …");
const teamReqSection = slice(src, A.TEAM_REQ, null);

// ═══════════════════════════════════════════════════════════════════════════════
//  WRITE NEW FILES
// ═══════════════════════════════════════════════════════════════════════════════

function writeFile(relPath, content) {
  const fullPath = path.join(ROOT, relPath);
  if (fs.existsSync(fullPath)) {
    const bk = fullPath + ".bak";
    if (!fs.existsSync(bk)) fs.writeFileSync(bk, fs.readFileSync(fullPath));
  }
  fs.writeFileSync(fullPath, content);
  const lines = content.split("\n").length;
  console.log(`  ✅  Wrote ${relPath}  (${lines} lines)`);
}

// actions-shared.ts — no extra imports needed beyond originals (self-contained)
writeFile("src/lib/actions-shared.ts",
  `/**\n * actions-shared.ts\n * Shared types, session store, and UI helpers for all actions-hub split files.\n * Extracted from lib/actions-handlers.ts.\n */\n` +
  originalImports + "\n\n" +
  sharedSection + "\n",
);

// purchase-flow-handlers.ts
const purchaseExported = exportTopLevel(purchaseSection);
writeFile("src/lib/purchase-flow-handlers.ts",
  `/**\n * purchase-flow-handlers.ts\n * ROW 1 purchase flows (age reset, dev up, custom player, legend, training, contract mods).\n * Extracted from lib/actions-handlers.ts.\n */\n` +
  splitFileHeader() +
  purchaseExported + "\n",
);

// wager-handlers.ts
const wagerExported = exportTopLevel(wagerSection);
writeFile("src/lib/wager-handlers.ts",
  `/**\n * wager-handlers.ts\n * Wager flow — steps 1-4 (game select → team pick → spread → opponent).\n * Extracted from lib/actions-handlers.ts.\n */\n` +
  splitFileHeader() +
  wagerExported + "\n",
);

// player-browser-handlers.ts
const playerBrowserExported = exportTopLevel(playerBrowserSection);
writeFile("src/lib/player-browser-handlers.ts",
  `/**\n * player-browser-handlers.ts\n * View player cards, free agent browser, all-players browser (ROW 2).\n * Extracted from lib/actions-handlers.ts.\n */\n` +
  splitFileHeader() +
  playerBrowserExported + "\n",
);

// team-stats-handlers.ts
const teamStatsExported = exportTopLevel(teamStatsSection);
writeFile("src/lib/team-stats-handlers.ts",
  `/**\n * team-stats-handlers.ts\n * Team stats interaction section.\n * Extracted from lib/actions-handlers.ts.\n */\n` +
  splitFileHeader() +
  teamStatsExported + "\n",
);

// rule-violation-handlers.ts
const ruleVioExported = exportTopLevel(ruleVioSection);
writeFile("src/lib/rule-violation-handlers.ts",
  `/**\n * rule-violation-handlers.ts\n * Rule violation report flow.\n * Extracted from lib/actions-handlers.ts.\n */\n` +
  splitFileHeader() +
  ruleVioExported + "\n",
);

// team-request-handlers.ts
const teamReqExported = exportTopLevel(teamReqSection);
writeFile("src/lib/team-request-handlers.ts",
  `/**\n * team-request-handlers.ts\n * Request open team and waitlist flows.\n * Extracted from lib/actions-handlers.ts.\n */\n` +
  splitFileHeader() +
  teamReqExported + "\n",
);

// ═══════════════════════════════════════════════════════════════════════════════
//  REBUILD actions-handlers.ts (slimmed)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n[8/8] Rebuilding slimmed actions-handlers.ts …");

// Determine which functions the dispatch calls from each split file
const dispatchSection = slice(src, A.MAIN_DISPATCH, A.ROW1_OPEN);

function buildImportLine(code, file) {
  const fns = extractFnNames(exportTopLevel(code));
  const needed = neededImports(src, fns); // search entire src for calls (dispatch + session)
  if (!needed.length) return "";
  return `import { ${needed.join(", ")} } from "./${file}.js";`;
}

const splitImports = [
  buildImportLine(purchaseSection,     "purchase-flow-handlers"),
  buildImportLine(wagerSection,        "wager-handlers"),
  buildImportLine(playerBrowserSection,"player-browser-handlers"),
  buildImportLine(teamStatsSection,    "team-stats-handlers"),
  buildImportLine(ruleVioSection,      "rule-violation-handlers"),
  buildImportLine(teamReqSection,      "team-request-handlers"),
].filter(Boolean).join("\n");

const slimmedActionsHandlers =
`/**
 * actions-handlers.ts  (slimmed — see individual handler files for extracted sections)
 *
 * Contains: types, session store, shared helpers, roster card builders,
 *           main dispatch (handleActionsInteraction), coins section,
 *           ROW 2 main roster display (handleMyRoster, handleAnyRosterShow).
 *
 * Delegated to split files:
 *   purchase-flow-handlers.ts   — ROW 1 purchase flows
 *   wager-handlers.ts           — Wager flow
 *   player-browser-handlers.ts  — ROW 2 player/FA/all-players browser
 *   team-stats-handlers.ts      — Team stats
 *   rule-violation-handlers.ts  — Rule violation
 *   team-request-handlers.ts    — Request open team + waitlist
 */
${originalImports}
${splitImports}
import { getSession, touchSession } from "./actions-shared.js";
export * from "./actions-shared.js";

${sharedSection}

${dispatchSection}
${coinsSection}
${row2MainSection}
`;

writeFile("src/lib/actions-handlers.ts", slimmedActionsHandlers);

console.log(`
Done. Summary:
  actions-shared.ts          ← ${sharedSection.split("\n").length} lines of shared types/session
  purchase-flow-handlers.ts  ← ${purchaseSection.split("\n").length} lines
  wager-handlers.ts          ← ${wagerSection.split("\n").length} lines
  player-browser-handlers.ts ← ${playerBrowserSection.split("\n").length} lines
  team-stats-handlers.ts     ← ${teamStatsSection.split("\n").length} lines
  rule-violation-handlers.ts ← ${ruleVioSection.split("\n").length} lines
  team-request-handlers.ts   ← ${teamReqSection.split("\n").length} lines
  actions-handlers.ts        ← rebuilt (dispatch + coins + ROW-2 main)

All originals backed up as .bak files.
`);
