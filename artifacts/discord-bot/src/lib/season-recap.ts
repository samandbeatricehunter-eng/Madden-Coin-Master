/**
 * season-recap.ts
 *
 * Generates a rich, multi-section AI season recap article covering:
 *  - Season highlights and storylines
 *  - Statistical leaders and record-breakers
 *  - Breakout performers
 *  - Teams to watch heading into the playoffs
 *  - Playoff picture and Wildcard excitement
 *
 * Posts as multiple embeds to:
 *  - Headlines channel (@everyone)
 *  - Season's historical records channel
 */

import OpenAI from "openai";
import { db } from "@workspace/db";
import {
  userRecordsTable,
  playerSeasonStatsTable,
  franchiseScheduleTable,
  usersTable,
} from "@workspace/db";
import { eq, desc, and, gt, asc } from "drizzle-orm";
import { Client, TextChannel, EmbedBuilder, Colors } from "discord.js";
import { PRIMARY_GUILD_ID, getGuildChannel, CHANNEL_KEYS } from "./db-helpers.js";

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "dummy",
});
const MAX_EMBED_DESC = 4000;

// ── Build comprehensive season context for the AI ─────────────────────────────

async function buildSeasonContext(seasonId: number, seasonNumber: number): Promise<string> {
  const parts: string[] = [];

  parts.push(`===== MADDEN CFM SEASON ${seasonNumber} — FULL REGULAR SEASON DATA =====`);
  parts.push("");

  // ── Final standings (sorted by wins, then point differential) ────────────────
  const records = await db.select({
    discordUsername:   userRecordsTable.discordUsername,
    team:              userRecordsTable.team,
    wins:              userRecordsTable.wins,
    losses:            userRecordsTable.losses,
    pointDifferential: userRecordsTable.pointDifferential,
  })
  .from(userRecordsTable)
  .where(eq(userRecordsTable.seasonId, seasonId))
  .orderBy(desc(userRecordsTable.wins), desc(userRecordsTable.pointDifferential));

  if (records.length > 0) {
    parts.push("=== FINAL REGULAR SEASON STANDINGS ===");
    records.forEach((r, i) => {
      const teamStr = r.team ?? r.discordUsername;
      const pd = r.pointDifferential >= 0 ? `+${r.pointDifferential}` : String(r.pointDifferential);
      const rank = i + 1;
      parts.push(`#${rank} ${teamStr}: ${r.wins}–${r.losses}, Point Diff ${pd}`);
    });
    parts.push("");

    const best  = records.slice(0, 3).map(r => `${r.team ?? r.discordUsername} (${r.wins}–${r.losses})`);
    const worst = records.slice(-3).reverse().map(r => `${r.team ?? r.discordUsername} (${r.wins}–${r.losses})`);
    const dominant = records.filter(r => r.pointDifferential > 150);
    const struggling = records.filter(r => r.pointDifferential < -100);

    if (best.length)      parts.push(`Elite teams this season: ${best.join(", ")}`);
    if (worst.length)     parts.push(`Teams that struggled: ${worst.join(", ")}`);
    if (dominant.length)  parts.push(`Dominant point differentials: ${dominant.map(r => `${r.team ?? r.discordUsername} (+${r.pointDifferential})`).join(", ")}`);
    if (struggling.length) parts.push(`Negative point differentials: ${struggling.map(r => `${r.team ?? r.discordUsername} (${r.pointDifferential})`).join(", ")}`);
    parts.push("");
  }

  // ── Playoff seeding ───────────────────────────────────────────────────────────
  const seededUsers = await db.select({
    team:              usersTable.team,
    playoffSeed:       usersTable.playoffSeed,
    playoffConference: usersTable.playoffConference,
  }).from(usersTable)
    .where(gt(usersTable.playoffSeed ?? 0, 0));

  const afcSeeds = seededUsers
    .filter(u => u.playoffConference === "AFC" && u.playoffSeed != null)
    .sort((a, b) => (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99));
  const nfcSeeds = seededUsers
    .filter(u => u.playoffConference === "NFC" && u.playoffSeed != null)
    .sort((a, b) => (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99));

  if (afcSeeds.length > 0) {
    parts.push("=== AFC PLAYOFF FIELD ===");
    parts.push(afcSeeds.map(u => `Seed ${u.playoffSeed}: ${u.team}`).join(" | "));
    parts.push("");
  }
  if (nfcSeeds.length > 0) {
    parts.push("=== NFC PLAYOFF FIELD ===");
    parts.push(nfcSeeds.map(u => `Seed ${u.playoffSeed}: ${u.team}`).join(" | "));
    parts.push("");
  }

  // ── All 18 weeks of game results ─────────────────────────────────────────────
  const allGames = await db.select({
    weekIndex:    franchiseScheduleTable.weekIndex,
    homeTeamName: franchiseScheduleTable.homeTeamName,
    awayTeamName: franchiseScheduleTable.awayTeamName,
    homeScore:    franchiseScheduleTable.homeScore,
    awayScore:    franchiseScheduleTable.awayScore,
    status:       franchiseScheduleTable.status,
  })
  .from(franchiseScheduleTable)
  .where(eq(franchiseScheduleTable.seasonId, seasonId))
  .orderBy(asc(franchiseScheduleTable.weekIndex));

  const played = allGames.filter(g => g.homeScore !== null && g.awayScore !== null);

  if (played.length > 0) {
    // Biggest blowouts
    const sorted = [...played].sort((a, b) => {
      const diffA = Math.abs((a.homeScore ?? 0) - (a.awayScore ?? 0));
      const diffB = Math.abs((b.homeScore ?? 0) - (b.awayScore ?? 0));
      return diffB - diffA;
    });
    const blowouts = sorted.slice(0, 5);
    parts.push("=== BIGGEST BLOWOUTS OF THE SEASON ===");
    for (const g of blowouts) {
      const homeScore = g.homeScore ?? 0;
      const awayScore = g.awayScore ?? 0;
      const margin = Math.abs(homeScore - awayScore);
      const winner = homeScore > awayScore ? g.homeTeamName : g.awayTeamName;
      const loser  = homeScore > awayScore ? g.awayTeamName : g.homeTeamName;
      const wScore = Math.max(homeScore, awayScore);
      const lScore = Math.min(homeScore, awayScore);
      const type   = g.status === 3 ? "(H2H)" : "(CPU)";
      parts.push(`Week ${(g.weekIndex ?? 0) + 1}: ${winner} def. ${loser} ${wScore}–${lScore} by ${margin} ${type}`);
    }
    parts.push("");

    // Closest games (thrillers)
    const closest = [...played]
      .filter(g => Math.abs((g.homeScore ?? 0) - (g.awayScore ?? 0)) <= 7)
      .sort((a, b) => {
        const diffA = Math.abs((a.homeScore ?? 0) - (a.awayScore ?? 0));
        const diffB = Math.abs((b.homeScore ?? 0) - (b.awayScore ?? 0));
        return diffA - diffB;
      })
      .slice(0, 5);
    if (closest.length > 0) {
      parts.push("=== NAIL-BITERS (margin ≤ 7 points) ===");
      for (const g of closest) {
        const homeScore = g.homeScore ?? 0;
        const awayScore = g.awayScore ?? 0;
        const margin = Math.abs(homeScore - awayScore);
        const winner = homeScore > awayScore ? g.homeTeamName : g.awayTeamName;
        const loser  = homeScore > awayScore ? g.awayTeamName : g.homeTeamName;
        const wScore = Math.max(homeScore, awayScore);
        const lScore = Math.min(homeScore, awayScore);
        const type   = g.status === 3 ? "(H2H)" : "(CPU)";
        parts.push(`Week ${(g.weekIndex ?? 0) + 1}: ${winner} def. ${loser} ${wScore}–${lScore} (margin ${margin}) ${type}`);
      }
      parts.push("");
    }

    // High-scoring games
    const highScoring = [...played]
      .filter(g => (g.homeScore ?? 0) + (g.awayScore ?? 0) >= 70)
      .sort((a, b) =>
        ((b.homeScore ?? 0) + (b.awayScore ?? 0)) - ((a.homeScore ?? 0) + (a.awayScore ?? 0)))
      .slice(0, 3);
    if (highScoring.length > 0) {
      parts.push("=== SHOOTOUTS (combined 70+ pts) ===");
      for (const g of highScoring) {
        const hs = g.homeScore ?? 0;
        const as = g.awayScore ?? 0;
        parts.push(`Week ${(g.weekIndex ?? 0) + 1}: ${g.homeTeamName} ${hs} – ${g.awayTeamName} ${as} (total: ${hs + as})`);
      }
      parts.push("");
    }

    // Count H2H vs CPU games played
    const h2hGames = played.filter(g => g.status === 3).length;
    const cpuGames = played.filter(g => g.status !== 3).length;
    parts.push(`Total games played: ${played.length} (${h2hGames} H2H, ${cpuGames} CPU/forced)`);
    parts.push("");
  }

  // ── Stat leaders with more depth ─────────────────────────────────────────────
  const passLeaders = await db.select({
    firstName: playerSeasonStatsTable.firstName,
    lastName:  playerSeasonStatsTable.lastName,
    teamName:  playerSeasonStatsTable.teamName,
    position:  playerSeasonStatsTable.position,
    passYds:   playerSeasonStatsTable.passYds,
    passTDs:   playerSeasonStatsTable.passTDs,
  }).from(playerSeasonStatsTable)
    .where(and(eq(playerSeasonStatsTable.seasonId, seasonId), gt(playerSeasonStatsTable.passYds, 0)))
    .orderBy(desc(playerSeasonStatsTable.passYds))
    .limit(10);

  if (passLeaders.length > 0) {
    parts.push("=== SEASON PASSING LEADERS (top 10) ===");
    passLeaders.forEach((p, i) =>
      parts.push(`#${i + 1} ${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.passYds.toLocaleString()} yds, ${p.passTDs} TDs`)
    );
    parts.push("");
  }

  const rushLeaders = await db.select({
    firstName: playerSeasonStatsTable.firstName,
    lastName:  playerSeasonStatsTable.lastName,
    teamName:  playerSeasonStatsTable.teamName,
    position:  playerSeasonStatsTable.position,
    rushYds:   playerSeasonStatsTable.rushYds,
    rushTDs:   playerSeasonStatsTable.rushTDs,
  }).from(playerSeasonStatsTable)
    .where(and(eq(playerSeasonStatsTable.seasonId, seasonId), gt(playerSeasonStatsTable.rushYds, 0)))
    .orderBy(desc(playerSeasonStatsTable.rushYds))
    .limit(10);

  if (rushLeaders.length > 0) {
    parts.push("=== SEASON RUSHING LEADERS (top 10) ===");
    rushLeaders.forEach((p, i) =>
      parts.push(`#${i + 1} ${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.rushYds.toLocaleString()} yds, ${p.rushTDs} TDs`)
    );
    parts.push("");
  }

  const recLeaders = await db.select({
    firstName: playerSeasonStatsTable.firstName,
    lastName:  playerSeasonStatsTable.lastName,
    teamName:  playerSeasonStatsTable.teamName,
    position:  playerSeasonStatsTable.position,
    recYds:    playerSeasonStatsTable.recYds,
    recTDs:    playerSeasonStatsTable.recTDs,
  }).from(playerSeasonStatsTable)
    .where(and(eq(playerSeasonStatsTable.seasonId, seasonId), gt(playerSeasonStatsTable.recYds, 0)))
    .orderBy(desc(playerSeasonStatsTable.recYds))
    .limit(10);

  if (recLeaders.length > 0) {
    parts.push("=== SEASON RECEIVING LEADERS (top 10) ===");
    recLeaders.forEach((p, i) =>
      parts.push(`#${i + 1} ${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.recYds.toLocaleString()} yds, ${p.recTDs} TDs`)
    );
    parts.push("");
  }

  const sackLeaders = await db.select({
    firstName:    playerSeasonStatsTable.firstName,
    lastName:     playerSeasonStatsTable.lastName,
    teamName:     playerSeasonStatsTable.teamName,
    position:     playerSeasonStatsTable.position,
    sacks:        playerSeasonStatsTable.sacks,
    defInts:      playerSeasonStatsTable.defInts,
    totalTackles: playerSeasonStatsTable.totalTackles,
  }).from(playerSeasonStatsTable)
    .where(and(eq(playerSeasonStatsTable.seasonId, seasonId), gt(playerSeasonStatsTable.sacks, 0)))
    .orderBy(desc(playerSeasonStatsTable.sacks))
    .limit(10);

  if (sackLeaders.length > 0) {
    parts.push("=== SEASON DEFENSIVE LEADERS — SACKS (top 10) ===");
    sackLeaders.forEach((p, i) =>
      parts.push(`#${i + 1} ${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.sacks} sacks, ${p.defInts} INTs, ${p.totalTackles} tackles`)
    );
    parts.push("");
  }

  const intLeaders = await db.select({
    firstName: playerSeasonStatsTable.firstName,
    lastName:  playerSeasonStatsTable.lastName,
    teamName:  playerSeasonStatsTable.teamName,
    position:  playerSeasonStatsTable.position,
    defInts:   playerSeasonStatsTable.defInts,
    sacks:     playerSeasonStatsTable.sacks,
  }).from(playerSeasonStatsTable)
    .where(and(eq(playerSeasonStatsTable.seasonId, seasonId), gt(playerSeasonStatsTable.defInts, 0)))
    .orderBy(desc(playerSeasonStatsTable.defInts))
    .limit(5);

  if (intLeaders.length > 0) {
    parts.push("=== SEASON INTERCEPTION LEADERS (top 5) ===");
    intLeaders.forEach((p, i) =>
      parts.push(`#${i + 1} ${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.defInts} INTs, ${p.sacks} sacks`)
    );
    parts.push("");
  }

  // ── TD leaders across all positions (multi-score threats) ────────────────────
  const allTdLeaders = await db.select({
    firstName: playerSeasonStatsTable.firstName,
    lastName:  playerSeasonStatsTable.lastName,
    teamName:  playerSeasonStatsTable.teamName,
    position:  playerSeasonStatsTable.position,
    passTDs:   playerSeasonStatsTable.passTDs,
    rushTDs:   playerSeasonStatsTable.rushTDs,
    recTDs:    playerSeasonStatsTable.recTDs,
  }).from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, seasonId));

  const tdRanked = allTdLeaders
    .map(p => ({ ...p, totalTDs: p.passTDs + p.rushTDs + p.recTDs }))
    .filter(p => p.totalTDs >= 5)
    .sort((a, b) => b.totalTDs - a.totalTDs)
    .slice(0, 10);

  if (tdRanked.length > 0) {
    parts.push("=== TOTAL TOUCHDOWN LEADERS (5+ TDs) ===");
    tdRanked.forEach((p, i) => {
      const breakdown = [
        p.passTDs > 0 ? `${p.passTDs} pass` : "",
        p.rushTDs > 0 ? `${p.rushTDs} rush` : "",
        p.recTDs  > 0 ? `${p.recTDs} rec`   : "",
      ].filter(Boolean).join(", ");
      parts.push(`#${i + 1} ${p.firstName} ${p.lastName} (${p.position}, ${p.teamName}): ${p.totalTDs} TDs (${breakdown})`);
    });
    parts.push("");
  }

  return parts.join("\n");
}

// ── Generate the recap with the AI ───────────────────────────────────────────

async function generateSeasonRecapText(seasonId: number, seasonNumber: number): Promise<string> {
  const context = await buildSeasonContext(seasonId, seasonNumber);

  const prompt = `You are an award-winning sports journalist covering a Madden NFL franchise (CFM) simulation league. It's the end of Season ${seasonNumber}'s regular season — the playoffs are about to begin. Write a blockbuster, ESPN-style end-of-season feature article (800–1000 words) that the commissioner can post to the league Discord.

Your article MUST cover these specific sections, flowing naturally into each other as vivid prose paragraphs (no headers or bullet points):

1. **SEASON OVERVIEW** — Set the stage. What defined this season? Was it competitive, chaotic, dominant? Name teams and give a pulse of the season at a glance.

2. **MOMENTS THAT MATTERED** — Highlight 3–5 of the most memorable games, storylines, or turning points. Reference the blowouts and the nail-biters from the data below. Who went on hot streaks? Who collapsed down the stretch?

3. **STATISTICAL LEGENDS** — Celebrate the season's biggest stat performers. Name the passing, rushing, receiving, and defensive leaders by name. Who had a legendary season? Identify 2–3 players who put up franchise-defining numbers and call them out as BREAKOUT performers of the season.

4. **BREAKOUT STARS & RISING TEAMS** — Based on the stats and team performances, which players exceeded expectations and which teams built something exciting? Which younger or lower-seeded teams punched above their weight? These are the teams to watch going forward.

5. **TEAMS TO WATCH** — Looking at playoff seeds and records, who enters Wildcard Weekend as the favorite? Which dark horse team could make a run? Who has the best shot at the championship?

6. **WILDCARD WEEKEND HYPE** — End with maximum excitement. Build anticipation for the first round. Tease the potential matchups, rivalries, and storylines. Leave the reader pumped for the playoffs.

Important tone rules:
- Write like a real ESPN or NFL Network feature article — bold, specific, energetic
- Use real player and team names from the data throughout every paragraph
- Do NOT be generic. Every sentence should be specific to this league's data
- Do NOT include section headers, markdown, or bullet points — just flowing paragraphs
- Start with a powerful, punchy opening sentence that captures the entire season in one breath

LEAGUE DATA:
${context}`;

  const response = await openai.chat.completions.create({
    model:                 "gpt-4o-mini",
    max_completion_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0]?.message?.content?.trim()
    ?? "The season recap could not be generated at this time.";
}

// ── Split into Discord-sized embed chunks ─────────────────────────────────────

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_EMBED_DESC) {
    // Try to split at last double-newline (paragraph break)
    let splitAt = remaining.lastIndexOf("\n\n", MAX_EMBED_DESC);
    // Fall back to single newline
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", MAX_EMBED_DESC);
    // Fall back to last space
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX_EMBED_DESC);
    // Hard cut
    if (splitAt <= 0) splitAt = MAX_EMBED_DESC;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Main export — called from wildcard-automation.ts ─────────────────────────

export async function postSeasonRecap(
  client: Client,
  seasonId: number,
  seasonNumber: number,
  historicalChannel: TextChannel | null,
  skipHeadlines = false,
  guildId: string = PRIMARY_GUILD_ID,
): Promise<void> {
  console.log(`[seasonRecap] Generating Season ${seasonNumber} recap article...`);

  let recapText: string;
  try {
    recapText = await generateSeasonRecapText(seasonId, seasonNumber);
  } catch (err) {
    console.error("[seasonRecap] AI generation failed:", err);
    recapText = "The season recap could not be generated — check server logs.";
  }

  const chunks = splitIntoChunks(recapText);

  // Build embeds (first gets the title, last gets the footer)
  const embeds = chunks.map((chunk, i) => {
    const embed = new EmbedBuilder()
      .setColor(Colors.DarkGold)
      .setDescription(chunk)
      .setTimestamp();

    if (i === 0) {
      embed.setTitle(`🏈 Season ${seasonNumber} — Regular Season Recap`);
    }
    if (i === chunks.length - 1) {
      embed.setFooter({ text: `REC League • Season ${seasonNumber} • Wildcard Weekend Begins Now` });
    }

    return embed;
  });

  // Discord allows max 10 embeds per message — split into batches if needed
  const BATCH_SIZE = 10;
  const embedBatches: EmbedBuilder[][] = [];
  for (let i = 0; i < embeds.length; i += BATCH_SIZE) {
    embedBatches.push(embeds.slice(i, i + BATCH_SIZE));
  }

  // Post to headlines channel (skipped on rebuilds to avoid duplicate @everyone pings)
  if (!skipHeadlines) {
    try {
      const headlinesId = await getGuildChannel(guildId, CHANNEL_KEYS.HEADLINES);
      const headlinesCh = headlinesId ? await client.channels.fetch(headlinesId).catch(() => null) : null;
      if (headlinesCh?.isTextBased()) {
        for (let i = 0; i < embedBatches.length; i++) {
          await (headlinesCh as TextChannel).send({
            content: i === 0 ? "@everyone 📰 **Season Recap is here!**" : undefined,
            embeds:  embedBatches[i],
          });
        }
        console.log("[seasonRecap] Posted to headlines channel");
      }
    } catch (err) {
      console.error("[seasonRecap] Failed to post to headlines:", err);
    }
  }

  // Post to historical records channel (if it was successfully created)
  if (historicalChannel) {
    try {
      for (let i = 0; i < embedBatches.length; i++) {
        await historicalChannel.send({
          content: i === 0 ? "📰 **Season Recap**" : undefined,
          embeds:  embedBatches[i],
        });
      }
      console.log("[seasonRecap] Posted to historical channel");
    } catch (err) {
      console.error("[seasonRecap] Failed to post to historical channel:", err);
    }
  } else {
    console.warn("[seasonRecap] Skipping historical channel post — channel unavailable");
  }

  console.log(`[seasonRecap] Done — ${chunks.length} embed(s) sent`);
}
