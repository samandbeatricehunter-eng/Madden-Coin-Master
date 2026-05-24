#!/usr/bin/env node
/**
 * fix-admin-ops-definitive.cjs
 *
 * FINAL fix for src/lib/admin-operations-handlers.ts.
 * Uses pure line-by-line processing — no regex, no block matching —
 * so it works regardless of what previous scripts have already done to the file.
 *
 * What it fixes:
 *   1. Removes any of the 4 archived import lines (if still present)
 *   2. Removes the orphan `    return;` + `  }` pair that causes "Unexpected }"
 *   3. Replaces handleModalCustomArticle with a stub (removes openaiClient call)
 *
 * Run from project root:  node fix-admin-ops-definitive.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "src", "lib", "admin-operations-handlers.ts");

if (!fs.existsSync(TARGET)) {
  console.error("ERROR: File not found:", TARGET);
  process.exit(1);
}

// Backup (once only)
const bakPath = TARGET + ".bak-definitive";
if (!fs.existsSync(bakPath)) {
  fs.copyFileSync(TARGET, bakPath);
  console.log("Backup →", path.basename(bakPath));
}

// Normalize CRLF → LF
const raw = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");
const lines = raw.split("\n");

// ── Lines to remove outright (matched by trimmed content) ─────────────────
const REMOVE_IMPORTS = new Set([
  'import { generateFranchiseArticle, generateWeekPreview } from "./franchise-article.js";',
  'import { sendArticleChunked } from "./send-article.js";',
  'import { generateMatchupBreakdown } from "./matchup-ai-breakdown.js";',
  'import OpenAI from "./openai-fallback.js";',
  // Also remove the openaiClient module-level const (single-line variant)
  'const openaiClient = new OpenAI({',
]);

const ARTICLE_FUNC_OPEN = "async function handleModalCustomArticle(interaction: ModalSubmitInteraction) {";

const ARTICLE_FUNC_STUB = [
  "async function handleModalCustomArticle(interaction: ModalSubmitInteraction) {",
  "  await interaction.deferReply({ ephemeral: true });",
  "  await interaction.editReply({ content: \"❌ AI article generation has been removed.\" });",
  "}",
].join("\n");

const result = [];
let i = 0;
let changes = 0;

while (i < lines.length) {
  const line  = lines[i];
  const trimmed = line.trim();

  // ── 1. Skip archived import lines ───────────────────────────────────────
  if (REMOVE_IMPORTS.has(trimmed)) {
    console.log(`  ✅  Removed import/const: ${trimmed.slice(0, 70)}`);
    i++;
    changes++;

    // If this was the openaiClient = new OpenAI({ opener, skip until the closing });
    if (trimmed === "const openaiClient = new OpenAI({") {
      while (i < lines.length) {
        const skip = lines[i].trim();
        i++;
        if (skip === "});") break;
      }
    }
    continue;
  }

  // ── 2. Remove orphan `    return;` + following `  }` ────────────────────
  // This orphan appears right after showAdminDepartmentMenu's closing `}`.
  // Detection: line is `    return;` (4-space indent) AND the last emitted
  // line was a bare `}` (top-level function close).
  if (
    trimmed === "return;" &&
    line.startsWith("    ") &&           // 4-space indent (was inside something)
    result.length > 0 &&
    result[result.length - 1].trim() === "}" &&
    !result[result.length - 1].startsWith(" ")  // previous line is bare `}` (col 0)
  ) {
    console.log("  ✅  Removed orphan `    return;`");
    i++;
    changes++;
    // Skip the following `  }` orphan brace if present
    if (i < lines.length && lines[i].trim() === "}") {
      console.log("  ✅  Removed orphan `  }`");
      i++;
      changes++;
    }
    continue;
  }

  // ── 3. Replace handleModalCustomArticle with a stub ───────────────────
  if (trimmed === ARTICLE_FUNC_OPEN) {
    result.push(ARTICLE_FUNC_STUB);
    console.log("  ✅  Replaced handleModalCustomArticle with stub");
    i++;
    changes++;
    // Skip the rest of the original function body
    let depth = 1; // opening { is already on the first line
    while (i < lines.length && depth > 0) {
      const l = lines[i];
      for (const ch of l) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      i++;
    }
    continue;
  }

  result.push(line);
  i++;
}

if (changes === 0) {
  console.log("\nℹ  No changes needed — file is already clean.\n");
  process.exit(0);
}

fs.writeFileSync(TARGET, result.join("\n"), "utf8");
console.log(`\n✅  Wrote ${TARGET}`);
console.log(`   ${changes} fix(es) applied.\n`);
console.log("Now try running the bot again.\n");
