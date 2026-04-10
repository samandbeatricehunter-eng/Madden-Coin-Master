/**
 * wildcard-automation.ts
 *
 * Fires when the league advances from Week 18 → Wildcard.
 * Runs fully async after the /advanceweek reply is sent.
 *
 * Actions performed (in order):
 *  1. Create "historical records for season N" channel
 *  2. Post regular season in-game awards + issue +coins per winning team
 *  3. Issue season PR bonuses (top 10 from standings JSON)
 *  4. Create GOTY poll from the GOTY candidate channel
 *  5. Post stat leaders (top 3 each category)
 *  6. Post divisional winners + playoff seeds with season records
 *  7. Create 4 community polls (Loudest Mouth, Most Heart, Best/Worst)
 */

import {
  Client, Guild, ChannelType, TextChannel, Colors, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, playerSeasonStatsTable,
  franchiseMcaTeamsTable,
  pendingPollsTable, seasonHistoricalChannelsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { readMcaJson } from "./mca-storage-reader.js";
import { addBalance, logTransaction } from "./db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "./payout-config.js";
import { postSeasonRecap } from "./season-recap.js";

// ── Channel / category IDs ─────────────────────────────────────────────────────
const HISTORICAL_CATEGORY_ID = "1480912009120841841";
const GOTY_CANDIDATE_CHANNEL_ID = "1485394206863392848";
const GENERAL_CHANNEL_ID = "1476321282868908052";

// ── Award key mapping (Madden 25 CFM) ─────────────────────────────────────────
// conferenceId: 0=AFC, 1=NFC, 2 or 3 = League-wide (varies by Madden version)
const AWARD_KEY_LABEL: Record<number, string> = {
  0:  "MVP",
  1:  "Offensive POTY",
  2:  "Defensive POTY",
  3:  "Offensive ROTY",
  4:  "Defensive ROTY",
  5:  "Coach of the Year",
  6:  "Best QB",
  7:  "Best RB",
  8:  "Best WR",
  9:  "Best TE",
  10: "Best OL",
  11: "Best DL",
  12: "Best LB",
  13: "Best DB",
  14: "Best K",
  15: "Best P",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Discord's hard limit for poll answer text */
const POLL_ANSWER_MAX = 55;

/** Truncate a string to fit within Discord's poll answer character limit, adding … if cut. */
function truncatePollAnswer(text: string): string {
  const t = text.trim();
  if (t.length <= POLL_ANSWER_MAX) return t;
  return t.slice(0, POLL_ANSWER_MAX - 1) + "…";
}

/** Split an array into chunks of max size n */
function chunks<T>(arr: T[], n: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += n) result.push(arr.slice(i, i + n));
  return result;
}

/** Create a native Discord poll and return the message. Max 10 options per Discord limit. */
async function createPoll(
  channel: TextChannel,
  question: string,
  answers: string[],
  durationHours: number,
): Promise<import("discord.js").Message[]> {
  const batches = chunks(answers, 10);
  const messages: import("discord.js").Message[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch   = batches[i]!;
    const qText   = batches.length > 1 ? `${question} (Part ${i + 1} of ${batches.length})` : question;
    const msg = await channel.send({
      poll: {
        question: { text: qText.slice(0, 300) },
        answers:  batch.map(a => ({ text: truncatePollAnswer(a) })),
        duration: durationHours,
        allow_multiselect: false,
      },
    } as any);
    messages.push(msg);
  }
  return messages;
}

// ── Main export ────────────────────────────────────────────────────────────────
export async function runWildcardAutomation(
  client: Client,
  seasonId: number,
  seasonNumber: number,
  guild?: Guild | null,
): Promise<void> {
  console.log(`[wildcard] Starting automation for Season ${seasonNumber}...`);

  // ── Resolve guild ─────────────────────────────────────────────────────────────
  const resolvedGuild: Guild | null = guild
    ?? client.guilds.cache.first()
    ?? await client.guilds.fetch().then(async g => {
      const first = g.first();
      return first ? client.guilds.fetch(first.id) : null;
    }).catch(() => null);

  if (!resolvedGuild) {
    console.error("[wildcard] No guild found — aborting");
    return;
  }

  // ── 1. Create historical records channel ─────────────────────────────────────
  let historicalChannel: TextChannel | null = null;

  try {
    const chanName = `historical-records-for-season-${seasonNumber}`;

    // Guard: check if the channel already exists to avoid duplicates
    const existing = resolvedGuild.channels.cache.find(c => c.name === chanName)
      ?? await resolvedGuild.channels.fetch().then(cs => cs.find(c => c?.name === chanName)).catch(() => null);

    if (existing?.isTextBased()) {
      historicalChannel = existing as TextChannel;
      console.log(`[wildcard] Historical channel already exists: ${existing.id}`);
    } else {
      const newChannel = await resolvedGuild.channels.create({
        name:   chanName,
        type:   ChannelType.GuildText,
        parent: HISTORICAL_CATEGORY_ID,
      });
      historicalChannel = newChannel as TextChannel;
      console.log(`[wildcard] Created historical channel: ${newChannel.id}`);
    }

    await db.insert(seasonHistoricalChannelsTable)
      .values({ seasonId, channelId: historicalChannel.id })
      .onConflictDoUpdate({
        target: seasonHistoricalChannelsTable.seasonId,
        set: { channelId: historicalChannel.id },
      });
  } catch (err) {
    console.error("[wildcard] Failed to create/resolve historical channel:", err);
    // Report failure to the general channel so admins are aware
    try {
      const generalCh = resolvedGuild.channels.cache.get(GENERAL_CHANNEL_ID)
        ?? await resolvedGuild.channels.fetch(GENERAL_CHANNEL_ID).catch(() => null);
      if (generalCh?.isTextBased()) {
        await (generalCh as TextChannel).send({
          content: `⚠️ **Historical records channel could not be created** for Season ${seasonNumber}. Check bot permissions in the Historical Records category. Error: \`${err}\``,
        });
      }
    } catch { /* ignore */ }
    return;
  }

  // ── 2. AI season recap (headlines + historical channel) ──────────────────────
  try {
    await postSeasonRecap(client, seasonId, seasonNumber, historicalChannel);
  } catch (err) {
    console.error("[wildcard] Season recap failed:", err);
  }

  // ── 3. Parse and post in-game awards ─────────────────────────────────────────
  try {
    await postAwards(client, historicalChannel, seasonId, seasonNumber);
  } catch (err) {
    console.error("[wildcard] Awards section failed:", err);
  }

  // ── 4. Issue season PR bonuses ───────────────────────────────────────────────
  try {
    await issueSeasonPrBonuses(client, historicalChannel, seasonId);
  } catch (err) {
    console.error("[wildcard] Season PR section failed:", err);
  }

  // ── 4. Create GOTY poll ───────────────────────────────────────────────────────
  try {
    await createGotyPoll(client, historicalChannel, seasonId);
  } catch (err) {
    console.error("[wildcard] GOTY poll failed:", err);
  }

  // ── 5. Post stat leaders (top 3 each) ────────────────────────────────────────
  try {
    await postStatLeaders(historicalChannel, seasonId, seasonNumber);
  } catch (err) {
    console.error("[wildcard] Stat leaders section failed:", err);
  }

  // ── 6. Post divisional winners + seeds ───────────────────────────────────────
  try {
    await postPlayoffSection(historicalChannel, seasonId, seasonNumber);
  } catch (err) {
    console.error("[wildcard] Playoff section failed:", err);
  }

  // ── 7. Create community polls ─────────────────────────────────────────────────
  try {
    await createCommunityPolls(client, historicalChannel, seasonId);
  } catch (err) {
    console.error("[wildcard] Community polls failed:", err);
  }

  console.log(`[wildcard] Automation complete for Season ${seasonNumber}`);
}

// ────────────────────────────────────────────────────────────────────────────────
// SECTION 2: Awards
// ────────────────────────────────────────────────────────────────────────────────

interface AwardEntry {
  awardKey:     number;
  conferenceId: number;
  firstName?:   string;
  lastName?:    string;
  teamName?:    string;
  teamId?:      number;
}

async function postAwards(
  client: Client,
  channel: TextChannel,
  seasonId: number,
  seasonNumber: number,
): Promise<void> {
  const raw = await readMcaJson("mca/awards.json");
  if (!raw || typeof raw !== "object") {
    await channel.send({
      embeds: [new EmbedBuilder().setColor(Colors.Red)
        .setTitle("🏆 Regular Season Awards (In-Game)")
        .setDescription("*Award data not available — MCA awards export not yet received for this season.*")
        .setTimestamp()],
    });
    return;
  }

  // Parse flexible award structure
  const body = raw as Record<string, unknown>;
  const listKey = Object.keys(body).find(k =>
    k.toLowerCase().includes("award") && Array.isArray(body[k])
  );
  if (!listKey) {
    await channel.send({ embeds: [new EmbedBuilder().setColor(Colors.Red)
      .setTitle("🏆 Regular Season Awards (In-Game)")
      .setDescription("*Award data received but could not be parsed. Check server logs.*")
      .setTimestamp()] });
    return;
  }

  const rawAwards = body[listKey] as Record<string, unknown>[];
  const awards: AwardEntry[] = rawAwards.map(a => ({
    awardKey:     Number(a["awardKey"]     ?? a["awardId"]  ?? -1),
    conferenceId: Number(a["conferenceId"] ?? a["confId"]   ?? 2),
    firstName:    String(a["firstName"]    ?? a["fname"]    ?? ""),
    lastName:     String(a["lastName"]     ?? a["lname"]    ?? ""),
    teamName:     String(a["teamName"]     ?? a["teamNickName"] ?? a["teamShortName"] ?? ""),
    teamId:       a["teamId"] != null ? Number(a["teamId"]) : undefined,
  }));

  // Resolve team display names via DB if available
  const mcaTeams = await db.select({ teamId: franchiseMcaTeamsTable.teamId, nickName: franchiseMcaTeamsTable.nickName, fullName: franchiseMcaTeamsTable.fullName })
    .from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.seasonId, seasonId));
  const teamIdToNick = new Map(mcaTeams.map(t => [t.teamId, t.nickName]));

  function awardLine(a: AwardEntry): string {
    const label    = AWARD_KEY_LABEL[a.awardKey] ?? `Award #${a.awardKey}`;
    const name     = [a.firstName, a.lastName].filter(Boolean).join(" ") || "Unknown";
    const teamDisp = (a.teamId && teamIdToNick.get(a.teamId)) || a.teamName || "?";
    const isCoach  = a.awardKey === 5;
    const person   = isCoach ? teamDisp : `${name} (${teamDisp})`;
    return `${label} — ${person}`;
  }

  // Collect which teams won awards (for bonus payout) — only league players
  const allUsers = await db.select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable);
  const teamNameToDiscord = new Map<string, string>();
  for (const u of allUsers) {
    if (u.team) teamNameToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
  }

  const awardWinBonus = await getPayoutValue(PAYOUT_KEYS.AWARD_WIN_BONUS);
  const bonusedTeams  = new Set<string>(); // discordId → already awarded this season

  // Determine conference for each award
  // Leagues use conferenceId 0,1 or 1,2 depending on Madden version.
  // We detect which scheme by looking at the data.
  // If any award with awardKey 0 (MVP) exists, check its conferenceId to calibrate.
  const mvpEntry = awards.find(a => a.awardKey === 0);
  // If MVP conferenceId >= 2 → league-wide awards use 2+, conference awards use 0/1
  // If MVP conferenceId < 2  → league-wide awards may use both 0 and 1 (ambiguous)
  // We'll treat conferenceId 0,1 as AFC/NFC for per-player awards
  // and use "League" for league-wide award types (0,5)
  const leagueWideKeys = new Set([0, 5]); // MVP, Coach of Year

  const leagueLines: string[] = [];
  const afcLines:    string[] = [];
  const nfcLines:    string[] = [];

  for (const a of awards) {
    if (a.awardKey < 0 || !(a.awardKey in AWARD_KEY_LABEL)) continue;

    const line = awardLine(a);
    if (leagueWideKeys.has(a.awardKey)) {
      leagueLines.push(line);
    } else if (a.conferenceId === 0) {
      afcLines.push(line);
    } else {
      nfcLines.push(line);
    }

    // Issue award bonus to the team owner (each team only once)
    const teamNick = (a.teamId && teamIdToNick.get(a.teamId)) || a.teamName || "";
    const discordId = teamNameToDiscord.get(teamNick.toLowerCase().trim());
    if (discordId && !bonusedTeams.has(discordId) && awardWinBonus > 0) {
      bonusedTeams.add(discordId);
      await addBalance(discordId, awardWinBonus);
      await logTransaction(discordId, awardWinBonus, "addcoins",
        `Season ${seasonNumber} in-game award winner bonus`, "system");
      try {
        const user = await client.users.fetch(discordId);
        await user.send(
          `🏆 **Season ${seasonNumber} Award Bonus!**\n` +
          `One of your players won a regular season award — you've been credited **+${awardWinBonus} 🪙** coins!`
        ).catch(() => {});
      } catch (_) {}
    }
  }

  const leagueSec = leagueLines.length
    ? `**REGULAR SEASON AWARDS (IN-GAME):**\n${leagueLines.map(l => `🏆 ${l}`).join("\n")}`
    : "*No league-wide awards data*";
  const afcSec = afcLines.length
    ? `\n\n**AFC**\n${afcLines.map(l => `🏆 ${l}`).join("\n")}`
    : "";
  const nfcSec = nfcLines.length
    ? `\n\n**NFC**\n${nfcLines.map(l => `🏆 ${l}`).join("\n")}`
    : "";

  const bonusNote = bonusedTeams.size > 0
    ? `\n\n*+${awardWinBonus} 🪙 awarded to ${bonusedTeams.size} team(s) with award winners*`
    : "";

  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle(`🏆 Season ${seasonNumber} — Regular Season Awards`)
      .setColor(Colors.Gold)
      .setDescription((leagueSec + afcSec + nfcSec + bonusNote).slice(0, 4000))
      .setTimestamp()],
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// SECTION 3: Season PR Bonuses
// ────────────────────────────────────────────────────────────────────────────────

async function issueSeasonPrBonuses(
  client: Client,
  channel: TextChannel,
  seasonId: number,
): Promise<void> {
  const raw = await readMcaJson("mca/standings.json");
  if (!raw || typeof raw !== "object") {
    await channel.send({ content: "*Season PR data not available — standings not yet exported.*" });
    return;
  }

  const body = raw as Record<string, unknown>;
  const listKey = Object.keys(body).find(k =>
    k.toLowerCase().includes("standing") && Array.isArray(body[k])
  );
  if (!listKey) return;

  interface StandingEntry {
    teamId:       number;
    rank:         number;
    wins:         number;
    losses:       number;
    teamName?:    string;
  }

  const rawStandings = body[listKey] as Record<string, unknown>[];
  const standings: StandingEntry[] = rawStandings.map(s => ({
    teamId:  Number(s["teamId"] ?? 0),
    rank:    Number(s["rank"]   ?? s["overallRank"] ?? s["stPRank"] ?? 999),
    wins:    Number(s["wins"]   ?? s["totalWins"]   ?? 0),
    losses:  Number(s["losses"] ?? s["totalLosses"] ?? 0),
    teamName: String(s["teamName"] ?? s["teamNickName"] ?? ""),
  }));

  standings.sort((a, b) => a.rank - b.rank);
  const top10 = standings.slice(0, 10);

  // Resolve discordId via franchiseMcaTeamsTable
  const mcaTeams = await db.select({
    teamId: franchiseMcaTeamsTable.teamId,
    nickName: franchiseMcaTeamsTable.nickName,
    discordId: franchiseMcaTeamsTable.discordId,
  }).from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.seasonId, seasonId));
  const teamIdToMca = new Map(mcaTeams.map(t => [t.teamId, t]));

  const payouts = [
    await getPayoutValue(PAYOUT_KEYS.SEASON_PR_1),   // rank 1
    await getPayoutValue(PAYOUT_KEYS.SEASON_PR_2),   // rank 2
    await getPayoutValue(PAYOUT_KEYS.SEASON_PR_3_6), // rank 3-6
    await getPayoutValue(PAYOUT_KEYS.SEASON_PR_7_8), // rank 7-8
    await getPayoutValue(PAYOUT_KEYS.SEASON_PR_9_10),// rank 9-10
  ];

  function rankToPayout(rank: number): number {
    if (rank === 1)            return payouts[0]!;
    if (rank === 2)            return payouts[1]!;
    if (rank >= 3 && rank <=6) return payouts[2]!;
    if (rank >= 7 && rank <=8) return payouts[3]!;
    return payouts[4]!;
  }

  const prLines: string[] = [];

  for (const entry of top10) {
    const mca = teamIdToMca.get(entry.teamId);
    const teamDisplay = mca?.nickName || entry.teamName || `Team #${entry.teamId}`;
    const bonus = rankToPayout(entry.rank);

    if (mca?.discordId) {
      await addBalance(mca.discordId, bonus);
      await logTransaction(mca.discordId, bonus, "addcoins",
        `Season PR ranking bonus — #${entry.rank} (${teamDisplay})`, "system");
      try {
        const u = await client.users.fetch(mca.discordId);
        await u.send(
          `📊 **Season PR Bonus!** You finished **#${entry.rank}** in the Season Power Rankings — ` +
          `**+${bonus} 🪙** added to your balance!`
        ).catch(() => {});
      } catch (_) {}
    }

    const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : "📊";
    prLines.push(`${medal} **#${entry.rank}** ${teamDisplay} (${entry.wins}–${entry.losses}) — **+${bonus} 🪙**`);
  }

  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle("📊 Season Power Rankings — Bonus Payouts")
      .setColor(Colors.Blurple)
      .setDescription(prLines.join("\n") || "*No standings data available*")
      .setFooter({ text: "Top 10 PR finishers awarded coins based on final season ranking" })
      .setTimestamp()],
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// SECTION 4: GOTY Poll
// ────────────────────────────────────────────────────────────────────────────────

async function createGotyPoll(
  client: Client,
  historicalChannel: TextChannel,
  seasonId: number,
): Promise<void> {
  // Fetch the GOTY candidate channel
  let gotyChannel: TextChannel | null = null;
  try {
    const ch = await client.channels.fetch(GOTY_CANDIDATE_CHANNEL_ID);
    if (ch?.isTextBased()) gotyChannel = ch as TextChannel;
  } catch { return; }

  if (!gotyChannel) return;

  // Collect all non-bot entries before clearing
  const fetched = await gotyChannel.messages.fetch({ limit: 100 });
  const entryMessages = [...fetched.values()].filter(
    m => !m.author.bot && m.content.trim().length > 0,
  );
  const options = entryMessages
    .map(m => truncatePollAnswer(m.content))
    .slice(0, 100);

  if (options.length === 0) {
    await historicalChannel.send({ content: "*No GOTY candidates found in the candidate channel.*" });
    return;
  }

  // ── Clear the GOTY channel (bulk-delete recent; fall back to one-by-one for older) ──
  const allMessages = [...fetched.values()];
  try {
    await gotyChannel.bulkDelete(allMessages, true); // true = filter messages > 14 days
  } catch {
    // bulkDelete unavailable — delete individually
    for (const m of allMessages) {
      await m.delete().catch(() => {});
    }
  }

  // Post announcement embed in the GOTY channel, then the poll
  await gotyChannel.send({
    embeds: [new EmbedBuilder()
      .setTitle("🎮 Game of the Year Award — Vote Now!")
      .setColor(Colors.DarkGold)
      .setDescription(
        "Cast your vote below! Poll closes in **12 hours**.\n" +
        "After voting ends, the commissioners will select the two official winners.\n\n" +
        "**Winners receive coins + 1 free XF promotion (must be used before next season)!**"
      )
      .setTimestamp()],
  });

  const pollMessages = await createPoll(
    gotyChannel,
    "Who was the GOTY for this season?",
    options,
    12,
  );

  // Store all poll message IDs (channelId = GOTY channel so poll-checker can fetch results)
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  for (const msg of pollMessages) {
    await db.insert(pendingPollsTable).values({
      messageId:           msg.id,
      channelId:           GOTY_CANDIDATE_CHANNEL_ID,
      pollType:            "goty",
      seasonId,
      expiresAt,
      historicalChannelId: historicalChannel.id,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// SECTION 5: Stat Leaders (top 3 each category)
// ────────────────────────────────────────────────────────────────────────────────

const STAT_CATS = [
  { label: "🎯 Passing Yards",  field: (p: any) => p.passYds,      unit: "yds"    },
  { label: "🏆 Passing TDs",    field: (p: any) => p.passTDs,      unit: "TDs"    },
  { label: "💨 Rushing Yards",  field: (p: any) => p.rushYds,      unit: "yds"    },
  { label: "🏆 Rushing TDs",    field: (p: any) => p.rushTDs,      unit: "TDs"    },
  { label: "🙌 Rec. Yards",     field: (p: any) => p.recYds,       unit: "yds"    },
  { label: "🏆 Rec. TDs",       field: (p: any) => p.recTDs,       unit: "TDs"    },
  { label: "💥 Sacks",          field: (p: any) => p.sacks,        unit: "sacks"  },
  { label: "🫳 Def INTs",       field: (p: any) => p.defInts,      unit: "INTs"   },
  { label: "🦺 Total Tackles",  field: (p: any) =>
      p.totalTackles > 0 ? p.totalTackles : p.tackleSolo + p.tackleAssist, unit: "tackles" },
];

async function postStatLeaders(
  channel: TextChannel,
  seasonId: number,
  seasonNumber: number,
): Promise<void> {
  const players = await db.select().from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, seasonId));

  if (players.length === 0) {
    await channel.send({ content: "*No player stat data available for stat leaders.*" });
    return;
  }

  function buildLeaders(field: (p: any) => number, unit: string, topN = 3): string {
    return players
      .map(p => ({ p, val: field(p) }))
      .filter(x => x.val > 0)
      .sort((a, b) => b.val - a.val)
      .slice(0, topN)
      .map(({ p, val }, i) => {
        const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown";
        const pos  = p.position ? `, ${p.position}` : "";
        return `**#${i + 1}** ${name}${pos} (${p.teamName || "?"}) — ${val.toLocaleString()} ${unit}`;
      })
      .join("\n") || "*No data*";
  }

  const embed1 = new EmbedBuilder()
    .setTitle(`📊 Season ${seasonNumber} Stat Leaders — Top 3 Each Category`)
    .setColor(Colors.Blurple);
  for (const cat of STAT_CATS.slice(0, 5)) {
    embed1.addFields({ name: cat.label, value: buildLeaders(cat.field, cat.unit) });
  }
  const embed2 = new EmbedBuilder().setColor(Colors.Blurple);
  for (const cat of STAT_CATS.slice(5)) {
    embed2.addFields({ name: cat.label, value: buildLeaders(cat.field, cat.unit) });
  }

  await channel.send({ embeds: [embed1, embed2] });
}

// ────────────────────────────────────────────────────────────────────────────────
// SECTION 6: Divisional winners + playoff seeds
// ────────────────────────────────────────────────────────────────────────────────

async function postPlayoffSection(
  channel: TextChannel,
  seasonId: number,
  seasonNumber: number,
): Promise<void> {
  // Pull seeded users + their season records
  const seededUsers = await db.select({
    discordId:         usersTable.discordId,
    team:              usersTable.team,
    playoffSeed:       usersTable.playoffSeed,
    playoffConference: usersTable.playoffConference,
  }).from(usersTable)
    .where(sql`${usersTable.playoffSeed} IS NOT NULL`);

  const records = await db.select({
    discordId: userRecordsTable.discordId,
    wins:      userRecordsTable.wins,
    losses:    userRecordsTable.losses,
  }).from(userRecordsTable).where(eq(userRecordsTable.seasonId, seasonId));

  const recordMap = new Map(records.map(r => [r.discordId, r]));

  function formatSeedLine(u: typeof seededUsers[0], seed: number): string {
    const rec  = recordMap.get(u.discordId);
    const wl   = rec ? `${rec.wins}–${rec.losses}` : "?–?";
    const icon = seed <= 4 ? "🏆" : "🃏";
    return `${icon} **Seed ${seed}** — ${u.team ?? "Unknown"} (${wl})`;
  }

  const afc = seededUsers
    .filter(u => u.playoffConference === "AFC" && u.playoffSeed != null)
    .sort((a, b) => (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99));
  const nfc = seededUsers
    .filter(u => u.playoffConference === "NFC" && u.playoffSeed != null)
    .sort((a, b) => (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99));

  const afcDiv = afc.filter(u => (u.playoffSeed ?? 99) <= 4);
  const nfcDiv = nfc.filter(u => (u.playoffSeed ?? 99) <= 4);

  const embed = new EmbedBuilder()
    .setTitle(`🏈 Season ${seasonNumber} — Playoff Picture`)
    .setColor(Colors.DarkGreen);

  if (afcDiv.length > 0) {
    embed.addFields({
      name:  "🏅 AFC Division Winners",
      value: afcDiv.map(u => {
        const rec = recordMap.get(u.discordId);
        const wl  = rec ? `${rec.wins}–${rec.losses}` : "?–?";
        return `🏆 ${u.team ?? "Unknown"} (${wl})`;
      }).join("\n"),
    });
  }
  if (nfcDiv.length > 0) {
    embed.addFields({
      name:  "🏅 NFC Division Winners",
      value: nfcDiv.map(u => {
        const rec = recordMap.get(u.discordId);
        const wl  = rec ? `${rec.wins}–${rec.losses}` : "?–?";
        return `🏆 ${u.team ?? "Unknown"} (${wl})`;
      }).join("\n"),
    });
  }
  if (afc.length > 0) {
    embed.addFields({ name: "🔷 AFC Playoff Seeds (1–7)", value: afc.map(u => formatSeedLine(u, u.playoffSeed!)).join("\n") });
  }
  if (nfc.length > 0) {
    embed.addFields({ name: "🔶 NFC Playoff Seeds (1–7)", value: nfc.map(u => formatSeedLine(u, u.playoffSeed!)).join("\n") });
  }

  embed.setTimestamp();
  await channel.send({ embeds: [embed] });
}

// ────────────────────────────────────────────────────────────────────────────────
// SECTION 7: Community polls
// ────────────────────────────────────────────────────────────────────────────────

async function createCommunityPolls(
  client: Client,
  channel: TextChannel,
  seasonId: number,
): Promise<void> {
  // Fetch all active users with teams
  const allUsers = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  }).from(usersTable);

  const activeTeams = allUsers
    .map(u => u.team)
    .filter((t): t is string => !!t)
    .sort();

  // Build season records to find bottom 5
  const records = await db.select({
    discordId: userRecordsTable.discordId,
    wins:      userRecordsTable.wins,
    losses:    userRecordsTable.losses,
  }).from(userRecordsTable).where(eq(userRecordsTable.seasonId, seasonId));

  const teamMap = new Map(allUsers.filter(u => u.team).map(u => [u.discordId, u.team!]));

  // Sort by worst H2H record (fewest wins, then most losses)
  const withRecords = records
    .filter(r => teamMap.has(r.discordId))
    .map(r => ({ team: teamMap.get(r.discordId)!, wins: r.wins, losses: r.losses }))
    .sort((a, b) => a.wins !== b.wins ? a.wins - b.wins : b.losses - a.losses);

  const bottom5Teams = withRecords.slice(0, 5).map(r => r.team);

  const expiresAt12 = new Date(Date.now() + 12 * 60 * 60 * 1000);

  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle("🗳️ Community Awards — Vote Now!")
      .setColor(Colors.DarkBlue)
      .setDescription("Polls close in **12 hours**. Each poll allows one vote — choose wisely!")
      .setTimestamp()],
  });

  const pollDefs: Array<{ question: string; options: string[]; type: string }> = [
    { question: "Who had the LOUDEST mouth?",    options: activeTeams, type: "loudest"     },
    { question: "Who had the most HEART?",       options: activeTeams, type: "heart"       },
    { question: "Who was the BEST of the WORST?",options: bottom5Teams, type: "best_worst"  },
    { question: "Who was the WORST of the WORST?",options: bottom5Teams, type: "worst_worst" },
  ];

  for (const def of pollDefs) {
    if (def.options.length === 0) continue;
    const msgs = await createPoll(channel, def.question, def.options, 12);
    for (const msg of msgs) {
      await db.insert(pendingPollsTable).values({
        messageId:           msg.id,
        channelId:           channel.id,
        pollType:            def.type,
        seasonId,
        expiresAt:           expiresAt12,
        historicalChannelId: channel.id,
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// OFFSEASON: Post PR data to historical channel
// ────────────────────────────────────────────────────────────────────────────────

export async function runOffseasonHistoricalPost(
  client: Client,
  seasonId: number,
  seasonNumber: number,
): Promise<void> {
  // Look up the historical channel for this season
  const [row] = await db.select().from(seasonHistoricalChannelsTable)
    .where(eq(seasonHistoricalChannelsTable.seasonId, seasonId)).limit(1);
  if (!row) {
    console.warn("[offseason] No historical channel found for season", seasonId);
    return;
  }

  let channel: TextChannel | null = null;
  try {
    const ch = await client.channels.fetch(row.channelId);
    if (ch?.isTextBased()) channel = ch as TextChannel;
  } catch { return; }
  if (!channel) return;

  // All-time records
  const allUsers = await db.select({
    discordId:      usersTable.discordId,
    team:           usersTable.team,
    allTimeH2HWins: usersTable.allTimeH2HWins,
    allTimeH2HLosses: usersTable.allTimeH2HLosses,
  }).from(usersTable);

  allUsers.sort((a, b) => (b.allTimeH2HWins ?? 0) - (a.allTimeH2HWins ?? 0));

  const allTimeLines = allUsers.slice(0, 15).map((u, i) => {
    const wl = `${u.allTimeH2HWins ?? 0}–${u.allTimeH2HLosses ?? 0}`;
    return `**#${i + 1}** ${u.team ?? "Unknown"} — ${wl}`;
  });

  // Season records
  const records = await db.select({
    discordId: userRecordsTable.discordId,
    wins:      userRecordsTable.wins,
    losses:    userRecordsTable.losses,
  }).from(userRecordsTable).where(eq(userRecordsTable.seasonId, seasonId));

  const teamMap = new Map(allUsers.map(u => [u.discordId, u.team ?? "Unknown"]));
  records.sort((a, b) => b.wins !== a.wins ? b.wins - a.wins : a.losses - b.losses);

  const seasonLines = records.slice(0, 15).map((r, i) => {
    const team = teamMap.get(r.discordId) ?? "Unknown";
    return `**#${i + 1}** ${team} — ${r.wins}–${r.losses}`;
  });

  // Season PR from standings JSON
  const raw = await readMcaJson("mca/standings.json");
  const prLines: string[] = [];
  if (raw && typeof raw === "object") {
    const body    = raw as Record<string, unknown>;
    const listKey = Object.keys(body).find(k => k.toLowerCase().includes("standing") && Array.isArray(body[k]));
    if (listKey) {
      const mcaTeams = await db.select({ teamId: franchiseMcaTeamsTable.teamId, nickName: franchiseMcaTeamsTable.nickName })
        .from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.seasonId, seasonId));
      const teamIdToNick = new Map(mcaTeams.map(t => [t.teamId, t.nickName]));
      const standings = (body[listKey] as Record<string, unknown>[])
        .map(s => ({
          teamId:  Number(s["teamId"] ?? 0),
          rank:    Number(s["rank"] ?? s["stPRank"] ?? 999),
          wins:    Number(s["wins"] ?? 0),
          losses:  Number(s["losses"] ?? 0),
          name:    String(s["teamName"] ?? s["teamNickName"] ?? ""),
        }))
        .sort((a, b) => a.rank - b.rank);
      for (const s of standings.slice(0, 15)) {
        const name = teamIdToNick.get(s.teamId) || s.name;
        prLines.push(`**#${s.rank}** ${name} (${s.wins}–${s.losses})`);
      }
    }
  }

  const allTimeEmbed = new EmbedBuilder()
    .setTitle(`📜 All-Time Records — Through Season ${seasonNumber}`)
    .setColor(Colors.DarkGold)
    .setDescription(allTimeLines.join("\n") || "*No data*")
    .setTimestamp();

  const seasonEmbed = new EmbedBuilder()
    .setTitle(`📊 Season ${seasonNumber} Final Records`)
    .setColor(Colors.Blurple)
    .setDescription(seasonLines.join("\n") || "*No data*")
    .setTimestamp();

  await channel.send({ content: "📌 **POST-SEASON RECORDS PINNED**", embeds: [allTimeEmbed, seasonEmbed] });

  if (prLines.length > 0) {
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle(`📊 Season ${seasonNumber} Final Power Rankings`)
        .setColor(Colors.Blurple)
        .setDescription(prLines.join("\n"))
        .setTimestamp()],
    });
  }
}
