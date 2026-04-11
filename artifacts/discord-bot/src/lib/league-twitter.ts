/**
 * League Twitter — AI-generated "reporter" tweets posted every 3 hours.
 *
 * Reporters are fictional but inspired by real NFL media personalities.
 * The GPT model is given rich league context so tweets feel grounded.
 * When a Discord user replies to a tweet in the channel, the bot responds
 * as the reporter who posted it.
 */

import { Client, TextChannel } from "discord.js";
import OpenAI from "openai";
import { db } from "@workspace/db";
import {
  leagueTwitterTable, leagueTwitterMatchupCacheTable, leagueTwitterTradeEventsTable,
  usersTable, seasonsTable,
  teamSeasonStatsTable, playerSeasonStatsTable,
  franchiseScheduleTable, franchiseRostersTable,
} from "@workspace/db";
import { eq, desc, and, gte, isNotNull, ne } from "drizzle-orm";
import { getOrCreateActiveSeason } from "./db-helpers.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const LEAGUE_TWITTER_CHANNEL_ID = "1492213174697726033";

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const FOUR_HOURS_MS  = 4 * 60 * 60 * 1000;

// ── OpenAI client (same proxy used by messageCreate) ──────────────────────────

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

// ── Reporter personas ──────────────────────────────────────────────────────────

interface Reporter {
  name:   string;   // Display name
  handle: string;   // @handle shown in header
  outlet: string;   // e.g. "ESPN", "NFL Network"
  style:  string;   // Personality note for the prompt
}

const REPORTERS: Reporter[] = [
  // ── Insider / beat reporters ────────────────────────────────────────────────
  {
    name:   "Adam Shaffer",
    handle: "@AdamShaffer",
    outlet: "ESPN",
    style:  "Fast, definitive insider. Short 'per sources' style tweets. First to break moves. Dry, confident, never buries the lede.",
  },
  {
    name:   "Ian Rappaport",
    handle: "@IanRappaport",
    outlet: "NFL Network",
    style:  "Player-centric, contract-focused insider. Measured tone with quiet authority. Loves 'I'm told' and 'per sources' framing.",
  },
  {
    name:   "Tom Pellissarro",
    handle: "@TomPellissarro",
    outlet: "NFL Network",
    style:  "Steady, factual follow-up reporter. Adds context and detail to bigger stories. Professional and measured — never sensational.",
  },
  {
    name:   "Jay Glazier",
    handle: "@JayGlazier",
    outlet: "Fox Sports",
    style:  "Bombastic and competitive. Labels everything EXCLUSIVE. Dramatic flair, loves scooping rivals. High energy even on small stories.",
  },
  {
    name:   "Jordan Schulter",
    handle: "@JordanSchulter",
    outlet: "ESPN",
    style:  "Young, aggressive hot-take analyst. Fast opinions, spicy trade analysis, fire emojis, built to go viral.",
  },
  {
    name:   "Diana Rossini",
    handle: "@DianaRossini",
    outlet: "The Athletic",
    style:  "Elite access, respected by coaches. Concise, authoritative, and understated. Breaks front-office and roster decisions.",
  },
  {
    name:   "Jeff Darrington",
    handle: "@JeffDarrington",
    outlet: "ESPN",
    style:  "Stat-driven analyst-reporter hybrid. Loves historical comparisons. Often starts with 'put this in perspective' and leans data-heavy.",
  },
  // ── Pundits / on-air personalities ─────────────────────────────────────────
  {
    name:   "Steven A. Stone",
    handle: "@StevenAStone",
    outlet: "ESPN",
    style:  "LOUD, opinionated, DRAMATIC. Uses ALL CAPS for emphasis frequently. Makes sweeping declarations. Passionate and confrontational — everything is either UNACCEPTABLE or EXTRAORDINARY. Loves long dramatic pauses (em dashes). First-person proclamations.",
  },
  {
    name:   "Pat McCaffrey",
    handle: "@PatMcCaffrey",
    outlet: "The Pat McCaffrey Show",
    style:  "Energetic, casual, and hilarious. Former player turned media star. Combines genuine football knowledge with self-deprecating humor. Loves hyperbole, exclamation points, and calling things 'absolutely FILTHY'. Very relatable and hype-focused.",
  },
  {
    name:   "Shannon Burke",
    handle: "@ShannonBurke",
    outlet: "ESPN",
    style:  "Passionate, emphatic, and opinionated. Former tight end. Uses catchphrases and colorful language. Gets fired up over winning and losing. Unapologetically loud about respect, effort, and who the real ones are.",
  },
  {
    name:   "Chad 'Ochenta' Williams",
    handle: "@OchentaWilliams",
    outlet: "NFL Network",
    style:  "Playful, flashy, and social-media-savvy. Former receiver who never takes himself too seriously. Emoji-heavy, playful trash talk, third-person references to himself. Everything is a vibe — even serious news.",
  },
  {
    name:   "Erin Avery",
    handle: "@ErinAvery",
    outlet: "ESPN",
    style:  "Polished sideline reporter and studio host. Warm but authoritative. Excellent storyteller who finds the human angle in every matchup. Measured enthusiasm, never over-the-top.",
  },
  {
    name:   "Rachel Norris",
    handle: "@RachelNorris",
    outlet: "ESPN",
    style:  "Sharp, assertive studio analyst. Known for holding players and coaches accountable. Asks the hard questions in tweet form. Mixes warmth with real critical takes.",
  },
  {
    name:   "Johnny Manziel",
    handle: "@JohnnyFootball",
    outlet: "Manziel Unfiltered Podcast",
    style:  "Drunk, high, angry, and absolutely CONVINCED he's the smartest person in any room. Refers to himself in third person as 'Johnny Football'. Rambling but cocky — starts a point, loses it, finds it again and somehow doubles down harder. Loud, chaotic, slurred energy. Casually brings up his own NFL career like it went great. Money signs 💰. Randomly defensive about things nobody asked about. Loves calling everyone out. Acts like he's dropping truth bombs while barely holding it together. Sometimes contradicts himself mid-tweet and acts like he meant to.",
  },
];

function pickReporter(avoid?: string): Reporter {
  const pool = avoid ? REPORTERS.filter(r => r.name !== avoid) : REPORTERS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

// ── Context builder ────────────────────────────────────────────────────────────

async function buildLeagueContext(season: typeof seasonsTable.$inferSelect): Promise<string> {
  const parts: string[] = [];

  // ── Season info ────────────────────────────────────────────────────────────
  parts.push(`SEASON: Season ${season.seasonNumber}, current week: ${season.currentWeek ?? "pre-season"}`);

  // ── Standings — use MCA in-game records (teamSeasonStatsTable) ─────────────
  // These come directly from the Madden CFM franchise data import and reflect
  // the actual in-game regular season record, NOT the Discord H2H tracking record.
  const mcaStandings = await db.select({
    teamName:     teamSeasonStatsTable.teamName,
    wins:         teamSeasonStatsTable.wins,
    losses:       teamSeasonStatsTable.losses,
    offPtsPerGame: teamSeasonStatsTable.offPtsPerGame,
    turnoverDiff: teamSeasonStatsTable.turnoverDiff,
  })
    .from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, season.id));

  // Sanity bounds: a Madden regular season has at most 17 games (18 with a bye bye),
  // so any team showing wins > 25 or losses > 25 has corrupt data (the MCA export
  // sometimes writes total season points into the wins/losses fields instead).
  // Filter those out entirely so the AI never sees fabricated records.
  const activeStandings = mcaStandings
    .filter(t => {
      const total = t.wins + t.losses;
      return total > 0 && t.wins <= 25 && t.losses <= 25;
    })
    .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses));

  if (activeStandings.length > 0) {
    // Show ONLY win-loss records — no other numbers, to avoid the AI mis-reading
    // any parenthetical stats as part of the record.
    const lines = activeStandings.map(r => `  ${r.teamName}: ${r.wins}W-${r.losses}L`);
    parts.push(`\nCURRENT STANDINGS (in-game regular season record — wins and losses only):\n${lines.join("\n")}`);
  } else {
    // No valid standings data — explicitly tell the model not to invent records.
    parts.push(`\nCURRENT STANDINGS: Data not available this cycle. Do NOT invent, assume, or quote any team's record. Avoid any mention of win-loss records entirely.`);
  }

  // ── Playoff status ─────────────────────────────────────────────────────────
  // Pull playoff seedings from usersTable (written by auto-seeding on every MCA sync).
  // playoffSeed 1–7 = in playoffs; null = eliminated / missed playoffs.
  const allUserTeams = await db.select({
    team:              usersTable.team,
    playoffSeed:       usersTable.playoffSeed,
    playoffConference: usersTable.playoffConference,
  })
    .from(usersTable)
    .where(isNotNull(usersTable.team));

  const playoffTeams = allUserTeams
    .filter(u => u.playoffSeed !== null && u.playoffSeed >= 1 && u.playoffSeed <= 7 && u.playoffConference)
    .sort((a, b) => {
      // Group by conference, then by seed ascending
      if (a.playoffConference !== b.playoffConference) return (a.playoffConference ?? "").localeCompare(b.playoffConference ?? "");
      return (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99);
    });

  const eliminatedTeams = allUserTeams
    .filter(u => !u.playoffSeed || u.playoffSeed < 1 || u.playoffSeed > 7)
    .map(u => u.team)
    .filter((t): t is string => !!t);

  // Detect whether we are currently in the playoff phase by checking for any
  // completed playoff schedule rows (weekIndex >= 1000).
  const playoffGames = await db.select({ weekIndex: franchiseScheduleTable.weekIndex })
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      isNotNull(franchiseScheduleTable.homeScore),
      gte(franchiseScheduleTable.weekIndex, 1000),
    ))
    .limit(1);

  const isInPlayoffs = playoffGames.length > 0;

  if (playoffTeams.length > 0) {
    const phaseLabel = isInPlayoffs ? "CURRENT PLAYOFF FIELD" : "CURRENT PLAYOFF SEEDS (regular season, may change)";
    const lines: string[] = [];
    const conferences = [...new Set(playoffTeams.map(u => u.playoffConference))];
    for (const conf of conferences) {
      const confTeams = playoffTeams.filter(u => u.playoffConference === conf);
      lines.push(`  ${conf}:`);
      for (const u of confTeams) {
        const bye = u.playoffSeed! <= 2 ? " (1st-round bye)" : "";
        lines.push(`    Seed ${u.playoffSeed}: ${u.team}${bye}`);
      }
    }
    if (eliminatedTeams.length > 0) {
      lines.push(`  NOT in playoffs / eliminated: ${eliminatedTeams.join(", ")}`);
    }
    parts.push(`\n${phaseLabel}:\n${lines.join("\n")}`);
  } else {
    // No seedings available yet
    parts.push(`\nPLAYOFF STATUS: Playoff seedings not yet determined for this season.`);
  }

  // ── Team season stat highlights ─────────────────────────────────────────────
  if (mcaStandings.length > 0) {
    // Sanity-bound: offPtsPerGame should be under 80 to be a real per-game value.
    // If the MCA export sends total season points in this field (e.g. 289), ignore it.
    const withRealPpg = mcaStandings.filter(t => t.offPtsPerGame > 0 && t.offPtsPerGame < 80);
    const topOff      = [...withRealPpg].sort((a, b) => b.offPtsPerGame - a.offPtsPerGame)[0];
    const topTO       = [...mcaStandings].filter(t => t.turnoverDiff > 0).sort((a, b) => b.turnoverDiff - a.turnoverDiff)[0];

    // Fetch defTDs (which actually stores total points allowed from MCA data) separately
    const allDefStats = await db.select({ teamName: teamSeasonStatsTable.teamName, defTDs: teamSeasonStatsTable.defTDs })
      .from(teamSeasonStatsTable)
      .where(eq(teamSeasonStatsTable.seasonId, season.id));
    // Only consider teams with real data (defTDs > 0 means they've actually played)
    const topDef = allDefStats.filter(t => t.defTDs > 0).sort((a, b) => a.defTDs - b.defTDs)[0];

    const statLines: string[] = [];
    if (topOff)  statLines.push(`  Best offense by scoring: ${topOff.teamName} (${topOff.offPtsPerGame.toFixed(1)} points per game)`);
    if (topDef)  statLines.push(`  Best defense (fewest points allowed): ${topDef.teamName} (${topDef.defTDs} points allowed this season)`);
    if (topTO)   statLines.push(`  Best turnover differential: ${topTO.teamName} (+${topTO.turnoverDiff})`);
    if (statLines.length > 0) parts.push(`\nTEAM STAT HIGHLIGHTS:\n${statLines.join("\n")}`);
  }

  // ── Top individual players (stat leaders) ──────────────────────────────────
  const players = await db.select()
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));

  if (players.length > 0) {
    // Sanity-bound player stats — Madden sometimes sends accumulator values mid-season
    // that are wildly inflated. Cap at sane single-season maximums to avoid AI hallucinations.
    const sanePlayers = players.filter(p =>
      p.passYds  <= 7000 &&
      p.rushYds  <= 2500 &&
      p.recYds   <= 2500 &&
      p.passTDs  <= 60   &&
      p.rushTDs  <= 30   &&
      p.recTDs   <= 25   &&
      p.sacks    <= 30
    );

    // Use sanePlayers for derived stats; fall back to all players if sanity filter wipes everyone
    const pool = sanePlayers.length > 0 ? sanePlayers : players;

    const topQBs  = [...pool].filter(p => p.position === "QB" && p.passYds > 0).sort((a, b) => b.passYds - a.passYds).slice(0, 3);
    const topRBs  = [...pool].filter(p => p.position === "HB" && p.rushYds > 0).sort((a, b) => b.rushYds - a.rushYds).slice(0, 3);
    const topWRs  = [...pool].filter(p => ["WR","TE"].includes(p.position) && p.recYds > 0).sort((a, b) => b.recYds - a.recYds).slice(0, 3);
    const topPass = [...pool].filter(p => p.position === "QB" && p.passTDs > 0).sort((a, b) => b.passTDs - a.passTDs)[0];
    const topSack = [...pool].filter(p => p.sacks > 0).sort((a, b) => b.sacks - a.sacks)[0];
    const topRush = [...pool].filter(p => p.position === "HB" && p.rushTDs > 0).sort((a, b) => b.rushTDs - a.rushTDs)[0];

    // Include ACTUAL stat numbers so the AI does not invent them
    const fmtQBs  = (ps: typeof pool) =>
      ps.map(p => `${p.firstName} ${p.lastName} (${p.teamName}) — ${p.passYds.toLocaleString()} yds`).join(", ");
    const fmtRBs  = (ps: typeof pool) =>
      ps.map(p => `${p.firstName} ${p.lastName} (${p.teamName}) — ${p.rushYds.toLocaleString()} yds`).join(", ");
    const fmtWRs  = (ps: typeof pool) =>
      ps.map(p => `${p.firstName} ${p.lastName} (${p.teamName}, ${p.position}) — ${p.recYds.toLocaleString()} yds`).join(", ");

    const statLines: string[] = [];
    if (topQBs.length) statLines.push(`  QB passing yards leaders: ${fmtQBs(topQBs)}`);
    if (topRBs.length) statLines.push(`  RB rushing yards leaders: ${fmtRBs(topRBs)}`);
    if (topWRs.length) statLines.push(`  WR/TE receiving yards leaders: ${fmtWRs(topWRs)}`);
    if (topPass)       statLines.push(`  Passing TD leader: ${topPass.firstName} ${topPass.lastName} (${topPass.teamName}) — ${topPass.passTDs} TDs`);
    if (topRush)       statLines.push(`  Rushing TD leader: ${topRush.firstName} ${topRush.lastName} (${topRush.teamName}) — ${topRush.rushTDs} TDs`);
    if (topSack)       statLines.push(`  Sack leader: ${topSack.firstName} ${topSack.lastName} (${topSack.teamName}) — ${topSack.sacks} sacks`);
    if (statLines.length > 0) parts.push(`\nINDIVIDUAL STAT LEADERS THIS SEASON (use ONLY these exact numbers — do NOT invent or modify any statistic):\n${statLines.join("\n")}`);
  }

  // ── Team rosters (top 5 players per human team by OVR) ─────────────────────
  // Included so the AI knows exactly who is on each roster. It must NEVER
  // reference a player as being on a team if they are not listed here.
  const rosterRows = await db.select({
    teamName:  franchiseRostersTable.teamName,
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    position:  franchiseRostersTable.position,
    overall:   franchiseRostersTable.overall,
  })
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, season.id),
      isNotNull(franchiseRostersTable.discordId),   // human-controlled teams only
    ))
    .orderBy(desc(franchiseRostersTable.overall));

  if (rosterRows.length > 0) {
    // Group by team, top 5 per team
    const byTeam = new Map<string, typeof rosterRows>();
    for (const p of rosterRows) {
      const list = byTeam.get(p.teamName) ?? [];
      if (list.length < 7) {
        list.push(p);
        byTeam.set(p.teamName, list);
      }
    }
    const rosterLines: string[] = [];
    for (const [team, roster] of byTeam) {
      const players = roster.map(p => `${p.firstName} ${p.lastName} (${p.position}, ${p.overall} OVR)`).join(", ");
      rosterLines.push(`  ${team}: ${players}`);
    }
    parts.push(`\nTEAM ROSTERS (top players by OVR — ONLY reference players listed here as being on these teams):\n${rosterLines.join("\n")}`);
  }

  // ── Recent completed game results (last 2 weeks) ────────────────────────────
  const recentGames = await db.select({
    weekIndex:    franchiseScheduleTable.weekIndex,
    homeTeamName: franchiseScheduleTable.homeTeamName,
    awayTeamName: franchiseScheduleTable.awayTeamName,
    homeScore:    franchiseScheduleTable.homeScore,
    awayScore:    franchiseScheduleTable.awayScore,
  })
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      isNotNull(franchiseScheduleTable.homeScore),
    ))
    .orderBy(desc(franchiseScheduleTable.weekIndex))
    .limit(16);

  if (recentGames.length > 0) {
    // Convert a raw weekIndex integer into a human-readable round label.
    // Regular season: weekIndex is 0-based (0 = Week 1, 17 = Week 18).
    // Playoffs use high weekIndex values matching the DB constants.
    const weekIndexLabel = (wi: number): string => {
      if (wi === 1018) return "Wild Card Round";
      if (wi === 1019) return "Divisional Round";
      if (wi === 1020) return "Conference Championship";
      if (wi === 1022) return "Super Bowl";
      if (wi >= 1000)  return `Playoff Round (week index ${wi})`;
      return `Week ${wi + 1}`;  // regular season: 0-based → 1-based display
    };

    // Find the two most recent distinct weekIndex values (not necessarily consecutive,
    // since playoff rounds skip indices, e.g. Conference=1020 → Super Bowl=1022).
    const distinctWeeks = [...new Set(recentGames.map(g => g.weekIndex))].sort((a, b) => b - a);
    const latestWeek = distinctWeeks[0];
    const prevWeek   = distinctWeeks[1];

    const latestWeekGames = recentGames.filter(g => g.weekIndex === latestWeek);
    const prevWeekGames   = prevWeek !== undefined ? recentGames.filter(g => g.weekIndex === prevWeek) : [];

    const fmtGame = (g: typeof recentGames[0]) => {
      const winner = (g.homeScore ?? 0) > (g.awayScore ?? 0) ? g.homeTeamName : g.awayTeamName;
      return `  ${g.awayTeamName} @ ${g.homeTeamName}: ${g.awayScore}–${g.homeScore} (${winner} wins)`;
    };

    if (latestWeekGames.length > 0 && latestWeek !== undefined) {
      parts.push(`\nRECENT GAME RESULTS — ${weekIndexLabel(latestWeek)}:\n${latestWeekGames.map(fmtGame).join("\n")}`);
    }
    if (prevWeekGames.length > 0 && prevWeek !== undefined) {
      parts.push(`\nPREVIOUS WEEK GAME RESULTS — ${weekIndexLabel(prevWeek)}:\n${prevWeekGames.map(fmtGame).join("\n")}`);
    }
  }

  // ── Trade activity events (last 48 hours) ──────────────────────────────────
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  // Exclude offer_sent — those are private negotiations and cause the AI to
  // fabricate inaccurate "seeking" stories about the wrong team.
  const tradeEvents = await db.select()
    .from(leagueTwitterTradeEventsTable)
    .where(and(
      eq(leagueTwitterTradeEventsTable.seasonId, season.id),
      gte(leagueTwitterTradeEventsTable.createdAt, fortyEightHoursAgo),
      ne(leagueTwitterTradeEventsTable.eventType, "offer_sent"),
    ))
    .orderBy(desc(leagueTwitterTradeEventsTable.createdAt))
    .limit(10);

  if (tradeEvents.length > 0) {
    const lines = tradeEvents.map(e => `  [${e.eventType.replace(/_/g, " ")}] ${e.summary}`);
    parts.push(`\nRECENT TRADE BLOCK ACTIVITY (last 48 hours — only events you may reference for trade/roster rumors):\n${lines.join("\n")}`);
  } else {
    // Explicit signal to the model: no trade activity to reference
    parts.push(`\nRECENT TRADE BLOCK ACTIVITY: NONE in the last 48 hours. Do NOT invent or speculate about any trade block activity.`);
  }

  // ── Matchup cache (within 4-hour freshness window) ─────────────────────────
  const fourHoursAgo = new Date(Date.now() - FOUR_HOURS_MS);
  const cachedMatchups = await db.select()
    .from(leagueTwitterMatchupCacheTable)
    .where(and(
      eq(leagueTwitterMatchupCacheTable.seasonId, season.id),
      gte(leagueTwitterMatchupCacheTable.postedAt, fourHoursAgo),
    ))
    .orderBy(desc(leagueTwitterMatchupCacheTable.postedAt))
    .limit(1);

  if (cachedMatchups[0]) {
    const cm = cachedMatchups[0];
    parts.push(`\nUPCOMING MATCHUPS — ${cm.weekLabel} (just posted):\n${cm.matchupsText}`);
  }

  return parts.join("\n");
}

// ── Matchup cache writer (called by matchup runners after posting) ─────────────

/**
 * Call this right after the matchup embed is sent to the channel.
 * Writes plain-text matchup data to the cache so the twitter bot can reference
 * it for the next 4 hours.
 *
 * @param seasonId   - Current season ID
 * @param weekLabel  - Human-readable label, e.g. "Week 12" or "Wild Card"
 * @param games      - Array of { homeTeamName, awayTeamName } objects
 */
export async function cacheMatchupsForTwitter(
  seasonId:  number,
  weekLabel: string,
  games:     { homeTeamName: string; awayTeamName: string }[],
): Promise<void> {
  try {
    const matchupsText = games
      .map(g => `  ${g.awayTeamName} @ ${g.homeTeamName}`)
      .join("\n");

    await db.insert(leagueTwitterMatchupCacheTable).values({
      seasonId,
      weekLabel,
      matchupsText,
    });
    console.log(`[league-twitter] Cached ${games.length} matchups for "${weekLabel}"`);
  } catch (err) {
    console.error("[league-twitter] Failed to cache matchups:", err);
  }
}

// ── Trade event logger (called by trade block commands/interactions) ──────────

export type TradeEventType =
  | "listing_posted"
  | "iso_posted"
  | "offer_sent"
  | "trade_completed"
  | "listing_removed"
  | "iso_removed";

/**
 * Log a trade-related event for the League Twitter context window.
 * Call this from every trade block command/interaction that creates activity.
 * Events expire naturally from context after 48 hours.
 */
export async function logTradeEvent(opts: {
  seasonId:  number;
  eventType: TradeEventType;
  summary:   string;
  teamA?:    string;
  teamB?:    string;
}): Promise<void> {
  try {
    await db.insert(leagueTwitterTradeEventsTable).values({
      seasonId:  opts.seasonId,
      eventType: opts.eventType,
      summary:   opts.summary,
      teamA:     opts.teamA ?? null,
      teamB:     opts.teamB ?? null,
    });
  } catch (err) {
    console.error("[league-twitter] Failed to log trade event:", err);
  }
}

// ── Tweet generator ────────────────────────────────────────────────────────────

const TOPIC_PROMPTS = [
  // Game results
  "React to a specific completed game from RECENT GAME RESULTS — highlight the winner, the margin, or a surprising outcome.",
  "Pick a blowout or close game from RECENT GAME RESULTS and explain what it reveals about both teams.",
  "Focus on the SPOTLIGHT TEAM's most recent game result from RECENT GAME RESULTS. How did they perform?",

  // Standings / records
  "Comment on the SPOTLIGHT TEAM's in-game record from CURRENT STANDINGS — are they a legit contender or pretender?",
  "Make the case for a team with a losing record from CURRENT STANDINGS — why they can still make noise.",
  "Identify an overachieving team from CURRENT STANDINGS and ask if they're for real or due for a correction.",
  "Call out a team with a great record from CURRENT STANDINGS that you think is actually overrated based on their stats.",
  "Write a bold prediction about which team makes a late-season run based on their current form in the standings.",

  // Individual players
  "Focus on the SPOTLIGHT TEAM's top player from TEAM ROSTERS. Break down their season based on stat leaders in the context.",
  "Give a scouting report on a passing yards or TD leader from INDIVIDUAL STAT LEADERS — overhyped or underrated?",
  "Highlight the sack leader or best defensive player from INDIVIDUAL STAT LEADERS and what they mean to their team.",
  "Focus on the rushing yards leader from INDIVIDUAL STAT LEADERS and whether their team is built around them.",
  "Take a player from the SPOTLIGHT TEAM's roster and make the case for why they're underappreciated this season.",

  // Offense / defense
  "Praise or roast the SPOTLIGHT TEAM's offense using their real PPG or scoring data from the context.",
  "Analyze the SPOTLIGHT TEAM's defensive performance — are they a top or bottom unit based on points allowed?",
  "Comment on which defenses have been elite or awful this season based on points allowed in the team stat data.",
  "React to the league's highest-scoring offense from TEAM STAT HIGHLIGHTS — sustainable or a fluke?",
  "Highlight a team that scores a lot but also gives up a lot — which side will decide their fate?",

  // Matchups / previews
  "If UPCOMING MATCHUPS are listed in the context, hype up one specific game and predict the winner. Only use listed matchups.",
  "Pick two teams from CURRENT STANDINGS and preview their rivalry — which team has the edge right now?",

  // Trades / roster moves
  "If RECENT TRADE BLOCK ACTIVITY lists real events, react to one. If it says NONE, pick any other topic instead.",
  "Based on records and stats in context, assess which teams should be buyers or sellers at this point in the season.",

  // Trends / analysis
  "Comment on the league's turnover differential trends using the data in the context.",
  "Discuss whether this season belongs to the passing game or rushing game based on the stat leaders in context.",
  "Write a hot take about the biggest surprise — best or worst — team in the league using only context data.",
  "Compare the SPOTLIGHT TEAM to the top team in the standings and explain what separates them.",
];

// ── Topic rotation queue ────────────────────────────────────────────────────────
// Topics are shuffled into a queue and consumed in order so the same topic
// never fires twice in close succession. The queue reshuffles when exhausted.
let _topicQueue: number[] = [];
let _topicPos   = 0;

function nextTopicIndex(): number {
  if (_topicPos >= _topicQueue.length) {
    _topicQueue = Array.from({ length: TOPIC_PROMPTS.length }, (_, i) => i)
      .sort(() => Math.random() - 0.5);
    _topicPos = 0;
  }
  return _topicQueue[_topicPos++]!;
}

// ── Spotlight team picker ───────────────────────────────────────────────────────
// For each tweet we pick a "spotlight team" that hasn't been mentioned recently.
// This forces coverage spread across the whole league rather than fixating on
// the same 2-3 teams the AI finds most interesting.
function pickSpotlightTeam(allTeams: string[], recentTeams: string[]): string | null {
  const recentSet = new Set(recentTeams);
  const fresh = allTeams.filter(t => !recentSet.has(t));
  if (fresh.length > 0) {
    return fresh[Math.floor(Math.random() * fresh.length)]!;
  }
  // All teams recently mentioned — pick anyone not in the last 3
  const last3 = new Set(recentTeams.slice(0, 3));
  const fallback = allTeams.filter(t => !last3.has(t));
  return fallback[Math.floor(Math.random() * fallback.length)] ?? null;
}

async function generateTweet(
  reporter:     Reporter,
  context:      string,
  recentTeams:  string[] = [],
  spotlightTeam: string | null = null,
): Promise<string> {
  const topicIdx = nextTopicIndex();
  // Replace the placeholder token with the actual spotlight team name in the topic
  const rawTopic = TOPIC_PROMPTS[topicIdx]!;
  const topic    = spotlightTeam
    ? rawTopic.replace(/SPOTLIGHT TEAM/g, spotlightTeam)
    : rawTopic.replace(/the SPOTLIGHT TEAM('s)?/g, "any team in the league$1");

  const spotlightDirective = spotlightTeam
    ? `\n- SPOTLIGHT: This tweet's main subject MUST be the **${spotlightTeam}**. Do not make another team the focal point.`
    : "";

  // Build avoidance directive from recently-featured teams
  const avoidDirective = recentTeams.length > 0
    ? `\n- VARIETY: These teams have dominated recent tweets — do NOT make them the main subject: ${recentTeams.join(", ")}. Choose a different team unless the spotlight overrides this.`
    : `\n- VARIETY: Rotate through all teams in the league. Never fixate on the same team twice in a row.`;

  const system = `You are ${reporter.name} (${reporter.handle}), a sports reporter/personality for ${reporter.outlet}.
Voice & Personality: ${reporter.style}

You are covering the **R.E.C. League** — a Madden CFM (franchise mode) football league. Treat it as a REAL league with real drama, real storylines, and real stakes. Never break the fourth wall.

Write a single post in your authentic voice (max 260 characters). Make it feel like a real-time sports Twitter post — not templated, not robotic.

---
CONTENT PRIORITY ORDER — work through this list and pick the highest available topic:
1. Recent game results (RECENT GAME RESULTS in context) — react, highlight standouts, call out upsets
2. Upcoming matchups (UPCOMING MATCHUPS in context) — build anticipation, pick a side, tease rivalries
3. Confirmed trades/moves (RECENT TRADE BLOCK ACTIVITY — only if real events are listed, not NONE)
4. Player & team performance breakdowns using INDIVIDUAL STAT LEADERS or TEAM STAT HIGHLIGHTS
5. Standings trends, hot/cold teams, contender vs. pretender takes from CURRENT STANDINGS
6. Playoff picture commentary using CURRENT PLAYOFF SEEDS or CURRENT PLAYOFF FIELD
7. If NONE of the above have usable data — write a light observation, ranking, or general league commentary based on any real data available. NEVER fabricate content.

---
STYLE RULES:
- Stay fully in character — tone, vocabulary, sentence rhythm should all match your personality
- Vary structure every time — avoid sounding templated or repetitive
- Insider reporters (Shaffer, Rappaport, Pellissarro, Rossini): short, factual, "per sources" / "I'm told" framing
- Loud pundits (Stone, Burke): frequent ALL CAPS for emphasis, sweeping declarations, first-person passion
- Hype personalities (McCaffrey, Williams): exclamation points, emoji where it fits, informal and fun
- Johnny Manziel: rambling, third-person ("Johnny Football doesn't miss"), slurred run-on energy, randomly brings up his own career, 💰 emoji, cocky but barely coherent, contradicts himself and doubles down
- Polished hosts (Avery, Norris): warm, story-driven, accountable takes
- Emojis are fine if they suit your persona (especially 🔥 🚨 👀 for hype types)
- Do NOT use hashtags
- Do NOT mention this is a video game or simulation
- Output ONLY the tweet text — no labels, no preamble${spotlightDirective}${avoidDirective}

---
CRITICAL DATA RULES — violating any of these is a failure:
- RECORDS: Use ONLY the in-game W-L from CURRENT STANDINGS. If it says "Data not available", do NOT mention any team's record — pivot to players or game scores instead.
- ROSTERS: Only say a player is on a team if they appear in that team's TEAM ROSTERS entry. Never invent or move players.
- TRADE RUMORS: NEVER imply a team is shopping, trading, releasing, or seeking anyone unless that exact event is in RECENT TRADE BLOCK ACTIVITY. If it says NONE, pick a different topic entirely.
- MATCHUPS: Only reference an upcoming game if that exact matchup is listed under UPCOMING MATCHUPS.
- NO H2H RECORDS: Do not cite head-to-head records between teams.
- PLAYOFFS: NEVER call a team a playoff team unless they appear in CURRENT PLAYOFF SEEDS or CURRENT PLAYOFF FIELD. Teams listed as eliminated are OUT — no playoff implications for them, ever.
- STATS: Every number MUST come verbatim from INDIVIDUAL STAT LEADERS or TEAM STAT HIGHLIGHTS. Do not round, estimate, or invent any statistic. If a player's exact number isn't listed, name them without a number.`;

  const user = `LEAGUE CONTEXT:\n${context}\n\nTOPIC ANGLE: ${topic}\n\nWrite your tweet:`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user },
    ],
    max_tokens: 120,
    temperature: 0.9,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

// ── Reply generator ─────────────────────────────────────────────────────────────

export async function generateReply(
  reporter: Reporter,
  originalTweet: string,
  replyContent: string,
  context: string,
): Promise<string> {
  const system = `You are ${reporter.name} (${reporter.handle}), a sports reporter/personality for ${reporter.outlet}.
Voice & Personality: ${reporter.style}

You posted a tweet about the R.E.C. League (a Madden CFM franchise-mode football league treated as a REAL league).
A fan just replied to your tweet. Respond as yourself — stay fully in your persona.

Rules:
- Match your personality exactly: loud pundits stay loud, insiders stay dry, hype personalities stay fun
- Be direct, human, and conversational — like a real person replying on Twitter/X
- Insider types can use "per sources", pundits can get animated, personalities can be playful
- Max 220 characters
- No hashtags
- Output ONLY the reply text, nothing else`;

  const user =
    `Your original tweet: "${originalTweet}"\n\n` +
    `Fan replied: "${replyContent}"\n\n` +
    `League context for reference:\n${context}\n\nYour reply:`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user },
    ],
    max_tokens: 100,
    temperature: 0.85,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

// ── Post a tweet to the channel ────────────────────────────────────────────────

/** Post a single tweet from the given reporter and persist it to the DB. */
async function postOneTweet(
  tc:            TextChannel,
  reporter:      Reporter,
  context:       string,
  seasonId:      number,
  recentTeams:   string[] = [],
  spotlightTeam: string | null = null,
): Promise<void> {
  const tweetText = await generateTweet(reporter, context, recentTeams, spotlightTeam);
  if (!tweetText) return;

  const header = `**${reporter.name}** ${reporter.handle} · *${reporter.outlet}*`;
  const msg = await tc.send(`${header}\n\n${tweetText}`);

  await db.insert(leagueTwitterTable).values({
    seasonId,
    messageId:      msg.id,
    reporterName:   reporter.name,
    reporterHandle: reporter.handle,
    content:        tweetText,
  });

  console.log(`[league-twitter] Posted tweet by ${reporter.name}`);
}

/**
 * Posts 1–3 tweets at each interval.
 * The count is randomly selected; reporters are always different within a burst
 * and won't repeat the last reporter from the previous interval.
 */
export async function postLeagueTweet(client: Client): Promise<void> {
  try {
    const season  = await getOrCreateActiveSeason();
    const context = await buildLeagueContext(season);

    const ch = client.channels.cache.get(LEAGUE_TWITTER_CHANNEL_ID)
      ?? await client.channels.fetch(LEAGUE_TWITTER_CHANNEL_ID).catch(() => null);
    if (!ch?.isTextBased()) return;
    const tc = ch as TextChannel;

    // How many tweets this burst — max 2 to prevent topic clustering
    const count = Math.random() < 0.55 ? 1 : 2;

    // ── Pull all known human-team names ────────────────────────────────────────
    const userTeams = await db.select({ team: usersTable.team })
      .from(usersTable)
      .where(isNotNull(usersTable.team));

    const knownTeams = [...new Set(
      userTeams.map(u => u.team).filter((t): t is string => !!t && t.trim().length > 0)
    )];

    // ── Fetch recent tweet history to detect overused teams ────────────────────
    // Look back 14 tweets — any team appearing even once is flagged as "recent".
    // Threshold of 1 (instead of 2) ensures much wider rotation.
    const recentTweets = await db.select({
      content:      leagueTwitterTable.content,
      reporterName: leagueTwitterTable.reporterName,
    })
      .from(leagueTwitterTable)
      .where(eq(leagueTwitterTable.seasonId, season.id))
      .orderBy(desc(leagueTwitterTable.postedAt))
      .limit(14);

    // Count team mentions across the recent window
    const teamMentionCount = new Map<string, number>();
    for (const { content } of recentTweets) {
      if (!content) continue;
      for (const teamName of knownTeams) {
        const words = teamName.split(/\s+/);
        const matched = words.some(w =>
          w.length > 3 && new RegExp(`\\b${w}\\b`, "i").test(content)
        );
        if (matched) {
          teamMentionCount.set(teamName, (teamMentionCount.get(teamName) ?? 0) + 1);
        }
      }
    }

    // Any team mentioned 1+ time in the last 14 tweets is "recently covered"
    const recentlyUsedTeams = [...teamMentionCount.entries()]
      .filter(([, c]) => c >= 1)
      .map(([team]) => team);

    // Seed: avoid repeating the reporter from the previous interval's last tweet
    const [lastTweet] = await db.select({ reporterName: leagueTwitterTable.reporterName })
      .from(leagueTwitterTable)
      .where(eq(leagueTwitterTable.seasonId, season.id))
      .orderBy(desc(leagueTwitterTable.postedAt))
      .limit(1);

    const usedReporters = new Set<string>(lastTweet ? [lastTweet.reporterName] : []);

    // Track spotlight teams used within this burst so each tweet covers a different team
    const burstSpotlights = new Set<string>();

    for (let i = 0; i < count; i++) {
      // Pick a reporter not already used this burst (or last interval's last tweet)
      const available = REPORTERS.filter(r => !usedReporters.has(r.name));
      const reporter  = available.length > 0
        ? available[Math.floor(Math.random() * available.length)]!
        : REPORTERS[Math.floor(Math.random() * REPORTERS.length)]!;

      usedReporters.add(reporter.name);

      // Pick a spotlight team: avoid recently used AND already spotlighted this burst
      const avoidForSpotlight = [...new Set([...recentlyUsedTeams, ...burstSpotlights])];
      const spotlight = pickSpotlightTeam(knownTeams, avoidForSpotlight);
      if (spotlight) burstSpotlights.add(spotlight);

      await postOneTweet(tc, reporter, context, season.id, recentlyUsedTeams, spotlight);

      // Short pause between tweets in the same burst
      if (i < count - 1) {
        await new Promise(resolve => setTimeout(resolve, 4_000 + Math.random() * 6_000));
      }
    }
  } catch (err) {
    console.error("[league-twitter] Error posting tweet:", err);
  }
}

// ── Handle a user reply to a tweet ────────────────────────────────────────────

export async function handleTwitterReply(client: Client, message: import("discord.js").Message): Promise<void> {
  try {
    if (!message.reference?.messageId) return;

    const season = await getOrCreateActiveSeason().catch(() => null);
    if (!season) return;

    const [tweetRow] = await db.select()
      .from(leagueTwitterTable)
      .where(eq(leagueTwitterTable.messageId, message.reference.messageId))
      .limit(1);

    if (!tweetRow) return; // The referenced message isn't one of our tweets

    const reporter: Reporter = REPORTERS.find(r => r.name === tweetRow.reporterName)
      ?? { name: tweetRow.reporterName, handle: tweetRow.reporterHandle, outlet: "NFL Network", style: "Direct and factual." };

    const context = await buildLeagueContext(season);
    const replyText = await generateReply(reporter, tweetRow.content, message.content, context);
    if (!replyText) return;

    const header = `**${reporter.name}** ${reporter.handle}`;
    await message.reply(`${header}\n\n${replyText}`);
  } catch (err) {
    console.error("[league-twitter] Reply error:", err);
  }
}

// ── Wipe channel messages and DB rows for a new season ────────────────────────

export async function wipeLeagueTwitterSeason(
  client: Client,
  seasonId: number,
): Promise<void> {
  try {
    // Purge DB records for this season
    await db.delete(leagueTwitterTable).where(eq(leagueTwitterTable.seasonId, seasonId));

    // Purge Discord channel messages
    const ch = client.channels.cache.get(LEAGUE_TWITTER_CHANNEL_ID)
      ?? await client.channels.fetch(LEAGUE_TWITTER_CHANNEL_ID).catch(() => null);
    if (!ch?.isTextBased()) return;
    const tc = ch as TextChannel;

    let lastId: string | undefined;
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const msgs = await tc.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
      if (msgs.size === 0) break;
      for (const msg of msgs.values()) {
        await msg.delete().catch(() => {});
        total++;
      }
      lastId = msgs.last()?.id;
    }
    console.log(`[league-twitter] Wiped ${total} messages from twitter channel`);
  } catch (err) {
    console.error("[league-twitter] Wipe error:", err);
  }
}

// ── Scheduler ──────────────────────────────────────────────────────────────────

export function startLeagueTwitterScheduler(client: Client): void {
  // Post immediately on startup (small delay so the client is ready), then every 3 hours
  setTimeout(() => {
    postLeagueTweet(client).catch(err => console.error("[league-twitter] Startup tweet error:", err));
  }, 15_000); // 15-second delay after startup

  setInterval(() => {
    postLeagueTweet(client).catch(err => console.error("[league-twitter] Scheduled tweet error:", err));
  }, THREE_HOURS_MS);

  console.log("✅ League Twitter scheduler started (every 3 hours)");
}
