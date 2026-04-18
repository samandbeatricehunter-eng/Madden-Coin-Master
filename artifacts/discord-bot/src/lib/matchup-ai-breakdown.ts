import OpenAI from "openai";
import {
  db, franchiseRostersTable, teamSeasonStatsTable, userRecordsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { EmbedBuilder } from "discord.js";

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "dummy",
});

async function fetchRoster(seasonId: number, teamId: number) {
  return db
    .select()
    .from(franchiseRostersTable)
    .where(and(eq(franchiseRostersTable.seasonId, seasonId), eq(franchiseRostersTable.teamId, teamId)))
    .limit(60);
}

async function fetchTeamStats(seasonId: number, teamId: number) {
  const rows = await db
    .select()
    .from(teamSeasonStatsTable)
    .where(and(eq(teamSeasonStatsTable.seasonId, seasonId), eq(teamSeasonStatsTable.teamId, teamId)))
    .limit(1);
  return rows[0] ?? null;
}

async function fetchRecord(seasonId: number, discordId: string) {
  const rows = await db
    .select()
    .from(userRecordsTable)
    .where(and(eq(userRecordsTable.seasonId, seasonId), eq(userRecordsTable.discordId, discordId)))
    .limit(1);
  return rows[0] ?? null;
}

type Roster   = Awaited<ReturnType<typeof fetchRoster>>;
type TeamStat = Awaited<ReturnType<typeof fetchTeamStats>>;
type Record_  = Awaited<ReturnType<typeof fetchRecord>>;

const DEV: Record<number, string> = { 0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor" };

function rosterBlock(teamName: string, players: Roster): string {
  if (!players.length) return `${teamName}: No roster data`;
  const sorted = [...players].sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0)).slice(0, 22);
  const lines = sorted.map(p =>
    `  [${p.position}] ${p.firstName} ${p.lastName} OVR:${p.overall} DEV:${DEV[p.devTrait] ?? p.devTrait}`
  );
  return `${teamName} Roster (top 22 by OVR):\n${lines.join("\n")}`;
}

function statsBlock(teamName: string, s: TeamStat): string {
  if (!s) return `${teamName}: No season stats yet`;
  return [
    `${teamName} Season Stats:`,
    `  W-L: ${s.wins}-${s.losses}`,
    `  Off Yds: ${s.offYds}  Pass: ${s.offPassYds}  Rush: ${s.offRushYds}`,
    `  Off PPG: ${s.offPtsPerGame?.toFixed(1) ?? "?"}`,
    `  Sacks: ${s.teamSacks}  INTs: ${s.teamInts}`,
    `  TO Diff: ${s.turnoverDiff}  Red Zone Off: ${s.offRedZonePct?.toFixed(0)}%  Red Zone Def Allowed: ${s.defRedZonePct?.toFixed(0)}%`,
  ].join("\n");
}

function recordBlock(teamName: string, rec: Record_): string {
  if (!rec) return `${teamName}: Record unknown`;
  return `${teamName}: ${rec.wins}-${rec.losses}-${rec.ties} (PD: ${rec.pointDifferential})`;
}

export async function generateMatchupBreakdown(opts: {
  seasonId:       number;
  awayTeamName:   string;
  homeTeamName:   string;
  awayTeamId:     number;
  homeTeamId:     number;
  awayDiscordId:  string;
  homeDiscordId:  string;
  awayDiscordTag: string;
  homeDiscordTag: string;
  weekLabel:      string;
}): Promise<EmbedBuilder> {
  const { seasonId, awayTeamName, homeTeamName, awayTeamId, homeTeamId,
          awayDiscordId, homeDiscordId, awayDiscordTag, homeDiscordTag, weekLabel } = opts;

  const [awayRoster, homeRoster, awayStats, homeStats, awayRec, homeRec] = await Promise.all([
    fetchRoster(seasonId, awayTeamId),
    fetchRoster(seasonId, homeTeamId),
    fetchTeamStats(seasonId, awayTeamId),
    fetchTeamStats(seasonId, homeTeamId),
    fetchRecord(seasonId, awayDiscordId),
    fetchRecord(seasonId, homeDiscordId),
  ]);

  const context = [
    `=== MATCHUP: ${awayTeamName} (AWAY) @ ${homeTeamName} (HOME) — ${weekLabel} ===`,
    recordBlock(awayTeamName, awayRec),
    recordBlock(homeTeamName, homeRec),
    "",
    statsBlock(awayTeamName, awayStats),
    "",
    statsBlock(homeTeamName, homeStats),
    "",
    rosterBlock(awayTeamName, awayRoster),
    "",
    rosterBlock(homeTeamName, homeRoster),
  ].join("\n");

  const prompt = `You are an expert Madden CFM analyst. Using ONLY the data below, produce a pre-game breakdown with these exact bolded headers and nothing else before the first header:

**TOP 3 PLAYER MATCHUPS**
1. [AwayPos] [AwayPlayer] vs [HomePos] [HomePlayer] — [1 sharp sentence]
2. ...
3. ...

**KEYS TO THE GAME**
${awayTeamName}:
• [Key 1]
• [Key 2]
• [Key 3]
${homeTeamName}:
• [Key 1]
• [Key 2]
• [Key 3]

**FINAL SCORE PREDICTION**
${awayTeamName} [score] — ${homeTeamName} [score]
[2-3 sentences of reasoning grounded in the stats and roster above. Be specific and bold in your pick.]

Use real player names and real stat numbers from the data provided. Keep every point brief and tactical.

---
${context}`;

  let text = "Analysis unavailable.";
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 750,
      temperature: 0.72,
    });
    text = res.choices[0]?.message?.content?.trim() ?? text;
  } catch (err) {
    console.error("[matchup-breakdown] OpenAI error:", err);
  }

  const matchups   = extractSection(text, "**TOP 3 PLAYER MATCHUPS**", "**KEYS TO THE GAME**");
  const keys       = extractSection(text, "**KEYS TO THE GAME**", "**FINAL SCORE PREDICTION**");
  const prediction = extractSection(text, "**FINAL SCORE PREDICTION**", null);

  return new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(`🤖 AI Game Preview — ${awayTeamName} @ ${homeTeamName}`)
    .setDescription(`*${weekLabel} · ${awayDiscordTag} vs ${homeDiscordTag}*`)
    .addFields(
      { name: "⚔️ Top 3 Player Matchups",  value: (matchups   || text).slice(0, 1020), inline: false },
      { name: "🔑 Keys to the Game",        value: (keys       || "\u200b").slice(0, 1020), inline: false },
      { name: "🎯 Final Score Prediction",  value: (prediction || "\u200b").slice(0, 1020), inline: false },
    )
    .setFooter({ text: "AI-generated · based on live season data" })
    .setTimestamp();
}

function extractSection(text: string, startLabel: string, endLabel: string | null): string {
  const si = text.indexOf(startLabel);
  if (si === -1) return "";
  const after = text.slice(si + startLabel.length).trimStart();
  if (!endLabel) return after.trim();
  const ei = after.indexOf(endLabel);
  return (ei === -1 ? after : after.slice(0, ei)).trim();
}
