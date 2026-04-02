import OpenAI from "openai";
import { db } from "@workspace/db";
import {
  userRecordsTable, playerSeasonStatsTable, franchiseScheduleTable,
  usersTable,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";

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

  const played = weekGames.filter(g => g.homeScore !== null && g.awayScore !== null);
  if (played.length > 0) {
    parts.push(`=== WEEK ${completedWeekIndex + 1} RESULTS ===`);
    for (const g of played) {
      const winner = (g.homeScore ?? 0) >= (g.awayScore ?? 0)
        ? `${g.homeTeamName} ${g.homeScore}–${g.awayScore} ${g.awayTeamName}`
        : `${g.awayTeamName} ${g.awayScore}–${g.homeScore} ${g.homeTeamName}`;
      const type = g.status === 3 ? "(H2H)" : "(CPU)";
      parts.push(`${winner} ${type}`);
    }
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

// ── Main export — call this from advanceweek ───────────────────────────────────
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

Use the data below to craft real storylines, highlight standout performers, call out any dominant teams or teams in danger, 
and build excitement for the next week. Reference players and teams by name. Write in an energetic, sports-media tone — 
like an ESPN or NFL Network column. Avoid generic filler. Make it feel authentic and specific to The R.E.C. League.

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
