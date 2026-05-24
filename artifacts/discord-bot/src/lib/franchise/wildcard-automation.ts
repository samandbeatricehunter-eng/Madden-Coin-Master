/**
 * wildcard-automation.ts
 *
 * Fires when the league advances from Week 18 → Wildcard.
 *
 * After the cleanup, this module's ONLY responsibility is to seed the in-menu
 * Game-of-the-Year voting round for the just-finished regular season:
 *
 *   1. Scrape last 100 messages from the GOTY-designated channel.
 *   2. Filter bots / empty / dupes, truncate each to 200 chars.
 *   3. Insert as `goty_candidates` rows (idx is insertion order).
 *   4. Insert/refresh a `goty_rounds` row with `voteEndsAt = now + 24h`,
 *      `status = 'open'`.
 *   5. Post a short announcement in the GOTY channel pointing voters at
 *      `/menu → 🎮 GOTY Vote`.
 *
 * Everything else the old wildcard automation did (historical-records channel,
 * in-game awards, stat leaders, community polls, Discord-poll GOTY) has been
 * removed. Coin payouts for the season (incl. PR bonuses, end-of-season stat
 * tiers) are queued to the Commissioner's Office by `eos-auto-post.ts`.
 *
 * `rebuildHistoricalChannel` and `runOffseasonHistoricalPost` remain as
 * no-op stubs so existing admin buttons stay wired but report that the
 * feature has been retired.
 */

import {
  Client, Guild, ChannelType, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { gotyRoundsTable, gotyCandidatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  PRIMARY_GUILD_ID, getGuildChannel, CHANNEL_KEYS,
} from "../db/db-helpers.js";

const GOTY_VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const GOTY_CANDIDATE_TEXT_MAX = 200;
const GOTY_SCRAPE_LIMIT = 100;

function normaliseCandidate(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > GOTY_CANDIDATE_TEXT_MAX
    ? cleaned.slice(0, GOTY_CANDIDATE_TEXT_MAX - 1) + "…"
    : cleaned;
}

/**
 * Seed the GOTY in-menu vote for the just-finished season.
 * Safe to call repeatedly — the candidate set + round window are refreshed.
 */
async function seedGotyRound(
  client: Client,
  guild: Guild,
  seasonId: number,
  seasonNumber: number,
): Promise<void> {
  const gotyChannelId = await getGuildChannel(guild.id, CHANNEL_KEYS.GOTY);
  if (!gotyChannelId) {
    console.warn(`[wildcard] No GOTY channel configured for guild ${guild.id} — skipping GOTY seed`);
    return;
  }

  let gotyChannel: TextChannel | null = null;
  try {
    const ch = await client.channels.fetch(gotyChannelId);
    if (ch?.type === ChannelType.GuildText) gotyChannel = ch as TextChannel;
  } catch (err) {
    console.warn(`[wildcard] Failed to fetch GOTY channel ${gotyChannelId}:`, err);
    return;
  }
  if (!gotyChannel) return;

  // Scrape last 100 user messages, dedupe by lowercased text, preserve chronological order.
  const fetched = await gotyChannel.messages.fetch({ limit: GOTY_SCRAPE_LIMIT });
  const chronological = [...fetched.values()].reverse(); // oldest → newest
  const seen = new Set<string>();
  const candidates: { text: string; authorId: string }[] = [];
  for (const m of chronological) {
    if (m.author.bot) continue;
    const text = normaliseCandidate(m.content);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ text, authorId: m.author.id });
  }

  if (candidates.length === 0) {
    console.warn(`[wildcard] GOTY channel has no eligible candidate messages for season ${seasonNumber}`);
    return;
  }

  // Wipe any prior candidates for this season and reseed (idempotent reruns).
  await db.delete(gotyCandidatesTable).where(eq(gotyCandidatesTable.seasonId, seasonId));
  await db.insert(gotyCandidatesTable).values(
    candidates.map((c, i) => ({
      seasonId,
      idx: i,
      text: c.text,
      authorId: c.authorId,
    })),
  );

  const voteEndsAt = new Date(Date.now() + GOTY_VOTE_WINDOW_MS);

  // Post announcement first so we can persist the message id.
  let announcementMessageId: string | null = null;
  const announcement =
    `🎮 **Season ${seasonNumber} — Game of the Year Voting is OPEN!**\n` +
    `Voting closes <t:${Math.floor(voteEndsAt.getTime() / 1000)}:R> ` +
    `(<t:${Math.floor(voteEndsAt.getTime() / 1000)}:F>).\n\n` +
    `**${candidates.length}** candidates were pulled from the last ${GOTY_SCRAPE_LIMIT} messages here.\n` +
    `Cast your vote: \`/menu\` → **🎮 GOTY Vote**\n\n` +
    `_Each of the top 2 finishing candidates' submitters wins coins when voting closes._`;
  try {
    const msg = await gotyChannel.send({ content: announcement });
    announcementMessageId = msg.id;
  } catch (err) {
    console.warn("[wildcard] Failed to post GOTY announcement:", err);
  }

  await db.insert(gotyRoundsTable).values({
    seasonId,
    voteEndsAt,
    status: "open",
    announcementMessageId,
    announcementChannelId: gotyChannel.id,
  }).onConflictDoUpdate({
    target: gotyRoundsTable.seasonId,
    set: {
      voteEndsAt,
      status: "open",
      announcementMessageId,
      announcementChannelId: gotyChannel.id,
      finalizedAt: null,
    },
  });

  console.log(`[wildcard] Seeded GOTY round for season ${seasonNumber} with ${candidates.length} candidates`);
}

export async function runWildcardAutomation(
  client: Client,
  seasonId: number,
  seasonNumber: number,
  guild?: Guild | null,
): Promise<void> {
  console.log(`[wildcard] Starting GOTY seed for Season ${seasonNumber}...`);

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

  try {
    await seedGotyRound(client, resolvedGuild, seasonId, seasonNumber);
  } catch (err) {
    console.error("[wildcard] GOTY seed failed:", err);
  }

  console.log(`[wildcard] Automation complete for Season ${seasonNumber}`);
}

/**
 * Historical channel rebuild has been retired along with the EOS auto-posts.
 * Kept as a stub so admin buttons stay wired.
 */
export async function rebuildHistoricalChannel(
  _client: Client,
  _seasonId: number,
  _seasonNumber: number,
  _guild?: Guild | null,
): Promise<{ ok: boolean; message: string }> {
  return {
    ok: false,
    message:
      "ℹ️ The end-of-season historical-records channel has been retired. " +
      "Coin payouts (PR bonuses, stat tiers, GOTY winners) now flow through the Commissioner's Office.",
  };
}

/**
 * Offseason historical post has been retired along with the EOS auto-posts.
 */
export async function runOffseasonHistoricalPost(
  _client: Client,
  _seasonId: number,
  _seasonNumber: number,
): Promise<{ ok: boolean; message: string }> {
  return {
    ok: false,
    message:
      "ℹ️ The offseason historical post has been retired. " +
      "Coin payouts now flow through the Commissioner's Office.",
  };
}
