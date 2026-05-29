import { Events, Message, PermissionFlagsBits } from "discord.js";
import { db } from "@workspace/db";
import { pendingChannelPayoutsTable, guildChannelsTable } from "@workspace/db";
import { and, eq, count } from "drizzle-orm";
import {
  getOrCreateActiveSeason,
  PRIMARY_GUILD_ID,
  getGuildChannel,
  CHANNEL_KEYS,
  addBalance,
  logTransaction,
} from "../lib/db/db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/economy/payout-config.js";
import { promptHighlightNomination } from "../lib/media/play-of-the-year.js";

const PLAYOFF_WEEKS_SET = new Set(["wildcard", "divisional", "conference", "superbowl"]);
const HIGHLIGHT_AUTO_PAYOUT = 50;

function isDiscordStreamLabel(content: string): boolean {
  return content.trim().toLowerCase() === "discord";
}

function hasValidUrl(content: string): boolean {
  if (isDiscordStreamLabel(content)) return true;
  const match = content.match(/https?:\/\/\S+/i);
  if (!match) return false;
  try {
    const url = new URL(match[0]);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}


function isAllowedStreamHost(content: string): boolean {
  if (isDiscordStreamLabel(content)) return true;
  const match = content.match(/https?:\/\/\S+/i);
  if (!match) return false;
  try {
    const url = new URL(match[0]);
    const host = url.hostname.toLowerCase();
    return (
      host.includes("twitch.tv") ||
      host.includes("youtube.com") ||
      host.includes("youtu.be") ||
      host.includes("kick.com") ||
      host.includes("facebook.com") ||
      host.includes("xbox.com") ||
      host.includes("discord.com")
    );
  } catch {
    return false;
  }
}

async function isReachableUrl(content: string): Promise<boolean> {
  if (isDiscordStreamLabel(content)) return true;
  const match = content.match(/https?:\/\/\S+/i);
  if (!match) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(match[0], { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (res.ok || (res.status >= 300 && res.status < 400)) return true;
    const getRes = await fetch(match[0], { method: "GET", redirect: "follow", signal: controller.signal });
    return getRes.ok || (getRes.status >= 300 && getRes.status < 400);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function reactOk(message: Message): Promise<void> {
  try { await message.react("✅"); } catch { /* ignore */ }
}

async function dmUser(message: Message, content: string): Promise<void> {
  await message.author.send(content).catch(() => null);
}

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
  // Phase 4.1: gameday channel permissions prevent regular users from sending.
  // Do not auto-delete user messages anymore; return false so stream/highlight
  // handlers can still operate in their configured channels if needed.
  return false;
}

async function handleStreamPost(message: Message): Promise<void> {
  if (!hasValidUrl(message.content)) return;
  if (!isAllowedStreamHost(message.content) || !(await isReachableUrl(message.content))) {
    await dmUser(message, "❌ Your stream link was not paid because it was not a reachable supported stream URL. Supported examples: Twitch, YouTube, Kick, Facebook, Xbox, or Discord links.");
    return;
  }

  try {
    const guildId = message.guildId!;
    const season = await getOrCreateActiveSeason(guildId);
    const currentWeek = (season as any).currentWeek ?? "1";
    const streamPayout = await getPayoutValue(PAYOUT_KEYS.STREAM_PAYOUT, guildId);

    const [existing] = await db
      .select({ id: pendingChannelPayoutsTable.id })
      .from(pendingChannelPayoutsTable)
      .where(and(
        eq(pendingChannelPayoutsTable.type, "stream"),
        eq(pendingChannelPayoutsTable.discordId, message.author.id),
        eq(pendingChannelPayoutsTable.seasonId, season.id),
        eq(pendingChannelPayoutsTable.week, currentWeek),
      ))
      .limit(1);

    if (existing) { await reactOk(message); return; }

    await db.insert(pendingChannelPayoutsTable).values({
      type: "stream",
      discordId: message.author.id,
      amount: streamPayout,
      channelId: message.channelId,
      messageId: message.id,
      guildId,
      seasonId: season.id,
      week: currentWeek,
      status: "approved",
      resolvedAt: new Date(),
      resolvedBy: "bot:auto",
    });

    await addBalance(message.author.id, streamPayout, guildId);
    await logTransaction(message.author.id, streamPayout, "payout", `Auto stream payout — ${currentWeek}`, guildId, "stream");

    await reactOk(message);
    await dmUser(message, `✅ Your stream link was logged and **${streamPayout} coins** were paid automatically.`);
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
    const guildId = message.guildId!;
    const season = await getOrCreateActiveSeason(guildId);
    const currentWeek = (season as any).currentWeek ?? "1";

    if (videoAttachments.length > 1) {
      await message.delete().catch(() => null);
      await dmUser(
        message,
        "❌ Your highlight post was removed because it included multiple video clips.\n\nOnly **one highlight upload** is allowed per advance week. Please repost the single clip you want to count.",
      );
      return;
    }

    const [existing] = await db
      .select({ id: pendingChannelPayoutsTable.id })
      .from(pendingChannelPayoutsTable)
      .where(and(
        eq(pendingChannelPayoutsTable.type, "highlight"),
        eq(pendingChannelPayoutsTable.discordId, message.author.id),
        eq(pendingChannelPayoutsTable.seasonId, season.id),
        eq(pendingChannelPayoutsTable.week, currentWeek),
      ))
      .limit(1);

    if (existing) {
      await message.delete().catch(() => null);
      await dmUser(
        message,
        "❌ Your highlight post was removed because you already submitted your weekly highlight for this advance week.\n\nOnly **one highlight upload** is eligible per advance week.",
      );
      return;
    }

    await db.insert(pendingChannelPayoutsTable).values({
      type: "highlight",
      discordId: message.author.id,
      amount: HIGHLIGHT_AUTO_PAYOUT,
      channelId: message.channelId,
      messageId: message.id,
      guildId,
      seasonId: season.id,
      week: currentWeek,
      status: "approved",
      resolvedAt: new Date(),
      resolvedBy: "bot:auto",
    });

    await addBalance(message.author.id, HIGHLIGHT_AUTO_PAYOUT, guildId);
    await logTransaction(message.author.id, HIGHLIGHT_AUTO_PAYOUT, "payout", `Auto highlight payout — ${currentWeek}`, guildId, "highlight");

    await reactOk(message);
    await dmUser(
      message,
      `✅ Your weekly highlight was accepted and **${HIGHLIGHT_AUTO_PAYOUT} coins** were paid automatically.`,
    );
    await promptHighlightNomination(message);
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
