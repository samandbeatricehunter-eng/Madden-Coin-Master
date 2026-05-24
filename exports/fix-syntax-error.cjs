#!/usr/bin/env node
/**
 * fix-syntax-error.cjs
 *
 * CRLF-safe replacement for fix-broken-imports.cjs.
 * Normalizes Windows line-endings before applying patches so every regex
 * and exact-string replacement works correctly on Windows machines.
 *
 * Patches 6 files:
 *   src/lib/admin-operations-handlers.ts  — removes 4 archived imports + openaiClient block + call-sites
 *   src/events/interactionCreate.ts       — removes league-twitter import + logTradeEvent calls
 *   src/events/messageCreate.ts           — removes openai-fallback + league-twitter imports + call-sites
 *   src/index.ts                          — removes league-twitter import + startLeagueTwitterScheduler call
 *   src/lib/playoff-matchups-runner.ts    — removes league-twitter import + cacheMatchupsForTwitter call
 *   src/lib/weekly-matchups-runner.ts     — removes league-twitter import + cacheMatchupsForTwitter call
 *
 * Run from project root:  node fix-syntax-error.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT = __dirname;
let totalChanges = 0;

/**
 * Read, normalize CRLF → LF, apply patches, write back.
 * Backups are written once as <file>.bak (does not overwrite an existing .bak).
 */
function patchFile(relPath, patches) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`  ⚠️  SKIP (not found): ${relPath}\n`);
    return;
  }

  const bakPath = fullPath + ".bak2";
  const rawOriginal = fs.readFileSync(fullPath, "utf8");

  // Write a backup before first modification
  if (!fs.existsSync(bakPath)) fs.writeFileSync(bakPath, rawOriginal);

  // Normalize to LF so all patterns work on both Windows and Unix
  let content = rawOriginal.replace(/\r\n/g, "\n");
  let fileChanges = 0;

  for (const { desc, find, replace, findRe } of patches) {
    const before = content;
    if (findRe) {
      content = content.replace(findRe, replace ?? "");
    } else if (find !== undefined) {
      if (content.includes(find)) {
        content = content.split(find).join(replace ?? "");
      }
    }
    if (content !== before) {
      console.log(`  ✅  ${desc}`);
      fileChanges++;
      totalChanges++;
    } else {
      console.log(`  ℹ️  Already clean / not found: ${desc}`);
    }
  }

  if (fileChanges > 0) {
    // Write back with LF (consistent regardless of OS)
    fs.writeFileSync(fullPath, content, "utf8");
    console.log(`  💾  Saved ${relPath}\n`);
  } else {
    console.log(`  (no changes needed in ${relPath})\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. admin-operations-handlers.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("── [1/6] src/lib/admin-operations-handlers.ts ───────────────────────");
patchFile("src/lib/admin-operations-handlers.ts", [

  // ── Broken imports ─────────────────────────────────────────────────────────
  {
    desc: "Remove franchise-article import",
    findRe: /^import \{ generateFranchiseArticle,\s*generateWeekPreview \} from "\.\/franchise-article\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove send-article import",
    findRe: /^import \{ sendArticleChunked \} from "\.\/send-article\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove matchup-ai-breakdown import",
    findRe: /^import \{ generateMatchupBreakdown \} from "\.\/matchup-ai-breakdown\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove openai-fallback import",
    findRe: /^import OpenAI from "\.\/openai-fallback\.js";\n/m,
    replace: "",
  },

  // ── openaiClient instantiation (module-level const) ───────────────────────
  // Match the whole block: const openaiClient = new OpenAI({ ... });
  {
    desc: "Remove openaiClient instantiation",
    findRe: /\nconst openaiClient\s*=\s*new OpenAI\(\{[^}]*\}\);\n/,
    replace: "\n",
  },

  // ── Call-sites ─────────────────────────────────────────────────────────────
  // The custom-article handler body that calls openaiClient + sendArticleChunked
  {
    desc: "Stub openaiClient.chat.completions.create block",
    findRe: /const response = await openaiClient\.chat\.completions\.create\(\{[\s\S]*?\}\);\n[\s\S]*?await \(sendArticleChunked as Function\)\(channel, header, article\);\n/,
    replace: "  // AI article generation removed — archived\n  await interaction.editReply({ content: '❌ AI article feature has been removed.' });\n  return;\n",
  },
  // The advance-week async IIFE that calls generateFranchiseArticle
  {
    desc: "Stub advance-week article IIFE",
    findRe: /\(async \(\) => \{\s*const tc = headlinesChannel as TextChannel;[\s\S]*?\}\)\(\);/,
    replace: "// Article generation removed — franchise-article archived",
  },
  // Any remaining standalone sendArticleChunked calls
  {
    desc: "Remove stray sendArticleChunked calls",
    findRe: /\s*await (?:\(sendArticleChunked as Function\)|sendArticleChunked)\([^;]*\);\n/g,
    replace: "\n",
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 2. events/interactionCreate.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("── [2/6] src/events/interactionCreate.ts ────────────────────────────");
patchFile("src/events/interactionCreate.ts", [
  {
    desc: "Remove league-twitter import (logTradeEvent)",
    findRe: /^import \{ logTradeEvent \} from "\.\.\/lib\/league-twitter\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove logTradeEvent call-sites",
    findRe: /\s*(?:await )?logTradeEvent\([^)]*\)(?:\.catch\([^)]*\))?;?\n/g,
    replace: "\n",
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 3. events/messageCreate.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("── [3/6] src/events/messageCreate.ts ────────────────────────────────");
patchFile("src/events/messageCreate.ts", [
  {
    desc: "Remove openai-fallback import",
    findRe: /^import OpenAI from "\.\.\/lib\/openai-fallback\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove league-twitter import (handleTwitterReply)",
    findRe: /^import \{ handleTwitterReply \} from "\.\.\/lib\/league-twitter\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove handleTwitterReply call-site",
    findRe: /\s*handleTwitterReply\(message\.client, message\)\.catch\([^)]*\)[^;]*;\n/,
    replace: "\n",
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 4. src/index.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("── [4/6] src/index.ts ───────────────────────────────────────────────");
patchFile("src/index.ts", [
  {
    desc: "Remove league-twitter import (startLeagueTwitterScheduler)",
    findRe: /^import \{ startLeagueTwitterScheduler \}\s*from "\.\/lib\/league-twitter\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove startLeagueTwitterScheduler() call",
    findRe: /^\s*startLeagueTwitterScheduler\(client\);\n/m,
    replace: "",
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 5. lib/playoff-matchups-runner.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("── [5/6] src/lib/playoff-matchups-runner.ts ─────────────────────────");
patchFile("src/lib/playoff-matchups-runner.ts", [
  {
    desc: "Remove league-twitter import (cacheMatchupsForTwitter)",
    findRe: /^import \{ cacheMatchupsForTwitter \} from "\.\/league-twitter\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove cacheMatchupsForTwitter call-site",
    findRe: /\s*await cacheMatchupsForTwitter\([\s\S]*?\);\n/,
    replace: "\n",
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 6. lib/weekly-matchups-runner.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("── [6/6] src/lib/weekly-matchups-runner.ts ──────────────────────────");
patchFile("src/lib/weekly-matchups-runner.ts", [
  {
    desc: "Remove league-twitter import (cacheMatchupsForTwitter)",
    findRe: /^import \{ cacheMatchupsForTwitter \} from "\.\/league-twitter\.js";\n/m,
    replace: "",
  },
  {
    desc: "Remove cacheMatchupsForTwitter call-site",
    findRe: /\s*await cacheMatchupsForTwitter\([\s\S]*?\);\n/,
    replace: "\n",
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
console.log("═".repeat(68));
console.log(`  fix-syntax-error: ${totalChanges} change(s) applied`);
console.log("═".repeat(68) + "\n");
if (totalChanges > 0) {
  console.log("Now try running the bot again.");
}
