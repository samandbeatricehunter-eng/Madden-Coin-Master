import OpenAI from "openai";
import { db, playerSeasonStatsTable, franchiseScheduleTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  getWeekResultsFromGcs,
  getUpcomingMatchupsFromGcs,
  getArticleStandings,
  type GcsGame,
  type ArticleStanding,
} from "./gcs-fallback.js";

// ── Divisional standings formatter ────────────────────────────────────────────
// Builds the standings context section broken out by conference and division,
// with a current playoff picture (4 division winners + 3 wild cards per conf).
function formatConferenceStandingsContext(
  records:   ArticleStanding[],
  weekLabel: string,
): string[] {
  const parts: string[] = [];
  const CONFERENCES = ["AFC", "NFC"] as const;
  const DIVISIONS   = ["East", "North", "South", "West"] as const;

  const known   = records.filter(r => r.conference !== null);
  const unknown = records.filter(r => r.conference === null);

  for (const conf of CONFERENCES) {
    const confTeams = known
      .filter(r => r.conference === conf)
      .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
    if (confTeams.length === 0) continue;

    parts.push(`=== ${conf} STANDINGS (${weekLabel}) ===`);

    // Per-division breakdown
    for (const div of DIVISIONS) {
      const divTeams = confTeams
        .filter(r => r.division === div)
        .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
      if (divTeams.length === 0) continue;
      parts.push(`${conf} ${div}:`);
      for (const t of divTeams) {
        const pd   = t.pointDifferential >= 0 ? `+${t.pointDifferential}` : `${t.pointDifferential}`;
        const user = t.discordUsername ? ` (${t.discordUsername})` : "";
        parts.push(`  ${t.teamName}${user} ${t.wins}-${t.losses} [PD ${pd}]`);
      }
    }
    parts.push("");

    // Playoff picture — top team per division = division winner; next 3 = wild cards
    const divWinners: ArticleStanding[] = [];
    for (const div of DIVISIONS) {
      const top = confTeams
        .filter(r => r.division === div)
        .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential)[0];
      if (top) divWinners.push(top);
    }
    const divWinnerSet  = new Set(divWinners.map(t => t.teamName));
    const sortedWinners = divWinners.sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
    const wildCards     = confTeams.filter(t => !divWinnerSet.has(t.teamName)).slice(0, 3);
    const playoffTeams  = [...sortedWinners, ...wildCards];
    const bubbleTeams   = confTeams.filter(t => !playoffTeams.some(p => p.teamName === t.teamName)).slice(0, 3);

    parts.push(`${conf} PLAYOFF PICTURE (7 teams make it: 4 division winners + 3 wild cards):`);
    playoffTeams.forEach((t, i) => {
      const label = i < 4 ? `#${i + 1} seed — Division Winner` : `#${i + 1} seed — Wild Card`;
      parts.push(`  ${label}: ${t.teamName} (${t.wins}-${t.losses})`);
    });
    if (bubbleTeams.length > 0) {
      const wcCutline = wildCards[2]?.wins ?? 0;
      parts.push(`${conf} bubble (chasing last wild card spot):`);
      for (const t of bubbleTeams) {
        const gb = wcCutline - t.wins;
        parts.push(`  ${t.teamName} (${t.wins}-${t.losses}) — ${gb} win${gb !== 1 ? "s" : ""} back`);
      }
    }
    parts.push("");
  }

  // Notable streaks
  const gamesPlayed = records.length > 0 ? Math.max(...records.map(r => r.wins + r.losses)) : 0;
  if (gamesPlayed > 0) {
    const undefeated = records.filter(r => r.losses === 0 && r.wins > 0);
    const winless    = records.filter(r => r.wins  === 0 && r.losses > 0);
    if (undefeated.length > 0) {
      const names = undefeated.map(r => `${r.teamName} (${r.conference ?? "?"} ${r.division ?? "?"})`).join(", ");
      parts.push(`NOTABLE: UNDEFEATED (${undefeated[0]!.wins}-0): ${names}`);
      parts.push("");
    }
    if (winless.length > 0) {
      const names = winless.map(r => `${r.teamName} (${r.conference ?? "?"} ${r.division ?? "?"})`).join(", ");
      parts.push(`NOTABLE: WINLESS (0-${winless[0]!.losses}): ${names}`);
      parts.push("");
    }
  }

  // Any teams the lookup couldn't classify
  if (unknown.length > 0) {
    parts.push("=== UNCLASSIFIED TEAMS ===");
    for (const t of unknown) {
      const pd = t.pointDifferential >= 0 ? `+${t.pointDifferential}` : `${t.pointDifferential}`;
      parts.push(`${t.teamName}: ${t.wins}-${t.losses} [PD ${pd}]`);
    }
    parts.push("");
  }

  return parts;
}

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "dummy",
});

// ── Pull all league data needed for the article ────────────────────────────────
async function buildLeagueContext(
  seasonId: number,
  completedWeekIndex: number,
  seasonNumber: number,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`The R.E.C. League — Season ${seasonNumber}, just finished Week ${completedWeekIndex + 1}`);
  parts.push("");

  // ── Standings ────────────────────────────────────────────────────────────────
  // Use GCS-first standings so all 32 teams appear (not just bot-registered users)
  const records = await getArticleStandings(seasonId, completedWeekIndex + 1);

  if (records.length > 0) {
    parts.push(...formatConferenceStandingsContext(records, `after Week ${completedWeekIndex + 1}`));
  }

  // ── Last week's scores ───────────────────────────────────────────────────────
  const weekGames = await db
    .select({
      homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
      homeScore:    franchiseScheduleTable.homeScore,
      awayScore:    franchiseScheduleTable.awayScore,
      status:       franchiseScheduleTable.status,
    })
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  seasonId),
      eq(franchiseScheduleTable.weekIndex, completedWeekIndex),
    ));

  // ── Completed game results — DB first, GCS fallback ─────────────────────────
  const weekNum = completedWeekIndex + 1;
  let playedGames: GcsGame[] = weekGames
    .filter(g => g.homeScore !== null && g.awayScore !== null)
    .map(g => ({
      homeTeamName: g.homeTeamName,
      awayTeamName: g.awayTeamName,
      homeScore:    g.homeScore,
      awayScore:    g.awayScore,
      isH2H:        g.status === 3,
    }));

  if (playedGames.length === 0) {
    // DB has no results — try GCS
    playedGames = await getWeekResultsFromGcs(weekNum);
  }

  if (playedGames.length > 0) {
    parts.push(`=== WEEK ${weekNum} RESULTS ===`);
    parts.push("Format: WINNING TEAM defeated LOSING TEAM, WINNER SCORE–LOSER SCORE");
    for (const g of playedGames) {
      const hs = g.homeScore ?? 0, as_ = g.awayScore ?? 0;
      const [winner, winScore, loser, loseScore] = hs >= as_
        ? [g.homeTeamName, hs, g.awayTeamName, as_]
        : [g.awayTeamName, as_, g.homeTeamName, hs];
      const type = g.isH2H ? "H2H" : "vs CPU";
      parts.push(`${winner} defeated ${loser}, ${winScore}–${loseScore} [${type}]`);
    }
    parts.push("");
  } else {
    parts.push(`=== WEEK ${weekNum} RESULTS ===`);
    parts.push("No game results available for this week. Do NOT invent scores or claim any games were played.");
    parts.push("");
  }

  // ── Upcoming week's actual schedule — DB first, GCS fallback ─────────────
  const upcomingWeekIndex = completedWeekIndex + 1;
  const upcomingWeekNum   = upcomingWeekIndex + 1;

  let upcomingGamesRaw = await db
    .select({
      homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
      status:       franchiseScheduleTable.status,
    })
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  seasonId),
      eq(franchiseScheduleTable.weekIndex, upcomingWeekIndex),
    ));

  let upcomingGames: GcsGame[] = upcomingGamesRaw.map(g => ({
    homeTeamName: g.homeTeamName,
    awayTeamName: g.awayTeamName,
    homeScore:    null,
    awayScore:    null,
    isH2H:        g.status === 3,
  }));

  if (upcomingGames.length === 0) {
    upcomingGames = await getUpcomingMatchupsFromGcs(upcomingWeekNum); // 1-based
  }

  if (upcomingGames.length > 0) {
    const h2h = upcomingGames.filter(g => g.isH2H);
    const cpu  = upcomingGames.filter(g => !g.isH2H);
    parts.push(`=== WEEK ${upcomingWeekNum} UPCOMING MATCHUPS (use ONLY these when teasing next week) ===`);
    for (const g of h2h) parts.push(`${g.awayTeamName} @ ${g.homeTeamName} (H2H)`);
    for (const g of cpu)  parts.push(`${g.awayTeamName} @ ${g.homeTeamName} (vs CPU)`);
    parts.push("IMPORTANT: Only reference the matchups listed above when looking ahead. Do not invent or reuse games from this week.");
    parts.push("");
  } else {
    parts.push("No upcoming schedule data available. Do not invent or speculate about specific Week " + upcomingWeekNum + " matchups.");
    parts.push("");
  }

  // ── Passing leaders ──────────────────────────────────────────────────────────
  const passLeaders = await db
    .select({
      firstName: playerSeasonStatsTable.firstName,
      lastName:  playerSeasonStatsTable.lastName,
      teamName:  playerSeasonStatsTable.teamName,
      position:  playerSeasonStatsTable.position,
      passYds:   playerSeasonStatsTable.passYds,
      passTDs:   playerSeasonStatsTable.passTDs,
    })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, seasonId))
    .orderBy(desc(playerSeasonStatsTable.passYds))
    .limit(10);

  const hasPassData = passLeaders.some(p => p.passYds > 0);
  if (hasPassData) {
    parts.push("=== PASSING LEADERS (Season) ===");
    for (const p of passLeaders.filter(p => p.passYds > 0)) {
      parts.push(`${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.passYds} yds, ${p.passTDs} TDs`);
    }
    parts.push("");
  }

  // ── Rushing leaders ──────────────────────────────────────────────────────────
  const rushLeaders = await db
    .select({
      firstName: playerSeasonStatsTable.firstName,
      lastName:  playerSeasonStatsTable.lastName,
      teamName:  playerSeasonStatsTable.teamName,
      position:  playerSeasonStatsTable.position,
      rushYds:   playerSeasonStatsTable.rushYds,
      rushTDs:   playerSeasonStatsTable.rushTDs,
    })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, seasonId))
    .orderBy(desc(playerSeasonStatsTable.rushYds))
    .limit(10);

  const hasRushData = rushLeaders.some(p => p.rushYds > 0);
  if (hasRushData) {
    parts.push("=== RUSHING LEADERS (Season) ===");
    for (const p of rushLeaders.filter(p => p.rushYds > 0)) {
      parts.push(`${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.rushYds} yds, ${p.rushTDs} TDs`);
    }
    parts.push("");
  }

  // ── Receiving leaders ────────────────────────────────────────────────────────
  const recLeaders = await db
    .select({
      firstName: playerSeasonStatsTable.firstName,
      lastName:  playerSeasonStatsTable.lastName,
      teamName:  playerSeasonStatsTable.teamName,
      position:  playerSeasonStatsTable.position,
      recYds:    playerSeasonStatsTable.recYds,
      recTDs:    playerSeasonStatsTable.recTDs,
    })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, seasonId))
    .orderBy(desc(playerSeasonStatsTable.recYds))
    .limit(10);

  const hasRecData = recLeaders.some(p => p.recYds > 0);
  if (hasRecData) {
    parts.push("=== RECEIVING LEADERS (Season) ===");
    for (const p of recLeaders.filter(p => p.recYds > 0)) {
      parts.push(`${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.recYds} yds, ${p.recTDs} TDs`);
    }
    parts.push("");
  }

  // ── Defense leaders (sacks + INTs) ──────────────────────────────────────────
  const sackLeaders = await db
    .select({
      firstName: playerSeasonStatsTable.firstName,
      lastName:  playerSeasonStatsTable.lastName,
      teamName:  playerSeasonStatsTable.teamName,
      position:  playerSeasonStatsTable.position,
      sacks:     playerSeasonStatsTable.sacks,
      defInts:   playerSeasonStatsTable.defInts,
    })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, seasonId))
    .orderBy(desc(playerSeasonStatsTable.sacks))
    .limit(10);

  const hasSackData = sackLeaders.some(p => p.sacks > 0);
  if (hasSackData) {
    parts.push("=== SACK LEADERS (Season) ===");
    for (const p of sackLeaders.filter(p => p.sacks > 0)) {
      parts.push(`${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.sacks} sacks, ${p.defInts} INTs`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ── Preview context builder ────────────────────────────────────────────────────
// Pulls current standings + the scheduled matchups for the upcoming week.
async function buildPreviewContext(
  seasonId:     number,
  weekIndex:    number,   // 0-based index of the week being previewed
  seasonNumber: number,
): Promise<string> {
  const parts: string[] = [];
  const weekNum = weekIndex + 1;

  parts.push(`The R.E.C. League — Season ${seasonNumber}, previewing Week ${weekNum}`);
  parts.push("");

  // ── Current standings (going into the week) ───────────────────────────────
  // GCS-first so all teams appear, not just bot-registered users.
  // weekNum here is the UPCOMING week, so last completed week = weekNum - 1.
  const records = await getArticleStandings(seasonId, weekNum - 1);

  if (records.length > 0) {
    parts.push(...formatConferenceStandingsContext(records, `heading into Week ${weekNum}`));
  }

  // ── Scheduled matchups for the preview week — DB first, GCS fallback ────────
  const matchupsRaw = await db
    .select({
      homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
      status:       franchiseScheduleTable.status,
    })
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  seasonId),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ));

  let matchups: GcsGame[] = matchupsRaw.map(g => ({
    homeTeamName: g.homeTeamName,
    awayTeamName: g.awayTeamName,
    homeScore:    null,
    awayScore:    null,
    isH2H:        g.status === 3,
  }));

  if (matchups.length === 0) {
    matchups = await getUpcomingMatchupsFromGcs(weekNum); // weekNum is already 1-based
  }

  const h2hGames = matchups.filter(g => g.isH2H);
  const cpuGames = matchups.filter(g => !g.isH2H);

  if (matchups.length === 0) {
    parts.push(`=== WEEK ${weekNum} MATCHUPS ===`);
    parts.push("No schedule data available for this week. Do NOT invent matchups.");
    parts.push("");
  } else {
    if (h2hGames.length > 0) {
      parts.push(`=== WEEK ${weekNum} H2H MATCHUPS (user vs user) ===`);
      for (const g of h2hGames) {
        parts.push(`${g.awayTeamName} @ ${g.homeTeamName}`);
      }
      parts.push("");
    }
    if (cpuGames.length > 0) {
      parts.push(`=== WEEK ${weekNum} CPU MATCHUPS ===`);
      for (const g of cpuGames) {
        parts.push(`${g.awayTeamName} @ ${g.homeTeamName} (vs CPU)`);
      }
      parts.push("");
    }
  }

  // ── Season stat leaders (context for players to watch) ────────────────────
  const passLeaders = await db
    .select({
      firstName: playerSeasonStatsTable.firstName,
      lastName:  playerSeasonStatsTable.lastName,
      teamName:  playerSeasonStatsTable.teamName,
      passYds:   playerSeasonStatsTable.passYds,
      passTDs:   playerSeasonStatsTable.passTDs,
    })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, seasonId))
    .orderBy(desc(playerSeasonStatsTable.passYds))
    .limit(3);

  const rushLeaders = await db
    .select({
      firstName: playerSeasonStatsTable.firstName,
      lastName:  playerSeasonStatsTable.lastName,
      teamName:  playerSeasonStatsTable.teamName,
      rushYds:   playerSeasonStatsTable.rushYds,
      rushTDs:   playerSeasonStatsTable.rushTDs,
    })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, seasonId))
    .orderBy(desc(playerSeasonStatsTable.rushYds))
    .limit(3);

  if (passLeaders.some(p => p.passYds > 0)) {
    parts.push("=== PLAYERS TO WATCH — PASSING ===");
    for (const p of passLeaders.filter(p => p.passYds > 0)) {
      parts.push(`${p.firstName} ${p.lastName} (${p.teamName}): ${p.passYds} yds, ${p.passTDs} TDs this season`);
    }
    parts.push("");
  }

  if (rushLeaders.some(p => p.rushYds > 0)) {
    parts.push("=== PLAYERS TO WATCH — RUSHING ===");
    for (const p of rushLeaders.filter(p => p.rushYds > 0)) {
      parts.push(`${p.firstName} ${p.lastName} (${p.teamName}): ${p.rushYds} yds, ${p.rushTDs} TDs this season`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ── Recap article (default — after a week completes) ─────────────────────────
export async function generateFranchiseArticle(
  seasonId:            number,
  seasonNumber:        number,
  completedWeekIndex:  number,  // 0-based index of the week that just finished
  upcomingWeekLabel:   string,  // e.g. "Week 7" or "Wildcard"
): Promise<string> {
  const context = await buildLeagueContext(seasonId, completedWeekIndex, seasonNumber);

  const prompt = `You are a sports journalist covering The R.E.C. League — a Madden NFL franchise simulation league.
Write a short, engaging league newsletter article (around 400–500 words) recapping the week that just ended and looking ahead to ${upcomingWeekLabel}.

Always refer to the league by its full name: "The R.E.C. League". Never call it a "simulation league", "CFM league", or any other generic label.

This is a RECAP article. Cover what happened: scores, winners, losers, standout performers, and any notable storylines.

CRITICAL — FACTUAL ACCURACY ON GAME RESULTS:
The WEEK RESULTS section below uses the format "WINNER defeated LOSER, WINNER_SCORE–LOSER_SCORE".
The team listed FIRST is always the WINNER. The team listed SECOND is always the LOSER.
You MUST report each game exactly as listed — never swap the winner and loser, never invent scores, never omit a result.
If a result says "Jaguars defeated Texans", then the Jaguars WON and the Texans LOST — do not reverse this under any circumstances.

CRITICAL — NO INVENTED PLAYER NAMES:
Only name specific players that appear explicitly in the STATS sections of the LEAGUE DATA below.
Do NOT use your general knowledge of Madden rosters, NFL rosters, or any outside source to assign players to teams.
If a team's players do not appear in the stats data, write about that team using only their team name and game result — never guess or invent a player name for them.
A wrong player name is worse than no player name.

CRITICAL — CONFERENCE STRUCTURE:
The league follows real NFL conference and division alignment. The data includes AFC and NFC standings broken out by division.
- An AFC team is competing for AFC playoff seeds. An NFC team is competing for NFC playoff seeds.
- Never pit an AFC team against an NFC team in a "playoff race" discussion — they are in different conferences.
- When discussing who is "in the hunt" or "fighting for a playoff spot", refer to teams in the same conference.
- Mention division leaders and how key games affected the divisional and wild-card race within each conference.
- Reference the playoff picture section to identify which teams are division leaders, wild-card contenders, or on the bubble.

End with a brief tease of what's coming next (${upcomingWeekLabel}).

Use the data below. Reference players and teams by name. Write in an energetic, sports-media tone — like an ESPN or NFL Network column.
Avoid generic filler. Make it feel authentic and specific to The R.E.C. League.

Do NOT include headers or markdown. Just write flowing paragraphs as a cohesive article.
Start with a strong opening line that references the week number.

LEAGUE DATA:
${context}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_completion_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response");
  return text;
}

// ── Preview article (hype upcoming matchups before the week is played) ────────
export async function generateWeekPreview(
  seasonId:     number,
  seasonNumber: number,
  weekIndex:    number,  // 0-based index of the week being previewed
): Promise<string> {
  const weekNum = weekIndex + 1;
  const context = await buildPreviewContext(seasonId, weekIndex, seasonNumber);

  const prompt = `You are a sports journalist covering The R.E.C. League — a Madden NFL franchise simulation league.
Write a short, engaging league newsletter article (around 400–500 words) previewing Week ${weekNum} — the games have NOT been played yet.

Always refer to the league by its full name: "The R.E.C. League". Never call it a "simulation league", "CFM league", or any other generic label.

This is a PREVIEW article. Hype the key matchups, highlight the stakes for each team, call out players to watch, and build anticipation.
Do NOT report scores or results — the games haven't happened yet.

CRITICAL — NO INVENTED PLAYER NAMES:
Only name specific players that appear explicitly in the STATS sections of the LEAGUE DATA below.
Do NOT use your general knowledge of Madden rosters, NFL rosters, or any outside source to assign players to teams.
If a team's players do not appear in the stats data, preview that team using only their team name and standings — never guess or invent a player name for them.
A wrong player name is worse than no player name.

CRITICAL — CONFERENCE STRUCTURE:
The league follows real NFL conference and division alignment. The data includes AFC and NFC standings broken out by division.
- AFC teams compete for AFC playoff seeds; NFC teams compete for NFC playoff seeds. Keep these separate.
- Never suggest an AFC team is chasing a playoff spot alongside an NFC team — they play for different conferences.
- When building drama around matchups, frame divisional games as races for division titles and cross-division games
  as battles for wild-card position within the correct conference.
- Reference the playoff picture section to identify which teams are locked in, fighting for wild cards, or on the bubble
  in their respective conference.

Use the data below. Reference players and teams by name. Write in an energetic, sports-media tone — like an ESPN or NFL Network column.
Avoid generic filler. Make it feel authentic and specific to The R.E.C. League.

Do NOT include headers or markdown. Just write flowing paragraphs as a cohesive article.
Start with a strong opening line that builds excitement for Week ${weekNum}.

LEAGUE DATA:
${context}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_completion_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response");
  return text;
}
