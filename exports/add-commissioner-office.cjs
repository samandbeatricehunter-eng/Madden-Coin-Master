#!/usr/bin/env node
/**
 * add-commissioner-office.cjs
 *
 * Wires pending-inbox-handlers.ts into the bot at three precise points:
 *
 *   1. admin-operations-handlers.ts
 *      a) Adds import for pending-inbox-handlers
 *      b) Adds "Commissioner's Office" option to buildManageEconomyMenuRows()
 *      c) Adds the commissioner_office case in the economy select handler
 *
 *   2. src/events/interactionCreate.ts
 *      a) Adds import for handleCommOfficeInteraction
 *      b) Adds co_ prefix routing right after the ao_ block
 *
 * Run AFTER fix-admin-ops-definitive.cjs from project root:
 *   node add-commissioner-office.cjs
 */

"use strict";
const fs   = require("fs");
const path = require("path");

// ── File paths ─────────────────────────────────────────────────────────────────
const AOH  = path.join(__dirname, "src", "lib", "admin-operations-handlers.ts");
const IC   = path.join(__dirname, "src", "events", "interactionCreate.ts");

[AOH, IC].forEach(f => {
  if (!fs.existsSync(f)) {
    console.error("ERROR: File not found:", f);
    process.exit(1);
  }
});

// ── Helper: insert text after first occurrence of needle ──────────────────────
function insertAfter(src, needle, insertion) {
  const idx = src.indexOf(needle);
  if (idx === -1) return null;
  const pos = idx + needle.length;
  return src.slice(0, pos) + insertion + src.slice(pos);
}

// ── Helper: check if text already exists ──────────────────────────────────────
function alreadyPatched(src, marker) {
  return src.includes(marker);
}

// ═══════════════════════════════════════════════════════════════════════
// 1.  admin-operations-handlers.ts
// ═══════════════════════════════════════════════════════════════════════
let aoh = fs.readFileSync(AOH, "utf8").replace(/\r\n/g, "\n");
let aohChanges = 0;

// ── 1a. Add import for pending-inbox-handlers ──────────────────────────
const AOH_IMPORT_NEEDLE  = `import { buildPayoutHubEmbed, buildPayoutHubRows } from "./admin-payout-handlers.js";`;
const AOH_IMPORT_INSERT  = `\nimport { buildCommOfficeEmbed, buildCommOfficeRows, handleCommOfficeInteraction } from "./pending-inbox-handlers.js";`;
const AOH_IMPORT_MARKER  = `from "./pending-inbox-handlers.js"`;

if (alreadyPatched(aoh, AOH_IMPORT_MARKER)) {
  console.log("  ℹ  admin-operations: pending-inbox import already present");
} else {
  const patched = insertAfter(aoh, AOH_IMPORT_NEEDLE, AOH_IMPORT_INSERT);
  if (!patched) {
    console.warn("  ⚠  admin-operations: could not find admin-payout-handlers import anchor — skipping import patch");
  } else {
    aoh = patched;
    aohChanges++;
    console.log("  ✅  Added pending-inbox-handlers import");
  }
}

// ── 1b. Add Commissioner's Office menu option ──────────────────────────
// Inserts after the existing Payouts option inside buildManageEconomyMenuRows()
const AOH_MENU_NEEDLE  = `{ label: "Payouts", value: "payouts", description: "Open payout management", emoji: "💰" },`;
const AOH_MENU_INSERT  = `\n          { label: "Commissioner's Office", value: "commissioner_office", description: "Pending purchases, score reports, and interviews", emoji: "🏛️" },`;
const AOH_MENU_MARKER  = `commissioner_office`;

if (alreadyPatched(aoh, AOH_MENU_MARKER)) {
  console.log("  ℹ  admin-operations: Commissioner's Office menu option already present");
} else {
  const patched = insertAfter(aoh, AOH_MENU_NEEDLE, AOH_MENU_INSERT);
  if (!patched) {
    console.warn("  ⚠  admin-operations: could not find Payouts menu option anchor — skipping menu patch");
  } else {
    aoh = patched;
    aohChanges++;
    console.log("  ✅  Added Commissioner's Office menu option");
  }
}

// ── 1c. Add commissioner_office handler case ───────────────────────────
// Inserts after the "payouts" handler in the economy select section
const AOH_CASE_NEEDLE  = `if (selected === "payouts") return handlePayoutsHub(interaction as any);`;
const AOH_CASE_INSERT  = `
  if (selected === "commissioner_office") {
    await interaction.update({
      embeds: [buildCommOfficeEmbed()],
      components: buildCommOfficeRows() as ActionRowBuilder<any>[],
    });
    return true;
  }`;
const AOH_CASE_MARKER  = `if (selected === "commissioner_office")`;

if (alreadyPatched(aoh, AOH_CASE_MARKER)) {
  console.log("  ℹ  admin-operations: commissioner_office handler already present");
} else {
  const patched = insertAfter(aoh, AOH_CASE_NEEDLE, AOH_CASE_INSERT);
  if (!patched) {
    console.warn("  ⚠  admin-operations: could not find payouts handler anchor — skipping case patch");
  } else {
    aoh = patched;
    aohChanges++;
    console.log("  ✅  Added commissioner_office select handler");
  }
}

if (aohChanges > 0) {
  const bakAoh = AOH + ".bak-co";
  if (!fs.existsSync(bakAoh)) fs.copyFileSync(AOH, bakAoh);
  fs.writeFileSync(AOH, aoh, "utf8");
  console.log(`  ✅  Wrote admin-operations-handlers.ts (${aohChanges} change(s))\n`);
} else {
  console.log("  ℹ  admin-operations-handlers.ts — no changes needed\n");
}

// ═══════════════════════════════════════════════════════════════════════
// 2.  src/events/interactionCreate.ts
// ═══════════════════════════════════════════════════════════════════════
let ic = fs.readFileSync(IC, "utf8").replace(/\r\n/g, "\n");
let icChanges = 0;

// ── 2a. Add import for handleCommOfficeInteraction ─────────────────────
const IC_IMPORT_NEEDLE  = `import { handleAdminOperationsInteraction } from "../lib/admin-operations-handlers.js";`;
const IC_IMPORT_INSERT  = `\nimport { handleCommOfficeInteraction } from "../lib/pending-inbox-handlers.js";`;
const IC_IMPORT_MARKER  = `from "../lib/pending-inbox-handlers.js"`;

if (alreadyPatched(ic, IC_IMPORT_MARKER)) {
  console.log("  ℹ  interactionCreate: pending-inbox import already present");
} else {
  const patched = insertAfter(ic, IC_IMPORT_NEEDLE, IC_IMPORT_INSERT);
  if (!patched) {
    console.warn("  ⚠  interactionCreate: could not find admin-operations import anchor — skipping import patch");
  } else {
    ic = patched;
    icChanges++;
    console.log("  ✅  Added handleCommOfficeInteraction import");
  }
}

// ── 2b. Add co_ routing block right after the ao_ block ───────────────
const IC_ROUTE_NEEDLE  =
`  // ── Admin Operations hub — dispatch all ao_ prefixed interactions ─────────────
  if (action?.startsWith("ao_")) {
    const handled = await handleAdminOperationsInteraction(interaction);
    if (handled) return;
  }`;
const IC_ROUTE_INSERT  = `

  // ── Commissioner's Office — dispatch all co_ prefixed interactions ────────────
  if (action?.startsWith("co_")) {
    await handleCommOfficeInteraction(interaction as any);
    return;
  }`;
const IC_ROUTE_MARKER  = `action?.startsWith("co_")`;

if (alreadyPatched(ic, IC_ROUTE_MARKER)) {
  console.log("  ℹ  interactionCreate: co_ routing already present");
} else {
  const patched = insertAfter(ic, IC_ROUTE_NEEDLE, IC_ROUTE_INSERT);
  if (!patched) {
    console.warn("  ⚠  interactionCreate: could not find ao_ routing block — skipping route patch");
    console.warn("     Add this manually after the ao_ block in interactionCreate.ts:");
    console.warn(`
  // ── Commissioner's Office ───────────────────────────────────────────────────
  if (action?.startsWith("co_")) {
    await handleCommOfficeInteraction(interaction as any);
    return;
  }
`);
  } else {
    ic = patched;
    icChanges++;
    console.log("  ✅  Added co_ routing block in interactionCreate.ts");
  }
}

if (icChanges > 0) {
  const bakIc = IC + ".bak-co";
  if (!fs.existsSync(bakIc)) fs.copyFileSync(IC, bakIc);
  fs.writeFileSync(IC, ic, "utf8");
  console.log(`  ✅  Wrote interactionCreate.ts (${icChanges} change(s))\n`);
} else {
  console.log("  ℹ  interactionCreate.ts — no changes needed\n");
}

console.log("Done. Commissioner's Office is now wired in.");
console.log("Next: run fix-admin-ops-definitive.cjs if you haven't already, then restart the bot.\n");
