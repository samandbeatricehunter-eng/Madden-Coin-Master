#!/usr/bin/env node
/**
 * fix-admin-ops-final.cjs
 *
 * Surgically fixes src/lib/admin-operations-handlers.ts.
 *
 * Problems in the current file (as of last GitHub push):
 *   1. Import: generateFranchiseArticle, generateWeekPreview from ./franchise-article.js  (archived)
 *   2. Import: sendArticleChunked from ./send-article.js  (archived)
 *   3. Import: generateMatchupBreakdown from ./matchup-ai-breakdown.js  (archived)
 *   4. Import: OpenAI from ./openai-fallback.js  (archived)
 *   5. Stray `    return;\n  }` orphan left by a prior partial patch at line ~153
 *   6. openaiClient.chat.completions.create(...) call block in handleModalCustomArticle
 *
 * All replacements use exact string matching — no regex — so CRLF/LF doesn't matter.
 *
 * Run from project root:  node fix-admin-ops-final.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "src", "lib", "admin-operations-handlers.ts");

if (!fs.existsSync(TARGET)) {
  console.error("ERROR: File not found:", TARGET);
  process.exit(1);
}

// Back up once (don't overwrite an existing backup)
const bakPath = TARGET + ".bak-final";
if (!fs.existsSync(bakPath)) {
  fs.copyFileSync(TARGET, bakPath);
  console.log("Backup written to", path.basename(bakPath));
}

// Normalize CRLF → LF so every replacement works on Windows and Unix equally
let src = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

let changes = 0;

function replace(description, find, replaceWith) {
  if (!src.includes(find)) {
    console.log("  ℹ  Already clean / not found:", description);
    return;
  }
  src = src.split(find).join(replaceWith);
  console.log("  ✅ ", description);
  changes++;
}

// ── 1. Remove archived imports ─────────────────────────────────────────────
replace(
  "Remove franchise-article import",
  'import { generateFranchiseArticle, generateWeekPreview } from "./franchise-article.js";\n',
  "",
);

replace(
  "Remove send-article import",
  'import { sendArticleChunked } from "./send-article.js";\n',
  "",
);

replace(
  "Remove matchup-ai-breakdown import",
  'import { generateMatchupBreakdown } from "./matchup-ai-breakdown.js";\n',
  "",
);

replace(
  "Remove openai-fallback import",
  'import OpenAI from "./openai-fallback.js";\n',
  "",
);

// ── 2. Remove the stray orphan lines left by prior partial patch ───────────
// The prior script partially removed the openaiClient block but left:
//   }\n\n    return;\n  }\n
// sitting between showAdminDepartmentMenu and the next if-block.
// We match from the end of showAdminDepartmentMenu to the next clean if-statement.
replace(
  "Remove stray orphan return/brace from prior partial patch",
  '  });\n}\n    return;\n  }\n\n  if (selected === "manage_economy")',
  '  });\n}\n\n  if (selected === "manage_economy")',
);

// ── 3. Remove openaiClient instantiation (module-level const) ─────────────
// Match the exact block as it appears in the file
replace(
  "Remove openaiClient instantiation",
  'const openaiClient = new OpenAI({\n  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],\n  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "dummy",\n});\n',
  "",
);

// ── 4. Remove/stub the openaiClient call block in handleModalCustomArticle ─
// Replace the entire openaiClient.chat.completions block (up through the stale
// "article posting removed" comment) with a simple early return.
replace(
  "Stub handleModalCustomArticle openai call block",
  `    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: [
            "You are an award-winning sports journalist covering The R.E.C. League — a competitive Madden NFL franchise simulation league.",
            "Write in a bold, energetic, ESPN-style voice.",
            "Use vivid prose paragraphs. Do NOT use markdown headers (##, ###) or bullet points — just flowing, punchy paragraphs.",
            "Keep the article between 400–600 words unless the prompt implies a shorter piece.",
            "IMPORTANT: Always start your response with a single line in exactly this format:",
            "HEADLINE: <your headline here>",
            "Then leave one blank line, then write the article body.",
          ].join("\\n"),
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1200,
      temperature: 0.85,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const lines = raw.split("\\n");
    const headlineLine = lines.find(l => l.startsWith("HEADLINE:"));
    const headline = headlineLine ? headlineLine.replace("HEADLINE:", "").trim() : "Breaking News";
    const bodyStart = headlineLine ? lines.indexOf(headlineLine) + 2 : 0;
    const article   = lines.slice(bodyStart).join("\\n").trim();

    const header = \`📰 **\${headline}**\\n\\n\`;
    // article posting removed — sendArticleChunked archived

    await interaction.editReply({ content: \`✅ Custom article posted to <#\${headlinesChannelId}>.\` });`,
  `    // AI article generation removed — feature archived
    await interaction.editReply({ content: "❌ The AI article feature has been removed." });`,
);

// ── Done ───────────────────────────────────────────────────────────────────
if (changes > 0) {
  fs.writeFileSync(TARGET, src, "utf8");
  console.log("\n✅ Wrote", TARGET);
  console.log(`   ${changes} change(s) applied.`);
  console.log("\nNow try running the bot again.\n");
} else {
  console.log("\nℹ  No changes needed — file is already clean.\n");
}
