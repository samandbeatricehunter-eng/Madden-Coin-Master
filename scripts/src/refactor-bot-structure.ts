/**
 * One-shot refactor: moves discord-bot files into domain folders and rewrites
 * every relative import across the bot src tree to match the new locations.
 *
 * Run with: pnpm tsx scripts/src/refactor-bot-structure.ts
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync } from "node:fs";
import { join, relative, dirname, basename, resolve } from "node:path";

const BOT_SRC = resolve("artifacts/discord-bot/src");

// basename (without .ts) -> new directory relative to BOT_SRC
const MOVES: Record<string, string> = {};

// ── commands ──────────────────────────────────────────────────────────────────
const cmdAdmin = [
  "admin","adminserver","endofseasonpayout","lottery",
  "admin-cancel-resend-eos","admin-catchup","admin-clearteam","admin-customarchetypes",
  "admin-customplayersettings","admin-deleteuser","admin-eos-reapprove","admin-eos-testrun",
  "admin-fixplayernames","admin-gotw","admin-initialize","admin-inventory","admin-legend",
  "admin-legendvault","admin-linkteam","admin-milestone-audit","admin-operations",
  "admin-rebuild-historical","admin-repair-teamlinks","admin-repost-banners",
  "admin-resendarticle","admin-reset-season-stats","admin-rollback-franchise",
  "admin-season","admin-set-stat-tiers","admin-setadmin","admin-setuser",
  "admin-stat-tiers","admin-team","admin-team-logo","admin-transactions",
];
const cmdEconomy = ["buy-agereset","buy-customplayer","buy-devup","buy-legend","purchase","purchasecustomplayer"];
const cmdStats = ["h2hrecord","globalrecords","userstats","viewroster","viewplayerdetails","viewplayerstats","viewcustomarchetypes","help","rules"];
const cmdLeague = ["interviewrequest","waitlist","draft-presence"];

for (const n of cmdAdmin) MOVES[n] = "commands/admin";
for (const n of cmdEconomy) MOVES[n] = "commands/economy";
for (const n of cmdStats) MOVES[n] = "commands/stats";
for (const n of cmdLeague) MOVES[n] = "commands/league";
// actions.ts stays at commands/

// ── lib ───────────────────────────────────────────────────────────────────────
const libDb = ["db-helpers","user-data","server-settings","repair-records"];
const libMenu = ["menu-hub","menu-router","command-list"];
const libHandlers = [
  "actions-handlers","admin-actions","admin-operations-handlers","admin-payout-handlers",
  "admin-store-handlers","admin-troubleshoot-handlers","admin-user-handlers",
  "custom-player-interactions","custom-player-session","pending-cocomm-actions",
  "pending-inbox-handlers","league-data-handlers",
];
const libFranchise = [
  "franchise-article","full-sync-engine","gcs-reader","gcs-fallback","mca-storage-reader",
  "season-recap","send-article","season-schedule-post","eos-auto-post",
  "playoff-seeding","playoff-matchups-runner","weekly-matchups-runner","wildcard-automation",
];
const libEa = ["ea-client"];
const libEconomy = ["purchase-shared","custom-player-helpers","default-legends","payout-config","dev-trait","stat-categories","roster-legend-assign"];
const libDiscord = ["embeds","theme","user-stats-embed","matchup-image","matchup-ai-breakdown","draft-presence-manager","league-twitter","register-commands"];
const libScheduling = ["savings-interest","poll-checker"];
const libHelpers = ["gotw-helpers","week-helpers"];

for (const n of libDb) MOVES[n] = "lib/db";
for (const n of libMenu) MOVES[n] = "lib/menu";
for (const n of libHandlers) MOVES[n] = "lib/handlers";
for (const n of libFranchise) MOVES[n] = "lib/franchise";
for (const n of libEa) MOVES[n] = "lib/ea";
for (const n of libEconomy) MOVES[n] = "lib/economy";
for (const n of libDiscord) MOVES[n] = "lib/discord";
for (const n of libScheduling) MOVES[n] = "lib/scheduling";
for (const n of libHelpers) MOVES[n] = "lib/helpers";
// constants.ts stays at lib/

// ── 1. Locate every .ts file and build basename -> absolute final path map ────
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const allTs = walk(BOT_SRC);

// Map basename(no ext) -> the absolute path it will live at AFTER moves.
const finalPathOf = new Map<string, string>();
for (const abs of allTs) {
  const base = basename(abs, ".ts");
  const targetDir = MOVES[base];
  const finalAbs = targetDir
    ? join(BOT_SRC, targetDir, base + ".ts")
    : abs;
  finalPathOf.set(base, finalAbs);
}

// ── 2. Move files ─────────────────────────────────────────────────────────────
const toMove: [string, string][] = [];
for (const abs of allTs) {
  const base = basename(abs, ".ts");
  const target = MOVES[base];
  if (!target) continue;
  const newAbs = join(BOT_SRC, target, base + ".ts");
  if (abs === newAbs) continue;
  toMove.push([abs, newAbs]);
}

console.log(`Moving ${toMove.length} files…`);
for (const [from, to] of toMove) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    execSync(`git mv "${from}" "${to}"`, { stdio: "pipe" });
  } catch {
    renameSync(from, to);
  }
}

// ── 3. Rewrite imports in every .ts file in BOT_SRC ───────────────────────────
const allTsFinal = walk(BOT_SRC);
const IMPORT_RE = /(from\s+["'])(\.[^"']+?)(\.js)(["'])/g;
const SIDE_EFFECT_IMPORT_RE = /(import\s+["'])(\.[^"']+?)(\.js)(["'])/g;

let rewrittenFiles = 0;
let rewrittenImports = 0;

for (const file of allTsFinal) {
  const original = readFileSync(file, "utf8");
  const fileDir = dirname(file);

  const replacer = (_m: string, pre: string, importPath: string, ext: string, quote: string) => {
    // importPath is like "./foo" or "../lib/bar/baz"
    const importedBase = basename(importPath);
    const finalTargetAbs = finalPathOf.get(importedBase);
    if (!finalTargetAbs) return pre + importPath + ext + quote;

    // Compute new relative path from fileDir to finalTargetAbs (without ext).
    const finalNoExt = finalTargetAbs.replace(/\.ts$/, "");
    let rel = relative(fileDir, finalNoExt).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    if (rel === pre.match(/["']/) ? "" : importPath) {
      return pre + importPath + ext + quote;
    }
    if (rel !== importPath) rewrittenImports++;
    return pre + rel + ext + quote;
  };

  let updated = original.replace(IMPORT_RE, replacer);
  updated = updated.replace(SIDE_EFFECT_IMPORT_RE, replacer);

  if (updated !== original) {
    writeFileSync(file, updated);
    rewrittenFiles++;
  }
}

console.log(`✅ Moved ${toMove.length} files`);
console.log(`✅ Rewrote ${rewrittenImports} import paths across ${rewrittenFiles} files`);
console.log(`\nSanity check: run 'pnpm --filter @workspace/discord-bot run typecheck'`);
