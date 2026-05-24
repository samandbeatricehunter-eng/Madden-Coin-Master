#!/usr/bin/env node
/**
 * fix-remaining-cleanup.cjs
 *
 * Handles the four post-refactor manual items:
 *
 *  1. events/messageCreate.ts      — stub out AI block; keep channel monitors + @mention guard
 *  2. lib/actions-handlers.ts      — remove interviewrequest.js import + ac_interview/ac_tweet dispatch lines
 *  3. lib/eos-auto-post.ts         — remove gcs-fallback import; stub out article data calls
 *  4. lib/wildcard-automation.ts   — remove season-recap import + dynamic import usage
 *     lib/season-recap.ts          — archive to src/_archive/
 *
 * Run from project root:  node fix-remaining-cleanup.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT    = __dirname;
const SRC     = path.join(ROOT, "src");
const LIB     = path.join(SRC, "lib");
const EVENTS  = path.join(SRC, "events");
const ARCHIVE = path.join(SRC, "_archive");

if (!fs.existsSync(ARCHIVE)) fs.mkdirSync(ARCHIVE, { recursive: true });

let totalChanges = 0;

function patchFile(relPath, patches) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`  ⚠️  SKIP (not found): ${relPath}`);
    return;
  }
  // Backup
  const bak = fullPath + ".bak";
  const original = fs.readFileSync(fullPath, "utf8");
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, original);

  let content = original;
  let fileChanges = 0;

  for (const { desc, find, replace, findRe } of patches) {
    let next;
    if (findRe) {
      next = content.replace(findRe, replace ?? "");
    } else {
      if (!content.includes(find)) {
        console.log(`  ℹ️  Already applied or not found: "${desc}"`);
        continue;
      }
      next = content.split(find).join(replace ?? "");
    }
    if (next !== content) {
      console.log(`  ✅  ${desc}`);
      content = next;
      fileChanges++;
      totalChanges++;
    }
  }

  if (fileChanges > 0) {
    fs.writeFileSync(fullPath, content);
    console.log(`  Saved ${relPath} (${fileChanges} change(s))\n`);
  } else {
    console.log(`  No changes needed in ${relPath}\n`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  1. events/messageCreate.ts — stub out AI block
// ═══════════════════════════════════════════════════════════════════════════════

console.log("── [1/5] events/messageCreate.ts — stub AI block ─────────────────────");

// The AI block runs from "// Show typing" to the end of execute(), just before
// the standalone splitIntoChunks helper. We replace the whole section with an
// offline stub and drop the now-unused splitIntoChunks function.

patchFile("src/events/messageCreate.ts", [
  {
    desc: "Replace AI chatbot block with offline stub",
    // Start: the "Show typing" comment that kicks off the AI path
    // End  : closing brace of execute() + blank line before splitIntoChunks
    findRe: /\/\/ Show typing while we work[\s\S]*?^}/m,
    replace:
`  // AI assistant is currently offline — direct users to slash commands
  await message.reply(
    "Hey! The AI assistant is currently offline. Use slash commands for anything you need."
  ).catch(() => {});
  return;
}`,
  },
  {
    desc: "Remove unused splitIntoChunks helper function",
    findRe: /\/\*\* Split text into chunks[\s\S]*?^}\s*$/m,
    replace: "",
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  2. lib/actions-handlers.ts — remove interview import + stale dispatch lines
// ═══════════════════════════════════════════════════════════════════════════════

console.log("── [2/5] lib/actions-handlers.ts — remove interview import + dispatch ─");

patchFile("src/lib/actions-handlers.ts", [
  {
    desc: "Remove interviewrequest.js import block",
    find: `import {
  INTERVIEW_QUESTIONS, pickThreeIndices, getQuestionPool, interviewTypeLabel,
  type InterviewType,
} from "../commands/interviewrequest.js";`,
    replace: "",
  },
  {
    desc: "Remove ac_interview dispatch line",
    findRe: /^\s*if \(id === "ac_interview"\)\s*\{[^\n]+\}\n/m,
    replace: "",
  },
  {
    desc: "Remove ac_tweet dispatch line",
    findRe: /^\s*if \(id === "ac_tweet"\)\s*\{[^\n]+\}\n/m,
    replace: "",
  },
  {
    desc: "Remove ac_modal_tweet dispatch line",
    findRe: /^\s*if \(id === "ac_modal_tweet"\)\s*\{[^\n]+\}\n/m,
    replace: "",
  },
  {
    desc: "Remove handleInterviewTypePick export (stale after interview removal)",
    findRe: /^export async function handleInterviewTypePick[\s\S]*?^}\n/m,
    replace: "",
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  3. lib/eos-auto-post.ts — remove gcs-fallback import; stub article data calls
// ═══════════════════════════════════════════════════════════════════════════════

console.log("── [3/5] lib/eos-auto-post.ts — remove gcs-fallback dependency ────────");

patchFile("src/lib/eos-auto-post.ts", [
  {
    desc: "Remove gcs-fallback import",
    findRe: /^import \{ getArticleStandings, getSeasonRecords \} from "\.\/gcs-fallback\.js";\n/m,
    replace: "",
  },
  {
    desc: "Stub getArticleStandings call (article posts removed)",
    findRe: /const allStandings\s*=\s*await getArticleStandings\([^)]+\);/,
    replace: `const allStandings: any[] = []; // article-posts removed`,
  },
  {
    desc: "Stub getSeasonRecords call (article posts removed)",
    findRe: /const \{ records:\s*prRecords \}\s*=\s*await getSeasonRecords\([^)]+\);/,
    replace: `const prRecords: any[] = []; // article-posts removed`,
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  4. lib/wildcard-automation.ts — remove season-recap dependency
// ═══════════════════════════════════════════════════════════════════════════════

console.log("── [4/5] lib/wildcard-automation.ts — remove season-recap dependency ──");

patchFile("src/lib/wildcard-automation.ts", [
  {
    desc: "Remove static season-recap import",
    findRe: /^import \{ postSeasonRecap \} from "\.\/season-recap\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove dynamic season-recap import block inside rebuildHistoricalChannel",
    // Targets the try { const { postSeasonRecap } = await import(...) ... } catch block
    findRe: /\/\/ ── Season recap[\s\S]*?console\.error\("\[rebuild\] Season recap failed:"[\s\S]*?\}\s*\n/,
    replace: "  // Season recap removed (franchise-article feature archived)\n",
  },
  {
    desc: "Remove postSeasonRecap call in runWildcardAutomation (if present)",
    findRe: /\bawait postSeasonRecap\([^;]+\);\n/g,
    replace: "",
  },
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Archive lib/season-recap.ts
// ═══════════════════════════════════════════════════════════════════════════════

console.log("── [5/5] Archive lib/season-recap.ts ────────────────────────────────");

const seasonRecapSrc = path.join(LIB, "season-recap.ts");
const seasonRecapDst = path.join(ARCHIVE, "season-recap.ts");

if (!fs.existsSync(seasonRecapSrc)) {
  console.log("  ℹ️  lib/season-recap.ts already gone or not found\n");
} else if (fs.existsSync(seasonRecapDst)) {
  console.log("  ℹ️  Already archived: src/_archive/season-recap.ts\n");
} else {
  fs.renameSync(seasonRecapSrc, seasonRecapDst);
  console.log("  ✅  Moved lib/season-recap.ts → src/_archive/season-recap.ts\n");
  totalChanges++;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`${"═".repeat(68)}`);
console.log(`  fix-remaining-cleanup: ${totalChanges} change(s) applied`);
console.log(`${"═".repeat(68)}`);

if (totalChanges > 0) {
  console.log(`
Next: run  pnpm --filter @workspace/discord-bot run typecheck
and check for any remaining compile errors — there should be none.
`);
}
