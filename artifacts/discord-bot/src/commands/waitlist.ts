import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, TextChannel, Client,
} from "discord.js";
import { db } from "@workspace/db";
import { waitlistTable, usersTable, seasonsTable } from "@workspace/db";
import { eq, and, asc, isNotNull } from "drizzle-orm";
import { isAdminUser, getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";
import { NFL_TEAMS } from "../lib/constants.js";

// ── Button ID helpers ─────────────────────────────────────────────────────────
export const WAITLIST_ACCEPT_PREFIX = "waitlist_accept:";
export const WAITLIST_DENY_PREFIX   = "waitlist_deny:";

export function waitlistAcceptId(guildId: string) { return `${WAITLIST_ACCEPT_PREFIX}${guildId}`; }
export function waitlistDenyId(guildId: string)   { return `${WAITLIST_DENY_PREFIX}${guildId}`; }

// ── Command definition ────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("waitlist")
  .setDescription("Manage the new-member waitlist (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Add a Discord user to the waitlist by their ID")
      .addStringOption(o =>
        o.setName("discord_id")
          .setDescription("The Discord user ID to add to the waitlist")
          .setRequired(true),
      ),
  )
  .addSubcommand(sub =>
    sub.setName("remove")
      .setDescription("Remove a Discord user from the waitlist by their ID")
      .addStringOption(o =>
        o.setName("discord_id")
          .setDescription("The Discord user ID to remove from the waitlist")
          .setRequired(true),
      ),
  )
  .addSubcommand(sub =>
    sub.setName("view")
      .setDescription("View the current waitlist in chronological order"),
  )
  .addSubcommand(sub =>
    sub.setName("notify")
      .setDescription("Manually send a waitlist DM to a specific user")
      .addStringOption(o =>
        o.setName("discord_id")
          .setDescription("The Discord user ID to notify")
          .setRequired(true),
      ),
  );

// ── Execute ───────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const adminId = interaction.user.id;

  if (!(await isAdminUser(adminId, guildId))) {
    await interaction.editReply({ content: "❌ You must be a league admin to use this command." });
    return;
  }

  const sub = interaction.options.getSubcommand(true);

  // ── /waitlist add ─────────────────────────────────────────────────────────
  if (sub === "add") {
    const targetId = interaction.options.getString("discord_id", true).trim();

    // Check if already on waitlist
    const [existing] = await db
      .select({ id: waitlistTable.id, status: waitlistTable.status })
      .from(waitlistTable)
      .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, targetId)))
      .limit(1);

    if (existing) {
      await interaction.editReply({
        content: `⚠️ <@${targetId}> is already on the waitlist (status: **${existing.status}**). Use \`/waitlist remove\` first if you need to re-add them.`,
      });
      return;
    }

    await db.insert(waitlistTable).values({
      guildId,
      discordId: targetId,
      addedBy:   adminId,
      status:    "waiting",
    });

    // Get their position
    const all = await db
      .select({ discordId: waitlistTable.discordId })
      .from(waitlistTable)
      .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.status, "waiting")))
      .orderBy(asc(waitlistTable.addedAt));

    const pos = all.findIndex(r => r.discordId === targetId) + 1;

    await interaction.editReply({
      content: `✅ <@${targetId}> has been added to the waitlist at position **#${pos}**.`,
    });
    return;
  }

  // ── /waitlist remove ──────────────────────────────────────────────────────
  if (sub === "remove") {
    const targetId = interaction.options.getString("discord_id", true).trim();

    const [existing] = await db
      .select({ id: waitlistTable.id })
      .from(waitlistTable)
      .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, targetId)))
      .limit(1);

    if (!existing) {
      await interaction.editReply({ content: `⚠️ <@${targetId}> is not on the waitlist.` });
      return;
    }

    await db
      .delete(waitlistTable)
      .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, targetId)));

    await interaction.editReply({ content: `✅ <@${targetId}> has been removed from the waitlist.` });
    return;
  }

  // ── /waitlist view ────────────────────────────────────────────────────────
  if (sub === "view") {
    const entries = await db
      .select()
      .from(waitlistTable)
      .where(eq(waitlistTable.guildId, guildId))
      .orderBy(asc(waitlistTable.addedAt));

    if (entries.length === 0) {
      await interaction.editReply({ content: "📋 The waitlist is currently empty." });
      return;
    }

    const lines = entries.map((e, i) => {
      const statusEmoji = e.status === "waiting" ? "⏳" : e.status === "notified" ? "📨" : e.status === "accepted" ? "✅" : "❌";
      const addedDate   = e.addedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return `**#${i + 1}** ${statusEmoji} <@${e.discordId}> — added ${addedDate} · status: **${e.status}**`;
    });

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`📋 Waitlist (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Users are listed in chronological order — earliest added is #1." })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── /waitlist notify ──────────────────────────────────────────────────────
  if (sub === "notify") {
    const targetId = interaction.options.getString("discord_id", true).trim();

    const [entry] = await db
      .select()
      .from(waitlistTable)
      .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, targetId)))
      .limit(1);

    if (!entry) {
      await interaction.editReply({ content: `⚠️ <@${targetId}> is not on the waitlist. Add them first with \`/waitlist add\`.` });
      return;
    }

    const result = await sendWaitlistDm({
      client:    interaction.client,
      guild:     interaction.guild!,
      guildId,
      discordId: targetId,
    });

    if (result.success) {
      await db
        .update(waitlistTable)
        .set({ notifiedAt: new Date(), status: "notified" })
        .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, targetId)));
      await interaction.editReply({ content: `✅ DM sent to <@${targetId}>.` });
    } else {
      await interaction.editReply({ content: `❌ Could not DM <@${targetId}>: ${result.error}` });
    }
    return;
  }
}

// ── Shared: send the waitlist DM ──────────────────────────────────────────────
export async function sendWaitlistDm(opts: {
  client:    Client;
  guild:     { id: string; name: string; channels: any; roles: any; invites?: any };
  guildId:   string;
  discordId: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, guild, guildId, discordId } = opts;

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

    // Count open teams so we can say "X team(s)"
    const takenRows = await db
      .select({ team: usersTable.team, discordId: usersTable.discordId })
      .from(usersTable)
      .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, guildId)));

    const taken     = new Set(takenRows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.team as string));
    const openCount = NFL_TEAMS.filter(t => !taken.has(t)).length;
    const teamWord  = openCount === 1 ? "team has" : "teams have";

    const dmText = [
      `📣 **A spot has opened up in the R.E.C. League!**`,
      "",
      `You're on the waitlist and **${openCount} ${teamWord}** just become available.`,
      inviteLink ? `\nUse this invite link to join: ${inviteLink}` : "",
      "",
      "Please click **Accept** to let the commissioners know you're ready to join, or **Decline** if you're no longer interested.",
    ].join("\n").trim();

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
export async function checkAndNotifyWaitlist(
  client:  Client,
  guild:   any,
  guildId: string,
): Promise<void> {
  try {
    // Get waiting entries in order
    const waiters = await db
      .select()
      .from(waitlistTable)
      .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.status, "waiting")))
      .orderBy(asc(waitlistTable.addedAt));

    if (waiters.length === 0) return;

    // Count open teams
    const takenRows = await db
      .select({ team: usersTable.team, discordId: usersTable.discordId })
      .from(usersTable)
      .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, guildId)));

    const taken     = new Set(takenRows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.team as string));
    const openCount = NFL_TEAMS.filter(t => !taken.has(t)).length;

    if (openCount === 0) return;

    // Notify up to openCount users (however many slots opened = how many to notify)
    const toNotify = waiters.slice(0, openCount);

    for (const entry of toNotify) {
      const result = await sendWaitlistDm({ client, guild, guildId, discordId: entry.discordId });
      if (result.success) {
        await db
          .update(waitlistTable)
          .set({ notifiedAt: new Date(), status: "notified" })
          .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, entry.discordId)));
      }
    }
  } catch (err) {
    console.error("[waitlist] checkAndNotifyWaitlist error:", err);
  }
}
