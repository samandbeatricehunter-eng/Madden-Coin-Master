import OpenAI from "openai";
import { db } from "@workspace/db";
import {
  userRecordsTable, playerSeasonStatsTable, franchiseScheduleTable,
  usersTable,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  getWeekResultsFromGcs,
  getUpcomingMatchupsFromGcs,
  type GcsGame,
} from "./gcs-fallback.js";

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
  const records = await db
    .select({
      discordId:         userRecordsTable.discordId,
      discordUsername:   userRecordsTable.discordUsername,
      team:              userRecordsTable.team,
      wins:              userRecordsTable.wins,
      losses:            userRecordsTable.losses,
      pointDifferential: userRecordsTable.pointDifferential,
    })
    .from(userRecordsTable)
    .where(eq(userRecordsTable.seasonId, seasonId))
    .orderBy(desc(userRecordsTable.wins));

  if (records.length > 0) {
    parts.push("=== CURRENT STANDINGS ===");
    for (const r of records) {
      const teamStr = r.team ? `${r.team}` : r.discordUsername;
      const pd      = r.pointDifferential >= 0 ? `+${r.pointDifferential}` : String(r.pointDifferential);
      parts.push(`${teamStr} (${r.discordUsername}): ${r.wins}-${r.losses}, Point Diff ${pd}`);
    }
    parts.push("");

    // Explicitly flag notable records so the AI doesn't miss them
    const gamesPlayed = Math.max(...records.map(r => r.wins + r.losses));
    if (gamesPlayed > 0) {
      const undefeated = records.filter(r => r.losses === 0 && r.wins > 0);
      const winless    = records.filter(r => r.wins === 0 && r.losses > 0);
      if (undefeated.length > 0) {
        const names = undefeated.map(r => r.team ?? r.discordUsername).join(", ");
        parts.push(`NOTABLE: The following teams are UNDEFEATED this season (${undefeated[0]!.wins}-0): ${names}`);
      }
      if (winless.length > 0) {
        const names = winless.map(r => r.team ?? r.discordUsername).join(", ");
        parts.push(`NOTABLE: The following teams are WINLESS this season (0-${winless[0]!.losses}): ${names}`);
      }
      if (undefeated.length > 0 || winless.length > 0) parts.push("");
    }
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
    for (const g of playedGames) {
      const hs = g.homeScore ?? 0, as_ = g.awayScore ?? 0;
      const winner = hs >= as_
        ? `${g.homeTeamName} ${hs}–${as_} ${g.awayTeamName}`
        : `${g.awayTeamName} ${as_}–${hs} ${g.homeTeamName}`;
      parts.push(`${winner} ${g.isH2H ? "(H2H)" : "(vs CPU)"}`);
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
    upcomingGames = await getUpcomingMatchupsFromGcs(upcomingWeekIndex);
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
    .limit(5);

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
    .limit(5);

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
    .limit(5);

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
    .limit(5);

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
  const records = await db
    .select({
      discordId:         userRecordsTable.discordId,
      discordUsername:   userRecordsTable.discordUsername,
      team:              userRecordsTable.team,
      wins:              userRecordsTable.wins,
      losses:            userRecordsTable.losses,
      pointDifferential: userRecordsTable.pointDifferential,
    })
    .from(userRecordsTable)
    .where(eq(userRecordsTable.seasonId, seasonId))
    .orderBy(desc(userRecordsTable.wins));

  if (records.length > 0) {
    parts.push("=== CURRENT STANDINGS (heading into this week) ===");
    for (const r of records) {
      const teamStr = r.team ?? r.discordUsername;
      const pd      = r.pointDifferential >= 0 ? `+${r.pointDifferential}` : String(r.pointDifferential);
      parts.push(`${teamStr} (${r.discordUsername}): ${r.wins}-${r.losses}, Point Diff ${pd}`);
    }
    parts.push("");

    const gamesPlayed = Math.max(...records.map(r => r.wins + r.losses));
    if (gamesPlayed > 0) {
      const undefeated = records.filter(r => r.losses === 0 && r.wins > 0);
      const winless    = records.filter(r => r.wins === 0 && r.losses > 0);
      if (undefeated.length > 0) {
        const names = undefeated.map(r => r.team ?? r.discordUsername).join(", ");
        parts.push(`NOTABLE: Still undefeated heading into Week ${weekNum}: ${names}`);
      }
      if (winless.length > 0) {
        const names = winless.map(r => r.team ?? r.discordUsername).join(", ");
        parts.push(`NOTABLE: Still looking for their first win heading into Week ${weekNum}: ${names}`);
      }
      if (undefeated.length > 0 || winless.length > 0) parts.push("");
    }
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
    matchups = await getUpcomingMatchupsFromGcs(weekIndex);
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

  const prompt = `You are a sports journalist covering The R.E.C. League — a Madden NFL franchise (CFM) simulation league. 
Write a short, engaging league newsletter article (around 400–500 words) recapping the week that just ended and looking ahead to ${upcomingWeekLabel}.

Always refer to the league by its name: "The R.E.C. League". Never call it a "simulation league", "CFM league", or any other generic name.

This is a RECAP article. Focus on what happened: scores, standout performers, winners, losers, and any notable storylines from the results.
Mention how the week affects standings. End with a brief tease of what's coming next (${upcomingWeekLabel}).

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

  const prompt = `You are a sports journalist covering The R.E.C. League — a Madden NFL franchise (CFM) simulation league.
Write a short, engaging league newsletter article (around 400–500 words) previewing Week ${weekNum} — the games have NOT been played yet.

Always refer to the league by its name: "The R.E.C. League". Never call it a "simulation league", "CFM league", or any other generic name.

This is a PREVIEW article. Focus on what's coming: hype the key matchups, highlight the stakes for each team based on their current record,
call out players to watch, and build anticipation. Do NOT report scores or results — the games haven't happened.

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
