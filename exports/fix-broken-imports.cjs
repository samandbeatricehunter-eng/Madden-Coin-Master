#!/usr/bin/env node
/**
 * fix-broken-imports.cjs
 *
 * Removes every import that references an archived module so the bot starts up.
 * Also stubs the call-sites so no orphan references remain.
 *
 * Files patched:
 *   src/lib/admin-operations-handlers.ts   — franchise-article / send-article / matchup-ai / openai-fallback
 *   src/events/interactionCreate.ts        — league-twitter (logTradeEvent)
 *   src/events/messageCreate.ts            — openai-fallback + league-twitter (handleTwitterReply)
 *   src/index.ts                           — league-twitter (startLeagueTwitterScheduler)
 *   src/lib/playoff-matchups-runner.ts     — league-twitter (cacheMatchupsForTwitter)
 *   src/lib/weekly-matchups-runner.ts      — league-twitter (cacheMatchupsForTwitter)
 *
 * Run from project root:  node fix-broken-imports.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT = __dirname;
let totalChanges = 0;

function patchFile(relPath, patches) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`  ⚠️  SKIP (not found): ${relPath}\n`);
    return;
  }
  const bak = fullPath + ".bak";
  const original = fs.readFileSync(fullPath, "utf8");
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, original);

  let content = original;
  let fileChanges = 0;

  for (const { desc, find, replace, findRe } of patches) {
    const before = content;
    if (findRe) {
      content = content.replace(findRe, replace ?? "");
    } else {
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
    fs.writeFileSync(fullPath, content);
    console.log(`  Saved ${relPath}\n`);
  } else {
    console.log(`  No changes needed in ${relPath}\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. admin-operations-handlers.ts
// ─────────────────────────────────────────────────────────────────────────────
console.log("── [1/6] src/lib/admin-operations-handlers.ts ───────────────────────");

patchFile("src/lib/admin-operations-handlers.ts", [
  // ── Broken imports ──────────────────────────────────────────────────────────
  {
    desc: "Remove franchise-article import",
    findRe: /^import \{ generateFranchiseArticle, generateWeekPreview \} from "\.\/franchise-article\.js";\n/m,
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
  // ── Call-sites ──────────────────────────────────────────────────────────────
  {
    desc: "Remove openaiClient instantiation",
    findRe: /^const openaiClient\s*=\s*new OpenAI\(\{[\s\S]*?\}\);\n/m,
    replace: "",
  },
  {
    desc: "Stub sendArticleChunked call in custom-article handler",
    // The one-liner call inside the commissioner custom-article function
    find: `await (sendArticleChunked as Function)(channel, header, article);`,
    replace: `// article posting removed — sendArticleChunked archived`,
  },
  {
    desc: "Stub article generation block in advance-week handler",
    // The async IIFE that calls generateFranchiseArticle / generateWeekPreview
    findRe: /\(async \(\) => \{\s*const tc = headlinesChannel as TextChannel;[\s\S]*?\}\)\(\);/,
    replace: `// Article generation removed — franchise-article archived`,
  },
  {
    desc: "Remove generateMatchupBreakdown calls",
    findRe: /const (?:breakdown|matchupBreakdown)\s*=\s*await generateMatchupBreakdown\([\s\S]*?\);\n/g,
    replace: "",
  },
  {
    desc: "Remove matchup-breakdown send blocks",
    findRe: /\/\/ .*matchup.*breakdown[\s\S]*?generateMatchupBreakdown[\s\S]*?}\s*\n/gi,
    replace: "  // matchup AI breakdown removed (archived)\n",
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
console.log(`${"═".repeat(68)}`);
console.log(`  fix-broken-imports: ${totalChanges} change(s) applied`);
console.log(`${"═".repeat(68)}\n`);

if (totalChanges > 0) {
  console.log(`Run  node src/index.ts  (or your dev command) to verify the bot starts.\n`);
}
