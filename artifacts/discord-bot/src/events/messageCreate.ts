import { Events, Message, PermissionFlagsBits } from "discord.js";
import { db } from "@workspace/db";
import { pendingChannelPayoutsTable, guildChannelsTable } from "@workspace/db";
import { and, eq, count } from "drizzle-orm";
import {
  getOrCreateActiveSeason,
  PRIMARY_GUILD_ID,
  getGuildChannel,
  CHANNEL_KEYS,
} from "../lib/db/db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/economy/payout-config.js";

const PLAYOFF_WEEKS_SET = new Set(["wildcard", "divisional", "conference", "superbowl"]);

const TWITCH_URL_RE = /https?:\/\/(?:[\w-]+\.)?twitch\.tv\/\S+/i;


async function isCommissionerOrAdminMessage(message: Message): Promise<boolean> {
  const member = await message.guild?.members.fetch(message.author.id).catch(() => null);
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((r) => r.name.toLowerCase() === "commissioner");
}

async function handleGamedayChannelMessage(message: Message): Promise<boolean> {
  const guildId = message.guildId ?? PRIMARY_GUILD_ID;
  const [active] = await db.select({ channelId: guildChannelsTable.channelId })
    .from(guildChannelsTable)
    .where(and(
      eq(guildChannelsTable.guildId, guildId),
      eq(guildChannelsTable.channelKey, "gameday_active"),
    ))
    .limit(1);

  if (!active || active.channelId !== message.channelId) return false;
  if (await isCommissionerOrAdminMessage(message)) return true;

  await message.delete().catch(() => null);
  return true;
}


async function reactOk(message: Message): Promise<void> {
  try { await message.react("✅"); } catch { /* ignore */ }
}

async function handleStreamPost(message: Message): Promise<void> {
  if (!TWITCH_URL_RE.test(message.content)) return;

  try {
    const guildId     = message.guildId!;
    const season      = await getOrCreateActiveSeason(guildId);
    const currentWeek = (season as any).currentWeek ?? "1";
    const streamPayout = await getPayoutValue(PAYOUT_KEYS.STREAM_PAYOUT, guildId);

    // Dedup: one pending/approved stream payout per user per season+week
    const [existing] = await db
      .select({ id: pendingChannelPayoutsTable.id })
      .from(pendingChannelPayoutsTable)
      .where(and(
        eq(pendingChannelPayoutsTable.type, "stream"),
        eq(pendingChannelPayoutsTable.discordId, message.author.id),
        eq(pendingChannelPayoutsTable.seasonId, season.id),
        eq(pendingChannelPayoutsTable.week, currentWeek),
        eq(pendingChannelPayoutsTable.status, "pending"),
      ))
      .limit(1);

    if (existing) { await reactOk(message); return; }

    await db.insert(pendingChannelPayoutsTable).values({
      type:      "stream",
      discordId: message.author.id,
      amount:    streamPayout,
      channelId: message.channelId,
      messageId: message.id,
      guildId,
      seasonId:  season.id,
      week:      currentWeek,
    });

    await reactOk(message);
  } catch (err) {
    console.error("[messageCreate] handleStreamPost error:", err);
  }
}

async function handleHighlightPost(message: Message): Promise<void> {
  const videoAttachments = [...message.attachments.values()].filter(
    a => a.contentType?.startsWith("video/"),
  );
  if (videoAttachments.length === 0) return;

  try {
    const guildId         = message.guildId!;
    const season          = await getOrCreateActiveSeason(guildId);
    const currentWeek     = (season as any).currentWeek ?? "1";
    const isPlayoffWeek   = PLAYOFF_WEEKS_SET.has(currentWeek);
    const highlightLimit  = await getPayoutValue(PAYOUT_KEYS.HIGHLIGHT_LIMIT, guildId);
    const highlightPayout = await getPayoutValue(
      isPlayoffWeek ? PAYOUT_KEYS.HIGHLIGHT_PLAYOFF_PAYOUT : PAYOUT_KEYS.HIGHLIGHT_PAYOUT,
      guildId,
    );

    const [countRow] = await db
      .select({ total: count() })
      .from(pendingChannelPayoutsTable)
      .where(and(
        eq(pendingChannelPayoutsTable.type, "highlight"),
        eq(pendingChannelPayoutsTable.discordId, message.author.id),
        eq(pendingChannelPayoutsTable.seasonId, season.id),
        eq(pendingChannelPayoutsTable.week, currentWeek),
        eq(pendingChannelPayoutsTable.status, "pending"),
      ));

    const usedSlots = Number(countRow?.total ?? 0);
    if (usedSlots >= highlightLimit) { await reactOk(message); return; }

    const slotsToCreate = Math.min(videoAttachments.length, highlightLimit - usedSlots);

    for (let i = 0; i < slotsToCreate; i++) {
      await db.insert(pendingChannelPayoutsTable).values({
        type:      "highlight",
        discordId: message.author.id,
        amount:    highlightPayout,
        channelId: message.channelId,
        messageId: message.id,
        guildId,
        seasonId:  season.id,
        week:      currentWeek,
      });
    }

    await reactOk(message);
  } catch (err) {
    console.error("[messageCreate] handleHighlightPost error:", err);
  }
}

export const name = Events.MessageCreate;
export const once = false;

export async function execute(message: Message): Promise<void> {
  if (!message.guild) return;
  if (message.author.bot) return;

  if (await handleGamedayChannelMessage(message)) return;

  const guildId = message.guildId ?? PRIMARY_GUILD_ID;
  const [streamCh, highlightsCh] = await Promise.all([
    getGuildChannel(guildId, CHANNEL_KEYS.STREAM).catch(() => null),
    getGuildChannel(guildId, CHANNEL_KEYS.HIGHLIGHTS).catch(() => null),
  ]);

  if (streamCh && message.channelId === streamCh) {
    await handleStreamPost(message);
    return;
  }
  if (highlightsCh && message.channelId === highlightsCh) {
    await handleHighlightPost(message);
    return;
  }
}
