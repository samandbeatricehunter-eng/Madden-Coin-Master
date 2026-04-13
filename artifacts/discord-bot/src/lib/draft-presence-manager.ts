/**
 * Draft Presence Manager
 *
 * Two-message layout in the draft room channel:
 *   1. Embed message  (messageId)       — status display, edited in-place
 *   2. Button panels  (panelMessageIds) — per-user toggle buttons + close,
 *      re-posted to bottom on every toggle. Multiple messages if > 20 human teams.
 *
 * Per-user buttons:   customId = "draft_toggle:DISCORD_ID"
 * Close draft button: customId = "draft_presence_close"
 *
 * CPU / unregistered teams use a synthetic discordId "cpu:TEAMNAME" so they
 * appear in the embed without receiving toggle buttons.
 *
 * Permissions:
 *   - Each user may only click their OWN button (checked in interactionCreate handler)
 *   - Admins may click any button
 *
 * Limits: Discord allows max 5 action rows × 5 buttons = 25 buttons per message.
 * We reserve one row for the Close button, so each panel message holds ≤20 user buttons.
 * When there are more than 20 human teams, additional panel messages are posted.
 */

import {
  Client, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  TextChannel, ChannelType,
} from "discord.js";
import { db } from "@workspace/db";
import {
  draftSessionsTable, draftPresenceTable, usersTable,
  franchiseMcaTeamsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateActiveSeason } from "./db-helpers.js";

export const DRAFT_TOGGLE_PREFIX   = "draft_toggle";   // full id: draft_toggle:DISCORD_ID
export const DRAFT_CLOSE_BUTTON_ID = "draft_presence_close";

const DRAFT_CATEGORY_ID  = "1476321184311414978";
const MAX_BUTTONS_PER_PANEL = 20; // rows 1-4 × 5 = 20; row 5 reserved for close
const MAX_TEAMS_PER_FIELD   = 15; // embed field value stays safely under 1024 chars

/** Synthetic discordId prefix used for CPU / unregistered teams */
const CPU_PREFIX = "cpu:";
export function isCpuEntry(discordId: string): boolean {
  return discordId.startsWith(CPU_PREFIX);
}

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

/**
 * Populate the session's presence rows.
 *
 * Human teams come from usersTable (real Discord IDs).
 * All 32 Madden teams come from franchiseMcaTeamsTable; those not already
 * covered by a registered user get a synthetic "cpu:TEAMNAME" discordId so
 * they appear in the embed without a toggle button.
 */
export async function populatePresence(sessionId: number): Promise<void> {
  // 1. Registered Discord users
  const leagueUsers = await db.select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable);

  for (const u of leagueUsers) {
    await db.insert(draftPresenceTable)
      .values({ sessionId, discordId: u.discordId, teamName: u.team ?? null, isPresent: true })
      .onConflictDoNothing();
  }

  // 2. All MCA teams (32 teams in the franchise)
  const season   = await getOrCreateActiveSeason().catch(() => null);
  if (!season) return;

  const mcaTeams = await db.select()
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id));

  const registeredDiscordIds = new Set(leagueUsers.map(u => u.discordId));

  for (const t of mcaTeams) {
    // Skip if a registered Discord user already covers this team
    if (t.discordId && registeredDiscordIds.has(t.discordId)) continue;

    const syntheticId = `${CPU_PREFIX}${t.nickName}`;
    await db.insert(draftPresenceTable)
      .values({ sessionId, discordId: syntheticId, teamName: t.fullName, isPresent: true })
      .onConflictDoNothing();
  }
}

/** Toggle a user's presence.  Returns new status, or null if they're not found. */
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

/** Chunk an array into groups of max size n */
function chunkArray<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function buildPresenceEmbed(sessionId: number, isActive: boolean): Promise<EmbedBuilder> {
  const rows = await db.select()
    .from(draftPresenceTable)
    .where(eq(draftPresenceTable.sessionId, sessionId));

  // Sort: present first, then alpha by team name
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
      `**${present.length} of ${total} teams are present**\n` +
      `Use the buttons below to toggle your status.\n\u200b`,
    );
  } else {
    embed.setDescription(`**Final: ${present.length} of ${total} teams were present**\n\u200b`);
  }

  // ── Present teams — split into fields of MAX_TEAMS_PER_FIELD ────────────────
  if (present.length === 0) {
    embed.addFields({ name: `✅ Present (0)`, value: "*None yet*" });
  } else {
    const chunks = chunkArray(present, MAX_TEAMS_PER_FIELD);
    chunks.forEach((chunk, i) => {
      const label = chunks.length > 1
        ? `✅ Present (${present.length}) — Part ${i + 1}`
        : `✅ Present (${present.length})`;
      const lines = chunk.map(r => {
        const team = r.teamName ?? "Unknown";
        if (isCpuEntry(r.discordId)) return `✅  **${team}**`;
        return `✅  **${team}** — <@${r.discordId}>`;
      });
      embed.addFields({ name: label, value: lines.join("\n") });
    });
  }

  // ── Away teams — split into fields of MAX_TEAMS_PER_FIELD ───────────────────
  if (away.length > 0) {
    const chunks = chunkArray(away, MAX_TEAMS_PER_FIELD);
    chunks.forEach((chunk, i) => {
      const label = chunks.length > 1
        ? `🔴 Away (${away.length}) — Part ${i + 1}`
        : `🔴 Away (${away.length})`;
      const lines = chunk.map(r => {
        const team = r.teamName ?? "Unknown";
        if (isCpuEntry(r.discordId)) return `🔴  **${team}**`;
        return `🔴  **${team}** — <@${r.discordId}>`;
      });
      embed.addFields({ name: label, value: lines.join("\n") });
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
 * Builds component arrays for one or more button panel messages.
 * Each message holds ≤20 human-team buttons (4 rows) + 1 Close button row.
 * CPU/synthetic entries are skipped — they have no toggle button.
 */
export function buildButtonPanels(rows: PresenceRow[]): ActionRowBuilder<ButtonBuilder>[][] {
  const humanRows = rows.filter(r => !isCpuEntry(r.discordId));
  const panels: ActionRowBuilder<ButtonBuilder>[][] = [];

  const chunks = chunkArray(humanRows, MAX_BUTTONS_PER_PANEL);
  for (const chunk of chunks) {
    const componentRows: ActionRowBuilder<ButtonBuilder>[] = [];

    // User buttons in rows of 5
    for (let i = 0; i < chunk.length; i += 5) {
      const slice = chunk.slice(i, i + 5);
      componentRows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          slice.map(r =>
            new ButtonBuilder()
              .setCustomId(`${DRAFT_TOGGLE_PREFIX}:${r.discordId}`)
              .setLabel(truncate(r.teamName ?? "Unknown", 20))
              .setEmoji(r.isPresent ? "✅" : "🔴")
              .setStyle(r.isPresent ? ButtonStyle.Success : ButtonStyle.Danger),
          ),
        ),
      );
    }

    // Close button always occupies row 5 of every panel message
    componentRows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(DRAFT_CLOSE_BUTTON_ID)
          .setLabel("Close Draft")
          .setEmoji("🔒")
          .setStyle(ButtonStyle.Secondary),
      ),
    );

    panels.push(componentRows);
  }

  // If there are no human teams at all, still show a close-only panel
  if (panels.length === 0) {
    panels.push([
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(DRAFT_CLOSE_BUTTON_ID)
          .setLabel("Close Draft")
          .setEmoji("🔒")
          .setStyle(ButtonStyle.Secondary),
      ),
    ]);
  }

  return panels;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel message ID helpers
// ─────────────────────────────────────────────────────────────────────────────

function parsePanelIds(session: typeof draftSessionsTable.$inferSelect): string[] {
  if (session.panelMessageIds) {
    try { return JSON.parse(session.panelMessageIds) as string[]; } catch { /* fall through */ }
  }
  // Backward-compat: single panelMessageId column
  if (session.panelMessageId) return [session.panelMessageId];
  return [];
}

async function savePanelIds(sessionId: number, ids: string[]): Promise<void> {
  await db.update(draftSessionsTable)
    .set({
      panelMessageIds: JSON.stringify(ids),
      panelMessageId:  ids[ids.length - 1] ?? null,  // keep legacy column for compat
    })
    .where(eq(draftSessionsTable.id, sessionId));
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
  client:   Client,
  session:  typeof draftSessionsTable.$inferSelect,
  isActive: boolean,
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
 * Edit button panel messages in-place so they never move in the feed.
 * Only falls back to delete+repost if the number of panels changes
 * (e.g. a new user was added via /draftpresence refresh).
 */
async function updateButtonPanels(
  client:   Client,
  session:  typeof draftSessionsTable.$inferSelect,
  isActive: boolean,
): Promise<void> {
  const tc = await getChannel(client, session.channelId);
  if (!tc) return;

  const oldIds = parsePanelIds(session);

  if (!isActive) {
    // Draft ended — remove all button panels entirely
    for (const id of oldIds) {
      await tc.messages.delete(id).catch(() => {});
    }
    return;
  }

  const presenceRows = await db.select()
    .from(draftPresenceTable)
    .where(eq(draftPresenceTable.sessionId, session.id));

  presenceRows.sort((a, b) => (a.teamName ?? "").localeCompare(b.teamName ?? ""));

  const panels = buildButtonPanels(presenceRows);

  // Happy path: same number of panels → edit each one in-place, no channel noise
  if (panels.length === oldIds.length && oldIds.length > 0) {
    for (let i = 0; i < panels.length; i++) {
      const msg = await tc.messages.fetch(oldIds[i]!).catch(() => null);
      if (msg) {
        await msg.edit({ components: panels[i]! }).catch(err =>
          console.error("[draft-presence] panel edit failed:", err),
        );
      }
    }
    return;
  }

  // Panel count changed (refresh added/removed users) — delete old, post fresh
  for (const id of oldIds) {
    await tc.messages.delete(id).catch(() => {});
  }

  const newIds: string[] = [];
  for (const components of panels) {
    const msg = await tc.send({ components });
    newIds.push(msg.id);
  }

  await savePanelIds(session.id, newIds);
}

/**
 * Full refresh: update embed in-place + update button panels in-place.
 * Call this after every toggle. Neither message moves in the feed.
 */
export async function refreshPresence(client: Client, sessionId: number): Promise<void> {
  const [session] = await db.select()
    .from(draftSessionsTable)
    .where(eq(draftSessionsTable.id, sessionId))
    .limit(1);
  if (!session) return;

  await updateEmbedMessage(client, session, session.isActive);
  await updateButtonPanels(client, session, session.isActive);
}

/** Post the initial embed + button panels when the draft starts. */
export async function postInitialMessages(client: Client, sessionId: number, channel: TextChannel): Promise<void> {
  const embed    = await buildPresenceEmbed(sessionId, true);
  const embedMsg = await channel.send({ embeds: [embed] });

  await db.update(draftSessionsTable)
    .set({ messageId: embedMsg.id })
    .where(eq(draftSessionsTable.id, sessionId));

  // Re-fetch session with updated messageId, then post panels
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
    // Remove all panel messages
    const oldIds = parsePanelIds(session);
    for (const id of oldIds) {
      await tc.messages.delete(id).catch(() => {});
    }

    // Update embed to final state
    await updateEmbedMessage(client, session, false);

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
