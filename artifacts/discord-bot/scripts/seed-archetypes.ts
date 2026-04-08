/**
 * One-time seed script — inserts all custom player archetypes into the DB.
 * Run with: pnpm exec tsx scripts/seed-archetypes.ts
 * Safe to re-run: skips archetypes that already exist (matched by name + position).
 */
import { db } from "@workspace/db";
import { customArchetypesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

type Attrs = Record<string, number>;

interface ArchetypeEntry {
  position: string;
  name:     string;
  attrs:    Attrs;
}

// ── Attribute parsing helper ──────────────────────────────────────────────────
function a(
  Speed: number, Acceleration: number, Agility: number, Strength: number,
  Awareness: number, Carrying: number, BCVision: number, BreakTackle: number,
  Trucking: number, StiffArm: number, ChangeOfDirection: number, SpinMove: number,
  JukeMove: number, Catching: number, CatchInTraffic: number, SpectacularCatch: number,
  ShortRouteRunning: number, MediumRouteRunning: number, DeepRouteRunning: number,
  Release: number, Jumping: number, ThrowingPower: number, ShortAccuracy: number,
  MediumAccuracy: number, DeepAccuracy: number, ThrowOnTheRun: number,
  ThrowUnderPressure: number, BreakSack: number, PlayAction: number,
  PassBlocking: number, PassBlockPower: number, PassBlockFinesse: number,
  RunBlocking: number, RunBlockPower: number, RunBlockFinesse: number,
  LeadBlock: number, ImpactBlocking: number, PlayRecognition: number,
  Tackling: number, HitPower: number, BlockShedding: number, FinesseMoves: number,
  PowerMoves: number, Pursuit: number, ManCoverage: number, ZoneCoverage: number,
  Press: number, KickPuntReturn: number, KickingPower: number, KickingAccuracy: number,
  Stamina: number, Toughness: number, Injury: number, LongSnap: number,
): Attrs {
  return {
    "Speed": Speed, "Acceleration": Acceleration, "Agility": Agility,
    "Strength": Strength, "Awareness": Awareness, "Carrying": Carrying,
    "BC Vision": BCVision, "Break Tackle": BreakTackle, "Trucking": Trucking,
    "Stiff Arm": StiffArm, "Change of Direction": ChangeOfDirection,
    "Spin Move": SpinMove, "Juke Move": JukeMove, "Catching": Catching,
    "Catch in Traffic": CatchInTraffic, "Spectacular Catch": SpectacularCatch,
    "Short Route Running": ShortRouteRunning, "Medium Route Running": MediumRouteRunning,
    "Deep Route Running": DeepRouteRunning, "Release": Release, "Jumping": Jumping,
    "Throwing Power": ThrowingPower, "Short Accuracy": ShortAccuracy,
    "Medium Accuracy": MediumAccuracy, "Deep Accuracy": DeepAccuracy,
    "Throw on the Run": ThrowOnTheRun, "Throw Under Pressure": ThrowUnderPressure,
    "Break Sack": BreakSack, "Play Action": PlayAction,
    "Pass Blocking": PassBlocking, "Pass Block Power": PassBlockPower,
    "Pass Block Finesse": PassBlockFinesse, "Run Blocking": RunBlocking,
    "Run Block Power": RunBlockPower, "Run Block Finesse": RunBlockFinesse,
    "Lead Block": LeadBlock, "Impact Blocking": ImpactBlocking,
    "Play Recognition": PlayRecognition, "Tackling": Tackling, "Hit Power": HitPower,
    "Block Shedding": BlockShedding, "Finesse Moves": FinesseMoves,
    "Power Moves": PowerMoves, "Pursuit": Pursuit,
    "Man Coverage": ManCoverage, "Zone Coverage": ZoneCoverage, "Press": Press,
    "Kick/Punt Return": KickPuntReturn, "Kicking Power": KickingPower,
    "Kicking Accuracy": KickingAccuracy, "Stamina": Stamina, "Toughness": Toughness,
    "Injury": Injury, "Long Snap": LongSnap,
  };
}

// ── Archetype data ─────────────────────────────────────────────────────────────
// Arguments order matches the `a()` helper above (same as file attribute order)
const ARCHETYPES: ArchetypeEntry[] = [
  // ── QB ──────────────────────────────────────────────────────────────────────
  {
    position: "QB", name: "Field General QB",
    attrs: a(78,77,74,66,68,54,60,54,30,29,72,37,49,41,27,33,25,18,23,28,70,91,82,79,77,65,83,57,86,27,21,23,19,20,17,25,26,46,23,23,30,27,27,46,38,19,30,18,33,32,90,85,86,0),
  },
  {
    position: "QB", name: "Scrambling QB",
    attrs: a(93,93,89,69,65,50,87,74,52,68,85,73,78,40,21,18,19,19,23,28,87,92,75,71,78,77,74,74,79,23,32,32,30,33,33,31,26,26,42,40,37,38,38,28,20,18,19,33,28,21,90,89,88,0),
  },
  {
    position: "QB", name: "Balanced Improviser QB",
    attrs: a(86,88,89,69,65,50,87,74,52,68,80,73,78,40,21,18,19,19,23,28,87,91,83,73,75,84,80,74,79,23,32,32,30,33,33,31,26,26,42,40,37,38,38,28,20,18,19,33,28,21,90,89,88,0),
  },

  // ── RB ──────────────────────────────────────────────────────────────────────
  {
    position: "RB", name: "Power Back",
    attrs: a(86,90,78,82,74,90,77,84,85,82,78,70,76,65,49,49,57,52,40,47,86,54,33,29,22,30,33,31,26,48,38,36,39,32,29,36,37,46,42,41,42,31,29,49,40,47,44,82,21,21,94,87,93,0),
  },
  {
    position: "RB", name: "Elusive Back",
    attrs: a(92,92,78,71,74,82,77,82,68,72,88,82,87,65,49,49,57,52,40,47,86,54,33,29,22,30,33,31,26,48,38,36,39,32,29,36,37,46,42,41,42,31,29,49,40,47,44,82,21,21,93,87,93,0),
  },
  {
    position: "RB", name: "All-Around Back",
    attrs: a(89,91,78,72,74,85,77,82,77,77,83,76,82,72,65,63,71,62,64,60,86,54,33,29,22,30,33,31,26,54,44,42,45,38,35,42,43,46,42,41,42,31,29,49,40,47,44,82,21,21,96,87,93,0),
  },

  // ── FB ──────────────────────────────────────────────────────────────────────
  {
    position: "FB", name: "Blocking FB",
    attrs: a(81,84,78,78,70,88,77,71,85,82,71,60,54,58,49,49,57,52,40,47,81,54,33,29,22,30,33,31,26,71,75,70,78,78,76,80,86,46,42,41,42,31,29,49,40,47,44,82,21,21,90,87,93,0),
  },
  {
    position: "FB", name: "Utility FB",
    attrs: a(83,86,82,75,72,86,79,73,80,78,78,68,66,75,64,64,70,64,52,62,84,54,33,29,22,30,33,31,26,64,66,62,70,70,68,74,80,48,44,43,42,31,29,50,40,47,44,82,21,21,92,87,93,0),
  },

  // ── TE ──────────────────────────────────────────────────────────────────────
  {
    position: "TE", name: "Vertical Threat TE",
    attrs: a(85,87,82,72,68,65,60,68,64,66,80,62,68,82,78,80,75,73,70,76,84,45,25,20,18,20,22,28,25,60,58,56,62,60,58,64,68,60,40,42,45,38,42,50,35,38,36,30,20,20,85,84,88,0),
  },
  {
    position: "TE", name: "Possession TE",
    attrs: a(80,82,78,78,72,70,65,72,70,72,76,60,64,84,85,83,78,76,68,74,82,45,25,20,18,20,22,28,25,68,70,66,72,74,70,70,75,65,42,44,48,40,44,52,36,40,38,28,20,20,88,86,90,0),
  },
  {
    position: "TE", name: "Blocking TE",
    attrs: a(76,78,74,84,74,72,65,75,78,76,72,58,60,72,74,70,68,65,58,70,80,45,25,20,18,20,22,30,25,78,82,76,82,86,80,80,88,68,45,48,52,42,48,55,38,42,40,25,20,20,90,88,92,0),
  },

  // ── WR ──────────────────────────────────────────────────────────────────────
  {
    position: "WR", name: "Deep Threat WR",
    attrs: a(93,94,88,68,66,65,70,68,60,64,86,70,78,78,72,76,70,72,82,78,85,45,25,20,18,20,22,30,25,52,48,46,55,52,50,54,58,60,38,40,42,45,38,50,35,38,36,82,20,20,88,82,88,0),
  },
  {
    position: "WR", name: "Route Runner WR",
    attrs: a(88,90,90,66,70,68,74,70,58,62,90,78,82,82,78,80,82,80,76,82,82,45,25,20,18,20,22,30,25,50,46,44,54,50,48,52,56,64,38,40,42,46,38,50,35,38,36,78,20,20,90,84,90,0),
  },
  {
    position: "WR", name: "Physical WR",
    attrs: a(87,88,82,78,70,70,72,74,72,74,80,68,72,80,84,86,74,72,68,85,92,45,25,20,18,20,22,30,25,58,56,54,62,60,58,60,66,64,40,44,46,44,42,52,36,40,38,70,20,20,92,88,92,0),
  },

  // ── OL ──────────────────────────────────────────────────────────────────────
  {
    position: "OL", name: "Pass Protector OL",
    attrs: a(66,64,68,82,70,40,35,50,55,45,62,30,32,35,30,28,25,20,18,40,70,40,20,18,15,18,20,35,25,78,82,80,68,70,66,72,78,72,40,45,50,38,45,45,25,28,30,10,20,20,90,88,92,0),
  },
  {
    position: "OL", name: "Power Run Blocker OL",
    attrs: a(62,60,64,88,72,42,35,55,65,50,58,28,30,35,30,28,25,20,18,42,68,40,20,18,15,18,20,35,25,70,74,68,82,86,78,80,88,74,42,48,52,40,48,46,25,28,30,10,20,20,92,90,93,0),
  },
  {
    position: "OL", name: "Agile (Zone) OL",
    attrs: a(72,70,74,78,70,40,35,50,55,45,70,32,34,36,30,28,25,20,18,44,72,40,20,18,15,18,20,35,25,72,70,74,76,74,80,78,80,72,40,45,50,42,44,48,25,28,30,12,20,20,90,88,92,0),
  },

  // ── DL (DE archetypes) ───────────────────────────────────────────────────────
  {
    position: "DL", name: "Speed Rusher DE",
    attrs: a(86,88,82,76,70,55,45,65,60,58,80,78,70,45,40,38,25,20,18,50,82,40,20,18,15,18,20,40,25,30,28,26,32,30,28,30,55,70,78,80,75,82,68,78,40,45,42,15,20,20,88,86,90,0),
  },
  {
    position: "DL", name: "Power Rusher DE",
    attrs: a(80,82,76,86,72,55,45,68,70,65,74,65,60,45,40,38,25,20,18,50,78,40,20,18,15,18,20,40,25,30,28,26,32,30,28,30,60,72,82,88,80,65,84,78,38,42,40,12,20,20,90,90,92,0),
  },
  {
    position: "DL", name: "Run Stopper DE",
    attrs: a(78,80,74,88,74,55,45,70,72,68,72,60,55,45,40,38,25,20,18,50,76,40,20,18,15,18,20,40,25,30,28,26,32,30,28,30,62,75,85,88,85,60,80,80,35,40,38,10,20,20,90,92,93,0),
  },

  // ── DL (DT archetypes) ───────────────────────────────────────────────────────
  {
    position: "DL", name: "Speed Rusher DT",
    attrs: a(78,80,74,82,70,50,40,60,65,60,72,75,65,40,35,32,20,18,15,45,78,40,20,18,15,18,20,40,25,30,32,30,32,34,32,30,60,70,80,82,78,82,70,75,30,35,32,8,20,20,88,86,90,0),
  },
  {
    position: "DL", name: "Power Rusher DT",
    attrs: a(72,74,68,90,72,50,40,65,70,65,66,65,55,40,35,32,20,18,15,45,74,40,20,18,15,18,20,40,25,30,32,30,32,34,32,30,65,72,82,88,82,68,86,72,28,32,30,8,20,20,90,90,92,0),
  },
  {
    position: "DL", name: "Run Stopper DT",
    attrs: a(68,70,64,92,74,50,40,68,72,68,62,55,50,38,34,30,20,18,15,45,72,40,20,18,15,18,20,40,25,30,32,30,32,34,32,30,68,76,85,90,86,60,82,70,25,30,28,6,20,20,92,92,93,0),
  },

  // ── CB ──────────────────────────────────────────────────────────────────────
  {
    position: "CB", name: "Man Coverage CB",
    attrs: a(91,92,90,65,70,60,65,65,55,58,90,75,78,75,68,70,50,45,40,55,88,40,20,18,15,18,20,40,25,25,20,18,25,20,18,25,45,72,68,65,55,50,45,75,82,70,80,80,20,20,88,82,88,0),
  },
  {
    position: "CB", name: "Zone Coverage CB",
    attrs: a(89,90,88,64,74,60,65,62,52,55,88,72,75,76,70,72,50,45,40,55,86,40,20,18,15,18,20,40,25,25,20,18,25,20,18,25,42,78,70,64,55,50,45,78,72,82,72,78,20,20,90,84,90,0),
  },
  {
    position: "CB", name: "Slot CB",
    attrs: a(90,91,92,62,72,65,70,66,50,54,92,78,80,78,72,74,55,50,40,55,85,40,20,18,15,18,20,40,25,25,20,18,25,20,18,25,40,74,72,62,55,50,45,80,80,78,68,82,20,20,92,84,90,0),
  },

  // ── FS ──────────────────────────────────────────────────────────────────────
  {
    position: "FS", name: "Zone Free Safety",
    attrs: a(90,91,88,70,74,65,70,68,60,60,88,72,74,78,72,75,55,50,45,55,88,40,20,18,15,18,20,40,25,30,25,22,30,25,22,28,60,78,75,78,60,50,55,82,72,82,65,70,20,20,90,86,90,0),
  },
  {
    position: "FS", name: "Hybrid Free Safety",
    attrs: a(89,90,86,74,74,65,68,70,65,62,86,70,72,76,70,72,55,50,45,55,86,40,20,18,15,18,20,40,25,30,25,22,30,25,22,28,68,76,80,84,65,52,60,82,76,78,72,68,20,20,92,88,92,0),
  },
  {
    position: "FS", name: "Ball Hawk Free Safety",
    attrs: a(91,92,90,68,76,70,72,68,58,58,90,75,78,82,76,82,60,55,50,58,92,40,20,18,15,18,20,40,25,30,25,22,30,25,22,28,58,78,72,74,58,50,52,80,75,84,68,75,20,20,90,84,90,0),
  },

  // ── SS ──────────────────────────────────────────────────────────────────────
  {
    position: "SS", name: "Run Support Strong Safety",
    attrs: a(88,89,84,80,74,65,68,72,70,66,84,68,70,74,68,70,50,45,40,55,86,40,20,18,15,18,20,40,25,30,25,22,30,25,22,28,72,76,84,88,72,55,65,82,70,72,72,65,20,20,92,90,92,0),
  },
  {
    position: "SS", name: "Hybrid Strong Safety",
    attrs: a(89,90,86,76,74,65,68,70,68,65,86,70,72,76,70,72,50,45,40,55,86,40,20,18,15,18,20,40,25,30,25,22,30,25,22,28,68,76,80,84,68,55,62,82,74,74,70,68,20,20,92,88,92,0),
  },
  {
    position: "SS", name: "Coverage Strong Safety",
    attrs: a(90,91,88,72,76,65,70,68,62,60,88,72,74,78,72,75,55,50,45,55,88,40,20,18,15,18,20,40,25,30,25,22,30,25,22,28,62,78,76,78,62,50,55,82,78,80,72,70,20,20,90,86,90,0),
  },

  // ── LB ──────────────────────────────────────────────────────────────────────
  {
    position: "LB", name: "Field General LB",
    attrs: a(80,82,78,78,76,60,55,65,60,55,76,50,55,70,62,60,45,40,35,40,80,40,20,18,15,18,20,35,25,35,30,28,32,30,28,30,42,80,84,82,78,60,70,82,68,74,60,35,20,20,92,90,92,0),
  },
  {
    position: "LB", name: "Run Stopper LB",
    attrs: a(78,80,76,84,74,60,55,68,70,62,74,55,60,65,58,55,45,40,35,40,78,40,20,18,15,18,20,35,25,35,30,28,32,30,28,30,45,76,86,88,84,58,78,84,60,65,58,30,20,20,92,92,93,0),
  },
  {
    position: "LB", name: "Coverage LB",
    attrs: a(84,86,82,76,74,62,60,66,62,58,82,65,70,74,68,70,50,45,40,45,82,40,20,18,15,18,20,35,25,35,30,28,32,30,28,30,40,76,80,78,74,62,68,82,72,78,62,40,20,20,92,88,92,0),
  },

  // ── K ───────────────────────────────────────────────────────────────────────
  {
    position: "K", name: "Power Kicker",
    attrs: a(68,70,66,72,70,40,35,45,40,38,64,30,32,45,40,42,25,20,18,35,72,40,20,18,15,18,20,35,25,30,28,26,30,28,26,30,35,68,50,52,45,30,30,55,35,40,35,20,92,78,85,82,90,0),
  },
  {
    position: "K", name: "Accurate Kicker",
    attrs: a(66,68,64,70,72,40,35,45,38,36,62,28,30,45,40,42,25,20,18,35,70,40,20,18,15,18,20,35,25,30,28,26,30,28,26,30,35,70,48,50,45,30,30,52,35,40,35,20,82,90,85,82,90,0),
  },

  // ── P ───────────────────────────────────────────────────────────────────────
  {
    position: "P", name: "Power Punter",
    attrs: a(70,72,68,74,70,42,36,48,42,40,66,32,34,48,42,44,25,20,18,35,74,40,20,18,15,18,20,35,25,30,28,26,30,28,26,30,38,68,52,54,46,30,30,58,35,40,35,22,94,78,86,84,90,0),
  },
  {
    position: "P", name: "Accurate Punter",
    attrs: a(68,70,66,72,72,42,36,48,40,38,64,30,32,48,42,44,25,20,18,35,72,40,20,18,15,18,20,35,25,30,28,26,30,28,26,30,38,70,50,52,46,30,30,56,35,40,35,22,86,90,86,84,90,0),
  },
];

// ── Seed ─────────────────────────────────────────────────────────────────────
async function main() {
  let inserted = 0;
  let skipped  = 0;

  for (const arch of ARCHETYPES) {
    const existing = await db.select({ id: customArchetypesTable.id })
      .from(customArchetypesTable)
      .where(and(
        eq(customArchetypesTable.position, arch.position),
        eq(customArchetypesTable.name, arch.name),
      ))
      .limit(1);

    if (existing.length > 0) {
      console.log(`⏭  Skipped  [${arch.position}] ${arch.name}`);
      skipped++;
      continue;
    }

    await db.insert(customArchetypesTable).values({
      position:   arch.position,
      name:       arch.name,
      attributes: arch.attrs,
      isActive:   true,
    });

    console.log(`✅ Inserted [${arch.position}] ${arch.name}`);
    inserted++;
  }

  console.log(`\nDone — ${inserted} inserted, ${skipped} skipped`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
