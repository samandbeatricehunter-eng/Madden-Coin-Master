import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { customArchetypesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { ALL_POSITIONS, formatArchetypeEmbed } from "../lib/custom-player-helpers.js";

// ── Default archetypes seeded per position ────────────────────────────────────
// All 39 archetypes with exact Madden attribute ratings.
// Run /admin-customarchetypes seed-defaults once to load these into the DB.
const ARCHETYPE_DEFAULTS: Array<{ position: string; name: string; attributes: Record<string, number> }> = [
  // ── QB ──────────────────────────────────────────────────────────────────────
  { position: "QB", name: "Field General",
    attributes: { Speed: 78, Acceleration: 77, Agility: 74, Strength: 66, Awareness: 68, Carrying: 54, BCVision: 60, BreakTackle: 54, Trucking: 30, StiffArm: 29, ChangeOfDirection: 72, SpinMove: 37, JukeMove: 49, Catching: 41, CatchInTraffic: 27, SpectacularCatch: 33, ShortRouteRunning: 25, MedRouteRunning: 18, DeepRouteRunning: 23, Release: 28, Jumping: 70, ThrowingPower: 91, ShortAccuracy: 82, MedAccuracy: 79, DeepAccuracy: 77, ThrowOnRun: 65, ThrowUnderPressure: 83, BreakSack: 57, PlayAction: 86, PassBlocking: 27, PassBlockPower: 21, PassBlockFinesse: 23, RunBlocking: 19, RunBlockPower: 20, RunBlockFinesse: 17, LeadBlock: 25, ImpactBlocking: 26, PlayRecognition: 46, Tackling: 23, HitPower: 23, BlockShedding: 30, FinesseMoves: 27, PowerMoves: 27, Pursuit: 46, ManCoverage: 38, ZoneCoverage: 19, Press: 30, KickReturn: 18, KickingPower: 33, KickingAccuracy: 32, Stamina: 90, Toughness: 85, Injury: 86, LongSnap: 0 } },
  { position: "QB", name: "Scrambling",
    attributes: { Speed: 93, Acceleration: 93, Agility: 89, Strength: 69, Awareness: 65, Carrying: 50, BCVision: 87, BreakTackle: 74, Trucking: 52, StiffArm: 68, ChangeOfDirection: 85, SpinMove: 73, JukeMove: 78, Catching: 40, CatchInTraffic: 21, SpectacularCatch: 18, ShortRouteRunning: 19, MedRouteRunning: 19, DeepRouteRunning: 23, Release: 28, Jumping: 87, ThrowingPower: 92, ShortAccuracy: 75, MedAccuracy: 71, DeepAccuracy: 78, ThrowOnRun: 77, ThrowUnderPressure: 74, BreakSack: 74, PlayAction: 79, PassBlocking: 23, PassBlockPower: 32, PassBlockFinesse: 32, RunBlocking: 30, RunBlockPower: 33, RunBlockFinesse: 33, LeadBlock: 31, ImpactBlocking: 26, PlayRecognition: 26, Tackling: 42, HitPower: 40, BlockShedding: 37, FinesseMoves: 38, PowerMoves: 38, Pursuit: 28, ManCoverage: 20, ZoneCoverage: 18, Press: 19, KickReturn: 33, KickingPower: 28, KickingAccuracy: 21, Stamina: 90, Toughness: 89, Injury: 88, LongSnap: 0 } },
  { position: "QB", name: "Balanced Improviser",
    attributes: { Speed: 86, Acceleration: 88, Agility: 89, Strength: 69, Awareness: 65, Carrying: 50, BCVision: 87, BreakTackle: 74, Trucking: 52, StiffArm: 68, ChangeOfDirection: 80, SpinMove: 73, JukeMove: 78, Catching: 40, CatchInTraffic: 21, SpectacularCatch: 18, ShortRouteRunning: 19, MedRouteRunning: 19, DeepRouteRunning: 23, Release: 28, Jumping: 87, ThrowingPower: 91, ShortAccuracy: 83, MedAccuracy: 73, DeepAccuracy: 75, ThrowOnRun: 84, ThrowUnderPressure: 80, BreakSack: 74, PlayAction: 79, PassBlocking: 23, PassBlockPower: 32, PassBlockFinesse: 32, RunBlocking: 30, RunBlockPower: 33, RunBlockFinesse: 33, LeadBlock: 31, ImpactBlocking: 26, PlayRecognition: 26, Tackling: 42, HitPower: 40, BlockShedding: 37, FinesseMoves: 38, PowerMoves: 38, Pursuit: 28, ManCoverage: 20, ZoneCoverage: 18, Press: 19, KickReturn: 33, KickingPower: 28, KickingAccuracy: 21, Stamina: 90, Toughness: 89, Injury: 88, LongSnap: 0 } },

  // ── HB ──────────────────────────────────────────────────────────────────────
  { position: "RB", name: "Power Back",
    attributes: { Speed: 86, Acceleration: 90, Agility: 78, Strength: 82, Awareness: 74, Carrying: 90, BCVision: 77, BreakTackle: 84, Trucking: 85, StiffArm: 82, ChangeOfDirection: 78, SpinMove: 70, JukeMove: 76, Catching: 65, CatchInTraffic: 49, SpectacularCatch: 49, ShortRouteRunning: 57, MedRouteRunning: 52, DeepRouteRunning: 40, Release: 47, Jumping: 86, ThrowingPower: 54, ShortAccuracy: 33, MedAccuracy: 29, DeepAccuracy: 22, ThrowOnRun: 30, ThrowUnderPressure: 33, BreakSack: 31, PlayAction: 26, PassBlocking: 48, PassBlockPower: 38, PassBlockFinesse: 36, RunBlocking: 39, RunBlockPower: 32, RunBlockFinesse: 29, LeadBlock: 36, ImpactBlocking: 37, PlayRecognition: 46, Tackling: 42, HitPower: 41, BlockShedding: 42, FinesseMoves: 31, PowerMoves: 29, Pursuit: 49, ManCoverage: 40, ZoneCoverage: 47, Press: 44, KickReturn: 82, KickingPower: 21, KickingAccuracy: 21, Stamina: 94, Toughness: 87, Injury: 93, LongSnap: 0 } },
  { position: "RB", name: "Elusive Back",
    attributes: { Speed: 92, Acceleration: 92, Agility: 78, Strength: 71, Awareness: 74, Carrying: 82, BCVision: 77, BreakTackle: 82, Trucking: 68, StiffArm: 72, ChangeOfDirection: 88, SpinMove: 82, JukeMove: 87, Catching: 65, CatchInTraffic: 49, SpectacularCatch: 49, ShortRouteRunning: 57, MedRouteRunning: 52, DeepRouteRunning: 40, Release: 47, Jumping: 86, ThrowingPower: 54, ShortAccuracy: 33, MedAccuracy: 29, DeepAccuracy: 22, ThrowOnRun: 30, ThrowUnderPressure: 33, BreakSack: 31, PlayAction: 26, PassBlocking: 48, PassBlockPower: 38, PassBlockFinesse: 36, RunBlocking: 39, RunBlockPower: 32, RunBlockFinesse: 29, LeadBlock: 36, ImpactBlocking: 37, PlayRecognition: 46, Tackling: 42, HitPower: 41, BlockShedding: 42, FinesseMoves: 31, PowerMoves: 29, Pursuit: 49, ManCoverage: 40, ZoneCoverage: 47, Press: 44, KickReturn: 82, KickingPower: 21, KickingAccuracy: 21, Stamina: 93, Toughness: 87, Injury: 93, LongSnap: 0 } },
  { position: "RB", name: "All-Around Back",
    attributes: { Speed: 89, Acceleration: 91, Agility: 78, Strength: 72, Awareness: 74, Carrying: 85, BCVision: 77, BreakTackle: 82, Trucking: 77, StiffArm: 77, ChangeOfDirection: 83, SpinMove: 76, JukeMove: 82, Catching: 72, CatchInTraffic: 65, SpectacularCatch: 63, ShortRouteRunning: 71, MedRouteRunning: 62, DeepRouteRunning: 64, Release: 60, Jumping: 86, ThrowingPower: 54, ShortAccuracy: 33, MedAccuracy: 29, DeepAccuracy: 22, ThrowOnRun: 30, ThrowUnderPressure: 33, BreakSack: 31, PlayAction: 26, PassBlocking: 54, PassBlockPower: 44, PassBlockFinesse: 42, RunBlocking: 45, RunBlockPower: 38, RunBlockFinesse: 35, LeadBlock: 42, ImpactBlocking: 43, PlayRecognition: 46, Tackling: 42, HitPower: 41, BlockShedding: 42, FinesseMoves: 31, PowerMoves: 29, Pursuit: 49, ManCoverage: 40, ZoneCoverage: 47, Press: 44, KickReturn: 82, KickingPower: 21, KickingAccuracy: 21, Stamina: 96, Toughness: 87, Injury: 93, LongSnap: 0 } },

  // ── FB ──────────────────────────────────────────────────────────────────────
  { position: "FB", name: "Blocking",
    attributes: { Speed: 81, Acceleration: 84, Agility: 78, Strength: 78, Awareness: 70, Carrying: 88, BCVision: 77, BreakTackle: 71, Trucking: 85, StiffArm: 82, ChangeOfDirection: 71, SpinMove: 60, JukeMove: 54, Catching: 58, CatchInTraffic: 49, SpectacularCatch: 49, ShortRouteRunning: 57, MedRouteRunning: 52, DeepRouteRunning: 40, Release: 47, Jumping: 81, ThrowingPower: 54, ShortAccuracy: 33, MedAccuracy: 29, DeepAccuracy: 22, ThrowOnRun: 30, ThrowUnderPressure: 33, BreakSack: 31, PlayAction: 26, PassBlocking: 71, PassBlockPower: 75, PassBlockFinesse: 70, RunBlocking: 78, RunBlockPower: 78, RunBlockFinesse: 76, LeadBlock: 80, ImpactBlocking: 86, PlayRecognition: 46, Tackling: 42, HitPower: 41, BlockShedding: 42, FinesseMoves: 31, PowerMoves: 29, Pursuit: 49, ManCoverage: 40, ZoneCoverage: 47, Press: 44, KickReturn: 82, KickingPower: 21, KickingAccuracy: 21, Stamina: 90, Toughness: 87, Injury: 93, LongSnap: 0 } },
  { position: "FB", name: "Utility",
    attributes: { Speed: 83, Acceleration: 86, Agility: 82, Strength: 75, Awareness: 72, Carrying: 86, BCVision: 79, BreakTackle: 73, Trucking: 80, StiffArm: 78, ChangeOfDirection: 78, SpinMove: 68, JukeMove: 66, Catching: 75, CatchInTraffic: 64, SpectacularCatch: 64, ShortRouteRunning: 70, MedRouteRunning: 64, DeepRouteRunning: 52, Release: 62, Jumping: 84, ThrowingPower: 54, ShortAccuracy: 33, MedAccuracy: 29, DeepAccuracy: 22, ThrowOnRun: 30, ThrowUnderPressure: 33, BreakSack: 31, PlayAction: 26, PassBlocking: 64, PassBlockPower: 66, PassBlockFinesse: 62, RunBlocking: 70, RunBlockPower: 70, RunBlockFinesse: 68, LeadBlock: 74, ImpactBlocking: 80, PlayRecognition: 48, Tackling: 44, HitPower: 43, BlockShedding: 42, FinesseMoves: 31, PowerMoves: 29, Pursuit: 50, ManCoverage: 40, ZoneCoverage: 47, Press: 44, KickReturn: 82, KickingPower: 21, KickingAccuracy: 21, Stamina: 92, Toughness: 87, Injury: 93, LongSnap: 0 } },

  // ── WR ──────────────────────────────────────────────────────────────────────
  { position: "WR", name: "Deep Threat",
    attributes: { Speed: 93, Acceleration: 94, Agility: 88, Strength: 68, Awareness: 66, Carrying: 65, BCVision: 70, BreakTackle: 68, Trucking: 60, StiffArm: 64, ChangeOfDirection: 86, SpinMove: 70, JukeMove: 78, Catching: 78, CatchInTraffic: 72, SpectacularCatch: 76, ShortRouteRunning: 70, MedRouteRunning: 72, DeepRouteRunning: 82, Release: 78, Jumping: 85, ThrowingPower: 45, ShortAccuracy: 25, MedAccuracy: 20, DeepAccuracy: 18, ThrowOnRun: 20, ThrowUnderPressure: 22, BreakSack: 30, PlayAction: 25, PassBlocking: 52, PassBlockPower: 48, PassBlockFinesse: 46, RunBlocking: 55, RunBlockPower: 52, RunBlockFinesse: 50, LeadBlock: 54, ImpactBlocking: 58, PlayRecognition: 60, Tackling: 38, HitPower: 40, BlockShedding: 42, FinesseMoves: 45, PowerMoves: 38, Pursuit: 50, ManCoverage: 35, ZoneCoverage: 38, Press: 36, KickReturn: 82, KickingPower: 20, KickingAccuracy: 20, Stamina: 88, Toughness: 82, Injury: 88, LongSnap: 0 } },
  { position: "WR", name: "Route Runner",
    attributes: { Speed: 88, Acceleration: 90, Agility: 90, Strength: 66, Awareness: 70, Carrying: 68, BCVision: 74, BreakTackle: 70, Trucking: 58, StiffArm: 62, ChangeOfDirection: 90, SpinMove: 78, JukeMove: 82, Catching: 82, CatchInTraffic: 78, SpectacularCatch: 80, ShortRouteRunning: 82, MedRouteRunning: 80, DeepRouteRunning: 76, Release: 82, Jumping: 82, ThrowingPower: 45, ShortAccuracy: 25, MedAccuracy: 20, DeepAccuracy: 18, ThrowOnRun: 20, ThrowUnderPressure: 22, BreakSack: 30, PlayAction: 25, PassBlocking: 50, PassBlockPower: 46, PassBlockFinesse: 44, RunBlocking: 54, RunBlockPower: 50, RunBlockFinesse: 48, LeadBlock: 52, ImpactBlocking: 56, PlayRecognition: 64, Tackling: 38, HitPower: 40, BlockShedding: 42, FinesseMoves: 46, PowerMoves: 38, Pursuit: 50, ManCoverage: 35, ZoneCoverage: 38, Press: 36, KickReturn: 78, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 84, Injury: 90, LongSnap: 0 } },
  { position: "WR", name: "Physical",
    attributes: { Speed: 87, Acceleration: 88, Agility: 82, Strength: 78, Awareness: 70, Carrying: 70, BCVision: 72, BreakTackle: 74, Trucking: 72, StiffArm: 74, ChangeOfDirection: 80, SpinMove: 68, JukeMove: 72, Catching: 80, CatchInTraffic: 84, SpectacularCatch: 86, ShortRouteRunning: 74, MedRouteRunning: 72, DeepRouteRunning: 68, Release: 85, Jumping: 92, ThrowingPower: 45, ShortAccuracy: 25, MedAccuracy: 20, DeepAccuracy: 18, ThrowOnRun: 20, ThrowUnderPressure: 22, BreakSack: 30, PlayAction: 25, PassBlocking: 58, PassBlockPower: 56, PassBlockFinesse: 54, RunBlocking: 62, RunBlockPower: 60, RunBlockFinesse: 58, LeadBlock: 60, ImpactBlocking: 66, PlayRecognition: 64, Tackling: 40, HitPower: 44, BlockShedding: 46, FinesseMoves: 44, PowerMoves: 42, Pursuit: 52, ManCoverage: 36, ZoneCoverage: 40, Press: 38, KickReturn: 70, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 88, Injury: 92, LongSnap: 0 } },

  // ── TE ──────────────────────────────────────────────────────────────────────
  { position: "TE", name: "Vertical Threat",
    attributes: { Speed: 85, Acceleration: 87, Agility: 82, Strength: 72, Awareness: 68, Carrying: 65, BCVision: 60, BreakTackle: 68, Trucking: 64, StiffArm: 66, ChangeOfDirection: 80, SpinMove: 62, JukeMove: 68, Catching: 82, CatchInTraffic: 78, SpectacularCatch: 80, ShortRouteRunning: 75, MedRouteRunning: 73, DeepRouteRunning: 70, Release: 76, Jumping: 84, ThrowingPower: 45, ShortAccuracy: 25, MedAccuracy: 20, DeepAccuracy: 18, ThrowOnRun: 20, ThrowUnderPressure: 22, BreakSack: 28, PlayAction: 25, PassBlocking: 60, PassBlockPower: 58, PassBlockFinesse: 56, RunBlocking: 62, RunBlockPower: 60, RunBlockFinesse: 58, LeadBlock: 64, ImpactBlocking: 68, PlayRecognition: 60, Tackling: 40, HitPower: 42, BlockShedding: 45, FinesseMoves: 38, PowerMoves: 42, Pursuit: 50, ManCoverage: 35, ZoneCoverage: 38, Press: 36, KickReturn: 30, KickingPower: 20, KickingAccuracy: 20, Stamina: 85, Toughness: 84, Injury: 88, LongSnap: 0 } },
  { position: "TE", name: "Possession",
    attributes: { Speed: 80, Acceleration: 82, Agility: 78, Strength: 78, Awareness: 72, Carrying: 70, BCVision: 65, BreakTackle: 72, Trucking: 70, StiffArm: 72, ChangeOfDirection: 76, SpinMove: 60, JukeMove: 64, Catching: 84, CatchInTraffic: 85, SpectacularCatch: 83, ShortRouteRunning: 78, MedRouteRunning: 76, DeepRouteRunning: 68, Release: 74, Jumping: 82, ThrowingPower: 45, ShortAccuracy: 25, MedAccuracy: 20, DeepAccuracy: 18, ThrowOnRun: 20, ThrowUnderPressure: 22, BreakSack: 28, PlayAction: 25, PassBlocking: 68, PassBlockPower: 70, PassBlockFinesse: 66, RunBlocking: 72, RunBlockPower: 74, RunBlockFinesse: 70, LeadBlock: 70, ImpactBlocking: 75, PlayRecognition: 65, Tackling: 42, HitPower: 44, BlockShedding: 48, FinesseMoves: 40, PowerMoves: 44, Pursuit: 52, ManCoverage: 36, ZoneCoverage: 40, Press: 38, KickReturn: 28, KickingPower: 20, KickingAccuracy: 20, Stamina: 88, Toughness: 86, Injury: 90, LongSnap: 0 } },
  { position: "TE", name: "Blocking",
    attributes: { Speed: 76, Acceleration: 78, Agility: 74, Strength: 84, Awareness: 74, Carrying: 72, BCVision: 65, BreakTackle: 75, Trucking: 78, StiffArm: 76, ChangeOfDirection: 72, SpinMove: 58, JukeMove: 60, Catching: 72, CatchInTraffic: 74, SpectacularCatch: 70, ShortRouteRunning: 68, MedRouteRunning: 65, DeepRouteRunning: 58, Release: 70, Jumping: 80, ThrowingPower: 45, ShortAccuracy: 25, MedAccuracy: 20, DeepAccuracy: 18, ThrowOnRun: 20, ThrowUnderPressure: 22, BreakSack: 30, PlayAction: 25, PassBlocking: 78, PassBlockPower: 82, PassBlockFinesse: 76, RunBlocking: 82, RunBlockPower: 86, RunBlockFinesse: 80, LeadBlock: 80, ImpactBlocking: 88, PlayRecognition: 68, Tackling: 45, HitPower: 48, BlockShedding: 52, FinesseMoves: 42, PowerMoves: 48, Pursuit: 55, ManCoverage: 38, ZoneCoverage: 42, Press: 40, KickReturn: 25, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 88, Injury: 92, LongSnap: 0 } },

  // ── OL ──────────────────────────────────────────────────────────────────────
  { position: "OL", name: "Pass Protector",
    attributes: { Speed: 66, Acceleration: 64, Agility: 68, Strength: 82, Awareness: 70, Carrying: 40, BCVision: 35, BreakTackle: 50, Trucking: 55, StiffArm: 45, ChangeOfDirection: 62, SpinMove: 30, JukeMove: 32, Catching: 35, CatchInTraffic: 30, SpectacularCatch: 28, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 40, Jumping: 70, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 78, PassBlockPower: 82, PassBlockFinesse: 80, RunBlocking: 68, RunBlockPower: 70, RunBlockFinesse: 66, LeadBlock: 72, ImpactBlocking: 78, PlayRecognition: 72, Tackling: 40, HitPower: 45, BlockShedding: 50, FinesseMoves: 38, PowerMoves: 45, Pursuit: 45, ManCoverage: 25, ZoneCoverage: 28, Press: 30, KickReturn: 10, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 88, Injury: 92, LongSnap: 0 } },
  { position: "OL", name: "Power Run Blocker",
    attributes: { Speed: 62, Acceleration: 60, Agility: 64, Strength: 88, Awareness: 72, Carrying: 42, BCVision: 35, BreakTackle: 55, Trucking: 65, StiffArm: 50, ChangeOfDirection: 58, SpinMove: 28, JukeMove: 30, Catching: 35, CatchInTraffic: 30, SpectacularCatch: 28, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 42, Jumping: 68, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 70, PassBlockPower: 74, PassBlockFinesse: 68, RunBlocking: 82, RunBlockPower: 86, RunBlockFinesse: 78, LeadBlock: 80, ImpactBlocking: 88, PlayRecognition: 74, Tackling: 42, HitPower: 48, BlockShedding: 52, FinesseMoves: 40, PowerMoves: 48, Pursuit: 46, ManCoverage: 25, ZoneCoverage: 28, Press: 30, KickReturn: 10, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 90, Injury: 93, LongSnap: 0 } },
  { position: "OL", name: "Agile Zone",
    attributes: { Speed: 72, Acceleration: 70, Agility: 74, Strength: 78, Awareness: 70, Carrying: 40, BCVision: 35, BreakTackle: 50, Trucking: 55, StiffArm: 45, ChangeOfDirection: 70, SpinMove: 32, JukeMove: 34, Catching: 36, CatchInTraffic: 30, SpectacularCatch: 28, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 44, Jumping: 72, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 72, PassBlockPower: 70, PassBlockFinesse: 74, RunBlocking: 76, RunBlockPower: 74, RunBlockFinesse: 80, LeadBlock: 78, ImpactBlocking: 80, PlayRecognition: 72, Tackling: 40, HitPower: 45, BlockShedding: 50, FinesseMoves: 42, PowerMoves: 44, Pursuit: 48, ManCoverage: 25, ZoneCoverage: 28, Press: 30, KickReturn: 12, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 88, Injury: 92, LongSnap: 0 } },

  // ── DE ──────────────────────────────────────────────────────────────────────
  { position: "DL", name: "Speed Rusher End",
    attributes: { Speed: 86, Acceleration: 88, Agility: 82, Strength: 76, Awareness: 70, Carrying: 55, BCVision: 45, BreakTackle: 65, Trucking: 60, StiffArm: 58, ChangeOfDirection: 80, SpinMove: 78, JukeMove: 70, Catching: 45, CatchInTraffic: 40, SpectacularCatch: 38, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 50, Jumping: 82, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 28, PassBlockFinesse: 26, RunBlocking: 32, RunBlockPower: 30, RunBlockFinesse: 28, LeadBlock: 30, ImpactBlocking: 55, PlayRecognition: 70, Tackling: 78, HitPower: 80, BlockShedding: 75, FinesseMoves: 82, PowerMoves: 68, Pursuit: 78, ManCoverage: 40, ZoneCoverage: 45, Press: 42, KickReturn: 15, KickingPower: 20, KickingAccuracy: 20, Stamina: 88, Toughness: 86, Injury: 90, LongSnap: 0 } },
  { position: "DL", name: "Power Rusher End",
    attributes: { Speed: 80, Acceleration: 82, Agility: 76, Strength: 86, Awareness: 72, Carrying: 55, BCVision: 45, BreakTackle: 68, Trucking: 70, StiffArm: 65, ChangeOfDirection: 74, SpinMove: 65, JukeMove: 60, Catching: 45, CatchInTraffic: 40, SpectacularCatch: 38, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 50, Jumping: 78, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 28, PassBlockFinesse: 26, RunBlocking: 32, RunBlockPower: 30, RunBlockFinesse: 28, LeadBlock: 30, ImpactBlocking: 60, PlayRecognition: 72, Tackling: 82, HitPower: 88, BlockShedding: 80, FinesseMoves: 65, PowerMoves: 84, Pursuit: 78, ManCoverage: 38, ZoneCoverage: 42, Press: 40, KickReturn: 12, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 90, Injury: 92, LongSnap: 0 } },
  { position: "DL", name: "Run Stopper End",
    attributes: { Speed: 78, Acceleration: 80, Agility: 74, Strength: 88, Awareness: 74, Carrying: 55, BCVision: 45, BreakTackle: 70, Trucking: 72, StiffArm: 68, ChangeOfDirection: 72, SpinMove: 60, JukeMove: 55, Catching: 45, CatchInTraffic: 40, SpectacularCatch: 38, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 50, Jumping: 76, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 28, PassBlockFinesse: 26, RunBlocking: 32, RunBlockPower: 30, RunBlockFinesse: 28, LeadBlock: 30, ImpactBlocking: 62, PlayRecognition: 75, Tackling: 85, HitPower: 88, BlockShedding: 85, FinesseMoves: 60, PowerMoves: 80, Pursuit: 80, ManCoverage: 35, ZoneCoverage: 40, Press: 38, KickReturn: 10, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 92, Injury: 93, LongSnap: 0 } },

  // ── DT ──────────────────────────────────────────────────────────────────────
  { position: "DL", name: "Speed Rusher DT",
    attributes: { Speed: 78, Acceleration: 80, Agility: 74, Strength: 82, Awareness: 70, Carrying: 50, BCVision: 40, BreakTackle: 60, Trucking: 65, StiffArm: 60, ChangeOfDirection: 72, SpinMove: 75, JukeMove: 65, Catching: 40, CatchInTraffic: 35, SpectacularCatch: 32, ShortRouteRunning: 20, MedRouteRunning: 18, DeepRouteRunning: 15, Release: 45, Jumping: 78, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 32, PassBlockFinesse: 30, RunBlocking: 32, RunBlockPower: 34, RunBlockFinesse: 32, LeadBlock: 30, ImpactBlocking: 60, PlayRecognition: 70, Tackling: 80, HitPower: 82, BlockShedding: 78, FinesseMoves: 82, PowerMoves: 70, Pursuit: 75, ManCoverage: 30, ZoneCoverage: 35, Press: 32, KickReturn: 8, KickingPower: 20, KickingAccuracy: 20, Stamina: 88, Toughness: 86, Injury: 90, LongSnap: 0 } },
  { position: "DL", name: "Power Rusher DT",
    attributes: { Speed: 72, Acceleration: 74, Agility: 68, Strength: 90, Awareness: 72, Carrying: 50, BCVision: 40, BreakTackle: 65, Trucking: 70, StiffArm: 65, ChangeOfDirection: 66, SpinMove: 65, JukeMove: 55, Catching: 40, CatchInTraffic: 35, SpectacularCatch: 32, ShortRouteRunning: 20, MedRouteRunning: 18, DeepRouteRunning: 15, Release: 45, Jumping: 74, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 32, PassBlockFinesse: 30, RunBlocking: 32, RunBlockPower: 34, RunBlockFinesse: 32, LeadBlock: 30, ImpactBlocking: 65, PlayRecognition: 72, Tackling: 82, HitPower: 88, BlockShedding: 82, FinesseMoves: 68, PowerMoves: 86, Pursuit: 72, ManCoverage: 28, ZoneCoverage: 32, Press: 30, KickReturn: 8, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 90, Injury: 92, LongSnap: 0 } },
  { position: "DL", name: "Run Stopper DT",
    attributes: { Speed: 68, Acceleration: 70, Agility: 64, Strength: 92, Awareness: 74, Carrying: 50, BCVision: 40, BreakTackle: 68, Trucking: 72, StiffArm: 68, ChangeOfDirection: 62, SpinMove: 55, JukeMove: 50, Catching: 38, CatchInTraffic: 34, SpectacularCatch: 30, ShortRouteRunning: 20, MedRouteRunning: 18, DeepRouteRunning: 15, Release: 45, Jumping: 72, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 32, PassBlockFinesse: 30, RunBlocking: 32, RunBlockPower: 34, RunBlockFinesse: 32, LeadBlock: 30, ImpactBlocking: 68, PlayRecognition: 76, Tackling: 85, HitPower: 90, BlockShedding: 86, FinesseMoves: 60, PowerMoves: 82, Pursuit: 70, ManCoverage: 25, ZoneCoverage: 30, Press: 28, KickReturn: 6, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 92, Injury: 93, LongSnap: 0 } },

  // ── LB ──────────────────────────────────────────────────────────────────────
  { position: "LB", name: "Field General",
    attributes: { Speed: 80, Acceleration: 82, Agility: 78, Strength: 78, Awareness: 76, Carrying: 60, BCVision: 55, BreakTackle: 65, Trucking: 60, StiffArm: 55, ChangeOfDirection: 76, SpinMove: 50, JukeMove: 55, Catching: 70, CatchInTraffic: 62, SpectacularCatch: 60, ShortRouteRunning: 45, MedRouteRunning: 40, DeepRouteRunning: 35, Release: 40, Jumping: 80, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 35, PassBlockPower: 30, PassBlockFinesse: 28, RunBlocking: 32, RunBlockPower: 30, RunBlockFinesse: 28, LeadBlock: 30, ImpactBlocking: 42, PlayRecognition: 80, Tackling: 84, HitPower: 82, BlockShedding: 78, FinesseMoves: 60, PowerMoves: 70, Pursuit: 82, ManCoverage: 68, ZoneCoverage: 74, Press: 60, KickReturn: 35, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 90, Injury: 92, LongSnap: 0 } },
  { position: "LB", name: "Run Stopper",
    attributes: { Speed: 78, Acceleration: 80, Agility: 76, Strength: 84, Awareness: 74, Carrying: 60, BCVision: 55, BreakTackle: 68, Trucking: 70, StiffArm: 62, ChangeOfDirection: 74, SpinMove: 55, JukeMove: 60, Catching: 65, CatchInTraffic: 58, SpectacularCatch: 55, ShortRouteRunning: 45, MedRouteRunning: 40, DeepRouteRunning: 35, Release: 40, Jumping: 78, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 35, PassBlockPower: 30, PassBlockFinesse: 28, RunBlocking: 32, RunBlockPower: 30, RunBlockFinesse: 28, LeadBlock: 30, ImpactBlocking: 45, PlayRecognition: 76, Tackling: 86, HitPower: 88, BlockShedding: 84, FinesseMoves: 58, PowerMoves: 78, Pursuit: 84, ManCoverage: 60, ZoneCoverage: 65, Press: 58, KickReturn: 30, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 92, Injury: 93, LongSnap: 0 } },
  { position: "LB", name: "Coverage",
    attributes: { Speed: 84, Acceleration: 86, Agility: 82, Strength: 76, Awareness: 74, Carrying: 62, BCVision: 60, BreakTackle: 66, Trucking: 62, StiffArm: 58, ChangeOfDirection: 82, SpinMove: 65, JukeMove: 70, Catching: 74, CatchInTraffic: 68, SpectacularCatch: 70, ShortRouteRunning: 50, MedRouteRunning: 45, DeepRouteRunning: 40, Release: 45, Jumping: 82, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 35, PassBlockPower: 30, PassBlockFinesse: 28, RunBlocking: 32, RunBlockPower: 30, RunBlockFinesse: 28, LeadBlock: 30, ImpactBlocking: 40, PlayRecognition: 76, Tackling: 80, HitPower: 78, BlockShedding: 74, FinesseMoves: 62, PowerMoves: 68, Pursuit: 82, ManCoverage: 72, ZoneCoverage: 78, Press: 62, KickReturn: 40, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 88, Injury: 92, LongSnap: 0 } },

  // ── CB ──────────────────────────────────────────────────────────────────────
  { position: "CB", name: "Man Coverage",
    attributes: { Speed: 91, Acceleration: 92, Agility: 90, Strength: 65, Awareness: 70, Carrying: 60, BCVision: 65, BreakTackle: 65, Trucking: 55, StiffArm: 58, ChangeOfDirection: 90, SpinMove: 75, JukeMove: 78, Catching: 75, CatchInTraffic: 68, SpectacularCatch: 70, ShortRouteRunning: 50, MedRouteRunning: 45, DeepRouteRunning: 40, Release: 55, Jumping: 88, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 25, PassBlockPower: 20, PassBlockFinesse: 18, RunBlocking: 25, RunBlockPower: 20, RunBlockFinesse: 18, LeadBlock: 25, ImpactBlocking: 45, PlayRecognition: 72, Tackling: 68, HitPower: 65, BlockShedding: 55, FinesseMoves: 50, PowerMoves: 45, Pursuit: 75, ManCoverage: 82, ZoneCoverage: 70, Press: 80, KickReturn: 80, KickingPower: 20, KickingAccuracy: 20, Stamina: 88, Toughness: 82, Injury: 88, LongSnap: 0 } },
  { position: "CB", name: "Zone Coverage",
    attributes: { Speed: 89, Acceleration: 90, Agility: 88, Strength: 64, Awareness: 74, Carrying: 60, BCVision: 65, BreakTackle: 62, Trucking: 52, StiffArm: 55, ChangeOfDirection: 88, SpinMove: 72, JukeMove: 75, Catching: 76, CatchInTraffic: 70, SpectacularCatch: 72, ShortRouteRunning: 50, MedRouteRunning: 45, DeepRouteRunning: 40, Release: 55, Jumping: 86, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 25, PassBlockPower: 20, PassBlockFinesse: 18, RunBlocking: 25, RunBlockPower: 20, RunBlockFinesse: 18, LeadBlock: 25, ImpactBlocking: 42, PlayRecognition: 78, Tackling: 70, HitPower: 64, BlockShedding: 55, FinesseMoves: 50, PowerMoves: 45, Pursuit: 78, ManCoverage: 72, ZoneCoverage: 82, Press: 72, KickReturn: 78, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 84, Injury: 90, LongSnap: 0 } },
  { position: "CB", name: "Slot",
    attributes: { Speed: 90, Acceleration: 91, Agility: 92, Strength: 62, Awareness: 72, Carrying: 65, BCVision: 70, BreakTackle: 66, Trucking: 50, StiffArm: 54, ChangeOfDirection: 92, SpinMove: 78, JukeMove: 80, Catching: 78, CatchInTraffic: 72, SpectacularCatch: 74, ShortRouteRunning: 55, MedRouteRunning: 50, DeepRouteRunning: 40, Release: 55, Jumping: 85, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 25, PassBlockPower: 20, PassBlockFinesse: 18, RunBlocking: 25, RunBlockPower: 20, RunBlockFinesse: 18, LeadBlock: 25, ImpactBlocking: 40, PlayRecognition: 74, Tackling: 72, HitPower: 62, BlockShedding: 55, FinesseMoves: 50, PowerMoves: 45, Pursuit: 80, ManCoverage: 80, ZoneCoverage: 78, Press: 68, KickReturn: 82, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 84, Injury: 90, LongSnap: 0 } },

  // ── FS ──────────────────────────────────────────────────────────────────────
  { position: "FS", name: "Zone",
    attributes: { Speed: 90, Acceleration: 91, Agility: 88, Strength: 70, Awareness: 74, Carrying: 65, BCVision: 70, BreakTackle: 68, Trucking: 60, StiffArm: 60, ChangeOfDirection: 88, SpinMove: 72, JukeMove: 74, Catching: 78, CatchInTraffic: 72, SpectacularCatch: 75, ShortRouteRunning: 55, MedRouteRunning: 50, DeepRouteRunning: 45, Release: 55, Jumping: 88, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 25, PassBlockFinesse: 22, RunBlocking: 30, RunBlockPower: 25, RunBlockFinesse: 22, LeadBlock: 28, ImpactBlocking: 60, PlayRecognition: 78, Tackling: 75, HitPower: 78, BlockShedding: 60, FinesseMoves: 50, PowerMoves: 55, Pursuit: 82, ManCoverage: 72, ZoneCoverage: 82, Press: 65, KickReturn: 70, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 86, Injury: 90, LongSnap: 0 } },
  { position: "FS", name: "Hybrid",
    attributes: { Speed: 89, Acceleration: 90, Agility: 86, Strength: 74, Awareness: 74, Carrying: 65, BCVision: 68, BreakTackle: 70, Trucking: 65, StiffArm: 62, ChangeOfDirection: 86, SpinMove: 70, JukeMove: 72, Catching: 76, CatchInTraffic: 70, SpectacularCatch: 72, ShortRouteRunning: 55, MedRouteRunning: 50, DeepRouteRunning: 45, Release: 55, Jumping: 86, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 25, PassBlockFinesse: 22, RunBlocking: 30, RunBlockPower: 25, RunBlockFinesse: 22, LeadBlock: 28, ImpactBlocking: 68, PlayRecognition: 76, Tackling: 80, HitPower: 84, BlockShedding: 65, FinesseMoves: 52, PowerMoves: 60, Pursuit: 82, ManCoverage: 76, ZoneCoverage: 78, Press: 72, KickReturn: 68, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 88, Injury: 92, LongSnap: 0 } },
  { position: "FS", name: "Ball Hawk",
    attributes: { Speed: 91, Acceleration: 92, Agility: 90, Strength: 68, Awareness: 76, Carrying: 70, BCVision: 72, BreakTackle: 68, Trucking: 58, StiffArm: 58, ChangeOfDirection: 90, SpinMove: 75, JukeMove: 78, Catching: 82, CatchInTraffic: 76, SpectacularCatch: 82, ShortRouteRunning: 60, MedRouteRunning: 55, DeepRouteRunning: 50, Release: 58, Jumping: 92, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 25, PassBlockFinesse: 22, RunBlocking: 30, RunBlockPower: 25, RunBlockFinesse: 22, LeadBlock: 28, ImpactBlocking: 58, PlayRecognition: 78, Tackling: 72, HitPower: 74, BlockShedding: 58, FinesseMoves: 50, PowerMoves: 52, Pursuit: 80, ManCoverage: 75, ZoneCoverage: 84, Press: 68, KickReturn: 75, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 84, Injury: 90, LongSnap: 0 } },

  // ── SS ──────────────────────────────────────────────────────────────────────
  { position: "SS", name: "Run Support",
    attributes: { Speed: 88, Acceleration: 89, Agility: 84, Strength: 80, Awareness: 74, Carrying: 65, BCVision: 68, BreakTackle: 72, Trucking: 70, StiffArm: 66, ChangeOfDirection: 84, SpinMove: 68, JukeMove: 70, Catching: 74, CatchInTraffic: 68, SpectacularCatch: 70, ShortRouteRunning: 50, MedRouteRunning: 45, DeepRouteRunning: 40, Release: 55, Jumping: 86, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 25, PassBlockFinesse: 22, RunBlocking: 30, RunBlockPower: 25, RunBlockFinesse: 22, LeadBlock: 28, ImpactBlocking: 72, PlayRecognition: 76, Tackling: 84, HitPower: 88, BlockShedding: 72, FinesseMoves: 55, PowerMoves: 65, Pursuit: 82, ManCoverage: 70, ZoneCoverage: 72, Press: 72, KickReturn: 65, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 90, Injury: 92, LongSnap: 0 } },
  { position: "SS", name: "Hybrid",
    attributes: { Speed: 89, Acceleration: 90, Agility: 86, Strength: 76, Awareness: 74, Carrying: 65, BCVision: 68, BreakTackle: 70, Trucking: 68, StiffArm: 65, ChangeOfDirection: 86, SpinMove: 70, JukeMove: 72, Catching: 76, CatchInTraffic: 70, SpectacularCatch: 72, ShortRouteRunning: 50, MedRouteRunning: 45, DeepRouteRunning: 40, Release: 55, Jumping: 86, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 25, PassBlockFinesse: 22, RunBlocking: 30, RunBlockPower: 25, RunBlockFinesse: 22, LeadBlock: 28, ImpactBlocking: 68, PlayRecognition: 76, Tackling: 80, HitPower: 84, BlockShedding: 68, FinesseMoves: 55, PowerMoves: 62, Pursuit: 82, ManCoverage: 74, ZoneCoverage: 74, Press: 70, KickReturn: 68, KickingPower: 20, KickingAccuracy: 20, Stamina: 92, Toughness: 88, Injury: 92, LongSnap: 0 } },
  { position: "SS", name: "Coverage",
    attributes: { Speed: 90, Acceleration: 91, Agility: 88, Strength: 72, Awareness: 76, Carrying: 65, BCVision: 70, BreakTackle: 68, Trucking: 62, StiffArm: 60, ChangeOfDirection: 88, SpinMove: 72, JukeMove: 74, Catching: 78, CatchInTraffic: 72, SpectacularCatch: 75, ShortRouteRunning: 55, MedRouteRunning: 50, DeepRouteRunning: 45, Release: 55, Jumping: 88, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 40, PlayAction: 25, PassBlocking: 30, PassBlockPower: 25, PassBlockFinesse: 22, RunBlocking: 30, RunBlockPower: 25, RunBlockFinesse: 22, LeadBlock: 28, ImpactBlocking: 62, PlayRecognition: 78, Tackling: 76, HitPower: 78, BlockShedding: 62, FinesseMoves: 50, PowerMoves: 55, Pursuit: 82, ManCoverage: 78, ZoneCoverage: 80, Press: 72, KickReturn: 70, KickingPower: 20, KickingAccuracy: 20, Stamina: 90, Toughness: 86, Injury: 90, LongSnap: 0 } },

  // ── K ───────────────────────────────────────────────────────────────────────
  { position: "K", name: "Power Kicker",
    attributes: { Speed: 68, Acceleration: 70, Agility: 66, Strength: 72, Awareness: 70, Carrying: 40, BCVision: 35, BreakTackle: 45, Trucking: 40, StiffArm: 38, ChangeOfDirection: 64, SpinMove: 30, JukeMove: 32, Catching: 45, CatchInTraffic: 40, SpectacularCatch: 42, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 35, Jumping: 72, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 30, PassBlockPower: 28, PassBlockFinesse: 26, RunBlocking: 30, RunBlockPower: 28, RunBlockFinesse: 26, LeadBlock: 30, ImpactBlocking: 35, PlayRecognition: 68, Tackling: 50, HitPower: 52, BlockShedding: 45, FinesseMoves: 30, PowerMoves: 30, Pursuit: 55, ManCoverage: 35, ZoneCoverage: 40, Press: 35, KickReturn: 20, KickingPower: 92, KickingAccuracy: 78, Stamina: 85, Toughness: 82, Injury: 90, LongSnap: 0 } },
  { position: "K", name: "Accurate Kicker",
    attributes: { Speed: 66, Acceleration: 68, Agility: 64, Strength: 70, Awareness: 72, Carrying: 40, BCVision: 35, BreakTackle: 45, Trucking: 38, StiffArm: 36, ChangeOfDirection: 62, SpinMove: 28, JukeMove: 30, Catching: 45, CatchInTraffic: 40, SpectacularCatch: 42, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 35, Jumping: 70, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 30, PassBlockPower: 28, PassBlockFinesse: 26, RunBlocking: 30, RunBlockPower: 28, RunBlockFinesse: 26, LeadBlock: 30, ImpactBlocking: 35, PlayRecognition: 70, Tackling: 48, HitPower: 50, BlockShedding: 45, FinesseMoves: 30, PowerMoves: 30, Pursuit: 52, ManCoverage: 35, ZoneCoverage: 40, Press: 35, KickReturn: 20, KickingPower: 82, KickingAccuracy: 90, Stamina: 85, Toughness: 82, Injury: 90, LongSnap: 0 } },

  // ── P ───────────────────────────────────────────────────────────────────────
  { position: "P", name: "Power Punter",
    attributes: { Speed: 70, Acceleration: 72, Agility: 68, Strength: 74, Awareness: 70, Carrying: 42, BCVision: 36, BreakTackle: 48, Trucking: 42, StiffArm: 40, ChangeOfDirection: 66, SpinMove: 32, JukeMove: 34, Catching: 48, CatchInTraffic: 42, SpectacularCatch: 44, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 35, Jumping: 74, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 30, PassBlockPower: 28, PassBlockFinesse: 26, RunBlocking: 30, RunBlockPower: 28, RunBlockFinesse: 26, LeadBlock: 30, ImpactBlocking: 38, PlayRecognition: 68, Tackling: 52, HitPower: 54, BlockShedding: 46, FinesseMoves: 30, PowerMoves: 30, Pursuit: 58, ManCoverage: 35, ZoneCoverage: 40, Press: 35, KickReturn: 22, KickingPower: 94, KickingAccuracy: 78, Stamina: 86, Toughness: 84, Injury: 90, LongSnap: 0 } },
  { position: "P", name: "Accurate Punter",
    attributes: { Speed: 68, Acceleration: 70, Agility: 66, Strength: 72, Awareness: 72, Carrying: 42, BCVision: 36, BreakTackle: 48, Trucking: 40, StiffArm: 38, ChangeOfDirection: 64, SpinMove: 30, JukeMove: 32, Catching: 48, CatchInTraffic: 42, SpectacularCatch: 44, ShortRouteRunning: 25, MedRouteRunning: 20, DeepRouteRunning: 18, Release: 35, Jumping: 72, ThrowingPower: 40, ShortAccuracy: 20, MedAccuracy: 18, DeepAccuracy: 15, ThrowOnRun: 18, ThrowUnderPressure: 20, BreakSack: 35, PlayAction: 25, PassBlocking: 30, PassBlockPower: 28, PassBlockFinesse: 26, RunBlocking: 30, RunBlockPower: 28, RunBlockFinesse: 26, LeadBlock: 30, ImpactBlocking: 38, PlayRecognition: 70, Tackling: 50, HitPower: 52, BlockShedding: 46, FinesseMoves: 30, PowerMoves: 30, Pursuit: 56, ManCoverage: 35, ZoneCoverage: 40, Press: 35, KickReturn: 22, KickingPower: 86, KickingAccuracy: 90, Stamina: 86, Toughness: 84, Injury: 90, LongSnap: 0 } },
];

export const data = new SlashCommandBuilder()
  .setName("admin-customarchetypes")
  .setDescription("Manage custom player archetypes")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("list")
    .setDescription("List all archetypes (optionally filter by position)")
    .addStringOption(o => o
      .setName("position")
      .setDescription("Filter by position")
      .setRequired(false)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))),
    ),
  )
  .addSubcommand(sub => sub
    .setName("seed-defaults")
    .setDescription("Seed all positions with default Madden-style archetypes")
    .addBooleanOption(o => o
      .setName("overwrite")
      .setDescription("Overwrite archetypes that already exist? (default: false — skips existing)")
      .setRequired(false),
    ),
  )
  .addSubcommand(sub => sub
    .setName("add")
    .setDescription("Add or replace an archetype (JSON format: {\"Speed\":70,\"Accel\":72,...})")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name").setRequired(true))
    .addStringOption(o => o.setName("attributes").setDescription('JSON object: {"SpeedAttr":70,"Acceleration":72,...}').setRequired(true)),
  )
  .addSubcommand(sub => sub
    .setName("remove")
    .setDescription("Deactivate an archetype")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name to deactivate").setRequired(true)),
  )
  .addSubcommand(sub => sub
    .setName("restore")
    .setDescription("Re-activate a deactivated archetype")
    .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
    .addStringOption(o => o.setName("name").setDescription("Archetype name").setRequired(true)),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── List ─────────────────────────────────────────────────────────────────
  if (sub === "list") {
    const posFilter = interaction.options.getString("position");
    const rows = posFilter
      ? await db.select().from(customArchetypesTable).where(eq(customArchetypesTable.position, posFilter))
      : await db.select().from(customArchetypesTable);

    if (rows.length === 0) {
      await interaction.editReply({
        content: "No archetypes found. Run `/admin-customarchetypes seed-defaults` to populate them.",
      });
      return;
    }

    const lines = rows.map(r =>
      `${r.isActive ? "✅" : "❌"} **${r.position}** — ${r.name}`,
    ).join("\n");

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("📋 Custom Archetypes")
      .setDescription(lines.slice(0, 4000))
      .setFooter({ text: `${rows.length} total` });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Seed Defaults ─────────────────────────────────────────────────────────
  if (sub === "seed_defaults") {
    const overwrite = interaction.options.getBoolean("overwrite") ?? false;

    let created = 0;
    let skipped = 0;
    let updated = 0;

    for (const def of ARCHETYPE_DEFAULTS) {
      const existing = await db.select({ id: customArchetypesTable.id })
        .from(customArchetypesTable)
        .where(and(
          eq(customArchetypesTable.position, def.position),
          eq(customArchetypesTable.name, def.name),
        ))
        .limit(1);

      if (existing.length > 0) {
        if (overwrite) {
          await db.update(customArchetypesTable)
            .set({ attributes: def.attributes, isActive: true, updatedAt: new Date() })
            .where(eq(customArchetypesTable.id, existing[0]!.id));
          updated++;
        } else {
          skipped++;
        }
      } else {
        await db.insert(customArchetypesTable).values({
          position:   def.position,
          name:       def.name,
          attributes: def.attributes,
        });
        created++;
      }
    }

    const total = ARCHETYPE_DEFAULTS.length;
    const lines: string[] = [
      `Processed **${total}** default archetypes across all positions.`,
      `✅ Created: **${created}**`,
    ];
    if (skipped > 0) lines.push(`⏭️ Skipped (already exist): **${skipped}** — run with \`overwrite: true\` to update them`);
    if (updated > 0) lines.push(`🔄 Overwritten: **${updated}**`);

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("🏈 Default Archetypes Seeded")
      .setDescription(lines.join("\n"))
      .addFields({ name: "Positions Covered", value: "QB (3) · HB (3) · FB (2) · WR (3) · TE (3) · OL (3) · DE (3) · DT (3) · LB (3) · CB (3) · FS (3) · SS (3) · K (2) · P (2)" })
      .setFooter({ text: "39 archetypes total · Edit any with /admin-customarchetypes add" });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Add ──────────────────────────────────────────────────────────────────
  if (sub === "add") {
    const position   = interaction.options.getString("position", true);
    const name       = interaction.options.getString("name", true).trim();
    const attrStr    = interaction.options.getString("attributes", true);

    let attributes: Record<string, number>;
    try {
      const parsed = JSON.parse(attrStr);
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Must be a JSON object");
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "number") throw new Error(`Value for "${k}" must be a number`);
      }
      attributes = parsed as Record<string, number>;
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Invalid JSON: ${err.message}` });
      return;
    }

    const existing = await db.select()
      .from(customArchetypesTable)
      .where(and(
        eq(customArchetypesTable.position, position),
        eq(customArchetypesTable.name, name),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(customArchetypesTable)
        .set({ attributes, isActive: true, updatedAt: new Date() })
        .where(eq(customArchetypesTable.id, existing[0]!.id));
    } else {
      await db.insert(customArchetypesTable).values({ position, name, attributes });
    }

    const embed = formatArchetypeEmbed(position, name, attributes);
    embed.setTitle(`✅ Archetype Saved — ${embed.data.title}`);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Remove / Restore ─────────────────────────────────────────────────────
  const position = interaction.options.getString("position", true);
  const name     = interaction.options.getString("name", true).trim();
  const activate = sub === "restore";

  const [row] = await db.select()
    .from(customArchetypesTable)
    .where(and(
      eq(customArchetypesTable.position, position),
      eq(customArchetypesTable.name, name),
    ))
    .limit(1);

  if (!row) {
    await interaction.editReply({ content: `❌ No archetype found: **${position}** — ${name}` });
    return;
  }

  await db.update(customArchetypesTable)
    .set({ isActive: activate, updatedAt: new Date() })
    .where(eq(customArchetypesTable.id, row.id));

  await interaction.editReply({
    content: `${activate ? "✅ Restored" : "🗑️ Deactivated"}: **${position}** — ${name}`,
  });
}
