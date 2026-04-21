/**
 * playoff-seeding.ts
 *
 * Shared module for NFL playoff seeding computation and rules config.
 *
 * Rules source: https://theredzone.org/nfl/how-do-the-nfl-playoffs-work-a-complete-guide/
 * Stored globally in playoffSeedingConfigTable for all commands to reference.
 *
 * Seeding algorithm (per conference):
 *  Seeds 1–4 : 4 division winners, ranked by regular-season record (wins DESC → losses ASC → PD DESC)
 *  Seeds 5–7 : 3 best non-division-winner records (wild cards), same sort
 *
 * Full NFL tiebreaker chain (stored in DB, applied where data is available):
 *  Same-division    : H2H → div record → common games → conf record → SoV → SoS → PD
 *  Different-division: H2H → conf record → common games → SoV → SoS → conf PD → overall PD
 *
 * Current implementation applies: wins DESC → losses ASC → pointDifferential DESC
 * (the remaining tiebreakers require per-game data not exposed by ArticleStanding)
 */

import { db } from "@workspace/db";
import { playoffSeedingConfigTable, type PlayoffSeedingRules } from "@workspace/db";
import type { ArticleStanding } from "./gcs-fallback.js";

const DIVISIONS = ["East", "North", "South", "West"] as const;

// ── Core seeding algorithm ────────────────────────────────────────────────────

function recordSort(a: ArticleStanding, b: ArticleStanding): number {
  if (b.wins !== a.wins)               return b.wins - a.wins;
  if (a.losses !== b.losses)           return a.losses - b.losses;
  return b.pointDifferential - a.pointDifferential;
}

/**
 * Compute the 7 playoff seeds for one conference from its team standings.
 * Returns teams ordered seed 1 → 7.
 */
export function computePlayoffSeeds(confTeams: ArticleStanding[]): ArticleStanding[] {
  // 1. Find division winners (best record per division)
  const divLeaders = new Map<string, ArticleStanding>();
  for (const div of DIVISIONS) {
    const sorted = confTeams
      .filter(t => t.division === div)
      .sort(recordSort);
    if (sorted[0]) divLeaders.set(div, sorted[0]);
  }

  // 2. Sort division winners among themselves: best record first (seeds 1–4)
  const sortedWinners = [...divLeaders.values()].sort(recordSort);

  // 3. Wild cards: non-division-winners sorted by record (seeds 5–7)
  const divWinnerSet = new Set(sortedWinners.map(t => t.teamName));
  const wildCards = confTeams
    .filter(t => !divWinnerSet.has(t.teamName))
    .sort(recordSort);

  return [...sortedWinners, ...wildCards].slice(0, 7);
}

// ── Seeding rules config (stored in DB) ───────────────────────────────────────

export const DEFAULT_SEEDING_RULES: PlayoffSeedingRules = {
  description:
    "NFL Playoff Seeding Rules — 14 teams total (7 AFC, 7 NFC). " +
    "4 division winners per conference qualify automatically. " +
    "3 wild-card berths per conference go to non-division-winners with the best records. " +
    "Source: theredzone.org",
  sourceUrl: "https://theredzone.org/nfl/how-do-the-nfl-playoffs-work-a-complete-guide/",
  lastUpdated: "2025-12-15",
  playoffTeamsPerConference: 7,
  divisionWinners: 4,
  wildcardBerths: 3,
  seedingOrder: {
    seeds1to4:
      "The four division winners (North, South, East, West) ordered by regular-season record " +
      "from best to worst. Division titles guaranteed a top-4 seed.",
    seeds5to7:
      "The three wild-card teams — non-division-winners with the best regular-season records " +
      "in their conference, ordered by record among wild-card qualifiers.",
  },
  tiebreakerChainSameDivision: [
    "1. Head-to-head record (if teams played each other during the season)",
    "2. Best win % in games played within the division",
    "3. Best win % in common games (minimum 4 games required)",
    "4. Best win % in games played within the conference",
    "5. Strength of victory in all games",
    "6. Strength of schedule in all games",
    "7. Best combined ranking among conference teams in points scored and points allowed",
    "8. Best combined ranking among all teams in points scored and points allowed",
    "9. Best net points in common games",
    "10. Best net points in all games",
    "11. Best net touchdowns in all games",
    "12. Coin toss (last resort)",
  ],
  tiebreakerChainDifferentDivision: [
    "1. Head-to-head record (if teams played each other)",
    "2. Best win % in games played within the conference",
    "3. Best win % in common games (minimum 4 games required)",
    "4. Strength of victory in all games",
    "5. Strength of schedule in all games",
    "6. Best combined ranking among conference teams in points scored and points allowed",
    "7. Best combined ranking among all teams in points scored and points allowed",
    "8. Best net points in conference games",
    "9. Best net points in all games",
    "10. Best net touchdowns in all games",
    "11. Coin toss (last resort)",
  ],
  bracketFormat: {
    wildCard:
      "Seeds 2–7 play; No. 1 seed gets a bye. " +
      "Matchups: 7 vs 2, 6 vs 3, 5 vs 4. Higher seed hosts.",
    divisional:
      "Wild-Card winners join the 1-seed. Highest remaining seed plays lowest remaining seed; " +
      "other two play each other. Higher seed hosts.",
    conference:
      "Two remaining teams per conference play for the AFC/NFC championship. Higher seed hosts.",
    superBowl:
      "AFC champion vs NFC champion. Played at a neutral site — no home-field advantage.",
  },
};

/**
 * Read playoff seeding rules from the DB.
 * If no row exists yet, inserts the default rules and returns them.
 */
export async function getPlayoffSeedingRules(): Promise<PlayoffSeedingRules> {
  const rows = await db.select().from(playoffSeedingConfigTable).limit(1);
  if (rows[0]) return rows[0].rulesJson;

  await db.insert(playoffSeedingConfigTable).values({
    rulesJson: DEFAULT_SEEDING_RULES,
    sourceUrl: DEFAULT_SEEDING_RULES.sourceUrl,
  });
  return DEFAULT_SEEDING_RULES;
}

/**
 * Upsert the seeding rules in the DB (replaces the single global row).
 */
export async function savePlayoffSeedingRules(rules: PlayoffSeedingRules): Promise<void> {
  const rows = await db.select({ id: playoffSeedingConfigTable.id }).from(playoffSeedingConfigTable).limit(1);
  if (rows[0]) {
    await db.update(playoffSeedingConfigTable)
      .set({ rulesJson: rules, sourceUrl: rules.sourceUrl, updatedAt: new Date() });
  } else {
    await db.insert(playoffSeedingConfigTable).values({
      rulesJson: rules,
      sourceUrl: rules.sourceUrl,
    });
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

const SEED_EMOJIS: Record<number, string> = {
  1: "🥇", 2: "🥈", 3: "🥉",
  4: "4️⃣", 5: "5️⃣", 6: "6️⃣", 7: "7️⃣",
};

function seedBadge(seed: number): string {
  return SEED_EMOJIS[seed] ?? `#${seed}`;
}

/**
 * Format a list of seeded teams into readable embed lines.
 * teams[0] = seed 1, teams[6] = seed 7.
 */
export function formatSeedingLines(teams: ArticleStanding[], conference: string): string {
  if (!teams.length) return `_No ${conference} teams found_`;
  const lines: string[] = [];
  teams.forEach((t, i) => {
    const seed  = i + 1;
    const badge = seedBadge(seed);
    const type  = seed <= 4 ? "Div" : "WC";
    const rec   = `${t.wins}W-${t.losses}L`;
    const pd    = t.pointDifferential >= 0 ? `+${t.pointDifferential}` : `${t.pointDifferential}`;
    const user  = t.discordUsername ? ` (${t.discordUsername})` : "";
    lines.push(`${badge} \`${type}\` **${t.teamName}**${user} — ${rec} | PD: ${pd}`);
  });
  return lines.join("\n");
}
