#!/usr/bin/env node
/**
 * remove-features.cjs
 *
 * Removes AI chatbot, League Twitter / tweets, franchise articles, and
 * interview features from the entire codebase.
 *
 * Run from the project root:  node remove-features.cjs
 *
 * ─── FILES ARCHIVED (moved to src/_archive/) ────────────────────────────────
 *   lib/league-twitter.ts          — entire League Twitter system
 *   lib/franchise-article.ts       — franchise article generator
 *   lib/send-article.ts            — article posting helpers
 *   lib/matchup-ai-breakdown.ts    — AI matchup breakdown generator
 *   lib/openai-fallback.ts         — OpenAI client wrapper
 *   commands/admin-resendarticle.ts — admin resend-article command
 *
 * ─── FILES PATCHED ──────────────────────────────────────────────────────────
 *   index.ts                 — remove league-twitter scheduler + import
 *   events/messageCreate.ts  — remove OpenAI client, handleTwitterReply call
 *   lib/actions-handlers.ts  — remove ac_interview, ac_tweet dispatch entries
 *                              and the full interview + tweet handler sections
 *   lib/admin-payout-handlers.ts  — remove handleTweetPayout(Modal) +
 *                                   handleInterviewPayout(Modal) functions
 *   events/interactionCreate.ts   — remove all interview/tweet dispatch blocks
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT     = __dirname;
const SRC      = path.join(ROOT, "src");
const LIB      = path.join(SRC, "lib");
const COMMANDS = path.join(SRC, "commands");
const EVENTS   = path.join(SRC, "events");
const ARCHIVE  = path.join(SRC, "_archive");

if (!fs.existsSync(SRC))     throw new Error(`src/ not found — run from project root.`);
if (!fs.existsSync(ARCHIVE)) { fs.mkdirSync(ARCHIVE); console.log(`Created src/_archive/`); }

// ── helpers ───────────────────────────────────────────────────────────────────

function archiveFile(relPath) {
  const src  = path.join(ROOT, relPath);
  const dest = path.join(ARCHIVE, path.basename(src));
  if (!fs.existsSync(src))  { console.log(`  ⚠️  SKIP   ${relPath} — not found`);           return; }
  if (fs.existsSync(dest))  { console.log(`  ⚠️  SKIP   ${relPath} — already archived`);    return; }
  fs.renameSync(src, dest);
  console.log(`  ✅  ARCHIVED ${relPath}`);
}

function patch(relPath, description, fn) {
  const filePath = path.join(ROOT, relPath);
  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠️  SKIP   ${description} — ${relPath} not found`);
    return;
  }
  const before = fs.readFileSync(filePath, "utf8");
  const backup = filePath + ".bak";
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, before);
  const after = fn(before);
  if (after === before) {
    console.log(`  ℹ️  NOOP   ${description} — already patched or pattern not found`);
    return;
  }
  fs.writeFileSync(filePath, after);
  const linesRemoved = before.split("\n").length - after.split("\n").length;
  console.log(`  ✅  PATCHED ${description}  (−${linesRemoved} lines)`);
}

// ── helper: remove a contiguous block between two anchor strings ──────────────
// startAnchor: first line of the block to remove (inclusive)
// endAnchor:   first line to KEEP after the block
function removeBetween(src, startAnchor, endAnchor) {
  const si = src.indexOf(startAnchor);
  if (si === -1) return src;
  const ei = src.indexOf(endAnchor, si);
  if (ei === -1) return src;
  return src.slice(0, si) + src.slice(ei);
}

// ── helper: remove a single exact string (incl. surrounding blank lines) ─────
function removeLine(src, exact) {
  // Remove the line + optional trailing newline
  const idx = src.indexOf(exact);
  if (idx === -1) return src;
  // Eat up to one preceding blank line and the trailing newline
  let start = idx;
  if (start > 0 && src[start - 1] === "\n") {
    let prev = start - 2;
    while (prev >= 0 && src[prev] === " ") prev--;
    if (prev >= 0 && src[prev] === "\n") start = prev + 1;
  }
  const end = idx + exact.length + (src[idx + exact.length] === "\n" ? 1 : 0);
  return src.slice(0, start) + src.slice(end);
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — Archive pure feature files
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[1/7] Archive pure feature files…");
archiveFile("src/lib/league-twitter.ts");
archiveFile("src/lib/franchise-article.ts");
archiveFile("src/lib/send-article.ts");
archiveFile("src/lib/matchup-ai-breakdown.ts");
archiveFile("src/lib/openai-fallback.ts");
archiveFile("src/commands/admin-resendarticle.ts");

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — index.ts: remove league-twitter scheduler + import
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[2/7] Patch index.ts…");
patch("src/index.ts", "index.ts → remove league-twitter import + scheduler call", src => {
  let out = src;

  // Remove import line
  out = out.replace(
    /^import\s*\{\s*startLeagueTwitterScheduler\s*\}\s*from\s*["']\.\/lib\/league-twitter\.js["'];?\n?/m,
    "",
  );
  // Remove scheduler call (with optional comment line above it)
  out = out.replace(/^\s*startLeagueTwitterScheduler\(client\);?\n?/m, "");

  // Remove unused adminResendArticle import (already not in commands array but import may exist)
  out = out.replace(
    /^import\s*\*\s*as\s*adminResendArticle\s*from\s*["']\.\/commands\/admin-resendarticle\.js["'];?\n?/m,
    "",
  );
  // Remove it from the command list array if it was included
  out = out.replace(/^\s*adminResendArticle,?\n?/m, "");

  return out;
});

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 — messageCreate.ts: remove OpenAI client + handleTwitterReply
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[3/7] Patch events/messageCreate.ts…");
patch("src/events/messageCreate.ts", "messageCreate.ts → remove OpenAI + league-twitter", src => {
  let out = src;

  // Remove OpenAI import line
  out = out.replace(
    /^import\s+OpenAI\s+from\s+["']\.\.\/lib\/openai-fallback\.js["'];?\n?/m,
    "",
  );

  // Remove handleTwitterReply import line
  out = out.replace(
    /^import\s*\{\s*handleTwitterReply\s*\}\s*from\s*["']\.\.\/lib\/league-twitter\.js["'];?\n?/m,
    "",
  );

  // Remove the OpenAI client setup block
  // Anchors: starts with "// ── OpenAI client", ends just before "// ── Persistent escalation"
  out = removeBetween(
    out,
    "// ── OpenAI client ──────────────────────────────────────────────────────────────\n",
    "// ── Persistent escalation tracker",
  );

  // Remove the league-twitter reply handler block inside execute()
  // The block starts with the comment and ends with the closing `}` + blank line before
  // "// ── Channel-based payout monitors"
  out = removeBetween(
    out,
    "  // ── League Twitter reply handler",
    "  // ── Channel-based payout monitors",
  );

  return out;
});

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 4 — actions-handlers.ts: remove interview + tweet dispatch + handlers
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[4/7] Patch lib/actions-handlers.ts…");
patch("src/lib/actions-handlers.ts", "actions-handlers.ts → remove interview + tweet dispatch + handler bodies", src => {
  let out = src;

  // Remove single-line dispatch entries inside isActionsInteraction / handleActionsInteraction
  out = removeLine(out, `  if (id === "ac_interview")    { await handleInterview(interaction as ButtonInteraction, sess); return true; }`);
  out = removeLine(out, `  if (id === "ac_tweet")        { await handleTweetModal(interaction as ButtonInteraction); return true; }`);
  out = removeLine(out, `  if (id === "ac_modal_tweet")      { await handleTweetSubmit(interaction as ModalSubmitInteraction, sess); return true; }`);

  // Remove the entire interview section (lines 3175–3316) and tweet section (lines 3317–3416)
  // Both sections fall between these two stable anchors:
  //   START: "// ── Interview ──────────────────────────────────────────────────────────────────"
  //   END:   "// ═══════════════════════════════════════════════════════════════════════════════\n//  ROW 2"
  out = removeBetween(
    out,
    "// ── Interview ─────────────────────────────────────────────────────────────────\n",
    "// ═══════════════════════════════════════════════════════════════════════════════\n//  ROW 2",
  );

  return out;
});

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 5 — admin-payout-handlers.ts: remove tweet + interview payout functions
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[5/7] Patch lib/admin-payout-handlers.ts…");
patch("src/lib/admin-payout-handlers.ts", "admin-payout-handlers.ts → remove tweet + interview payout functions", src => {
  let out = src;

  // ── handleTweetPayout ─────────────────────────────────────────────────────
  out = removeBetween(
    out,
    "// ── Set Tweet Payout Amount ────────────────────────────────────────────────────\n",
    "// ── Set Interview Payout Amount ───────────────────────────────────────────────\n",
  );

  // ── handleInterviewPayout + handleInterviewPayoutModal ────────────────────
  // Find the next section anchor AFTER the interview payout block
  const interviewStart = "// ── Set Interview Payout Amount ───────────────────────────────────────────────\n";
  const interviewEnd   = out.indexOf(interviewStart);
  if (interviewEnd !== -1) {
    // Remove from that anchor to the next "// ──" section or end of function pair
    // The two functions end at the final closing brace before the next export or EOF
    // Use regex to consume from startAnchor through both function bodies
    out = out.replace(
      /\/\/ ── Set Interview Payout Amount[^\n]*\n[\s\S]*?export async function handleInterviewPayoutModal[\s\S]*?\n\}\n?/,
      "",
    );
  }

  return out;
});

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 6 — interactionCreate.ts: remove all interview + tweet dispatch blocks
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[6/7] Patch events/interactionCreate.ts…");
patch("src/events/interactionCreate.ts", "interactionCreate.ts → remove interview + tweet dispatch blocks", src => {
  let out = src;

  // ── interview_typepick (button handler) ──────────────────────────────────
  out = removeBetween(
    out,
    "  // ── Interview type picker (pre-game / post-game / general) ───────────────────\n",
    "  // ── Archetype viewer — archetype nav",
  );

  // ── interview_approve (button handler) ───────────────────────────────────
  out = removeBetween(
    out,
    "  if (action === \"interview_approve\") {\n",
    "  // ── Interview: deny (open modal) ─────────────────────────────────────────────\n",
  );

  // ── interview_deny (button handler, shows modal) ─────────────────────────
  out = removeBetween(
    out,
    "  // ── Interview: deny (open modal) ─────────────────────────────────────────────\n",
    "  // ── Wager: opponent accepts ───────────────────────────────────────────────",
  );

  // ── interview_answer (button in commission channel — opens modal) ─────────
  out = removeBetween(
    out,
    "  // Format: interview_answer:{targetUserId}:{i1,i2,i3}:{type}\n",
    // next stable anchor after interview_answer block
    "  // ── Archetype viewer",
  );
  // Fallback anchor in case the above wasn't found (different surrounding context)
  if (out.includes("  if (action === \"interview_answer\") {")) {
    // Remove the if block
    out = out.replace(
      /\s*\/\/ Format: interview_answer:[^\n]*\n\s*if \(action === "interview_answer"\) \{[\s\S]*?\n  \}\n/,
      "\n",
    );
  }

  // ── ap_tweetpayout + ap_interviewpayout (single-line dispatch) ───────────
  out = removeLine(out, `  if (action === "ap_tweetpayout")       { await handleTweetPayout(interaction);      return; }`);
  out = removeLine(out, `  if (action === "ap_interviewpayout")   { await handleInterviewPayout(interaction);  return; }`);

  // ── ap_modal_tweetpayout + ap_modal_interviewpayout ──────────────────────
  out = removeLine(out, `  if (action === "ap_modal_tweetpayout")      { await handleTweetPayoutModal(interaction);     return; }`);
  out = removeLine(out, `  if (action === "ap_modal_interviewpayout")  { await handleInterviewPayoutModal(interaction); return; }`);

  // ── interview_modal (modal submit handler) ────────────────────────────────
  // Remove the multi-line block at action === "interview_modal"
  out = out.replace(
    /\s*if \(action === "interview_modal"\) \{[\s\S]*?\n  \}\n/,
    "\n",
  );

  // ── interview_answer_modal (modal submit handler) ─────────────────────────
  out = out.replace(
    /\s*if \(action === "interview_answer_modal"\) \{[\s\S]*?\n  \}\n/,
    "\n",
  );

  return out;
});

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 7 — Remove now-dead imports from interactionCreate.ts + actions-handlers.ts
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[7/7] Clean up dead imports…");

// Remove handleInterviewTypePick from interactionCreate.ts imports
// (added by fix-routing-bugs.cjs v2; no longer called)
patch("src/events/interactionCreate.ts", "interactionCreate.ts → remove handleInterviewTypePick import", src => {
  return src
    // Case: it's on its own import line
    .replace(
      /^import\s*\{\s*handleInterviewTypePick\s*\}\s*from\s*["'][^"']+["'];?\n?/m,
      "",
    )
    // Case: it's in a multi-symbol import — strip just the symbol
    .replace(/,?\s*handleInterviewTypePick\s*,?/g, match => {
      // Avoid leaving trailing/leading comma
      if (match.startsWith(",") && match.endsWith(",")) return ",";
      return "";
    });
});

// Remove handleInterviewPayout, handleInterviewPayoutModal,
// handleTweetPayout, handleTweetPayoutModal from interactionCreate.ts imports
patch("src/events/interactionCreate.ts", "interactionCreate.ts → remove tweet/interview payout handler imports", src => {
  const toRemove = [
    "handleInterviewPayout",
    "handleInterviewPayoutModal",
    "handleTweetPayout",
    "handleTweetPayoutModal",
  ];
  let out = src;
  for (const sym of toRemove) {
    // Remove stand-alone import line
    out = out.replace(new RegExp(`^import\\s*\\{\\s*${sym}\\s*\\}\\s*from\\s*["'][^"']+["'];?\\n?`, "m"), "");
    // Remove symbol from shared import
    out = out.replace(new RegExp(`,?\\s*${sym}\\s*,?`, "g"), m => {
      if (m.startsWith(",") && m.endsWith(",")) return ",";
      return "";
    });
  }
  return out;
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`
Done.

ARCHIVED (moved to src/_archive/):
  lib/league-twitter.ts
  lib/franchise-article.ts
  lib/send-article.ts
  lib/matchup-ai-breakdown.ts
  lib/openai-fallback.ts
  commands/admin-resendarticle.ts

PATCHED:
  src/index.ts             — league-twitter scheduler removed
  src/events/messageCreate.ts — OpenAI client + handleTwitterReply removed
  src/lib/actions-handlers.ts — interview + tweet dispatch + handler bodies removed
  src/lib/admin-payout-handlers.ts — tweet/interview payout functions removed
  src/events/interactionCreate.ts  — all interview + tweet dispatch blocks removed

─────────────────────────────────────────────────────────────────────────────────
MANUAL FOLLOW-UP REQUIRED (too complex to automate safely):
─────────────────────────────────────────────────────────────────────────────────

1. events/messageCreate.ts  (lines ~1500–1748)
   The execute() function still contains the full AI chatbot logic — the
   section that runs when a user @-mentions the bot. After the channel monitors
   and @mention guard, everything from "Show typing while we work" down to the
   final openai.chat.completions.create() call should be replaced with:

     await message.reply("Hey! The AI assistant is currently offline. Use slash commands for anything you need.").catch(() => {});
     return;

   The commissioner co-comm action handler (below the AI block) should be kept.

2. lib/actions-handlers.ts — imports still reference interviewrequest.js
   Search for the import of INTERVIEW_QUESTIONS, pickThreeIndices, getQuestionPool,
   interviewTypeLabel, InterviewType from "../commands/interviewrequest.js" and
   remove it (those symbols are no longer used after this script runs).

3. actions hub embed (commands/actions.ts or actions-handlers.ts)
   Any button row that includes the "🎙️ Interview" or "🐦 Tweet" buttons
   in the hub embed should have those buttons removed.
   Search for: .setCustomId("ac_interview")  and  .setCustomId("ac_tweet")

4. lib/eos-auto-post.ts, lib/season-recap.ts, lib/wildcard-automation.ts
   These files import from franchise-article.ts / gcs-fallback.ts for article
   auto-posting. The article imports will now resolve to _archive/ and fail.
   Either:
   a) Remove just the article-posting portions from those files, OR
   b) If you don't use EOS auto-post / season recap: archive those files too
      and remove their import/call from admin-operations-handlers.ts.

─────────────────────────────────────────────────────────────────────────────────
`);
