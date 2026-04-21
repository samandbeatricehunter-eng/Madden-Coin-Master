import {
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  TextChannel, Client,
} from "discord.js";
import { db } from "@workspace/db";
import { waitlistTable, usersTable } from "@workspace/db";
import { eq, and, asc, isNotNull } from "drizzle-orm";
import { getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";
import { NFL_TEAMS } from "../lib/constants.js";

// ── Button ID helpers ─────────────────────────────────────────────────────────
export const WAITLIST_ACCEPT_PREFIX = "waitlist_accept:";
export const WAITLIST_DENY_PREFIX   = "waitlist_deny:";

export function waitlistAcceptId(guildId: string) { return `${WAITLIST_ACCEPT_PREFIX}${guildId}`; }
export function waitlistDenyId(guildId: string)   { return `${WAITLIST_DENY_PREFIX}${guildId}`; }

// ── Slash command removed ─────────────────────────────────────────────────────
// The /waitlist add, remove, view, and notify subcommands have been retired.
// Waitlist management is now handled through the /actions button flow (unlinked user hub).
// This file only exports shared utility functions used by actions-handlers and admin-user-handlers.

// ── Shared: send the waitlist DM ──────────────────────────────────────────────
export async function sendWaitlistDm(opts: {
  client:    Client;
  guild:     { id: string; name: string; channels: any; roles: any; invites?: any };
  guildId:   string;
  discordId: string;
  team?:     string;  // specific team they were waiting for, if any
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, guild, guildId, discordId, team } = opts;

    // Try to fetch the user
    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) return { success: false, error: "User not found or could not be fetched." };

    // Try to get an invite link to #welcome
    let inviteLink = "";
    try {
      const welcomeId = await getGuildChannel(guildId, CHANNEL_KEYS.WELCOME).catch(() => null);
      if (welcomeId) {
        const welcomeCh = guild.channels.cache.get(welcomeId)
          ?? await client.channels.fetch(welcomeId).catch(() => null);
        if (welcomeCh && "createInvite" in welcomeCh) {
          const invite = await (welcomeCh as TextChannel).createInvite({
            maxAge:  604800, // 7 days
            maxUses: 1,
            unique:  true,
            reason:  "Waitlist notification",
          });
          inviteLink = invite.url;
        }
      }
    } catch { /* invite creation may fail — that's ok */ }

    let dmText: string;

    if (team) {
      dmText = [
        `📣 **Good news! The ${team} are available in ${guild.name}!**`,
        "",
        `You were waitlisted for the **${team}** and they've just opened up.`,
        inviteLink ? `\nUse this invite link to join: ${inviteLink}` : "",
        "",
        "Click **Accept** to let the commissioners know you want to claim this team, or **Decline** if you're no longer interested.",
      ].join("\n").trim();
    } else {
      // Legacy: count open teams
      const takenRows = await db
        .select({ team: usersTable.team, discordId: usersTable.discordId })
        .from(usersTable)
        .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, guildId)));

      const taken     = new Set(takenRows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.team as string));
      const openCount = NFL_TEAMS.filter(t => !taken.has(t)).length;
      const teamWord  = openCount === 1 ? "team has" : "teams have";

      dmText = [
        `📣 **A spot has opened up in the R.E.C. League!**`,
        "",
        `You're on the waitlist and **${openCount} ${teamWord}** just become available.`,
        inviteLink ? `\nUse this invite link to join: ${inviteLink}` : "",
        "",
        "Please click **Accept** to let the commissioners know you're ready to join, or **Decline** if you're no longer interested.",
      ].join("\n").trim();
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(waitlistAcceptId(guildId))
        .setLabel("✅ Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(waitlistDenyId(guildId))
        .setLabel("❌ Decline")
        .setStyle(ButtonStyle.Danger),
    );

    await user.send({ content: dmText, components: [row] });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err?.message ?? err) };
  }
}

// ── Auto-scan: called after /advanceweek completes ────────────────────────────
// Processes team-specific waitlist entries (team column set) and legacy entries (no team).
export async function checkAndNotifyWaitlist(
  client:  Client,
  guild:   any,
  guildId: string,
): Promise<void> {
  try {
    const waiters = await db
      .select()
      .from(waitlistTable)
      .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.status, "waiting")))
      .orderBy(asc(waitlistTable.addedAt));

    if (waiters.length === 0) return;

    // Compute open teams
    const takenRows = await db
      .select({ team: usersTable.team, discordId: usersTable.discordId })
      .from(usersTable)
      .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, guildId)));

    const taken    = new Set(takenRows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.team as string));
    const openSet  = new Set(NFL_TEAMS.filter(t => !taken.has(t)));

    if (openSet.size === 0) return;

    // 1. Team-specific waiters — notify only if their team is now open
    for (const entry of waiters.filter(w => w.team)) {
      if (!openSet.has(entry.team!)) continue;
      const result = await sendWaitlistDm({ client, guild, guildId, discordId: entry.discordId, team: entry.team! });
      if (result.success) {
        await db.delete(waitlistTable)
          .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, entry.discordId)));
      }
    }

    // 2. Legacy waiters (no team) — notify first N by open slot count
    const legacyWaiters = waiters.filter(w => !w.team);
    const toNotify      = legacyWaiters.slice(0, openSet.size);
    for (const entry of toNotify) {
      const result = await sendWaitlistDm({ client, guild, guildId, discordId: entry.discordId });
      if (result.success) {
        await db.update(waitlistTable)
          .set({ notifiedAt: new Date(), status: "notified" })
          .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, entry.discordId)));
      }
    }
  } catch (err) {
    console.error("[waitlist] checkAndNotifyWaitlist error:", err);
  }
}

// ── Team-unlink trigger: DM anyone waitlisted for this specific team ──────────
export async function notifyTeamWaitlist(opts: {
  team:    string;
  guildId: string;
  client:  Client;
  guild:   { id: string; name: string; channels: any; roles: any; invites?: any };
}): Promise<void> {
  try {
    const { team, guildId, client, guild } = opts;

    const waiters = await db
      .select()
      .from(waitlistTable)
      .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.team, team), eq(waitlistTable.status, "waiting")));

    for (const entry of waiters) {
      const result = await sendWaitlistDm({ client, guild, guildId, discordId: entry.discordId, team });
      if (result.success) {
        await db.delete(waitlistTable)
          .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, entry.discordId)));
      }
    }
  } catch (err) {
    console.error("[waitlist] notifyTeamWaitlist error:", err);
  }
}
