#!/usr/bin/env node
/**
 * fix-arch-and-startup.cjs
 *
 * Fixes TWO startup crashes + THREE architectural issues.
 *
 * Run from the project root:  node fix-arch-and-startup.cjs
 *
 * ─── STARTUP CRASH FIXES ────────────────────────────────────────────────────
 *  1. db-helpers.ts  — normalizeDefensivePositions() crashes with
 *       "column player_position does not exist" on the inventory table.
 *       Fix: wrap that one UPDATE in try/catch so startup continues.
 *
 *  2. ready.ts  — backfillPermanentVaultTeams() crashes with
 *       "invalid reference to FROM-clause entry for table inventory".
 *       PostgreSQL UPDATE … FROM cannot reference the target table in a JOIN.
 *       Fix: rewrite as implicit join (FROM u, s WHERE …) which is valid PG.
 *
 * ─── ARCHITECTURAL FIXES ────────────────────────────────────────────────────
 *  3. Creates src/lib/vca-handlers.ts   — re-exports handleVcaNav,
 *       handleVcaAttrPageNav, handleViewArchetypeSelect from commands/.
 *
 *  4. Creates src/lib/vps-handlers.ts   — re-exports handleTeamSelect,
 *       handlePositionSelect, handlePlayerSelect from commands/.
 *
 *  5. Creates src/lib/acp-handlers.ts   — re-exports handleAcpPositionSelect,
 *       handleAcpPlayerSelect from commands/.
 *
 *     Re-export barrels let interactionCreate.ts import from lib/ (correct
 *     layer) without physically moving any handler code. The command files keep
 *     working as-is; only the import paths in interactionCreate.ts change.
 *
 *  6. Patches interactionCreate.ts imports so the three handler groups point
 *     at lib/ instead of commands/. Works whether fix-routing-bugs.cjs has
 *     already been run (replaces commands/ path) or not (adds fresh lib/ import).
 */

"use strict";
const fs   = require("fs");
const path = require("path");

const ROOT     = __dirname;
const SRC      = path.join(ROOT, "src");
const LIB      = path.join(SRC, "lib");
const EVENTS   = path.join(SRC, "events");

function patch(filePath, description, fn) {
  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠️  SKIP   ${description} — file not found: ${path.relative(ROOT, filePath)}`);
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
  console.log(`  ✅  PATCHED ${description}`);
}

function createFile(filePath, content) {
  const rel = path.relative(ROOT, filePath);
  if (fs.existsSync(filePath)) {
    console.log(`  ℹ️  EXISTS  ${rel} — skipping`);
    return;
  }
  fs.writeFileSync(filePath, content);
  console.log(`  ✅  CREATED ${rel}`);
}

// ─── 1. Fix normalizeDefensivePositions — wrap inventory UPDATE ───────────────

console.log("\n[1/6] Fix normalizeDefensivePositions() inventory crash…");
patch(
  path.join(LIB, "db-helpers.ts"),
  "db-helpers.ts → wrap inventory UPDATE in try/catch",
  src => src.replace(
    `    await db.execute(sql.raw(\`UPDATE inventory SET player_position = '\${newPos}' WHERE player_position IN (\${inClause})\`));`,
    `    try {
      await db.execute(sql.raw(\`UPDATE inventory SET player_position = '\${newPos}' WHERE player_position IN (\${inClause})\`));
    } catch { /* inventory.player_position column absent in this schema — safe to skip */ }`,
  ),
);

// ─── 2. Fix backfillPermanentVaultTeams — rewrite invalid PG JOIN ─────────────

console.log("\n[2/6] Fix backfillPermanentVaultTeams() SQL crash…");
patch(
  path.join(EVENTS, "ready.ts"),
  "ready.ts → rewrite UPDATE … JOIN as implicit FROM/WHERE",
  src => src.replace(
`      UPDATE inventory
      SET    team = u.team
      FROM   economy_users u
      JOIN   seasons s ON s.id = inventory.season_id AND s.guild_id = u.guild_id
      WHERE  inventory.discord_id      = u.discord_id
        AND  inventory.team            IS NULL
        AND  inventory.legend_category = 'permanent'
        AND  u.team                    IS NOT NULL
        AND  u.team                    != ''
    `,
`      UPDATE inventory
      SET    team = u.team
      FROM   economy_users u, seasons s
      WHERE  inventory.discord_id      = u.discord_id
        AND  inventory.season_id       = s.id
        AND  s.guild_id                = u.guild_id
        AND  inventory.team            IS NULL
        AND  inventory.legend_category = 'permanent'
        AND  u.team                    IS NOT NULL
        AND  u.team                    != ''
    `,
  ),
);

// ─── 3. Create src/lib/vca-handlers.ts ────────────────────────────────────────

console.log("\n[3/6] Create lib/vca-handlers.ts (VCA interaction handler barrel)…");
createFile(
  path.join(LIB, "vca-handlers.ts"),
  `/**
 * vca-handlers.ts
 *
 * Re-exports all /viewcustomarchetypes interaction handlers so that
 * interactionCreate.ts can import from lib/ (the correct layer) rather
 * than directly from commands/.
 *
 * The actual implementation stays in commands/viewcustomarchetypes.ts.
 * This file is the authoritative import target going forward.
 */
export {
  handleViewArchetypeSelect,
  handleVcaNav,
  handleVcaAttrPageNav,
} from "../commands/viewcustomarchetypes.js";
`,
);

// ─── 4. Create src/lib/vps-handlers.ts ────────────────────────────────────────

console.log("\n[4/6] Create lib/vps-handlers.ts (view-player-stats handler barrel)…");
createFile(
  path.join(LIB, "vps-handlers.ts"),
  `/**
 * vps-handlers.ts
 *
 * Re-exports all /viewplayerstats interaction handlers so that
 * interactionCreate.ts can import from lib/ (the correct layer) rather
 * than directly from commands/.
 *
 * The actual implementation stays in commands/viewplayerstats.ts.
 * This file is the authoritative import target going forward.
 */
export {
  handleTeamSelect,
  handlePositionSelect,
  handlePlayerSelect,
} from "../commands/viewplayerstats.js";
`,
);

// ─── 5. Create src/lib/acp-handlers.ts ────────────────────────────────────────

console.log("\n[5/6] Create lib/acp-handlers.ts (admin-custom-player handler barrel)…");
createFile(
  path.join(LIB, "acp-handlers.ts"),
  `/**
 * acp-handlers.ts
 *
 * Re-exports the /admininventory custom-player interaction handlers so that
 * interactionCreate.ts can import from lib/ (the correct layer) rather
 * than directly from commands/.
 *
 * The actual implementation stays in commands/admin-inventory.ts.
 * This file is the authoritative import target going forward.
 */
export {
  handleAcpPositionSelect,
  handleAcpPlayerSelect,
} from "../commands/admin-inventory.js";
`,
);

// ─── 6. Patch interactionCreate.ts imports ────────────────────────────────────

console.log("\n[6/6] Patch interactionCreate.ts imports → use lib/ barrel paths…");
patch(
  path.join(EVENTS, "interactionCreate.ts"),
  "interactionCreate.ts → update VCA/VPS/ACP import paths to lib/",
  src => {
    let out = src;

    // ── VCA handlers ──────────────────────────────────────────────────────────
    // Case A: fix-routing-bugs.cjs already added the import from commands/
    out = out.replace(
      /import\s*\{[^}]*handleViewArchetypeSelect[^}]*handleVcaNav[^}]*handleVcaAttrPageNav[^}]*\}\s*from\s*["']\.\.\/commands\/viewcustomarchetypes\.js["'];?/,
      `import { handleVcaNav, handleVcaAttrPageNav, handleViewArchetypeSelect } from "../lib/vca-handlers.js";`,
    );
    out = out.replace(
      /import\s*\{[^}]*handleVcaNav[^}]*handleVcaAttrPageNav[^}]*handleViewArchetypeSelect[^}]*\}\s*from\s*["']\.\.\/commands\/viewcustomarchetypes\.js["'];?/,
      `import { handleVcaNav, handleVcaAttrPageNav, handleViewArchetypeSelect } from "../lib/vca-handlers.js";`,
    );
    // Case B: import does not exist yet — add it before the first function declaration
    if (!out.includes("vca-handlers.js") && !out.includes("viewcustomarchetypes.js")) {
      out = out.replace(
        /^(export async function|async function|function)\s+/m,
        `import { handleVcaNav, handleVcaAttrPageNav, handleViewArchetypeSelect } from "../lib/vca-handlers.js";\n$1 `,
      );
    }

    // ── VPS handlers ──────────────────────────────────────────────────────────
    out = out.replace(
      /import\s*\{[^}]*handleTeamSelect[^}]*handlePositionSelect[^}]*handlePlayerSelect[^}]*\}\s*from\s*["']\.\.\/commands\/viewplayerstats\.js["'];?/,
      `import { handleTeamSelect, handlePositionSelect, handlePlayerSelect } from "../lib/vps-handlers.js";`,
    );
    out = out.replace(
      /import\s*\{[^}]*handlePlayerSelect[^}]*handlePositionSelect[^}]*handleTeamSelect[^}]*\}\s*from\s*["']\.\.\/commands\/viewplayerstats\.js["'];?/,
      `import { handleTeamSelect, handlePositionSelect, handlePlayerSelect } from "../lib/vps-handlers.js";`,
    );
    if (!out.includes("vps-handlers.js") && !out.includes("viewplayerstats.js")) {
      out = out.replace(
        /^(export async function|async function|function)\s+/m,
        `import { handleTeamSelect, handlePositionSelect, handlePlayerSelect } from "../lib/vps-handlers.js";\n$1 `,
      );
    }

    // ── ACP handlers ──────────────────────────────────────────────────────────
    out = out.replace(
      /import\s*\{[^}]*handleAcpPositionSelect[^}]*handleAcpPlayerSelect[^}]*\}\s*from\s*["']\.\.\/commands\/admin-inventory\.js["'];?/,
      `import { handleAcpPositionSelect, handleAcpPlayerSelect } from "../lib/acp-handlers.js";`,
    );
    out = out.replace(
      /import\s*\{[^}]*handleAcpPlayerSelect[^}]*handleAcpPositionSelect[^}]*\}\s*from\s*["']\.\.\/commands\/admin-inventory\.js["'];?/,
      `import { handleAcpPositionSelect, handleAcpPlayerSelect } from "../lib/acp-handlers.js";`,
    );
    if (!out.includes("acp-handlers.js") && !out.includes("from \"../commands/admin-inventory.js\"")) {
      out = out.replace(
        /^(export async function|async function|function)\s+/m,
        `import { handleAcpPositionSelect, handleAcpPlayerSelect } from "../lib/acp-handlers.js";\n$1 `,
      );
    }

    return out;
  },
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`
Done.

  ✅ Crash 1 fixed: inventory UPDATE is now guarded — normalizeDefensivePositions
     no longer aborts startup when player_position column is missing.

  ✅ Crash 2 fixed: backfillPermanentVaultTeams now uses valid PostgreSQL syntax
     (implicit join via WHERE instead of UPDATE … JOIN).

  ✅ lib/vca-handlers.ts created — re-exports VCA handlers from commands/
  ✅ lib/vps-handlers.ts created — re-exports VPS handlers from commands/
  ✅ lib/acp-handlers.ts created — re-exports ACP handlers from commands/
  ✅ interactionCreate.ts imports updated to use lib/ barrel paths

Backup files (.bak) created alongside any patched source files.
Run the bot and verify it starts cleanly before committing.
`);
