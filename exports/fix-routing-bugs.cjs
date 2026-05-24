#!/usr/bin/env node
/**
 * fix-routing-bugs.cjs  (v2 — adds all missing handler imports)
 *
 * Run from the project root:  node fix-routing-bugs.cjs
 *
 * Fixes applied
 * ─────────────
 * 1. Missing braces on ac_ dispatch in handleButton, handleSelectMenu, handleModal
 * 2. Missing imports for ALL handler functions used in interactionCreate.ts
 *    (actions, admin-operations, admin-payout, admin-store, admin-user,
 *     custom-player, menu-department-router, admin-inventory, viewcustomarchetypes,
 *     viewplayerstats)
 * 3. Dead code after inline `return` in commissioner-office intercept blocks
 * 4. adminOperations slash command not registered in commands array (index.ts)
 * 5. Operator-precedence bug in isActionsInteraction (go_ clause was unguarded)
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const IC_FILE    = path.join(__dirname, "src", "events", "interactionCreate.ts");
const INDEX_FILE = path.join(__dirname, "src", "index.ts");

if (!fs.existsSync(IC_FILE))    throw new Error(`Not found: ${IC_FILE}`);
if (!fs.existsSync(INDEX_FILE)) throw new Error(`Not found: ${INDEX_FILE}`);

function backup(file) {
  const dest = file + ".bak-fix-routing-" + Date.now();
  fs.copyFileSync(file, dest);
  console.log(`  Backed up → ${path.basename(dest)}`);
}

function apply(label, content, search, replace, opts = {}) {
  const isRegex = search instanceof RegExp;
  const found   = isRegex ? search.test(content) : content.includes(search);

  if (!found) {
    if (opts.required !== false) {
      console.warn(`  ⚠️  [${label}] Pattern not found — skipping (may already be fixed)`);
    }
    return content;
  }

  const count = isRegex
    ? (content.match(new RegExp(search.source, search.flags + (search.flags.includes("g") ? "" : "g"))) || []).length
    : content.split(search).length - 1;

  const result = isRegex
    ? content.replace(search, replace)
    : (opts.replaceAll ? content.split(search).join(replace) : content.replace(search, replace));

  console.log(`  ✅ [${label}] Applied (${count} occurrence${count !== 1 ? "s" : ""})`);
  return result;
}

// =============================================================================
// PATCH interactionCreate.ts
// =============================================================================
console.log("\nPatching src/events/interactionCreate.ts …");
backup(IC_FILE);
let ic = fs.readFileSync(IC_FILE, "utf8");

// ── Fix 2 — add ALL missing handler imports ───────────────────────────────────
// We insert a block of imports right before the first non-import declaration.
// The anchor is `function computeIsSetupInteraction` which immediately follows
// the last import line in the original file.

const IMPORT_ANCHOR = "function computeIsSetupInteraction";

// Each entry: { guard: substring to check for (skip if already present), statement }
const MISSING_IMPORTS = [
  {
    guard: "menu-department-router",
    statement: `import { handleMenuDepartmentInteraction } from "../lib/menu-department-router.js";`,
  },
  {
    guard: "actions-handlers",
    statement:
`import {
  handleActionsInteraction,
  handleInterviewTypePick,
} from "../lib/actions-handlers.js";`,
  },
  {
    guard: "admin-operations-handlers",
    statement: `import { handleAdminOperationsInteraction } from "../lib/admin-operations-handlers.js";`,
  },
  {
    guard: "admin-payout-handlers",
    statement:
`import {
  handleClose,
  handleGotw,
  handleGotwSelectAfc,
  handleGotwSelectNfc,
  handleGotwFinalize,
  handleGotwBonus,
  handleGotwBonusModal,
  handlePotw,
  handlePotwSelectAfc,
  handlePotwSelectNfc,
  handlePotwBack,
  handlePotwFinalize,
  handlePotwBonus,
  handlePotwBonusModal,
  handleAddCoins,
  handleAddCoinsSelectAfc,
  handleAddCoinsSelectNfc,
  handleAddCoinsNext,
  handleAddCoinsModal,
  handleRemoveCoins,
  handleRemoveCoinsNext,
  handleRemoveCoinsModal,
  handleTransfer,
  handleTransferSelectAfc,
  handleTransferSelectNfc,
  handleTransferNext,
  handleTransferModal,
  handleGame,
  handleGameSelect,
  handleGameWinnerHome,
  handleGameWinnerAway,
  handleGameWinnerCpu,
  handleGameModalHomeWins,
  handleGameModalAwayWins,
  handleGameModalCpuWins,
  handleCorrect,
  handleCorrectWeekSelect,
  handleCorrectGameSelect,
  handleCorrectNewWinner,
  handleCorrectSwap,
  handleCorrectModalSame,
  handleCorrectModalSwap,
  handleSetPay,
  handleSetPayReg,
  handleSetPayRegModal,
  handleSetPayChannel,
  handleSetPayChannelModal,
  handleSetPayHighlightCapModal,
  handleSetPayPlayoff,
  handleSetPayPo1Btn,
  handleSetPayPo2Btn,
  handleSetPayPo1Modal,
  handleSetPayPo2Modal,
  handleNewMember,
  handleNewMemberModal,
  handleReferral,
  handleReferralModal,
  handleEos,
  handleEosKeySelect,
  handleEosEditModal,
  handleEosStatTierModal,
  handleMilestone,
  handleMilestoneAdd,
  handleMilestoneEdit,
  handleMilestoneEditModal,
  handleTweetPayout,
  handleTweetPayoutModal,
  handleInterviewPayout,
  handleInterviewPayoutModal,
} from "../lib/admin-payout-handlers.js";`,
  },
  {
    guard: "admin-store-handlers",
    statement:
`import {
  handleSsClose,
  handleSsCancel,
  handleSsArch,
  handleSsArchPos,
  handleSsArchPrev,
  handleSsArchNext,
  handleSsArchEdit,
  handleSsArchBackToView,
  handleSsArchEditGroup,
  handleSsArchEditModal,
  handleSsLt,
  handleSsLtPos,
  handleSsLtLegend,
  handleSsLtModel,
  handleSsLtBackToPos,
  handleSsLtBackToModel,
  handleSsLtEdit,
  handleSsLtCreate,
  handleSsLtBackToView,
  handleSsLtEditGroup,
  handleSsLtEditModal,
} from "../lib/admin-store-handlers.js";`,
  },
  {
    guard: "admin-user-handlers",
    statement:
`import {
  handleUdClose,
  handleUdCancel,
  handleUdViewTeams,
  handleUdLink,
  handleUdLinkTeamAfc,
  handleUdLinkTeamNfc,
  handleUdLinkMember,
  handleUdLinkNext,
  handleUdLinkModal,
  handleUdUnlink,
  handleUdUnlinkTeamAfc,
  handleUdUnlinkTeamNfc,
  handleUdUnlinkConfirm,
  handleUdViewEdit,
  handleUdVeTeamAfc,
  handleUdVeTeamNfc,
  handleUdVeLoad,
  handleUdEditEconomy,
  handleUdEditRecords,
  handleUdEditAllTime,
  handleUdEditEconomyModal,
  handleUdEditRecordsModal,
  handleUdEditAllTimeModal,
  handleUdDelete,
  handleUdDeleteUserSelect,
  handleUdDeleteToggle,
  handleUdDeleteConfirm,
  handleTreqLinkButton,
  handleTreqDenyButton,
  handleTreqDenyReasonModal,
} from "../lib/admin-user-handlers.js";`,
  },
  {
    guard: "custom-player-interactions",
    statement:
`import {
  handleCcpPos,
  handleCcpArch,
  handleCcpOlPos,
  handleCcpPkg,
  handleCcpDev,
  handleCcpAttrSel,
  handleCcpAttrSelPrev,
  handleCcpAttrSelNext,
  handleCcpAttrPagePrev,
  handleCcpAttrPageNext,
  handleCcpAttrAdjust,
  handleCcpSubmitAttrs,
  handleCcpPreConfirm,
  handleCcpConfirm,
  handleCcpCancel,
  handleCcpApplied,
  handleCcpRefund,
  handleCcpRefundModal,
  handleCcpModal,
  handleCcpHand,
  handleCcpHeight,
  handleCcpWeight,
  handleCcpMotionStyle,
  handleCcpQbDetailsModal,
  handleCcpAppearanceModal,
} from "../lib/custom-player-interactions.js";`,
  },
  {
    guard: "admin-inventory",
    statement:
`import {
  handleAcpPositionSelect,
  handleAcpPlayerSelect,
} from "../commands/admin-inventory.js";`,
  },
  {
    guard: "viewcustomarchetypes",
    statement:
`import {
  handleViewArchetypeSelect,
  handleVcaNav,
  handleVcaAttrPageNav,
} from "../commands/viewcustomarchetypes.js";`,
  },
  {
    guard: "viewplayerstats",
    statement:
`import {
  handleTeamSelect,
  handlePositionSelect,
  handlePlayerSelect,
} from "../commands/viewplayerstats.js";`,
  },
];

if (!ic.includes(IMPORT_ANCHOR)) {
  console.error(`  ❌ Cannot find anchor "${IMPORT_ANCHOR}" — aborting import injection`);
  process.exit(1);
}

let insertedCount = 0;
let insertionBlock = "";
for (const { guard, statement } of MISSING_IMPORTS) {
  if (ic.includes(guard)) {
    console.log(`  ✅ [Fix 2] Already imported: ${guard} — skipping`);
  } else {
    insertionBlock += statement + "\n";
    insertedCount++;
  }
}

if (insertionBlock) {
  ic = ic.replace(IMPORT_ANCHOR, insertionBlock + IMPORT_ANCHOR);
  console.log(`  ✅ [Fix 2] Injected ${insertedCount} missing import block(s)`);
} else {
  console.log("  ✅ [Fix 2] All handler imports already present — skipping");
}

// ── Fix 1 — add braces to ac_ dispatch ───────────────────────────────────────
const BROKEN_AC_DISPATCH =
  "  if (action?.startsWith(\"ac_\")) await handleActionsInteraction(interaction); return;";

const FIXED_AC_DISPATCH =
  "  if (action?.startsWith(\"ac_\")) {\n" +
  "    const handledDept = await handleMenuDepartmentInteraction(interaction as any);\n" +
  "    if (handledDept) return;\n" +
  "    await handleActionsInteraction(interaction);\n" +
  "    return;\n" +
  "  }";

const occurrencesBefore = ic.split(BROKEN_AC_DISPATCH).length - 1;
if (occurrencesBefore === 0) {
  console.warn("  ⚠️  [Fix 1] Broken ac_ dispatch pattern not found — may already be fixed");
} else {
  ic = ic.split(BROKEN_AC_DISPATCH).join(FIXED_AC_DISPATCH);
  console.log(`  ✅ [Fix 1] Fixed missing braces on ac_ dispatch (${occurrencesBefore} occurrence${occurrencesBefore !== 1 ? "s" : ""})`);
}

// ── Fix 3a — dead code in commissioner-office intercept (handleButton) ────────
ic = apply(
  "Fix 3a — dead code in commissioner-office intercept",
  ic,
  `    const handled = await handleActionsInteraction(interaction); return;\n    if (handled) return;\n  }\n\n  // ── Actions hub`,
  `    await handleActionsInteraction(interaction);\n    return;\n  }\n\n  // ── Actions hub`,
  { required: false },
);

// ── Fix 3b — dead code in ac_office_select intercept (handleSelectMenu) ───────
ic = apply(
  "Fix 3b — dead code in ac_office_select intercept",
  ic,
  `    const handled = await handleActionsInteraction(interaction); return;\n    if (handled) return;\n  }\n\n  const parts`,
  `    await handleActionsInteraction(interaction);\n    return;\n  }\n\n  const parts`,
  { required: false },
);

// ── Fix 5 — operator precedence in isActionsInteraction ──────────────────────
const BROKEN_IS_ACTIONS =
  "  const isActionsInteraction = (interaction.isButton() || interaction.isStringSelectMenu())\n" +
  "    && typeof (interaction as any).customId === \"string\"\n" +
  "    && (interaction as any).customId.startsWith(\"ac_\") || (\"customId\" in interaction && interaction.customId?.startsWith(\"go_\")); ";

const FIXED_IS_ACTIONS =
  "  const isActionsInteraction = (\n" +
  "    (interaction.isButton() || interaction.isStringSelectMenu()) &&\n" +
  "    typeof (interaction as any).customId === \"string\" &&\n" +
  "    (\n" +
  "      (interaction as any).customId.startsWith(\"ac_\") ||\n" +
  "      (interaction as any).customId.startsWith(\"go_\")\n" +
  "    )\n" +
  "  );";

ic = apply("Fix 5 — isActionsInteraction operator precedence", ic, BROKEN_IS_ACTIONS, FIXED_IS_ACTIONS, { required: false });

fs.writeFileSync(IC_FILE, ic.replace(/\r\n/g, "\n"), "utf8");
console.log("  Saved.\n");

// =============================================================================
// PATCH src/index.ts
// =============================================================================
console.log("Patching src/index.ts …");
backup(INDEX_FILE);
let idx = fs.readFileSync(INDEX_FILE, "utf8");

if (!idx.includes("import * as adminOperations")) {
  console.warn("  ⚠️  [Fix 4] adminOperations import not found in index.ts — skipping");
} else if (/commands\s*=\s*\[[\s\S]*?\badminOperations\b/.test(idx)) {
  console.log("  ✅ [Fix 4] adminOperations already in commands array — skipping");
} else {
  idx = apply(
    "Fix 4 — register adminOperations slash command",
    idx,
    "adminRepostBanners, lottery,",
    "adminRepostBanners, lottery, adminOperations,",
    { required: false },
  );
}

fs.writeFileSync(INDEX_FILE, idx.replace(/\r\n/g, "\n"), "utf8");
console.log("  Saved.\n");

// =============================================================================
console.log("Done. Summary:");
console.log("  Fix 1 — missing braces on ac_ dispatch (all 3 handlers)");
console.log("  Fix 2 — injected all missing handler imports into interactionCreate.ts");
console.log("  Fix 3 — removed dead `if (handled) return` after unconditional returns");
console.log("  Fix 4 — adminOperations added to commands array in index.ts");
console.log("  Fix 5 — isActionsInteraction go_ clause now correctly parenthesized");
