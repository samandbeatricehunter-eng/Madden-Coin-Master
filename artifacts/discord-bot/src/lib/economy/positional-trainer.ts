// Positional Trainer — per-player weekly random-boost contract.
//
// A user can hire a tiered trainer (gold/silver/bronze) for a specific player
// for N weeks. Cost is paid in full upfront at quote = ceil(yearly/18) * weeks
// then multiplied by the per-guild economy inflation multiplier.
//
// Each week tick (Advance Week), every `active` trainer rolls:
//   1. Base hit chance per tier, reduced for 2 weeks after a hit (cooldown 1/2).
//   2. If hit, draws 1-2 boosts (gold can hit 2) using the same focus-weighted
//      attribute lottery as Training Packages.
//   3. Each boost is +1 or +2 (uniform); capped so the attribute won't pass 99,
//      and respecting per-player per-season method caps:
//        Speed +3, Strength +4, COD +4, Acceleration +4, Agility +4.
//
// Successful boosts are logged and queued as $0 pending Attribute purchases so
// commissioners can apply/confirm them through Commissioner's Office → Pending
// Purchases. The weekly roll does not directly mutate roster attributes.

import type { Client } from "discord.js";
import { db } from "@workspace/db";
import {
  positionalTrainersTable, trainerRollLogTable, trainerPlayerSeasonCapsTable,
  franchiseRostersTable, purchasesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ATTRIBUTES } from "../constants.js";

export type TrainerTier  = "gold" | "silver" | "bronze";
export type TrainerFocus = "speed" | "power" | "balanced" | "position";

export interface TrainerTierMeta {
  label:           string;
  yearly:          number;   // yearly base cost in coins
  baseChanceBps:   number;   // base hit chance (basis points: 6000 = 60%)
  cooldown1Bps:    number;   // chance the week after a hit
  cooldown2Bps:    number;   // chance two weeks after a hit
  maxBoostsOnHit:  number;   // max distinct attributes touched in a successful tick
  doubleBoostBps:  number;   // chance the second boost lands (only relevant if max > 1)
}

export const TRAINER_TIERS: Record<TrainerTier, TrainerTierMeta> = {
  gold:   { label: "🥇 Gold",   yearly: 3000, baseChanceBps: 6000, cooldown1Bps: 2500, cooldown2Bps: 4000, maxBoostsOnHit: 2, doubleBoostBps: 5000 },
  silver: { label: "🥈 Silver", yearly: 2000, baseChanceBps: 4000, cooldown1Bps: 1500, cooldown2Bps: 2500, maxBoostsOnHit: 1, doubleBoostBps: 0    },
  bronze: { label: "🥉 Bronze", yearly: 1000, baseChanceBps: 2500, cooldown1Bps:  500, cooldown2Bps: 1500, maxBoostsOnHit: 1, doubleBoostBps: 0    },
};

const REGULAR_SEASON_WEEKS = 18;

/** Per-week base cost before inflation, rounded up to a whole coin. */
export function pricePerWeek(tier: TrainerTier): number {
  return Math.ceil(TRAINER_TIERS[tier].yearly / REGULAR_SEASON_WEEKS);
}

/** Full upfront cost for `weeks` weeks of `tier`, with inflation applied. */
export function quoteHire(tier: TrainerTier, weeks: number, inflationMultiplierBps: number): {
  perWeek: number;
  total:   number;
} {
  const baseWeek = pricePerWeek(tier);
  const inflated = Math.round((baseWeek * inflationMultiplierBps) / 10000);
  const perWeek  = Math.max(1, inflated);
  return { perWeek, total: perWeek * weeks };
}

/** Current per-tick hit chance, taking the per-trainer cooldown into account. */
export function currentHitChanceBps(
  tier:                TrainerTier,
  lastHitWeekIndex:    number | null,
  currentWeekIndex:    number,
): number {
  const meta = TRAINER_TIERS[tier];
  if (lastHitWeekIndex == null) return meta.baseChanceBps;
  const gap = currentWeekIndex - lastHitWeekIndex;
  if (gap <= 0) return 0;                  // already rolled this same tick
  if (gap === 1) return meta.cooldown1Bps; // first cooldown week
  if (gap === 2) return meta.cooldown2Bps; // second cooldown week
  return meta.baseChanceBps;
}

/** Per-player per-season caps for the trainer-method boosts. */
export interface TrainerCapsRow {
  speedGain:    number;
  strengthGain: number;
  codGain:      number;
  accelGain:    number;
  agilityGain:  number;
}

export const TRAINER_PER_SEASON_CAP: Record<string, number> = {
  Speed:                3,
  Strength:             4,
  "Change of Direction": 4,
  Acceleration:         4,
  Agility:              4,
};

/** Remaining headroom for a given attribute under the per-season method caps.
 *  Returns Infinity for attributes that aren't capped by this system. */
export function remainingPerSeasonHeadroom(attr: string, caps: TrainerCapsRow): number {
  switch (attr) {
    case "Speed":                return Math.max(0, TRAINER_PER_SEASON_CAP[attr]! - caps.speedGain);
    case "Strength":             return Math.max(0, TRAINER_PER_SEASON_CAP[attr]! - caps.strengthGain);
    case "Change of Direction":  return Math.max(0, TRAINER_PER_SEASON_CAP[attr]! - caps.codGain);
    case "Acceleration":         return Math.max(0, TRAINER_PER_SEASON_CAP[attr]! - caps.accelGain);
    case "Agility":              return Math.max(0, TRAINER_PER_SEASON_CAP[attr]! - caps.agilityGain);
    default:                     return Infinity;
  }
}

/** Mutate caps row in-place for an applied boost. Returns the field that changed (or null). */
export function applyCapDelta(attr: string, points: number, caps: TrainerCapsRow): keyof TrainerCapsRow | null {
  switch (attr) {
    case "Speed":                caps.speedGain    += points; return "speedGain";
    case "Strength":             caps.strengthGain += points; return "strengthGain";
    case "Change of Direction":  caps.codGain      += points; return "codGain";
    case "Acceleration":         caps.accelGain    += points; return "accelGain";
    case "Agility":              caps.agilityGain  += points; return "agilityGain";
    default:                     return null;
  }
}

/** Result of a single weekly tick for one trainer. */
export interface TrainerTickResult {
  hit:              boolean;
  chanceAppliedBps: number;
  reason:           string;
  boosts:           Array<{ attr: string; before: number | null; after: number | null; points: number }>;
}

/** Roll one weekly tick for a trainer.
 *
 *  `pickAttrs(count, focus, playerPos, playerAttrs)` is injected so callers can
 *  reuse the existing Training-Package attribute-lottery without this module
 *  depending on actions-handlers (which would create a circular import). */
export function rollOneTick(args: {
  tier:             TrainerTier;
  focus:            TrainerFocus;
  playerPos:        string;
  playerAttrs:      Record<string, number>;
  caps:             TrainerCapsRow;
  lastHitWeekIndex: number | null;
  currentWeekIndex: number;
  pickAttrs:        (count: number, focus: TrainerFocus, pos: string, attrs: Record<string, number>) => string[];
  random?:          () => number;  // seam for tests
}): TrainerTickResult {
  const rand        = args.random ?? Math.random;
  const meta        = TRAINER_TIERS[args.tier];
  const chanceBps   = currentHitChanceBps(args.tier, args.lastHitWeekIndex, args.currentWeekIndex);
  const rollHitBps  = Math.floor(rand() * 10000);

  if (rollHitBps >= chanceBps) {
    const reason = args.lastHitWeekIndex != null && (args.currentWeekIndex - args.lastHitWeekIndex) <= 2
      ? `Missed roll (${(chanceBps / 100).toFixed(0)}% chance — reduced after recent hit)`
      : `Missed roll (${(chanceBps / 100).toFixed(0)}% base chance)`;
    return { hit: false, chanceAppliedBps: chanceBps, reason, boosts: [] };
  }

  // Decide how many boosts this hit produces (gold can hit 2).
  const wantBoosts = meta.maxBoostsOnHit > 1 && Math.floor(rand() * 10000) < meta.doubleBoostBps ? 2 : 1;

  // Draw candidates from the focus-weighted lottery, then filter/clamp by caps.
  // Over-draw a little so cap-blocked attrs don't leave us short.
  const draft = args.pickAttrs(Math.min(wantBoosts * 3, 8), args.focus, args.playerPos, args.playerAttrs);

  const boosts: TrainerTickResult["boosts"] = [];
  const capsScratch: TrainerCapsRow = { ...args.caps };

  for (const attr of draft) {
    if (boosts.length >= wantBoosts) break;
    if (attr === "Height" || attr === "Weight") continue;

    const before     = args.playerAttrs[attr] ?? null;
    const ninetyNine = before != null ? Math.max(0, 99 - before) : 2;
    const seasonCap  = remainingPerSeasonHeadroom(attr, capsScratch);
    const ceiling    = Math.min(2, ninetyNine, seasonCap);
    if (ceiling <= 0) continue;

    // 50/50 between +1 and +2 when both are allowed; otherwise pick the allowed value.
    const points = ceiling === 1 ? 1 : (rand() < 0.5 ? 1 : 2);
    const after  = before != null ? before + points : null;
    boosts.push({ attr, before, after, points });
    applyCapDelta(attr, points, capsScratch);
  }

  if (boosts.length === 0) {
    return {
      hit: false,
      chanceAppliedBps: chanceBps,
      reason: `Hit roll succeeded but every eligible attribute was already capped (99 / season method cap)`,
      boosts: [],
    };
  }

  const summary = boosts.map(b => `${b.attr} +${b.points}`).join(", ");
  return {
    hit: true,
    chanceAppliedBps: chanceBps,
    reason: `Hit (${(chanceBps / 100).toFixed(0)}% chance) → ${summary}`,
    boosts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default focus-biased attribute lottery — mirrors the Training Package roll.
// Kept here so positional-trainer.ts is self-contained for the weekly tick.
// ─────────────────────────────────────────────────────────────────────────────

const TRAINER_SPEED_BOOST_SET = new Set([
  "Speed", "Acceleration", "Agility", "Change of Direction",
  "Juke Move", "Spin Move", "Release",
  "Pass Block Finesse", "Run Block Finesse", "Finesse Moves",
  "Pursuit", "Man Coverage", "Zone Coverage", "Kick/Punt Return",
]);
const TRAINER_POWER_BOOST_SET = new Set([
  "Strength", "Trucking", "Stiff Arm", "Break Tackle",
  "Hit Power", "Throwing Power", "Power Moves",
  "Pass Block Power", "Run Block Power",
  "Lead Block", "Impact Blocking", "Block Shedding", "Tackling",
]);
const TRAINER_POS_FOCUS_SETS: Record<string, Set<string>> = {
  QB:    new Set(["Throwing Power","Short Accuracy","Medium Accuracy","Deep Accuracy","Throw on the Run","Throw Under Pressure","Break Sack","Play Action"]),
  HB:    new Set(["Carrying","BC Vision","Break Tackle","Trucking","Stiff Arm","Spin Move","Juke Move"]),
  FB:    new Set(["Carrying","Break Tackle","Trucking","Stiff Arm","Lead Block","Impact Blocking"]),
  WR:    new Set(["Catching","Catch in Traffic","Spectacular Catch","Short Route Running","Medium Route Running","Deep Route Running","Release"]),
  TE:    new Set(["Catching","Catch in Traffic","Spectacular Catch","Short Route Running","Medium Route Running","Deep Route Running","Release","Lead Block","Impact Blocking"]),
  LT:    new Set(["Pass Blocking","Pass Block Power","Pass Block Finesse","Run Blocking","Run Block Power","Run Block Finesse","Lead Block","Impact Blocking"]),
  LG:    new Set(["Pass Blocking","Pass Block Power","Pass Block Finesse","Run Blocking","Run Block Power","Run Block Finesse","Lead Block","Impact Blocking"]),
  C:     new Set(["Pass Blocking","Pass Block Power","Pass Block Finesse","Run Blocking","Run Block Power","Run Block Finesse","Lead Block","Impact Blocking"]),
  RG:    new Set(["Pass Blocking","Pass Block Power","Pass Block Finesse","Run Blocking","Run Block Power","Run Block Finesse","Lead Block","Impact Blocking"]),
  RT:    new Set(["Pass Blocking","Pass Block Power","Pass Block Finesse","Run Blocking","Run Block Power","Run Block Finesse","Lead Block","Impact Blocking"]),
  LEDGE: new Set(["Block Shedding","Finesse Moves","Power Moves","Pursuit","Tackling","Hit Power"]),
  REDGE: new Set(["Block Shedding","Finesse Moves","Power Moves","Pursuit","Tackling","Hit Power"]),
  DT:    new Set(["Block Shedding","Finesse Moves","Power Moves","Pursuit","Tackling","Hit Power"]),
  MIKE:  new Set(["Tackling","Hit Power","Block Shedding","Finesse Moves","Power Moves","Pursuit","Play Recognition","Man Coverage","Zone Coverage"]),
  WILL:  new Set(["Tackling","Hit Power","Block Shedding","Finesse Moves","Power Moves","Pursuit","Play Recognition","Man Coverage","Zone Coverage"]),
  SAM:   new Set(["Tackling","Hit Power","Block Shedding","Finesse Moves","Power Moves","Pursuit","Play Recognition","Man Coverage","Zone Coverage"]),
  CB:    new Set(["Man Coverage","Zone Coverage","Press","Play Recognition","Tackling","Hit Power","Pursuit"]),
  FS:    new Set(["Man Coverage","Zone Coverage","Press","Play Recognition","Tackling","Hit Power","Pursuit"]),
  SS:    new Set(["Man Coverage","Zone Coverage","Press","Play Recognition","Tackling","Hit Power","Pursuit"]),
  K:     new Set(["Kicking Power","Kicking Accuracy"]),
  P:     new Set(["Kicking Power","Kicking Accuracy"]),
  LS:    new Set(["Long Snap"]),
};

const _A = (...attrs: string[]) => new Set(attrs);
const SHARED_ATHLETE   = ["Speed","Acceleration","Agility","Strength","Awareness","Change of Direction","Jumping","Stamina","Toughness","Injury"] as const;
const SHARED_COVERAGE  = ["Tackling","Hit Power","Pursuit","Play Recognition","Man Coverage","Zone Coverage","Press"] as const;
const SHARED_DLINE     = ["Tackling","Hit Power","Block Shedding","Finesse Moves","Power Moves","Pursuit"] as const;
const SHARED_OL_BLOCKS = ["Pass Blocking","Pass Block Power","Pass Block Finesse","Run Blocking","Run Block Power","Run Block Finesse","Lead Block","Impact Blocking"] as const;

const TRAINER_POS_ATTRS: Record<string, Set<string>> = {
  QB:    _A(...SHARED_ATHLETE, "Throwing Power","Short Accuracy","Medium Accuracy","Deep Accuracy","Throw on the Run","Throw Under Pressure","Break Sack","Play Action"),
  HB:    _A(...SHARED_ATHLETE, "Carrying","BC Vision","Break Tackle","Trucking","Stiff Arm","Spin Move","Juke Move","Catching","Catch in Traffic","Kick/Punt Return"),
  FB:    _A(...SHARED_ATHLETE, "Carrying","Break Tackle","Trucking","Stiff Arm","Catching","Catch in Traffic",...SHARED_OL_BLOCKS),
  WR:    _A(...SHARED_ATHLETE, "Carrying","Catching","Catch in Traffic","Spectacular Catch","Short Route Running","Medium Route Running","Deep Route Running","Release","Kick/Punt Return"),
  TE:    _A(...SHARED_ATHLETE, "Carrying","Catching","Catch in Traffic","Spectacular Catch","Short Route Running","Medium Route Running","Deep Route Running","Release",...SHARED_OL_BLOCKS),
  LT:    _A(...SHARED_ATHLETE, ...SHARED_OL_BLOCKS),
  LG:    _A(...SHARED_ATHLETE, ...SHARED_OL_BLOCKS),
  C:     _A(...SHARED_ATHLETE, ...SHARED_OL_BLOCKS),
  RG:    _A(...SHARED_ATHLETE, ...SHARED_OL_BLOCKS),
  RT:    _A(...SHARED_ATHLETE, ...SHARED_OL_BLOCKS),
  LEDGE: _A(...SHARED_ATHLETE, ...SHARED_DLINE),
  REDGE: _A(...SHARED_ATHLETE, ...SHARED_DLINE),
  DT:    _A(...SHARED_ATHLETE, ...SHARED_DLINE),
  WILL:  _A(...SHARED_ATHLETE, ...SHARED_DLINE, "Play Recognition","Man Coverage","Zone Coverage"),
  MIKE:  _A(...SHARED_ATHLETE, ...SHARED_DLINE, "Play Recognition","Man Coverage","Zone Coverage"),
  SAM:   _A(...SHARED_ATHLETE, ...SHARED_DLINE, "Play Recognition","Man Coverage","Zone Coverage"),
  CB:    _A(...SHARED_ATHLETE, "Catching",...SHARED_COVERAGE,"Kick/Punt Return"),
  FS:    _A(...SHARED_ATHLETE, "Catching",...SHARED_COVERAGE),
  SS:    _A(...SHARED_ATHLETE, "Catching",...SHARED_COVERAGE),
  K:     _A("Kicking Power","Kicking Accuracy","Stamina","Toughness","Injury"),
  P:     _A("Kicking Power","Kicking Accuracy","Stamina","Toughness","Injury"),
  LS:    _A("Strength","Awareness","Long Snap","Stamina","Toughness","Injury"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Weekly tick orchestrator — iterates every active trainer in a season and
// applies one roll. Idempotent on (trainerId, weekIndex) via trainer_roll_log.
// ─────────────────────────────────────────────────────────────────────────────

export async function expireAllActiveTrainersForSeason(
  guildId: string,
  seasonId: number,
): Promise<number> {
  const res = await db.update(positionalTrainersTable)
    .set({ status: "expired", expiredAt: new Date() })
    .where(and(
      eq(positionalTrainersTable.guildId,  guildId),
      eq(positionalTrainersTable.seasonId, seasonId),
      eq(positionalTrainersTable.status,   "active"),
    ))
    .returning({ id: positionalTrainersTable.id });
  return res.length;
}

export interface WeeklyTickSummary {
  ticked:  number;
  hits:    number;
  misses:  number;
  expired: number;
  skipped: number;
}

export async function runWeeklyTrainerTick(args: {
  client:           Client;
  guildId:          string;
  seasonId:         number;
  rosterSeasonId:   number;
  currentWeekIndex: number;
}): Promise<WeeklyTickSummary> {
  const summary: WeeklyTickSummary = { ticked: 0, hits: 0, misses: 0, expired: 0, skipped: 0 };

  const active = await db.select().from(positionalTrainersTable)
    .where(and(
      eq(positionalTrainersTable.guildId,  args.guildId),
      eq(positionalTrainersTable.seasonId, args.seasonId),
      eq(positionalTrainersTable.status,   "active"),
    ));

  for (const t of active) {
    // Idempotency CLAIM: atomically reserve this (trainer, week) before doing
    // anything mutating. Insert a placeholder log row; if a concurrent ticker
    // already claimed it, the unique index returns nothing and we skip.
    let claimed: { id: number }[] = [];
    try {
      claimed = await db.insert(trainerRollLogTable).values({
        trainerId:        t.id,
        weekIndex:        args.currentWeekIndex,
        hit:              false,
        chanceAppliedBps: 0,
        reason:           "pending",
        boosts:           [],
      }).onConflictDoNothing().returning({ id: trainerRollLogTable.id });
    } catch (err) {
      console.error("[positional-trainer] tick claim insert failed", { trainerId: t.id, err });
      continue;
    }
    if (claimed.length === 0) { summary.skipped++; continue; }
    const claimedLogId = claimed[0]!.id;

    // Per-trainer isolation: never let one bad trainer skip the rest.
    try {
    // Find the player's roster row in the current roster season.
    let rosterRow: { id: number; attributes: Record<string, number> | null } | null = null;
    if (t.playerId) {
      const rows = await db.select({
        id:         franchiseRostersTable.id,
        attributes: franchiseRostersTable.attributes,
      }).from(franchiseRostersTable)
        .where(and(
          eq(franchiseRostersTable.seasonId, args.rosterSeasonId),
          eq(franchiseRostersTable.playerId, parseInt(t.playerId, 10)),
        ))
        .limit(1);
      rosterRow = (rows[0] as any) ?? null;
    }
    if (!rosterRow) {
      const fullName = t.playerName.split(" ");
      const first = fullName[0] ?? "";
      const last  = fullName.slice(1).join(" ");
      const rows = await db.select({
        id:         franchiseRostersTable.id,
        attributes: franchiseRostersTable.attributes,
      }).from(franchiseRostersTable)
        .where(and(
          eq(franchiseRostersTable.seasonId,  args.rosterSeasonId),
          eq(franchiseRostersTable.firstName, first),
          eq(franchiseRostersTable.lastName,  last),
          eq(franchiseRostersTable.position,  t.playerPos),
        ))
        .limit(1);
      rosterRow = (rows[0] as any) ?? null;
    }

    const attrs: Record<string, number> = (rosterRow?.attributes as any) ?? {};

    // Load (or seed) caps row.
    let [capsRow] = await db.select().from(trainerPlayerSeasonCapsTable)
      .where(and(
        eq(trainerPlayerSeasonCapsTable.guildId,    args.guildId),
        eq(trainerPlayerSeasonCapsTable.seasonId,   args.seasonId),
        eq(trainerPlayerSeasonCapsTable.playerName, t.playerName),
      ))
      .limit(1);
    if (!capsRow) {
      const [inserted] = await db.insert(trainerPlayerSeasonCapsTable).values({
        guildId:    args.guildId,
        seasonId:   args.seasonId,
        playerName: t.playerName,
      }).returning();
      capsRow = inserted!;
    }

    const tick = rollOneTick({
      tier:             t.tier as TrainerTier,
      focus:            t.focus as TrainerFocus,
      playerPos:        t.playerPos,
      playerAttrs:      attrs,
      caps:             capsRow as TrainerCapsRow,
      lastHitWeekIndex: t.lastHitWeekIndex,
      currentWeekIndex: args.currentWeekIndex,
      pickAttrs:        defaultPickAttrs,
    });

    summary.ticked++;
    if (tick.hit) summary.hits++; else summary.misses++;

    // Queue successful boosts for commissioner review instead of mutating the
    // roster JSON directly. Pending Purchases is the operational source for
    // commissioners applying in-game upgrades.
    let pendingPurchaseId: number | null = null;
    if (tick.hit && tick.boosts.length > 0) {
      for (const b of tick.boosts) {
        const field = applyCapDelta(b.attr, b.points, capsRow as TrainerCapsRow);
        if (field) (capsRow as any)[field] = (capsRow as any)[field] + b.points;
      }

      await db.update(trainerPlayerSeasonCapsTable)
        .set({
          speedGain:    (capsRow as any).speedGain,
          strengthGain: (capsRow as any).strengthGain,
          codGain:      (capsRow as any).codGain,
          accelGain:    (capsRow as any).accelGain,
          agilityGain:  (capsRow as any).agilityGain,
        })
        .where(eq(trainerPlayerSeasonCapsTable.id, capsRow.id));

      const attrSummary = tick.boosts.map((b) => `${b.attr} +${b.points}`).join(", ");
      const beforeAfter = tick.boosts.map((b) =>
        b.before !== null && b.after !== null
          ? `${b.attr}: ${b.before} → ${b.after} (+${b.points})`
          : `${b.attr} +${b.points}`,
      ).join("; ");

      const parsedPlayerId = t.playerId ? parseInt(t.playerId, 10) : NaN;
      const [purchase] = await db.insert(purchasesTable).values({
        discordId:      t.ownerDiscordId,
        seasonId:       args.seasonId,
        purchaseType:   "attribute",
        playerName:     t.playerName,
        playerPosition: t.playerPos,
        attributeName:  attrSummary,
        cost:           0,
        status:         "pending",
        notes:          `Positional Trainer weekly roll — Week ${args.currentWeekIndex + 1} — ${TRAINER_TIERS[t.tier as TrainerTier].label} ${t.focus} focus — ${beforeAfter}`,
        eaFranchiseId:  Number.isNaN(parsedPlayerId) ? null : parsedPlayerId,
      }).returning({ id: purchasesTable.id });
      pendingPurchaseId = purchase?.id ?? null;
    }

    // Finalize the previously-claimed log row with the actual roll result.
    await db.update(trainerRollLogTable)
      .set({
        hit:              tick.hit,
        chanceAppliedBps: tick.chanceAppliedBps,
        reason:           tick.reason,
        boosts:           tick.boosts,
      })
      .where(eq(trainerRollLogTable.id, claimedLogId));

    const nextRemaining = Math.max(0, t.weeksRemaining - 1);
    const willExpire    = nextRemaining <= 0;
    await db.update(positionalTrainersTable)
      .set({
        weeksRemaining:   nextRemaining,
        lastHitWeekIndex: tick.hit ? args.currentWeekIndex : t.lastHitWeekIndex,
        ...(willExpire ? { status: "expired", expiredAt: new Date() } : {}),
      })
      .where(eq(positionalTrainersTable.id, t.id));
    if (willExpire) summary.expired++;

    // DM owner with the tick result.
    try {
      const user = await args.client.users.fetch(t.ownerDiscordId);
      const wkLabel = `Week ${args.currentWeekIndex + 1}`;
      const tail    = willExpire
        ? `\n\n⏹ Trainer contract complete — **${t.weeksTotal} weeks** delivered.`
        : `\n\nWeeks remaining: **${nextRemaining}/${t.weeksTotal}**`;
      const body = tick.hit
        ? `🏋️ **Trainer Tick — ${t.playerName} (${t.playerPos})** — ${wkLabel}
${tick.reason}

📋 Queued in **Commissioner's Office → Pending Purchases**${pendingPurchaseId ? ` as #${pendingPurchaseId}` : ""} for approval/application.${tail}`
        : `🏋️ **Trainer Tick — ${t.playerName} (${t.playerPos})** — ${wkLabel}
${tick.reason}${tail}`;
      await user.send(body).catch(() => {});
    } catch { /* ignore DM failures */ }
    } catch (perTrainerErr) {
      console.error("[positional-trainer] per-trainer tick error", { trainerId: t.id, err: perTrainerErr });
    }
  }

  return summary;
}

/** Default lottery — weighted draw from the player's own non-99 attributes.
 *  Focus matches: speed/power = 1.5x weight; position = 2x weight. */
export function defaultPickAttrs(
  count:       number,
  focus:       TrainerFocus,
  pos:         string,
  attrs:       Record<string, number>,
): string[] {
  const posKey = pos.toUpperCase();
  const boostSet = focus === "speed"    ? TRAINER_SPEED_BOOST_SET
                 : focus === "power"    ? TRAINER_POWER_BOOST_SET
                 : focus === "position" ? (TRAINER_POS_FOCUS_SETS[posKey] ?? null)
                 : null;
  const boostMult = focus === "position" ? 2.0 : 1.5;
  const posFilter = TRAINER_POS_ATTRS[posKey];
  const allAttrs  = [...ATTRIBUTES] as string[];

  const pool = allAttrs.filter((attr) =>
    (!posFilter || posFilter.has(attr)) &&
    (attrs[attr] ?? 0) < 99,
  );
  if (pool.length === 0) return [];

  const remaining = pool.slice();
  const weights   = remaining.map(a => (boostSet && boostSet.has(a) ? boostMult : 1.0));
  const out: string[] = [];
  const n = Math.min(count, remaining.length);
  for (let i = 0; i < n; i++) {
    const total = weights.reduce((s, w) => s + w, 0);
    let rng = Math.random() * total;
    let sel = remaining.length - 1;
    for (let j = 0; j < remaining.length; j++) {
      rng -= weights[j]!;
      if (rng <= 0) { sel = j; break; }
    }
    out.push(remaining[sel]!);
    remaining.splice(sel, 1);
    weights.splice(sel, 1);
  }
  return out;
}
