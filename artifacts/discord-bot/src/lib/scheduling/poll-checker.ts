/**
 * poll-checker.ts
 *
 * Checks pending polls that have expired and:
 *  - For GOTY polls: posts results + a "Select Winners" button in the commissioners log
 *  - For community polls (loudest/heart/best_worst/worst_worst): marks processed (results are visible in Discord)
 *
 * Called on bot startup and every 30 minutes thereafter.
 */

import {
  Client, TextChannel, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { pendingPollsTable, seasonsTable } from "@workspace/db";
import { eq, and, lte } from "drizzle-orm";
import { PRIMARY_GUILD_ID, getGuildChannel, CHANNEL_KEYS } from "../db/db-helpers.js";

export function startPollChecker(client: Client): void {
  // Run immediately on startup then every 30 minutes
  setTimeout(async () => {
    await checkExpiredPolls(client);
    setInterval(() => checkExpiredPolls(client), 30 * 60 * 1000);
  }, 15_000); // wait 15s for bot to fully connect
}

export async function checkExpiredPolls(client: Client): Promise<void> {
  const expired = await db.select().from(pendingPollsTable)
    .where(and(
      eq(pendingPollsTable.processed, false),
      lte(pendingPollsTable.expiresAt, new Date()),
    ));

  if (expired.length === 0) return;
  console.log(`[pollChecker] Found ${expired.length} expired unprocessed poll(s)`);

  for (const poll of expired) {
    try {
      // Mark processed immediately to avoid double-firing
      await db.update(pendingPollsTable)
        .set({ processed: true, processedAt: new Date() })
        .where(eq(pendingPollsTable.id, poll.id));

      if (poll.pollType === "goty") {
        await handleGotyPollExpiry(client, poll);
      }
      // Community polls (loudest/heart/best_worst/worst_worst) expire naturally — no action needed
    } catch (err) {
      console.error(`[pollChecker] Error processing poll ${poll.id}:`, err);
      // Revert processed flag so it can be retried
      await db.update(pendingPollsTable)
        .set({ processed: false, processedAt: null })
        .where(eq(pendingPollsTable.id, poll.id));
    }
  }
}

async function handleGotyPollExpiry(
  client: Client,
  poll: typeof pendingPollsTable.$inferSelect,
): Promise<void> {
  // Resolve guild ID from the poll's season
  const [seasonRow] = await db.select({ guildId: seasonsTable.guildId })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, poll.seasonId))
    .limit(1);
  const guildId = seasonRow?.guildId ?? PRIMARY_GUILD_ID;

  const commChannelId =
    await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG)
    ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER);
  if (!commChannelId) {
    console.warn("[pollChecker] Commissioner log channel not configured — cannot post GOTY results");
    return;
  }

  // Fetch the poll message to read vote counts
  let topAnswers = "";
  try {
    const ch  = await client.channels.fetch(poll.channelId);
    const msg = ch?.isTextBased()
      ? await (ch as TextChannel).messages.fetch(poll.messageId).catch(() => null)
      : null;

    if (msg?.poll) {
      const answers = [...msg.poll.answers.values()];
      answers.sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0));
      topAnswers = answers
        .slice(0, 10)
        .map((a, i) => `**${i + 1}.** ${a.text} — ${a.voteCount ?? 0} vote(s)`)
        .join("\n");
    }
  } catch (err) {
    console.warn("[pollChecker] Could not fetch poll message for vote counts:", err);
  }

  const commChannel = await client.channels.fetch(commChannelId).catch(() => null);
  if (!commChannel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle("🎮 GOTY Poll Expired — Select Winners")
    .setColor(Colors.Gold)
    .setDescription(
      `The Game of the Year poll for Season has ended.\n\n` +
      (topAnswers ? `**Top vote-getters:**\n${topAnswers}\n\n` : "") +
      `Select **1 or 2 GOTY winners** below.\n` +
      `*(Select 1 if one winner's team is now CPU-controlled.)*\n` +
      `Each winner receives **100 🪙** + **1 free XF promotion** for any player.`
    )
    .setFooter({ text: `Poll ID: ${poll.id} | Season ${poll.seasonId}` })
    .setTimestamp();

  const button = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`goty_select:${poll.seasonId}`)
      .setLabel("🏆 Select GOTY Winners")
      .setStyle(ButtonStyle.Success),
  );

  await (commChannel as TextChannel).send({ embeds: [embed], components: [button] });
}
