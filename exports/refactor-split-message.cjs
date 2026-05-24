#!/usr/bin/env node
/**
 * refactor-split-message.cjs
 *
 * Two things in one pass:
 *
 * 1. Splits events/messageCreate.ts:
 *      src/lib/stream-monitor.ts   ← handleStreamPost + handleHighlightPost
 *      events/messageCreate.ts     ← slimmed (imports from stream-monitor)
 *
 * 2. Fixes Architectural Issue C:
 *      src/lib/actions-hub-embeds.ts ← buildActionsHubEmbed/Rows, buildUnlinkedHubEmbed/Rows
 *                                       (moved from commands/actions.ts)
 *      commands/actions.ts           ← stripped, imports from actions-hub-embeds
 *      lib/actions-handlers.ts       ← import updated to actions-hub-embeds
 *      lib/league-operations-menu.ts ← import updated to actions-hub-embeds
 *
 * Run from the project root:  node refactor-split-message.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT     = __dirname;
const SRC      = path.join(ROOT, "src");
const LIB      = path.join(SRC, "lib");
const COMMANDS = path.join(SRC, "commands");
const EVENTS   = path.join(SRC, "events");

function readBak(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const bak = filePath + ".bak";
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, src);
  return src;
}

function writeFile(relPath, content) {
  const fullPath = path.join(ROOT, relPath);
  if (fs.existsSync(fullPath)) {
    const bk = fullPath + ".bak";
    if (!fs.existsSync(bk)) fs.writeFileSync(bk, fs.readFileSync(fullPath));
  }
  fs.writeFileSync(fullPath, content);
  console.log(`  ✅  Wrote  ${relPath}  (${content.split("\n").length} lines)`);
}

function slice(text, startAnchor, endAnchor) {
  const si = text.indexOf(startAnchor);
  if (si === -1) return "";
  const ei = endAnchor ? text.indexOf(endAnchor, si) : text.length;
  return ei === -1 ? text.slice(si) : text.slice(si, ei);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 1 — messageCreate.ts split
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n[1/4] Splitting events/messageCreate.ts …");

const mcPath = path.join(EVENTS, "messageCreate.ts");
if (!fs.existsSync(mcPath)) {
  console.log("  ⚠️  events/messageCreate.ts not found — skipping messageCreate split");
} else {
  const mc = readBak(mcPath);

  const MONITORS_START = "// ── Channel-based payout monitors ─────────────────────────────────────────────";
  const COMM_HELPERS   = "// ── Commissioner role helpers ──────────────────────────────────────────────────";

  const monitorsSection = slice(mc, MONITORS_START, COMM_HELPERS);

  if (!monitorsSection) {
    console.log("  ℹ️  Channel monitors section not found — may already be split");
  } else {
    // ── Build lib/stream-monitor.ts ─────────────────────────────────────────────
    // Collect the imports messageCreate already has at the top
    const mcImportEnd   = mc.indexOf("\nexport const name");
    const mcImports     = mcImportEnd > 0 ? mc.slice(0, mcImportEnd) : "";

    writeFile("src/lib/stream-monitor.ts",
`/**
 * stream-monitor.ts
 * Handles #stream and #highlights channel post detection and coin payout requests.
 * Extracted from events/messageCreate.ts.
 */
${mcImports}

export ${monitorsSection.trimStart()}
`);

    // ── Rebuild messageCreate.ts ─────────────────────────────────────────────────
    // Remove the monitors block and replace with an import
    const slimmedMc = mc
      .replace(monitorsSection, "\n// Stream + highlight monitors — see lib/stream-monitor.ts\n")
      .replace(
        /^(import\s)/m,
        `import { handleStreamPost, handleHighlightPost } from "../lib/stream-monitor.js";\n$1`,
      );

    writeFile("src/events/messageCreate.ts", slimmedMc);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 2 — Architectural Issue C: move hub builders out of commands/actions.ts
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n[2/4] Creating lib/actions-hub-embeds.ts (Issue C fix) …");

const actionsPath = path.join(COMMANDS, "actions.ts");
if (!fs.existsSync(actionsPath)) {
  console.log("  ⚠️  commands/actions.ts not found — skipping Issue C");
} else {
  const actions = readBak(actionsPath);

  // The four builder functions start at "export function buildActionsHubEmbed"
  // and end just before "export async function execute"
  const BUILDERS_START = "export function buildActionsHubEmbed(";
  const EXECUTE_START  = "export async function execute(";

  const buildersSection = slice(actions, BUILDERS_START, EXECUTE_START);

  if (!buildersSection) {
    console.log("  ℹ️  Hub builder functions not found in commands/actions.ts — may already be moved");
  } else {
    // Collect the imports from actions.ts (before the SlashCommandBuilder.setName)
    const actionsImportEnd = actions.indexOf("\nexport const data");
    const actionsImports   = actionsImportEnd > 0 ? actions.slice(0, actionsImportEnd) : "";

    // ── Write lib/actions-hub-embeds.ts ───────────────────────────────────────
    writeFile("src/lib/actions-hub-embeds.ts",
`/**
 * actions-hub-embeds.ts
 * Embed and row builders for the /actions (Coaches Office) hub.
 * Moved from commands/actions.ts — fixes the backwards lib/ → commands/ dependency.
 */
${actionsImports}

${buildersSection}
`);

    // ── Strip builders from commands/actions.ts, replace with import ──────────
    console.log("[3/4] Patching commands/actions.ts …");
    const slimmedActions = actions.replace(
      buildersSection,
      `// Hub embed/row builders moved to lib/actions-hub-embeds.ts\n`,
    ).replace(
      // Add the import right after the last existing import line
      /(import[^\n]+\n)(\n*export const data)/,
      `$1import { buildActionsHubEmbed, buildActionsHubRows, buildUnlinkedHubEmbed, buildUnlinkedHubRows } from "../lib/actions-hub-embeds.js";\n$2`,
    );
    writeFile("src/commands/actions.ts", slimmedActions);

    // ── Update actions-handlers.ts ────────────────────────────────────────────
    console.log("[4/4] Updating import paths in lib/actions-handlers.ts and lib/league-operations-menu.ts …");

    const updateImport = (filePath, relPath) => {
      if (!fs.existsSync(filePath)) return;
      let content = fs.readFileSync(filePath, "utf8");
      const bk = filePath + ".bak";
      if (!fs.existsSync(bk)) fs.writeFileSync(bk, content);
      const updated = content.replace(
        /import\s*\{\s*(buildActionsHubEmbed[^}]*)\}\s*from\s*["']\.\.?\/commands\/actions\.js["'];?/,
        `import { $1} from "../lib/actions-hub-embeds.js";`,
      ).replace(
        /import\s*\{\s*(buildActionsHubEmbed[^}]*)\}\s*from\s*["']\.\/actions\.js["'];?/,
        `import { $1} from "./actions-hub-embeds.js";`,
      );
      if (updated !== content) {
        fs.writeFileSync(filePath, updated);
        console.log(`  ✅  Updated ${relPath}`);
      } else {
        console.log(`  ℹ️  No change needed in ${relPath}`);
      }
    };

    updateImport(path.join(LIB, "actions-handlers.ts"),       "lib/actions-handlers.ts");
    updateImport(path.join(LIB, "league-operations-menu.ts"), "lib/league-operations-menu.ts");
  }
}

console.log(`
Done.
  lib/stream-monitor.ts    ← handleStreamPost + handleHighlightPost
  events/messageCreate.ts  ← slimmed, imports from stream-monitor
  lib/actions-hub-embeds.ts← 4 hub builder functions
  commands/actions.ts      ← stripped, imports from actions-hub-embeds
  lib/actions-handlers.ts  ← import updated
  lib/league-operations-menu.ts ← import updated
`);
