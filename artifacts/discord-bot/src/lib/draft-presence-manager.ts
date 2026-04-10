/**
 * Draft Presence Manager
 *
 * Two-message layout in the draft room channel:
 *   1. Embed message  (messageId)      — status display, edited in-place
 *   2. Buttons panel  (panelMessageId) — per-user toggle buttons + close, re-posted to bottom on every toggle
 *
 * Per-user buttons:   customId = "draft_toggle:DISCORD_ID"
 * Close draft button: customId = "draft_presence_close"
 *
 * Permissions:
 *   - Each user may only click their OWN button (checked in interactionCreate handler)
 *   - Admins may click any button
 *
 * Limits: Discord allows max 5 action rows × 5 buttons = 25 buttons per message.
 * We reserve row 5 for the Close button, so rows 1-4 hold up to 20 user buttons.
 * Leagues with >20 members: first 20 shown as buttons; remainder listed in embed only.
 */

import {
  Client, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  TextChannel, ChannelType,
} from "discord.js";
import { db } from "@workspace/db";
import { draftSessionsTable, draftPresenceTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export const DRAFT_TOGGLE_PREFIX   = "draft_toggle";   // full id: draft_toggle:DISCORD_ID
export const DRAFT_CLOSE_BUTTON_ID = "draft_presence_close";

const DRAFT_CATEGORY_ID = "1476321184311414978";
const MAX_USER_BUTTONS  = 20; // rows 1-4 × 5 = 20; row 5 reserved for close

// ─────────────────────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────────────────────

export async function getActiveSession(guildId: string) {
  const [s] = await db.select()
    .from(draftSessionsTable)
    .where(and(eq(draftSessionsTable.guildId, guildId), eq(draftSessionsTable.isActive, true)))
    .limit(1);
  return s ?? null;
}

export async function startDraftSession(
  client:  Client,
  guildId: string,
  guild:   NonNullable<ReturnType<Client["guilds"]["cache"]["get"]>>,
): Promise<{ sessionId: number; channel: TextChannel }> {
  // Close any stale sessions
  await db.update(draftSessionsTable)
    .set({ isActive: false })
    .where(and(eq(draftSessionsTable.guildId, guildId), eq(draftSessionsTable.isActive, true)));

  const channel = await guild.channels.create({
    name:   "draft-room",
    type:   ChannelType.GuildText,
    parent: DRAFT_CATEGORY_ID,
  }) as TextChannel;

  await channel.lockPermissions().catch(() => {});

  const [session] = await db.insert(draftSessionsTable)
    .values({ guildId, channelId: channel.id, isActive: true })
    .returning();

  return { sessionId: session!.id, channel };
}

export async function populatePresence(sessionId: number): Promise<void> {
  const leagueUsers = await db.select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable);

  for (const u of leagueUsers) {
    await db.insert(draftPresenceTable)
      .values({ sessionId, discordId: u.discordId, teamName: u.team ?? null, isPresent: true })
      .onConflictDoNothing();
  }
}

/** Toggle a user's presence.  Returns new status, or null if they're not a league member. */
export async function togglePresence(sessionId: number, discordId: string): Promise<boolean | null> {
  const [row] = await db.select()
    .from(draftPresenceTable)
    .where(and(eq(draftPresenceTable.sessionId, sessionId), eq(draftPresenceTable.discordId, discordId)))
    .limit(1);

  if (!row) return null;

  const newStatus = !row.isPresent;
  await db.update(draftPresenceTable)
    .set({ isPresent: newStatus, updatedAt: new Date() })
    .where(eq(draftPresenceTable.id, row.id));

  return newStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Embed builder
// ─────────────────────────────────────────────────────────────────────────────

export async function buildPresenceEmbed(sessionId: number, isActive: boolean): Promise<EmbedBuilder> {
  const rows = await db.select()
    .from(draftPresenceTable)
    .where(eq(draftPresenceTable.sessionId, sessionId));

  rows.sort((a, b) => {
    if (a.isPresent !== b.isPresent) return a.isPresent ? -1 : 1;
    return (a.teamName ?? "").localeCompare(b.teamName ?? "");
  });

  const present = rows.filter(r => r.isPresent);
  const away    = rows.filter(r => !r.isPresent);
  const total   = rows.length;

  const embed = new EmbedBuilder()
    .setColor(isActive ? Colors.Green : Colors.Grey)
    .setTitle(isActive ? "🏈  DRAFT PRESENCE TRACKER" : "🏈  DRAFT COMPLETE — Final Attendance")
    .setTimestamp();

  if (isActive) {
    embed.setDescription(
      `**${present.length} of ${total} managers are present**\n` +
      `Use the buttons below to toggle your status.\n\u200b`,
    );
  } else {
    embed.setDescription(`**Final: ${present.length} of ${total} managers were present**\n\u200b`);
  }

  embed.addFields({
    name:  `✅ Present (${present.length})`,
    value: present.map(r => `✅  **${r.teamName ?? "Unknown"}** — <@${r.discordId}>`).join("\n") || "*None yet*",
  });

  if (away.length > 0) {
    embed.addFields({
      name:  `🔴 Away (${away.length})`,
      value: away.map(r => `🔴  **${r.teamName ?? "Unknown"}** — <@${r.discordId}>`).join("\n"),
    });
  }

  if (isActive && total > MAX_USER_BUTTONS) {
    embed.addFields({
      name:  "ℹ️ Note",
      value: `Leagues with more than ${MAX_USER_BUTTONS} members: extra members use \`/draftpresence toggle\` to update their status.`,
    });
  }

  if (isActive) embed.setFooter({ text: "Last updated" });

  return embed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Button builders
// ─────────────────────────────────────────────────────────────────────────────

type PresenceRow = { discordId: string; teamName: string | null; isPresent: boolean };

/**
 * Builds up to 4 rows of per-user toggle buttons (MAX_USER_BUTTONS = 20).
 * Row 5 is always the admin Close Draft button.
 */
export function buildButtonPanel(rows: PresenceRow[]): ActionRowBuilder<ButtonBuilder>[] {
  const userRows = rows.slice(0, MAX_USER_BUTTONS);

  // Chunk into rows of 5
  const buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < userRows.length; i += 5) {
    const chunk = userRows.slice(i, i + 5);
    const row   = new ActionRowBuilder<ButtonBuilder>().addComponents(
      chunk.map(r =>
        new ButtonBuilder()
          .setCustomId(`${DRAFT_TOGGLE_PREFIX}:${r.discordId}`)
          .setLabel(truncate(r.teamName ?? "Unknown", 20))
          .setEmoji(r.isPresent ? "✅" : "🔴")
          .setStyle(r.isPresent ? ButtonStyle.Success : ButtonStyle.Danger),
      ),
    );
    buttonRows.push(row);
  }

  // Always add close button as last row
  buttonRows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(DRAFT_CLOSE_BUTTON_ID)
        .setLabel("Close Draft")
        .setEmoji("🔒")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return buttonRows;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message update helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getChannel(client: Client, channelId: string): Promise<TextChannel | null> {
  const ch = client.channels.cache.get(channelId)
    ?? await client.channels.fetch(channelId).catch(() => null);
  return ch?.isTextBased() ? (ch as TextChannel) : null;
}

/** Edit the embed message in-place (does not move it in the feed). */
async function updateEmbedMessage(
  client:    Client,
  session:   typeof draftSessionsTable.$inferSelect,
  isActive:  boolean,
): Promise<void> {
  if (!session.messageId) return;
  const tc = await getChannel(client, session.channelId);
  if (!tc) return;
  const msg = await tc.messages.fetch(session.messageId).catch(() => null);
  if (!msg) return;
  const embed = await buildPresenceEmbed(session.id, isActive);
  await msg.edit({ embeds: [embed] }).catch(err =>
    console.error("[draft-presence] embed edit failed:", err),
  );
}

/**
 * Delete old button panel → post fresh one at bottom → update DB.
 * This keeps the toggle buttons always at the bottom of the feed.
 */
async function repostButtonPanel(
  client:   Client,
  session:  typeof draftSessionsTable.$inferSelect,
  isActive: boolean,
): Promise<void> {
  const tc = await getChannel(client, session.channelId);
  if (!tc) return;

  // Delete old panel
  if (session.panelMessageId) {
    await tc.messages.delete(session.panelMessageId).catch(() => {});
  }

  if (!isActive) return; // no buttons needed after close

  const presenceRows = await db.select()
    .from(draftPresenceTable)
    .where(eq(draftPresenceTable.sessionId, session.id));

  presenceRows.sort((a, b) => (a.teamName ?? "").localeCompare(b.teamName ?? ""));

  const components = buildButtonPanel(presenceRows);
  const newMsg     = await tc.send({ components });

  await db.update(draftSessionsTable)
    .set({ panelMessageId: newMsg.id })
    .where(eq(draftSessionsTable.id, session.id));
}

/**
 * Full refresh: update embed in-place + repost button panel at bottom.
 * Call this after every toggle.
 */
export async function refreshPresence(client: Client, sessionId: number): Promise<void> {
  const [session] = await db.select()
    .from(draftSessionsTable)
    .where(eq(draftSessionsTable.id, sessionId))
    .limit(1);
  if (!session) return;

  await updateEmbedMessage(client, session, session.isActive);
  await repostButtonPanel(client, session, session.isActive);
}

/** Post the initial embed + button panel when the draft starts. */
export async function postInitialMessages(client: Client, sessionId: number, channel: TextChannel): Promise<void> {
  const embed = await buildPresenceEmbed(sessionId, true);
  const embedMsg = await channel.send({ embeds: [embed] });

  await db.update(draftSessionsTable)
    .set({ messageId: embedMsg.id })
    .where(eq(draftSessionsTable.id, sessionId));

  // Post button panel (this re-fetches the session with the updated messageId)
  const [session] = await db.select()
    .from(draftSessionsTable)
    .where(eq(draftSessionsTable.id, sessionId))
    .limit(1);
  if (session) await repostButtonPanel(client, session, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// End draft
// ─────────────────────────────────────────────────────────────────────────────

export async function endDraftSession(client: Client, sessionId: number): Promise<void> {
  await db.update(draftSessionsTable)
    .set({ isActive: false })
    .where(eq(draftSessionsTable.id, sessionId));

  const [session] = await db.select()
    .from(draftSessionsTable)
    .where(eq(draftSessionsTable.id, sessionId))
    .limit(1);
  if (!session) return;

  const tc = await getChannel(client, session.channelId);

  if (tc) {
    // Remove old button panel
    if (session.panelMessageId) {
      await tc.messages.delete(session.panelMessageId).catch(() => {});
    }

    // Update embed to final state
    await updateEmbedMessage(client, session, false);

    // Post countdown notice
    await tc.send({
      content: "✅ **The draft has concluded.** This channel will be deleted in 10 seconds.",
    }).catch(() => {});
  }

  await new Promise(resolve => setTimeout(resolve, 10_000));

  const delCh = client.channels.cache.get(session.channelId)
    ?? await client.channels.fetch(session.channelId).catch(() => null);
  if (delCh) {
    await delCh.delete("Draft concluded").catch(err =>
      console.error("[draft-presence] channel delete failed:", err),
    );
  }
}
