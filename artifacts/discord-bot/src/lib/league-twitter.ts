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
  leagueTwitterTable, leagueTwitterMatchupCacheTable,
  usersTable, seasonsTable,
  teamSeasonStatsTable, playerSeasonStatsTable,
  completedTradesTable,
  tradeBlockListingsTable, tradeBlockISOTable,
  userRecordsTable,
} from "@workspace/db";
import { eq, desc, and, gte } from "drizzle-orm";
import { getOrCreateActiveSeason } from "./db-helpers.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const LEAGUE_TWITTER_CHANNEL_ID = "1492213174697726033";

const TWO_HOURS_MS   = 2 * 60 * 60 * 1000;
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
  {
    name:   "Adam Shaffer",
    handle: "@AdamShaffer",
    outlet: "ESPN",
    style:  "Fast, definitive, trade-break style. Known for short 'per sources' tweets. First to break moves.",
  },
  {
    name:   "Ian Rappaport",
    handle: "@IanRappaport",
    outlet: "NFL Network",
    style:  "Player-centric, contract-focused. Loves reporting on injuries and roster moves with insider gravitas.",
  },
  {
    name:   "Tom Pellissarro",
    handle: "@TomPellissarro",
    outlet: "NFL Network",
    style:  "Steady and factual. Often follows up on bigger stories with details and context. Measured tone.",
  },
  {
    name:   "Jay Glazier",
    handle: "@JayGlazier",
    outlet: "Fox Sports",
    style:  "Bombastic and competitive. Claims everything is EXCLUSIVE. Dramatic flair, loves scooping rivals.",
  },
  {
    name:   "Jordan Schulter",
    handle: "@JordanSchulter",
    outlet: "ESPN",
    style:  "Young, aggressive. Posts fast takes and hot trade analysis. Uses fire emojis. Tries to go viral.",
  },
  {
    name:   "Mike Garfield",
    handle: "@MikeGarfield",
    outlet: "NFL Network",
    style:  "Veteran voice. Thoughtful analysis on player development and team culture. Longer tweet threads.",
  },
  {
    name:   "Diana Rossini",
    handle: "@DianaRossini",
    outlet: "The Athletic",
    style:  "Elite access, respected by coaches. Breaks coaching/front-office stories. Concise and authoritative.",
  },
  {
    name:   "Jeff Darrington",
    handle: "@JeffDarrington",
    outlet: "ESPN",
    style:  "Analyst-reporter hybrid. Loves stats, trends, and historical comparisons. Likes to say 'put this in perspective'.",
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

  // ── Standings (team records) ───────────────────────────────────────────────
  const teamStats = await db.select()
    .from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, season.id));

  const records = await db.select({ discordId: userRecordsTable.discordId, wins: userRecordsTable.wins, losses: userRecordsTable.losses, team: userRecordsTable.team })
    .from(userRecordsTable)
    .where(eq(userRecordsTable.seasonId, season.id));

  if (records.length > 0) {
    const sorted = [...records].sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses));
    const lines = sorted.map(r => `  ${r.team ?? "Unknown"}: ${r.wins}W-${r.losses}L`);
    parts.push(`\nCURRENT STANDINGS:\n${lines.join("\n")}`);
  }

  // ── Team season stats highlights ───────────────────────────────────────────
  if (teamStats.length > 0) {
    const topOff = [...teamStats].sort((a, b) => b.offPtsPerGame - a.offPtsPerGame)[0];
    const topDef = [...teamStats].sort((a, b) => a.defTDs - b.defTDs)[0];
    const topTurnover = [...teamStats].sort((a, b) => b.turnoverDiff - a.turnoverDiff)[0];
    parts.push(
      `\nTEAM HIGHLIGHTS:` +
      (topOff ? `\n  Best offense (PPG): ${topOff.teamName} (${topOff.offPtsPerGame.toFixed(1)} PPG)` : "") +
      (topDef ? `\n  Best defense (fewest TDs allowed): ${topDef.teamName} (${topDef.defTDs} TDs allowed)` : "") +
      (topTurnover ? `\n  Best turnover differential: ${topTurnover.teamName} (+${topTurnover.turnoverDiff})` : ""),
    );
  }

  // ── Top players (by position) ──────────────────────────────────────────────
  const players = await db.select()
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));

  if (players.length > 0) {
    const topQBs = [...players].filter(p => p.position === "QB").sort((a, b) => b.passYds - a.passYds).slice(0, 3);
    const topRBs = [...players].filter(p => p.position === "HB").sort((a, b) => b.rushYds - a.rushYds).slice(0, 3);
    const topWRs = [...players].filter(p => ["WR","TE"].includes(p.position)).sort((a, b) => b.recYds - a.recYds).slice(0, 3);
    const topPass = [...players].filter(p => p.position === "QB").sort((a, b) => b.passTDs - a.passTDs)[0];
    const topSack = [...players].sort((a, b) => b.sacks - a.sacks)[0];

    const fmt = (ps: typeof players) => ps.map(p => `${p.firstName} ${p.lastName} (${p.teamName})`).join(", ");

    parts.push(
      `\nTOP PLAYERS THIS SEASON:` +
      (topQBs.length ? `\n  QB (pass yds): ${fmt(topQBs)}` : "") +
      (topRBs.length ? `\n  RB (rush yds): ${fmt(topRBs)}` : "") +
      (topWRs.length ? `\n  WR/TE (rec yds): ${fmt(topWRs)}` : "") +
      (topPass ? `\n  TD leader (pass): ${topPass.firstName} ${topPass.lastName} — ${topPass.passTDs} TDs` : "") +
      (topSack ? `\n  Sack leader: ${topSack.firstName} ${topSack.lastName} — ${topSack.sacks} sacks` : ""),
    );
  }

  // ── Recent completed trades (last 7 days) ──────────────────────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const trades = await db.select()
    .from(completedTradesTable)
    .where(and(
      eq(completedTradesTable.seasonId, season.id),
      gte(completedTradesTable.announcedAt, sevenDaysAgo),
    ))
    .orderBy(desc(completedTradesTable.announcedAt))
    .limit(5);

  if (trades.length > 0) {
    const lines = trades.map(t =>
      `  ${t.team1Name} traded [${t.whatTeam1Sent}] for [${t.whatTeam1Received}] with ${t.team2Name}`,
    );
    parts.push(`\nRECENT TRADES:\n${lines.join("\n")}`);
  }

  // ── Active trade block listings ─────────────────────────────────────────────
  const listings = await db.select({
    teamName: tradeBlockListingsTable.teamName,
    items:    tradeBlockListingsTable.items,
    notes:    tradeBlockListingsTable.notes,
  })
    .from(tradeBlockListingsTable)
    .where(and(
      eq(tradeBlockListingsTable.seasonId, season.id),
      eq(tradeBlockListingsTable.status, "active"),
    ))
    .limit(6);

  if (listings.length > 0) {
    const lines = listings.map(l => {
      const itemStr = (l.items as any[]).map((it: any) => {
        if (it.type === "player") return `${it.firstName} ${it.lastName} (${it.position})`;
        if (it.type === "pick")   return it.description;
        if (it.type === "coins")  return `${it.amount} coins`;
        return "asset";
      }).join(", ");
      return `  ${l.teamName} shopping: ${itemStr}${l.notes ? ` (wants: ${l.notes})` : ""}`;
    });
    parts.push(`\nACTIVE TRADE BLOCK:\n${lines.join("\n")}`);
  }

  // ── Active ISO listings ────────────────────────────────────────────────────
  const isos = await db.select({
    teamName:    tradeBlockISOTable.teamName,
    seekingType: tradeBlockISOTable.seekingType,
    offering:    tradeBlockISOTable.offering,
  })
    .from(tradeBlockISOTable)
    .where(and(
      eq(tradeBlockISOTable.seasonId, season.id),
      eq(tradeBlockISOTable.status, "active"),
    ))
    .limit(4);

  if (isos.length > 0) {
    const lines = isos.map(l => `  ${l.teamName} ISO: seeking ${l.seekingType}`);
    parts.push(`\nISO LISTINGS (teams seeking specific assets):\n${lines.join("\n")}`);
  }

  // ── Matchup cache (within 4-hour freshness window) ─────────────────────────
  // Written by the matchup runners when they post; gives the AI real game data
  // for matchup-related topics without the risk of stale schedule table entries.
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
    parts.push(`\nUPCOMING MATCHUPS — ${cm.weekLabel} (just posted — use these for matchup commentary):\n${cm.matchupsText}`);
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

// ── Tweet generator ────────────────────────────────────────────────────────────

const TOPIC_PROMPTS = [
  "Focus on a specific player's season stat line and what it means for their team's playoff chances.",
  "React to a recent trade and analyze what each team gained or gave up.",
  "Break a 'rumor' about a team shopping a player or seeking a specific asset on the block.",
  "Comment on a team's record this season — hot streak, cold streak, or surprising run.",
  "Praise or roast a team's offensive or defensive season performance using their real stats.",
  "Make the case for a playoff dark horse based on their season stats and record.",
  "Drop a 'per sources' rumor about a player about to be moved or a team making a power play.",
  "Write a short hot take about the best or worst team in the league based on their record.",
  "Comment on the league's overall scoring trends or which defenses have been elite.",
  "React to a new ISO or trade block listing as if it just broke on the wire.",
  "Give a scouting report on a specific player's season stats — overhyped or underrated.",
  "Speculate on which teams are buyers vs. sellers as the season nears its end.",
  "React to the league's turnover differential or rushing/passing leaders.",
  "Pick a team with a losing record and explain how they can still make noise.",
  "Compare two teams' season records and stats and declare which is the more dangerous squad.",
  "If upcoming matchups are listed in the context, hype up one specific game as a must-watch — only if real matchup data is provided.",
];

async function generateTweet(reporter: Reporter, context: string): Promise<string> {
  const topic = TOPIC_PROMPTS[Math.floor(Math.random() * TOPIC_PROMPTS.length)]!;

  const system = `You are ${reporter.name} (${reporter.handle}), a sports reporter for ${reporter.outlet}.
Personality: ${reporter.style}

You are covering a Madden CFM (franchise mode) fantasy football league called the REC League.
This is treated as a REAL league — real drama, real storylines, real reactions.
Write a single tweet (max 260 characters) in your authentic reporter voice about the league.

Rules:
- Sound like a real sports Twitter post, not a bot
- Mention specific player names, team names, stats, or trade details from the context
- Use reporter-style language ("per sources", "I'm told", "breaking", etc.) when fitting for your persona
- Emojis are fine if fitting (especially for hype-style reporters)
- Do NOT use hashtags
- Do NOT mention that this is a video game or simulation
- Output ONLY the tweet text, nothing else
- CRITICAL — Records: When citing a team's record, use ONLY the season W-L from the CURRENT STANDINGS section of the context. Never invent win-loss records.
- CRITICAL — Matchups: Do NOT reference a specific game between two teams (e.g. "Team A hosts Team B") unless that exact matchup is explicitly listed in the context. No upcoming-game hype unless the matchup is in the data.
- CRITICAL — H2H: Do NOT cite head-to-head records between teams. Only season records are provided and should be used.`;

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
  const system = `You are ${reporter.name} (${reporter.handle}), a sports reporter for ${reporter.outlet}.
Personality: ${reporter.style}

You posted a tweet about the REC League (a Madden CFM franchise-mode football league).
A fan just replied to your tweet. Respond as yourself — stay in your reporter persona.
This is a real sports league, not a video game.

Rules:
- Match your reporter personality (combative, measured, hyped, etc.)
- Be direct, human, and conversational — like a real reporter replying on Twitter
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

export async function postLeagueTweet(client: Client): Promise<void> {
  try {
    const season = await getOrCreateActiveSeason();
    const context = await buildLeagueContext(season);

    // Avoid repeating the same reporter twice in a row
    const [lastTweet] = await db.select({ reporterName: leagueTwitterTable.reporterName })
      .from(leagueTwitterTable)
      .where(eq(leagueTwitterTable.seasonId, season.id))
      .orderBy(desc(leagueTwitterTable.postedAt))
      .limit(1);

    const reporter = pickReporter(lastTweet?.reporterName);
    const tweetText = await generateTweet(reporter, context);
    if (!tweetText) return;

    const ch = client.channels.cache.get(LEAGUE_TWITTER_CHANNEL_ID)
      ?? await client.channels.fetch(LEAGUE_TWITTER_CHANNEL_ID).catch(() => null);
    if (!ch?.isTextBased()) return;
    const tc = ch as TextChannel;

    const header = `**${reporter.name}** ${reporter.handle} · *${reporter.outlet}*`;
    const msg = await tc.send(`${header}\n\n${tweetText}`);

    await db.insert(leagueTwitterTable).values({
      seasonId:     season.id,
      messageId:    msg.id,
      reporterName: reporter.name,
      reporterHandle: reporter.handle,
      content:      tweetText,
    });

    console.log(`[league-twitter] Posted tweet by ${reporter.name}`);
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
  }, TWO_HOURS_MS);

  console.log("✅ League Twitter scheduler started (every 2 hours)");
}
