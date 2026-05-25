import { db } from "@workspace/db";
import { gameLogTable, usersTable } from "@workspace/db";
import { and, eq, isNotNull, ne, inArray } from "drizzle-orm";
import { trashTalkCountsForUser } from "./press-conference.js";

// Minimum all-time H2H games for an opponent to qualify as a "rival".
export const RIVAL_MIN_GAMES = 3;

export type RivalryEntry = {
  opponentId:    string;
  opponentName:  string | null;
  opponentTeam:  string | null;
  games:         number;
  wins:          number;   // wins for the viewing user
  losses:        number;   // losses for the viewing user
  pointDiff:     number;   // cumulative point differential for the viewing user
  avgMargin:     number;   // mean |point spread| across the series
  trashTalkBoost: number;  // count of trash-talk press confs between the two users
  rating:        number;   // computed rivalry rating (0..∞, see formula below)
  temperature:   string;   // human-readable scale (Cold / Warm / Heated / White-Hot / Inferno)
};

/**
 * Rivalry rating formula. Designed to surface series that are both *frequent*
 * and *close* — a 10-game series decided by single scores rates higher than
 * a 10-game series of blowouts. Trash talk adds a small but steady boost so
 * users can heat up an otherwise cold rivalry through the press conference.
 *
 *   base       = games * 10                        // frequency
 *   closeness  = sum over games of max(0, 28 - |spread|)   // narrower = more
 *   trashBoost = trashTalkCount * 5                // engagement
 *
 *   rating = base + closeness + trashBoost
 *
 * `closeness` rewards single-score games most (28 - 0..3 ≈ 25-28) and tapers
 * off — a 4-touchdown blowout contributes 0. Numbers were chosen so a casual
 * series sits in the 30-80 range and a heated rivalry pushes 200+.
 */
function computeRating(games: number, spreadAbsSum: number, trashTalk: number, gamesArr: number[]): number {
  const base = games * 10;
  let closeness = 0;
  for (const s of gamesArr) {
    closeness += Math.max(0, 28 - Math.abs(s));
  }
  // spreadAbsSum kept in signature for future use; closeness is the per-game sum.
  void spreadAbsSum;
  const trashBoost = trashTalk * 5;
  return base + closeness + trashBoost;
}

function temperatureFor(rating: number): string {
  if (rating >= 250) return "🔥 Inferno";
  if (rating >= 175) return "🌡️ White-Hot";
  if (rating >= 100) return "♨️ Heated";
  if (rating >= 50)  return "🌤️ Warm";
  return "❄️ Cold";
}

/**
 * Top-N rivals for a user: opponents with at least RIVAL_MIN_GAMES all-time
 * head-to-head games, ranked by computed rivalry rating. Returns at most
 * `limit` entries (default 4). Only H2H rows with a resolved opponentDiscordId
 * are considered; CPU games are ignored.
 */
export async function getRivalsForUser(
  guildId: string,
  userId: string,
  limit = 4,
): Promise<RivalryEntry[]> {
  // Pull every H2H game row for this user across all seasons in this guild.
  const rows = await db.select({
    opponentId:  gameLogTable.opponentDiscordId,
    result:      gameLogTable.result,
    pointSpread: gameLogTable.pointSpread,
  }).from(gameLogTable)
    .where(and(
      eq(gameLogTable.guildId, guildId),
      eq(gameLogTable.discordId, userId),
      isNotNull(gameLogTable.opponentDiscordId),
      ne(gameLogTable.opponentDiscordId, ""),
    ));

  // Bucket by opponent
  type Acc = { games: number; wins: number; losses: number; pointDiff: number; spreads: number[] };
  const buckets = new Map<string, Acc>();
  for (const r of rows) {
    const opp = r.opponentId!;
    let acc = buckets.get(opp);
    if (!acc) { acc = { games: 0, wins: 0, losses: 0, pointDiff: 0, spreads: [] }; buckets.set(opp, acc); }
    acc.games += 1;
    acc.pointDiff += Number(r.pointSpread);
    acc.spreads.push(Number(r.pointSpread));
    if (r.result === "win")       acc.wins   += 1;
    else if (r.result === "loss") acc.losses += 1;
  }

  // Keep only the qualifying opponents (>=RIVAL_MIN_GAMES). Resolve names + trash-talk in one pass.
  const qualifying = [...buckets.entries()].filter(([, a]) => a.games >= RIVAL_MIN_GAMES);
  if (qualifying.length === 0) return [];

  const oppIds = qualifying.map(([id]) => id);
  const [nameRows, trashCounts] = await Promise.all([
    db.select({
      discordId: usersTable.discordId,
      username:  usersTable.discordUsername,
      team:      usersTable.team,
    }).from(usersTable)
      .where(and(eq(usersTable.guildId, guildId), inArray(usersTable.discordId, oppIds))),
    trashTalkCountsForUser(guildId, userId, oppIds),
  ]);
  const nameMap = new Map(nameRows.map(r => [r.discordId, r] as const));

  const entries: RivalryEntry[] = qualifying.map(([opponentId, a]) => {
    const trash   = trashCounts.get(opponentId) ?? 0;
    const rating  = computeRating(a.games, 0, trash, a.spreads);
    const avgMarg = a.games > 0 ? a.spreads.reduce((s, v) => s + Math.abs(v), 0) / a.games : 0;
    const nm      = nameMap.get(opponentId);
    return {
      opponentId,
      opponentName:  nm?.username ?? null,
      opponentTeam:  nm?.team     ?? null,
      games:         a.games,
      wins:          a.wins,
      losses:        a.losses,
      pointDiff:     a.pointDiff,
      avgMargin:     Math.round(avgMarg * 10) / 10,
      trashTalkBoost: trash,
      rating:        Math.round(rating),
      temperature:   temperatureFor(rating),
    };
  });

  entries.sort((a, b) => b.rating - a.rating);
  return entries.slice(0, limit);
}

/**
 * Lightweight check used by the in-channel winner-confirm hook: is the given
 * opponent in `userId`'s top-N rivals list AT THIS MOMENT, considering games
 * BEFORE the one being settled? We compute "before this one" by checking the
 * rival list now and accepting it — the new game will tip the count by 1
 * (3 prior + this one = 4 total) which still qualifies the opponent as a
 * rival from the user's perspective. Per the product spec, the rivalry
 * bonus is paid per-side: each player gets it only if the other player is
 * currently in their personal top-4.
 */
export async function isOpponentTopRival(
  guildId: string,
  userId: string,
  opponentId: string,
  topN = 4,
): Promise<boolean> {
  const rivals = await getRivalsForUser(guildId, userId, topN);
  return rivals.some(r => r.opponentId === opponentId);
}
