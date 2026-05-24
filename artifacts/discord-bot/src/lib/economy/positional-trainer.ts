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
// Boosts apply automatically — the bot does not ask the commissioner to approve
// them (the hire was already paid for). All rolls are logged with a human-readable
// reason so owners can see why a tick missed (base miss / cooldown / capped out).

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
