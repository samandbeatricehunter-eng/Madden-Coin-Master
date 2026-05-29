/**
 * admin-user-handlers.ts
 *
 * All interaction handlers for the /admin-user-data hub.
 * Prefix: ud_  (user data)
 *
 * Flows:
 *   ud_view_teams    — Show all linked teams table
 *   ud_link          — Link New User (3-step: team → member → modal)
 *   ud_unlink        — Unlink User (2-step: team → confirm)
 *   ud_view_edit     — View/Edit User Data (2-step: team → load → modal per section)
 *   ud_delete        — Delete User Data (2-step: user select → category toggles → confirm)
 *   ud_close         — Delete the hub message
 *   ud_cancel        — Return to hub embed
 */

import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, seasonsTable,
  inventoryTable, seasonStatsTable, coinTransactionsTable, purchasesTable,
  customPlayersTable, h2hMatchupRecordsTable, gameLogTable, wagersTable,
  payoutRequestsTable, pendingChannelPayoutsTable, pendingEosPayoutsTable,
  franchiseMcaTeamsTable, franchiseRostersTable, teamSeasonStatsTable,
  playerSeasonStatsTable, globalUserRecordsTable, waitlistTable,
  interviewRequestsTable, rulesTable,
} from "@workspace/db";
import { eq, and, isNotNull, inArray, or, desc, sum, sql } from "drizzle-orm";
import {
  isAdminUser, addBalance, logTransaction,
  getOrCreateActiveSeason, getOrCreateUser,
} from "../db/db-helpers.js";
import { NFL_TEAMS, NFL_DIVISION_MAP } from "../constants.js";
import { getPayoutValue, setPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";
import { notifyTeamWaitlist } from "../league/waitlist-helpers.js";

// ── User Data Hub Embed / Rows (moved from admin-user-data.ts) ─────────────────

export function buildUserDataHubEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("👤 User Data Management Hub")
    .setDescription(
      "Select an action below. All menus are ephemeral (only visible to you).\n\n" +
      "**Row 1 — User Actions**\n" +
      "🔵 View All User Teams | ⬛ Link New User | 🔴 Unlink User\n" +
      "⬛ View/Edit User Data | 🔴 Delete User Data"
    )
    .setFooter({ text: "Admin User Data Hub — selections expire after 15 minutes" })
    .setTimestamp();
}

export function buildUserDataHubRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ud_view_teams").setLabel("View All User Teams").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ud_link").setLabel("Link New User").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ud_unlink").setLabel("Unlink User").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ud_view_edit").setLabel("View/Edit User Data").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ud_delete").setLabel("Delete User Data").setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ud_close").setLabel("✖ Close Hub").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2];
}

// ── Session management ─────────────────────────────────────────────────────────

type DeleteCategory = "economy" | "records" | "wagers" | "payout_data" | "interviews" | "franchise_data" | "custom_players";

const DELETE_CATEGORIES: DeleteCategory[] = [
  "economy", "records", "wagers", "payout_data", "interviews", "franchise_data", "custom_players",
];
const CATEGORY_LABELS: Record<DeleteCategory, string> = {
  economy:        "Economy (inventory, season limits, transactions, purchases)",
  records:        "Records (season W/L, H2H records, game log)",
  wagers:         "Wagers",
  payout_data:    "Payout data (requests, channel & EOS payouts)",
  interviews:     "Interview requests",
  franchise_data: "Franchise data (MCA mapping, team stats, player stats)",
  custom_players: "Custom players",
};

interface UdSession {
  flow:              "link" | "unlink" | "view_edit" | "delete";
  linkTeam?:         string;
  linkMemberId?:     string;
  linkMemberName?:   string;
  linkCommChannelId?: string;
  linkCommMsgId?:    string;
  targetTeam?:       string;
  targetDiscordId?:  string;
  targetUsername?:   string;
  deleteDiscordId?:  string;
  deleteUsername?:   string;
  deleteFlags:       Record<string, boolean>;
  expiresAt:         number;
}

const udSessions = new Map<string, UdSession>();
const SESSION_TTL = 15 * 60 * 1000;

function sessionKey(guildId: string, userId: string): string { return `${guildId}:${userId}`; }

function getSession(guildId: string, userId: string): UdSession | undefined {
  const key = sessionKey(guildId, userId);
  const sess = udSessions.get(key);
  if (!sess) return undefined;
  if (Date.now() > sess.expiresAt) { udSessions.delete(key); return undefined; }
  return sess;
}

function setSession(guildId: string, userId: string, data: Partial<UdSession> & { flow: UdSession["flow"] }): UdSession {
  const key  = sessionKey(guildId, userId);
  const prev = udSessions.get(key);
  const sess: UdSession = {
    deleteFlags: {}, ...prev, ...data, expiresAt: Date.now() + SESSION_TTL,
  };
  udSessions.set(key, sess);
  return sess;
}

function clearSession(guildId: string, userId: string): void { udSessions.delete(sessionKey(guildId, userId)); }

// ── Admin guard ────────────────────────────────────────────────────────────────
async function checkAdmin(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);
  return isDiscordAdmin || isDbAdmin;
}

// ── Team select row builders ───────────────────────────────────────────────────
// Shows NFL teams that do NOT currently have a real linked user (open slots).
async function buildUnlinkedTeamRows(
  guildId: string,
  prefix:  string,
  selectedTeam?: string,
): Promise<ActionRowBuilder<StringSelectMenuBuilder>[]> {
  const rows = await db.select({ team: usersTable.team, discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), isNotNull(usersTable.team)));

  const linkedTeams = new Set(
    rows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.team as string),
  );

  const afcOpen = NFL_TEAMS.filter(t => NFL_DIVISION_MAP[t]?.conference === "AFC" && !linkedTeams.has(t));
  const nfcOpen = NFL_TEAMS.filter(t => NFL_DIVISION_MAP[t]?.conference === "NFC" && !linkedTeams.has(t));

  const result: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (afcOpen.length > 0) {
    result.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${prefix}_afc`)
          .setPlaceholder(selectedTeam && NFL_DIVISION_MAP[selectedTeam]?.conference === "AFC"
            ? `AFC — ${selectedTeam} selected`
            : "AFC — select an unlinked team")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(afcOpen.slice(0, 25).map(t =>
            new StringSelectMenuOptionBuilder()
              .setLabel(t)
              .setValue(t)
              .setDescription(NFL_DIVISION_MAP[t]?.division ?? "")
              .setDefault(selectedTeam === t),
          )),
      ),
    );
  }

  if (nfcOpen.length > 0) {
    result.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${prefix}_nfc`)
          .setPlaceholder(selectedTeam && NFL_DIVISION_MAP[selectedTeam]?.conference === "NFC"
            ? `NFC — ${selectedTeam} selected`
            : "NFC — select an unlinked team")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(nfcOpen.slice(0, 25).map(t =>
            new StringSelectMenuOptionBuilder()
              .setLabel(t)
              .setValue(t)
              .setDescription(NFL_DIVISION_MAP[t]?.division ?? "")
              .setDefault(selectedTeam === t),
          )),
      ),
    );
  }

  return result;
}

// Shows linked teams (real users) in this guild.
async function buildLinkedTeamRows(
  guildId: string,
  prefix:  string,
  selectedTeam?: string,
): Promise<ActionRowBuilder<StringSelectMenuBuilder>[]> {
  const linked = await db.select({
    team: usersTable.team, discordId: usersTable.discordId, discordUsername: usersTable.discordUsername,
  }).from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), isNotNull(usersTable.team)));

  const real = linked.filter(r => !r.discordId.startsWith("unlinked_") && r.team);

  const afcLinked = real.filter(r => NFL_DIVISION_MAP[r.team!]?.conference === "AFC");
  const nfcLinked = real.filter(r => NFL_DIVISION_MAP[r.team!]?.conference === "NFC");

  const result: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (afcLinked.length > 0) {
    result.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${prefix}_afc`)
          .setPlaceholder(selectedTeam && NFL_DIVISION_MAP[selectedTeam]?.conference === "AFC"
            ? `AFC — ${selectedTeam} selected`
            : "AFC — select a linked team")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(afcLinked.slice(0, 25).map(r =>
            new StringSelectMenuOptionBuilder()
              .setLabel(r.team!)
              .setValue(r.team!)
              .setDescription(`@${r.discordUsername}`)
              .setDefault(selectedTeam === r.team),
          )),
      ),
    );
  }

  if (nfcLinked.length > 0) {
    result.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${prefix}_nfc`)
          .setPlaceholder(selectedTeam && NFL_DIVISION_MAP[selectedTeam]?.conference === "NFC"
            ? `NFC — ${selectedTeam} selected`
            : "NFC — select a linked team")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(nfcLinked.slice(0, 25).map(r =>
            new StringSelectMenuOptionBuilder()
              .setLabel(r.team!)
              .setValue(r.team!)
              .setDescription(`@${r.discordUsername}`)
              .setDefault(selectedTeam === r.team),
          )),
      ),
    );
  }

  return result;
}

// Cancel / back button row
function cancelRow(label = "✖ Cancel"): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ud_cancel").setLabel(label).setStyle(ButtonStyle.Secondary),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CLOSE / CANCEL
// ══════════════════════════════════════════════════════════════════════════════

export async function handleUdClose(interaction: ButtonInteraction): Promise<void> {
  clearSession(interaction.guildId!, interaction.user.id);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("✖ Hub Closed").setDescription("The Admin User Data Hub has been closed.")],
    components: [],
  });
}

export async function handleUdCancel(interaction: ButtonInteraction): Promise<void> {
  clearSession(interaction.guildId!, interaction.user.id);
  await interaction.update({
    content:    "",
    embeds:     [buildUserDataHubEmbed()],
    components: buildUserDataHubRows(),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// VIEW ALL USER TEAMS
// ══════════════════════════════════════════════════════════════════════════════

export async function handleUdViewTeams(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  await interaction.deferUpdate();

  const linked = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
    balance:         usersTable.balance,
    serverNickname:  usersTable.serverNickname,
  }).from(usersTable)
    .where(and(eq(usersTable.guildId, interaction.guildId!), isNotNull(usersTable.team)))
    .orderBy(usersTable.team);

  const real = linked.filter(r => !r.discordId.startsWith("unlinked_"));

  const afc = real.filter(r => NFL_DIVISION_MAP[r.team!]?.conference === "AFC");
  const nfc = real.filter(r => NFL_DIVISION_MAP[r.team!]?.conference === "NFC");

  const fmtRow = (r: typeof real[number]) =>
    `**${r.team}** — <@${r.discordId}> (${r.serverNickname ?? r.discordUsername}) · **${r.balance.toLocaleString()}🪙**`;

  const afcValue = afc.length > 0 ? afc.map(fmtRow).join("\n") : "*No AFC users linked*";
  const nfcValue = nfc.length > 0 ? nfc.map(fmtRow).join("\n") : "*No NFC users linked*";

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`👥 All Linked Users (${real.length})`)
    .addFields(
      { name: "🏈 AFC",             value: afcValue.slice(0, 1024) },
      { name: "🏈 NFC",             value: nfcValue.slice(0, 1024) },
      { name: "Open Team Slots",    value: `${32 - real.length} team slots currently unlinked`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({
    content:    "",
    embeds:     [embed],
    components: [cancelRow("← Back to Hub")],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// LINK NEW USER
// ══════════════════════════════════════════════════════════════════════════════

export async function handleUdLink(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  setSession(interaction.guildId!, interaction.user.id, { flow: "link" });

  const teamRows = await buildUnlinkedTeamRows(interaction.guildId!, "ud_link_team");

  if (teamRows.length === 0) {
    await interaction.editReply({
      content:    "✅ All 32 teams are currently linked — no open slots available.",
      embeds:     [],
      components: [cancelRow("← Back to Hub")],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🔗 Link New User — Step 1")
    .setDescription("Select the **NFL team** to link, then select the guild member below. Click **Link User** when ready.");

  await interaction.editReply({ content: "", embeds: [embed], components: [...teamRows, cancelRow()] });
}

// Shared handler for team selection in link flow
async function handleUdLinkTeamSelect(interaction: StringSelectMenuInteraction, team: string): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const sess    = setSession(guildId, interaction.user.id, { flow: "link", linkTeam: team });

  const teamRows = await buildUnlinkedTeamRows(guildId, "ud_link_team", team);

  // Build member select from guild members who are NOT currently linked to a team
  const linkedRows = await db.select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), isNotNull(usersTable.team)));
  const linkedIds = new Set(linkedRows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.discordId));

  await interaction.guild!.members.fetch().catch(() => null);
  const members = [...interaction.guild!.members.cache.values()]
    .filter(m => !m.user.bot && !linkedIds.has(m.user.id))
    .slice(0, 25);

  const memberSelectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ud_link_member")
      .setPlaceholder(sess.linkMemberId ? `Member: @${sess.linkMemberName}` : "Select the guild member to link")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        members.length > 0
          ? members.map(m =>
              new StringSelectMenuOptionBuilder()
                .setLabel(m.nickname ?? m.user.username)
                .setValue(m.user.id)
                .setDescription(`@${m.user.username}`)
                .setDefault(m.user.id === sess.linkMemberId),
            )
          : [new StringSelectMenuOptionBuilder().setLabel("No unlinked members found").setValue("__none__")],
      ),
  );

  const hasBoth = !!sess.linkTeam && !!sess.linkMemberId;
  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ud_link_next")
      .setLabel(hasBoth ? `Link @${sess.linkMemberName} → ${team}` : "Link User (select member first)")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasBoth),
    new ButtonBuilder().setCustomId("ud_cancel").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🔗 Link New User — Step 1")
    .setDescription(`**Team selected:** ${team}\n\nNow select the guild member to link to this team.`);

  await interaction.editReply({ content: "", embeds: [embed], components: [...teamRows, memberSelectRow, actionRow] });
}

export async function handleUdLinkTeamAfc(interaction: StringSelectMenuInteraction): Promise<void> {
  await handleUdLinkTeamSelect(interaction, interaction.values[0]!);
}
export async function handleUdLinkTeamNfc(interaction: StringSelectMenuInteraction): Promise<void> {
  await handleUdLinkTeamSelect(interaction, interaction.values[0]!);
}

export async function handleUdLinkMember(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  const memberId = interaction.values[0]!;
  if (memberId === "__none__") {
    await interaction.editReply({ content: "❌ No unlinked members available.", components: [cancelRow()] });
    return;
  }

  const guildId    = interaction.guildId!;
  const memberObj  = interaction.guild?.members.cache.get(memberId);
  const memberName = memberObj?.nickname ?? memberObj?.user.username ?? memberId;

  const sess = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "link") {
    await interaction.editReply({ content: "❌ Session expired. Use /admin-user-data to restart.", components: [cancelRow()] });
    return;
  }

  setSession(guildId, interaction.user.id, { flow: "link", linkMemberId: memberId, linkMemberName: memberName });

  const teamRows = await buildUnlinkedTeamRows(guildId, "ud_link_team", sess.linkTeam);

  const linkedRows = await db.select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), isNotNull(usersTable.team)));
  const linkedIds = new Set(linkedRows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.discordId));

  await interaction.guild!.members.fetch().catch(() => null);
  const members = [...interaction.guild!.members.cache.values()]
    .filter(m => !m.user.bot && !linkedIds.has(m.user.id))
    .slice(0, 25);

  const memberSelectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ud_link_member")
      .setPlaceholder(`Member: @${memberName}`)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        members.length > 0
          ? members.map(m =>
              new StringSelectMenuOptionBuilder()
                .setLabel(m.nickname ?? m.user.username)
                .setValue(m.user.id)
                .setDescription(`@${m.user.username}`)
                .setDefault(m.user.id === memberId),
            )
          : [new StringSelectMenuOptionBuilder().setLabel("No unlinked members found").setValue("__none__")],
      ),
  );

  const hasBoth = !!sess.linkTeam;
  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ud_link_next")
      .setLabel(hasBoth ? `Link @${memberName} → ${sess.linkTeam}` : "Select a team first")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasBoth),
    new ButtonBuilder().setCustomId("ud_cancel").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🔗 Link New User — Step 1")
    .setDescription(
      `**Team:** ${sess.linkTeam ?? "*(not selected)*"}\n` +
      `**Member:** @${memberName}\n\n` +
      (hasBoth ? "Click **Link User** to proceed." : "Select a team from the dropdowns above."),
    );

  await interaction.editReply({ content: "", embeds: [embed], components: [...teamRows, memberSelectRow, actionRow] });
}

export async function handleUdLinkNext(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const sess = getSession(interaction.guildId!, interaction.user.id);
  if (!sess || sess.flow !== "link" || !sess.linkTeam || !sess.linkMemberId) {
    await interaction.reply({ content: "❌ Please select both a team and a member first.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("ud_modal_link")
    .setTitle(`Link @${sess.linkMemberName} → ${sess.linkTeam}`);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("new_user")
        .setLabel("Award new member bonus? (yes / no)")
        .setStyle(TextInputStyle.Short)
        .setValue("yes")
        .setRequired(true)
        .setMaxLength(3),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("referrer_id")
        .setLabel("Referrer Discord ID (leave blank if none)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("e.g. 123456789012345678"),
    ),
  );

  await interaction.showModal(modal);
}

export async function handleUdLinkModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "link" || !sess.linkTeam || !sess.linkMemberId) {
    await interaction.editReply({ content: "❌ Session expired. Use /admin-user-data to restart." }); return;
  }

  const teamName   = sess.linkTeam;
  const discordId  = sess.linkMemberId;
  const memberName = sess.linkMemberName ?? discordId;

  const newUserRaw  = interaction.fields.getTextInputValue("new_user").trim().toLowerCase();
  const referrerId  = interaction.fields.getTextInputValue("referrer_id").trim().replace(/[<@!>]/g, "");
  const isNewUser   = newUserRaw === "yes" || newUserRaw === "y";

  // Fetch the Discord user object
  const targetUser = await interaction.client.users.fetch(discordId).catch(() => null);
  if (!targetUser) {
    await interaction.editReply({ content: `❌ Could not fetch Discord user <@${discordId}>.` }); return;
  }

  // Check if team is already taken by a real user
  const [existingOwner] = await db.select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername })
    .from(usersTable)
    .where(and(eq(usersTable.team, teamName), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (existingOwner && existingOwner.discordId !== discordId && !existingOwner.discordId.startsWith("unlinked_")) {
    await interaction.editReply({
      content: `❌ **${teamName}** is already linked to <@${existingOwner.discordId}> (${existingOwner.discordUsername}). Unlink them first.`,
    }); return;
  }

  // Remove placeholder FIRST — must happen before insert to avoid unique (team, guildId) conflict
  await db.delete(usersTable)
    .where(and(eq(usersTable.discordId, `unlinked_${teamName.toLowerCase()}`), eq(usersTable.guildId, guildId)))
    .catch(() => null);

  // Upsert the user row
  const [existing] = await db.select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!existing) {
    await db.insert(usersTable).values({
      discordId,
      guildId,
      discordUsername: targetUser.username,
      team:            teamName,
      balance:         0,
      totalLegendPurchases: 0,
    });
    await db.insert(globalUserRecordsTable)
      .values({ discordId, wins: 0, losses: 0, ties: 0 })
      .onConflictDoNothing();
  } else {
    await db.update(usersTable)
      .set({ team: teamName, discordUsername: targetUser.username, updatedAt: new Date() })
      .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)));
  }

  // Remove from waitlist
  await db.delete(waitlistTable)
    .where(and(eq(waitlistTable.guildId, guildId), eq(waitlistTable.discordId, discordId)))
    .catch(() => null);

  // ── Discord role + nickname ────────────────────────────────────────────────
  const discordStatusLines: string[] = [];

  const guildMember = await interaction.guild?.members.fetch(discordId).catch(() => null);
  if (guildMember) {
    // Add member access role
    await interaction.guild!.roles.fetch().catch(() => null);
    const approvedRole = interaction.guild!.roles.cache.find(r => /^(locker room approved|approved member)$/i.test(r.name));
    if (approvedRole) {
      const added = await guildMember.roles.add(approvedRole).then(() => true).catch(err => {
        console.error(`[ud_link] Failed to add Locker Room Approved role to ${discordId}:`, err);
        return false;
      });
      if (added) discordStatusLines.push(`✅ Assigned **Locker Room Approved** role`);
      else       discordStatusLines.push(`⚠️ Could not assign **Locker Room Approved** role (check bot permissions)`);
    } else {
      discordStatusLines.push(`⚠️ **Locker Room Approved** role not found in this server`);
    }

    // Resolve short team nickname (e.g. "Cowboys") from MCA table, fallback to last word of fullName
    const [mcaTeam] = await db
      .select({ nickName: franchiseMcaTeamsTable.nickName })
      .from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.fullName, teamName))
      .orderBy(desc(franchiseMcaTeamsTable.id))
      .limit(1)
      .catch(() => [] as { nickName: string }[]);

    const teamNick = mcaTeam?.nickName ?? teamName.split(" ").pop() ?? teamName;
    const nickSet = await guildMember.setNickname(teamNick, `Linked to ${teamName} by ${interaction.user.username}`).then(() => true).catch(err => {
      console.error(`[ud_link] Failed to set nickname for ${discordId}:`, err);
      return false;
    });
    if (nickSet) discordStatusLines.push(`✅ Nickname set to **${teamNick}**`);
    else         discordStatusLines.push(`⚠️ Could not set nickname (check bot permissions / member rank)`);
  } else {
    discordStatusLines.push(`⚠️ Could not fetch guild member — role and nickname not applied`);
  }

  const bonusLines: string[] = [];

  // New member bonus
  if (isNewUser && !existing) {
    const newMemberBonus = await getPayoutValue(PAYOUT_KEYS.NEW_MEMBER_BONUS, guildId);
    if (newMemberBonus > 0) {
      await addBalance(discordId, newMemberBonus, guildId);
      await logTransaction(discordId, newMemberBonus, "addcoins", `New member welcome bonus`, guildId, interaction.user.id);
      bonusLines.push(`🎉 New member bonus: **+${newMemberBonus} coins** awarded to @${memberName}`);
      targetUser.send(`🎉 Welcome to the league! You've received **${newMemberBonus.toLocaleString()} coins** as a new member bonus. Good luck!`).catch(() => null);
    }
  }

  // Referral bonuses
  if (referrerId) {
    const newReferralBonus    = await getPayoutValue(PAYOUT_KEYS.REFERRAL_BONUS_NEW,    guildId);
    const memberReferralBonus = await getPayoutValue(PAYOUT_KEYS.REFERRAL_BONUS_MEMBER, guildId);

    if (newReferralBonus > 0) {
      await addBalance(discordId, newReferralBonus, guildId);
      await logTransaction(discordId, newReferralBonus, "addcoins", `Referral bonus (referred by <@${referrerId}>)`, guildId, interaction.user.id);
      bonusLines.push(`🤝 Referral bonus (new user): **+${newReferralBonus} coins** awarded to @${memberName}`);
    }
    if (memberReferralBonus > 0) {
      // Verify referrer exists in this guild
      const [referrerRow] = await db.select({ discordUsername: usersTable.discordUsername })
        .from(usersTable)
        .where(and(eq(usersTable.discordId, referrerId), eq(usersTable.guildId, guildId)))
        .limit(1);
      if (referrerRow) {
        await addBalance(referrerId, memberReferralBonus, guildId);
        await logTransaction(referrerId, memberReferralBonus, "addcoins", `Referral bonus (referred @${memberName})`, guildId, interaction.user.id);
        bonusLines.push(`🤝 Referral bonus (referrer): **+${memberReferralBonus} coins** awarded to <@${referrerId}> (${referrerRow.discordUsername})`);
        const referrerUser = await interaction.client.users.fetch(referrerId).catch(() => null);
        referrerUser?.send(`🤝 You referred **@${memberName}** to the league and earned **${memberReferralBonus.toLocaleString()} coins**!`).catch(() => null);
      } else {
        bonusLines.push(`⚠️ Referrer <@${referrerId}> not found in this guild — member referral bonus skipped.`);
      }
    }
  }

  const commChannelId = sess.linkCommChannelId;
  const commMsgId     = sess.linkCommMsgId;
  clearSession(guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ User Linked Successfully")
    .addFields(
      { name: "Member",  value: `<@${discordId}> (@${memberName})`, inline: true },
      { name: "Team",    value: teamName, inline: true },
    );

  if (discordStatusLines.length > 0) {
    embed.addFields({ name: "Discord Updates", value: discordStatusLines.join("\n") });
  }
  if (bonusLines.length > 0) {
    embed.addFields({ name: "Bonuses Awarded", value: bonusLines.join("\n") });
  }

  embed.setTimestamp().setFooter({ text: `Linked by ${interaction.user.username}` });

  await interaction.editReply({ embeds: [embed] });

  // ── Update commissioner request message if this link came from a team request ─
  if (commChannelId && commMsgId) {
    (async () => {
      try {
        const commChannel = await interaction.client.channels.fetch(commChannelId).catch(() => null);
        if (commChannel?.isTextBased()) {
          const commMsg = await (commChannel as TextChannel).messages.fetch(commMsgId).catch(() => null);
          if (commMsg) {
            await commMsg.edit({
              embeds: [new EmbedBuilder()
                .setColor(Colors.Green)
                .setTitle("✅ Team Request — Approved & Linked")
                .setDescription(`<@${discordId}> has been linked to the **${teamName}**.`)
                .setFooter({ text: `Actioned by ${interaction.user.username}` })
                .setTimestamp()],
              components: [],
            });
          }
        }
      } catch { /* ignore */ }
    })();
  }

  // ── DM the newly linked user with League Info rule #1 (league name & password) ──
  (async () => {
    try {
      const [leagueInfoRow] = await db.select({ rules: rulesTable.rules })
        .from(rulesTable)
        .where(and(eq(rulesTable.guildId, guildId), eq(rulesTable.section, "league_info")));

      const rule1 = leagueInfoRow?.rules?.[0];
      if (!rule1) return;

      const dmEmbed = new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`🏈 Welcome to the R.E.C. League — You've Been Linked to ${teamName}!`)
        .setDescription(
          `You've been added to the league as the **${teamName}**.\n\n` +
          "Here's everything you need to join the in-game league:\n\u200B",
        )
        .addFields(
          { name: "📋 League Info", value: rule1, inline: false },
          { name: "\u200B", value: "Use the **/menu** command in the server to access your hub — roster, coins, wagers, standings, and more.", inline: false },
        )
        .setTimestamp();

      await targetUser.send({ embeds: [dmEmbed] }).catch(err => {
        console.error(`[ud_link] Could not DM league info to ${discordId}:`, err);
      });
    } catch (err) {
      console.error("[ud_link] Error sending league info DM:", err);
    }
  })();
}

// ══════════════════════════════════════════════════════════════════════════════
// UNLINK USER
// ══════════════════════════════════════════════════════════════════════════════

export async function handleUdUnlink(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  setSession(interaction.guildId!, interaction.user.id, { flow: "unlink" });

  const teamRows = await buildLinkedTeamRows(interaction.guildId!, "ud_unlink_team");

  if (teamRows.length === 0) {
    await interaction.editReply({
      content:    "⚠️ No linked users found in this server.",
      embeds:     [],
      components: [cancelRow("← Back to Hub")],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("🔓 Unlink User — Step 1")
    .setDescription("Select the **linked team** to unlink. The user's coins and inventory will be preserved.\nSeason W/L records and playoff seed will be cleared.");

  await interaction.editReply({ content: "", embeds: [embed], components: [...teamRows, cancelRow()] });
}

async function handleUdUnlinkTeamSelect(interaction: StringSelectMenuInteraction, team: string): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;

  const [userRow] = await db.select({
    discordId: usersTable.discordId, discordUsername: usersTable.discordUsername,
    balance: usersTable.balance,
  }).from(usersTable)
    .where(and(eq(usersTable.team, team), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!userRow || userRow.discordId.startsWith("unlinked_")) {
    await interaction.editReply({ content: `❌ No real user linked to **${team}**.`, components: [cancelRow()] }); return;
  }

  setSession(guildId, interaction.user.id, {
    flow: "unlink", targetTeam: team, targetDiscordId: userRow.discordId, targetUsername: userRow.discordUsername,
  });

  const teamRows = await buildLinkedTeamRows(guildId, "ud_unlink_team", team);

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ud_unlink_confirm")
      .setLabel(`Unlink ${team} from @${userRow.discordUsername}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ud_cancel").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("⚠️ Confirm Unlink")
    .setDescription(
      `**Team:** ${team}\n**Owner:** <@${userRow.discordId}> (@${userRow.discordUsername})\n**Balance:** ${userRow.balance.toLocaleString()} coins (preserved)\n\n` +
      `This will:\n• Clear their team assignment\n• Clear their playoff seed & conference\n• Delete their season W/L records\n• Preserve all coins, inventory, and purchase history\n\n` +
      `**This cannot be undone.** Click Confirm Unlink to proceed.`,
    );

  await interaction.editReply({ content: "", embeds: [embed], components: [...teamRows, actionRow] });
}

export async function handleUdUnlinkTeamAfc(interaction: StringSelectMenuInteraction): Promise<void> {
  await handleUdUnlinkTeamSelect(interaction, interaction.values[0]!);
}
export async function handleUdUnlinkTeamNfc(interaction: StringSelectMenuInteraction): Promise<void> {
  await handleUdUnlinkTeamSelect(interaction, interaction.values[0]!);
}

export async function handleUdUnlinkConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "unlink" || !sess.targetTeam || !sess.targetDiscordId) {
    await interaction.reply({ content: "❌ Session expired. Use /admin-user-data to restart.", ephemeral: true }); return;
  }

  await interaction.deferUpdate();

  const { targetTeam: team, targetDiscordId: discordId, targetUsername: username } = sess;

  await db.update(usersTable)
    .set({ team: null, playoffSeed: null, playoffConference: null, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)));

  // DM anyone waitlisted for this specific team (fire-and-forget)
  notifyTeamWaitlist({
    team,
    guildId,
    client: interaction.client,
    guild:  interaction.guild! as any,
  }).catch(err => console.error("[admin-user] notifyTeamWaitlist error:", err));

  const guildSeasonIds = db.select({ id: seasonsTable.id }).from(seasonsTable).where(eq(seasonsTable.guildId, guildId));
  const deleted = await db.delete(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), inArray(userRecordsTable.seasonId, guildSeasonIds)))
    .returning({ id: userRecordsTable.id });

  clearSession(guildId, interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🔓 User Unlinked")
    .setDescription(
      `**${username}** (<@${discordId}>) has been unlinked from **${team}**.\n\n` +
      `• Team assignment: **cleared**\n` +
      `• Playoff seed/conference: **cleared**\n` +
      `• Season W/L records: **${deleted.length} record${deleted.length === 1 ? "" : "s"} deleted**\n\n` +
      `Coins and inventory were preserved.`,
    )
    .setFooter({ text: `Unlinked by ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({
    content:    "",
    embeds:     [embed],
    components: [cancelRow("← Back to Hub")],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// VIEW / EDIT USER DATA
// ══════════════════════════════════════════════════════════════════════════════

export async function handleUdViewEdit(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  setSession(interaction.guildId!, interaction.user.id, { flow: "view_edit" });

  const teamRows = await buildLinkedTeamRows(interaction.guildId!, "ud_ve_team");

  if (teamRows.length === 0) {
    await interaction.editReply({
      content:    "⚠️ No linked users found.",
      embeds:     [],
      components: [cancelRow("← Back to Hub")],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("📋 View/Edit User Data — Select Team")
    .setDescription("Select a linked team to view and edit their data.");

  await interaction.editReply({ content: "", embeds: [embed], components: [...teamRows, cancelRow()] });
}

async function handleUdViewEditTeamSelect(interaction: StringSelectMenuInteraction, team: string): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;

  const [userRow] = await db.select({
    discordId: usersTable.discordId, discordUsername: usersTable.discordUsername,
  }).from(usersTable)
    .where(and(eq(usersTable.team, team), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!userRow || userRow.discordId.startsWith("unlinked_")) {
    await interaction.editReply({ content: `❌ No real user linked to **${team}**.`, components: [cancelRow()] }); return;
  }

  setSession(guildId, interaction.user.id, {
    flow: "view_edit", targetTeam: team, targetDiscordId: userRow.discordId, targetUsername: userRow.discordUsername,
  });

  const teamRows = await buildLinkedTeamRows(guildId, "ud_ve_team", team);

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ud_ve_load")
      .setLabel(`Load Data for ${team}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ud_cancel").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("📋 View/Edit User Data")
    .setDescription(`**Team:** ${team}\n**Owner:** <@${userRow.discordId}> (@${userRow.discordUsername})\n\nClick **Load Data** to view and edit this user's stats.`);

  await interaction.editReply({ content: "", embeds: [embed], components: [...teamRows, actionRow] });
}

export async function handleUdVeTeamAfc(interaction: StringSelectMenuInteraction): Promise<void> {
  await handleUdViewEditTeamSelect(interaction, interaction.values[0]!);
}
export async function handleUdVeTeamNfc(interaction: StringSelectMenuInteraction): Promise<void> {
  await handleUdViewEditTeamSelect(interaction, interaction.values[0]!);
}

export async function handleUdVeLoad(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "view_edit" || !sess.targetDiscordId) {
    await interaction.reply({ content: "❌ Session expired. Use /admin-user-data to restart.", ephemeral: true }); return;
  }

  await interaction.deferUpdate();

  const discordId = sess.targetDiscordId;
  const season    = await getOrCreateActiveSeason(guildId);

  const [userRow, recordRow] = await Promise.all([
    db.select().from(usersTable)
      .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
      .limit(1),
    db.select().from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
      .limit(1),
  ]);

  const user   = userRow[0];
  const record = recordRow[0];

  if (!user) {
    await interaction.editReply({ content: `❌ User <@${discordId}> not found.`, components: [cancelRow()] }); return;
  }

  const allTimeRows = await db.select({
    totalWins:          sql<string>`COALESCE(SUM(${userRecordsTable.wins}), 0)`,
    totalLosses:        sql<string>`COALESCE(SUM(${userRecordsTable.losses}), 0)`,
    totalPlayoffWins:   sql<string>`COALESCE(SUM(${userRecordsTable.playoffWins}), 0)`,
    totalPlayoffLosses: sql<string>`COALESCE(SUM(${userRecordsTable.playoffLosses}), 0)`,
  }).from(userRecordsTable)
    .innerJoin(seasonsTable, eq(userRecordsTable.seasonId, seasonsTable.id))
    .where(and(eq(userRecordsTable.discordId, discordId), eq(seasonsTable.guildId, guildId)));

  const atW  = parseInt(allTimeRows[0]?.totalWins          ?? "0", 10);
  const atL  = parseInt(allTimeRows[0]?.totalLosses        ?? "0", 10);
  const atPW = parseInt(allTimeRows[0]?.totalPlayoffWins   ?? "0", 10);
  const atPL = parseInt(allTimeRows[0]?.totalPlayoffLosses ?? "0", 10);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📋 User Data — ${user.team ?? user.discordUsername}`)
    .addFields(
      { name: "Discord",           value: `<@${discordId}>`,                                   inline: true  },
      { name: "Team",              value: user.team ?? "*Not set*",                             inline: true  },
      { name: "Balance",           value: `${user.balance.toLocaleString()} coins`,             inline: true  },
      { name: "Legends (all-time)", value: `${user.totalLegendPurchases}`,                     inline: true  },
      { name: "Milestone Tier",    value: `${user.milestoneTierAwarded ?? 0}`,                 inline: true  },
      { name: "\u200b",            value: "\u200b",                                             inline: true  },
      { name: "Season W-L",        value: `${record?.wins ?? 0}W – ${record?.losses ?? 0}L`, inline: true  },
      { name: "Season PO W-L",     value: `${record?.playoffWins ?? 0}W – ${record?.playoffLosses ?? 0}L`, inline: true },
      { name: "Season SB W-L",     value: `${record?.superbowlWins ?? 0}W – ${record?.superbowlLosses ?? 0}L`, inline: true },
      { name: "All-Time H2H W-L",  value: `${atW}W – ${atL}L`,                               inline: true  },
      { name: "All-Time PO W-L",   value: `${atPW}W – ${atPL}L`,                             inline: true  },
      { name: "All-Time SB W-L",   value: `${user.allTimeSuperbowlWins}W – ${user.allTimeSuperbowlLosses}L`, inline: true },
      { name: "Playoff Seed",      value: user.playoffSeed ? `${user.playoffConference} #${user.playoffSeed}` : "*Not seeded*", inline: true },
    )
    .setTimestamp();

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ud_edit_economy").setLabel("Edit Economy").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ud_edit_records").setLabel("Edit Season Records").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ud_edit_alltime").setLabel("Edit All-Time Stats").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ud_cancel").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ content: "", embeds: [embed], components: [actionRow] });
}

export async function handleUdEditEconomy(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const sess = getSession(interaction.guildId!, interaction.user.id);
  if (!sess || sess.flow !== "view_edit" || !sess.targetDiscordId) {
    await interaction.reply({ content: "❌ Session expired.", ephemeral: true }); return;
  }

  const [userRow] = await db.select({ balance: usersTable.balance, totalLegendPurchases: usersTable.totalLegendPurchases })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, sess.targetDiscordId), eq(usersTable.guildId, interaction.guildId!)))
    .limit(1);

  const modal = new ModalBuilder()
    .setCustomId("ud_modal_edit_economy")
    .setTitle(`Edit Economy — ${sess.targetTeam}`);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("coins")
        .setLabel(`Coin Balance (current: ${userRow?.balance ?? 0})`)
        .setStyle(TextInputStyle.Short)
        .setValue(String(userRow?.balance ?? 0))
        .setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("legend_total")
        .setLabel(`All-Time Legend Purchases (current: ${userRow?.totalLegendPurchases ?? 0})`)
        .setStyle(TextInputStyle.Short)
        .setValue(String(userRow?.totalLegendPurchases ?? 0))
        .setRequired(false),
    ),
  );

  await interaction.showModal(modal);
}

export async function handleUdEditRecords(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "view_edit" || !sess.targetDiscordId) {
    await interaction.reply({ content: "❌ Session expired.", ephemeral: true }); return;
  }

  const season = await getOrCreateActiveSeason(guildId);
  const [recordRow] = await db.select().from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, sess.targetDiscordId), eq(userRecordsTable.seasonId, season.id)))
    .limit(1);

  const modal = new ModalBuilder()
    .setCustomId("ud_modal_edit_records")
    .setTitle(`Edit Season Records — ${sess.targetTeam}`);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("wins").setLabel(`Season Wins (current: ${recordRow?.wins ?? 0})`).setStyle(TextInputStyle.Short).setValue(String(recordRow?.wins ?? 0)).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("losses").setLabel(`Season Losses (current: ${recordRow?.losses ?? 0})`).setStyle(TextInputStyle.Short).setValue(String(recordRow?.losses ?? 0)).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("point_diff").setLabel(`Point Differential (current: ${recordRow?.pointDifferential ?? 0})`).setStyle(TextInputStyle.Short).setValue(String(recordRow?.pointDifferential ?? 0)).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("playoff_wins").setLabel(`Playoff Wins (current: ${recordRow?.playoffWins ?? 0})`).setStyle(TextInputStyle.Short).setValue(String(recordRow?.playoffWins ?? 0)).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("playoff_losses").setLabel(`Playoff Losses (current: ${recordRow?.playoffLosses ?? 0})`).setStyle(TextInputStyle.Short).setValue(String(recordRow?.playoffLosses ?? 0)).setRequired(false),
    ),
  );

  await interaction.showModal(modal);
}

export async function handleUdEditAllTime(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const sess = getSession(interaction.guildId!, interaction.user.id);
  if (!sess || sess.flow !== "view_edit" || !sess.targetDiscordId) {
    await interaction.reply({ content: "❌ Session expired.", ephemeral: true }); return;
  }

  const [userRow] = await db.select({
    allTimeSuperbowlWins: usersTable.allTimeSuperbowlWins,
    allTimeSuperbowlLosses: usersTable.allTimeSuperbowlLosses,
    milestoneTierAwarded: usersTable.milestoneTierAwarded,
  }).from(usersTable)
    .where(and(eq(usersTable.discordId, sess.targetDiscordId), eq(usersTable.guildId, interaction.guildId!)))
    .limit(1);

  const modal = new ModalBuilder()
    .setCustomId("ud_modal_edit_alltime")
    .setTitle(`Edit All-Time Stats — ${sess.targetTeam}`);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("sb_wins").setLabel(`All-Time Super Bowl Wins (current: ${userRow?.allTimeSuperbowlWins ?? 0})`).setStyle(TextInputStyle.Short).setValue(String(userRow?.allTimeSuperbowlWins ?? 0)).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("sb_losses").setLabel(`All-Time Super Bowl Losses (current: ${userRow?.allTimeSuperbowlLosses ?? 0})`).setStyle(TextInputStyle.Short).setValue(String(userRow?.allTimeSuperbowlLosses ?? 0)).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("milestone_tier").setLabel(`Milestone Tier Awarded (current: ${userRow?.milestoneTierAwarded ?? 0})`).setStyle(TextInputStyle.Short).setValue(String(userRow?.milestoneTierAwarded ?? 0)).setRequired(false).setPlaceholder("0–25"),
    ),
  );

  await interaction.showModal(modal);
}

export async function handleUdEditEconomyModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "view_edit" || !sess.targetDiscordId) {
    await interaction.editReply({ content: "❌ Session expired. Use /admin-user-data to restart." }); return;
  }

  const discordId = sess.targetDiscordId;
  const updates: Partial<typeof usersTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  const changes: string[] = [];

  const coinsRaw  = interaction.fields.getTextInputValue("coins").trim();
  const legendRaw = interaction.fields.getTextInputValue("legend_total").trim();

  if (coinsRaw !== "") {
    const v = parseInt(coinsRaw, 10);
    if (!isNaN(v) && v >= 0) { updates.balance = v; changes.push(`💰 Coin balance → **${v}**`); }
    else { await interaction.editReply({ content: "❌ Invalid coin balance value." }); return; }
  }
  if (legendRaw !== "") {
    const v = parseInt(legendRaw, 10);
    if (!isNaN(v) && v >= 0) { updates.totalLegendPurchases = v; changes.push(`🏆 Legend total → **${v}**`); }
    else { await interaction.editReply({ content: "❌ Invalid legend total value." }); return; }
  }

  if (Object.keys(updates).length > 1) {
    await db.update(usersTable)
      .set(updates)
      .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)));
  }

  await interaction.editReply({
    content: changes.length > 0
      ? `✅ Economy updated for ${sess.targetTeam}:\n${changes.join("\n")}`
      : "No changes made.",
  });
}

export async function handleUdEditRecordsModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "view_edit" || !sess.targetDiscordId) {
    await interaction.editReply({ content: "❌ Session expired. Use /admin-user-data to restart." }); return;
  }

  const discordId = sess.targetDiscordId;
  const season    = await getOrCreateActiveSeason(guildId);

  const fields: Record<string, string> = {
    wins:          interaction.fields.getTextInputValue("wins").trim(),
    losses:        interaction.fields.getTextInputValue("losses").trim(),
    point_diff:    interaction.fields.getTextInputValue("point_diff").trim(),
    playoff_wins:  interaction.fields.getTextInputValue("playoff_wins").trim(),
    playoff_losses: interaction.fields.getTextInputValue("playoff_losses").trim(),
  };

  const updates: Record<string, number> = {};
  const changes: string[] = [];

  for (const [key, raw] of Object.entries(fields)) {
    if (raw === "") continue;
    const v = key === "point_diff" ? parseInt(raw, 10) : parseInt(raw, 10);
    if (isNaN(v)) { await interaction.editReply({ content: `❌ Invalid value for ${key}.` }); return; }
    updates[key] = v;
    changes.push(`• ${key.replace("_", " ")} → **${v}**`);
  }

  if (Object.keys(updates).length > 0) {
    const [existing] = await db.select({ id: userRecordsTable.id })
      .from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
      .limit(1);

    const mappedUpdates: Partial<typeof userRecordsTable.$inferInsert> & { updatedAt: Date } = {
      updatedAt:         new Date(),
      ...(updates["wins"]          !== undefined ? { wins:             updates["wins"]          } : {}),
      ...(updates["losses"]        !== undefined ? { losses:           updates["losses"]        } : {}),
      ...(updates["point_diff"]    !== undefined ? { pointDifferential: updates["point_diff"]   } : {}),
      ...(updates["playoff_wins"]  !== undefined ? { playoffWins:       updates["playoff_wins"] } : {}),
      ...(updates["playoff_losses"] !== undefined ? { playoffLosses:    updates["playoff_losses"] } : {}),
    };

    if (existing) {
      await db.update(userRecordsTable).set(mappedUpdates)
        .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)));
    } else {
      await db.insert(userRecordsTable).values({
        discordId,
        discordUsername: sess.targetUsername ?? discordId,
        team:            sess.targetTeam,
        seasonId:        season.id,
        wins:            updates["wins"]          ?? 0,
        losses:          updates["losses"]        ?? 0,
        pointDifferential: updates["point_diff"]  ?? 0,
        playoffWins:     updates["playoff_wins"]  ?? 0,
        playoffLosses:   updates["playoff_losses"] ?? 0,
      });
    }
  }

  await interaction.editReply({
    content: changes.length > 0
      ? `✅ Season records updated for ${sess.targetTeam}:\n${changes.join("\n")}`
      : "No changes made.",
  });
}

export async function handleUdEditAllTimeModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "view_edit" || !sess.targetDiscordId) {
    await interaction.editReply({ content: "❌ Session expired. Use /admin-user-data to restart." }); return;
  }

  const sbWinsRaw    = interaction.fields.getTextInputValue("sb_wins").trim();
  const sbLossesRaw  = interaction.fields.getTextInputValue("sb_losses").trim();
  const milestoneRaw = interaction.fields.getTextInputValue("milestone_tier").trim();

  const updates: Partial<typeof usersTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  const changes: string[] = [];

  if (sbWinsRaw !== "") {
    const v = parseInt(sbWinsRaw, 10);
    if (isNaN(v) || v < 0) { await interaction.editReply({ content: "❌ Invalid SB wins value." }); return; }
    updates.allTimeSuperbowlWins = v;
    changes.push(`🏆 All-time SB wins → **${v}**`);
  }
  if (sbLossesRaw !== "") {
    const v = parseInt(sbLossesRaw, 10);
    if (isNaN(v) || v < 0) { await interaction.editReply({ content: "❌ Invalid SB losses value." }); return; }
    updates.allTimeSuperbowlLosses = v;
    changes.push(`📉 All-time SB losses → **${v}**`);
  }
  if (milestoneRaw !== "") {
    const v = parseInt(milestoneRaw, 10);
    if (isNaN(v) || v < 0 || v > 10) { await interaction.editReply({ content: "❌ Milestone tier must be 0–10." }); return; }
    updates.milestoneTierAwarded = v;
    changes.push(`🎯 Milestone tier → **${v}**`);
  }

  if (Object.keys(updates).length > 1) {
    await db.update(usersTable)
      .set(updates)
      .where(and(eq(usersTable.discordId, sess.targetDiscordId), eq(usersTable.guildId, guildId)));
  }

  await interaction.editReply({
    content: changes.length > 0
      ? `✅ All-time stats updated for ${sess.targetTeam}:\n${changes.join("\n")}`
      : "No changes made.",
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// DELETE USER DATA
// ══════════════════════════════════════════════════════════════════════════════

function buildDeleteFlagsRows(flags: Record<string, boolean>): ActionRowBuilder<ButtonBuilder>[] {
  const cats = DELETE_CATEGORIES;
  const shortLabels: Record<string, string> = {
    economy:        "Economy",
    records:        "Records",
    wagers:         "Wagers",
    payout_data:    "Payout Data",
    interviews:     "Interviews",
    franchise_data: "Franchise",
    custom_players: "Custom Players",
  };

  const toDelete = cats.filter(c => flags[c] !== false);
  const btnRow   = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...cats.slice(0, 5).map(c => {
      const active = flags[c] !== false;
      return new ButtonBuilder()
        .setCustomId(`ud_delete_toggle:${c}`)
        .setLabel(`${active ? "✅" : "⬜"} ${shortLabels[c]}`)
        .setStyle(active ? ButtonStyle.Success : ButtonStyle.Secondary);
    }),
  );

  const btnRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...cats.slice(5).map(c => {
      const active = flags[c] !== false;
      return new ButtonBuilder()
        .setCustomId(`ud_delete_toggle:${c}`)
        .setLabel(`${active ? "✅" : "⬜"} ${shortLabels[c]}`)
        .setStyle(active ? ButtonStyle.Success : ButtonStyle.Secondary);
    }),
    new ButtonBuilder()
      .setCustomId("ud_delete_confirm")
      .setLabel(`🗑️ Confirm Delete (${toDelete.length} categories)`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(toDelete.length === 0),
    new ButtonBuilder().setCustomId("ud_cancel").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  return [btnRow, btnRow2];
}

export async function handleUdDelete(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;

  const allUsers = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
    balance:         usersTable.balance,
  }).from(usersTable)
    .where(eq(usersTable.guildId, guildId));

  const realUsers = allUsers.filter(u => !u.discordId.startsWith("unlinked_"));

  if (realUsers.length === 0) {
    await interaction.editReply({
      content:    "⚠️ No users found in this server.",
      embeds:     [],
      components: [cancelRow("← Back to Hub")],
    });
    return;
  }

  setSession(guildId, interaction.user.id, { flow: "delete" });

  const userSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ud_delete_user")
      .setPlaceholder("Select user to delete data for…")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(realUsers.slice(0, 25).map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(u.discordUsername)
          .setValue(u.discordId)
          .setDescription(`Team: ${u.team ?? "none"} | Balance: ${u.balance.toLocaleString()} coins`),
      )),
  );

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("🗑️ Delete User Data — Select User")
    .setDescription("Select a user from the dropdown. Then choose which data categories to delete and click **Confirm Delete**.");

  await interaction.editReply({ content: "", embeds: [embed], components: [userSelect, cancelRow()] });
}

export async function handleUdDeleteUserSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  const guildId  = interaction.guildId!;
  const discordId = interaction.values[0]!;

  const [userRow] = await db.select({
    discordUsername: usersTable.discordUsername, team: usersTable.team, balance: usersTable.balance,
  }).from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!userRow) {
    await interaction.editReply({ content: "❌ User not found.", components: [cancelRow()] }); return;
  }

  const defaultFlags: Record<string, boolean> = Object.fromEntries(DELETE_CATEGORIES.map(c => [c, true]));

  setSession(guildId, interaction.user.id, {
    flow: "delete",
    deleteDiscordId: discordId,
    deleteUsername:  userRow.discordUsername,
    deleteFlags:     defaultFlags,
  });

  const flagRows = buildDeleteFlagsRows(defaultFlags);

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("⚠️ Confirm User Deletion")
    .setDescription(
      `**User:** @${userRow.discordUsername} (<@${discordId}>)\n` +
      `**Team:** ${userRow.team ?? "none"}\n` +
      `**Balance:** ${userRow.balance.toLocaleString()} coins\n\n` +
      `Toggle the categories below to include/exclude from deletion.\n` +
      `**Green = will be deleted. Grey = will be preserved.**\n\n` +
      `⚠️ This action cannot be undone.`,
    );

  await interaction.editReply({ content: "", embeds: [embed], components: flagRows });
}

export async function handleUdDeleteToggle(interaction: ButtonInteraction, category: string): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "delete" || !sess.deleteDiscordId) {
    await interaction.editReply({ content: "❌ Session expired.", components: [cancelRow()] }); return;
  }

  sess.deleteFlags[category] = !sess.deleteFlags[category];
  setSession(guildId, interaction.user.id, sess);

  const flagRows = buildDeleteFlagsRows(sess.deleteFlags);

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("⚠️ Confirm User Deletion")
    .setDescription(
      `**User:** @${sess.deleteUsername} (<@${sess.deleteDiscordId}>)\n\n` +
      `Toggle the categories below to include/exclude from deletion.\n` +
      `**Green = will be deleted. Grey = will be preserved.**\n\n` +
      `⚠️ This action cannot be undone.`,
    );

  await interaction.editReply({ content: "", embeds: [embed], components: flagRows });
}

export async function handleUdDeleteConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!await checkAdmin(interaction)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const guildId = interaction.guildId!;
  const sess    = getSession(guildId, interaction.user.id);
  if (!sess || sess.flow !== "delete" || !sess.deleteDiscordId) {
    await interaction.reply({ content: "❌ Session expired. Use /admin-user-data to restart.", ephemeral: true }); return;
  }

  await interaction.deferUpdate();

  const discordId = sess.deleteDiscordId;
  const flags     = sess.deleteFlags;
  const counts: Record<string, number> = {};

  const guildSeasonIds = db.select({ id: seasonsTable.id }).from(seasonsTable).where(eq(seasonsTable.guildId, guildId));

  const del = async (label: string, promise: Promise<any[]>) => {
    const rows = await promise;
    counts[label] = rows.length;
  };

  if (flags["economy"]) {
    await del("inventory",    db.delete(inventoryTable)       .where(and(eq(inventoryTable.discordId,        discordId), inArray(inventoryTable.seasonId,   guildSeasonIds))).returning({ id: inventoryTable.id }));
    await del("season_stats", db.delete(seasonStatsTable)     .where(and(eq(seasonStatsTable.discordId,      discordId), inArray(seasonStatsTable.seasonId, guildSeasonIds))).returning({ id: seasonStatsTable.id }));
    await del("transactions", db.delete(coinTransactionsTable).where(and(eq(coinTransactionsTable.discordId, discordId), eq(coinTransactionsTable.guildId, guildId))).returning({ id: coinTransactionsTable.id }));
    await del("purchases",    db.delete(purchasesTable)       .where(and(eq(purchasesTable.discordId,        discordId), inArray(purchasesTable.seasonId,   guildSeasonIds))).returning({ id: purchasesTable.id }));
  }

  if (flags["records"]) {
    await del("user_records", db.delete(userRecordsTable)      .where(and(eq(userRecordsTable.discordId, discordId), inArray(userRecordsTable.seasonId, guildSeasonIds))).returning({ id: userRecordsTable.id }));
    await del("h2h_records",  db.delete(h2hMatchupRecordsTable).where(and(or(eq(h2hMatchupRecordsTable.discordId1, discordId), eq(h2hMatchupRecordsTable.discordId2, discordId)), eq(h2hMatchupRecordsTable.guildId, guildId))).returning({ id: h2hMatchupRecordsTable.id }));
    await del("game_log",     db.delete(gameLogTable)          .where(and(eq(gameLogTable.discordId, discordId), eq(gameLogTable.guildId, guildId))).returning({ id: gameLogTable.id }));
  }

  if (flags["wagers"]) {
    await del("wagers", db.delete(wagersTable).where(and(or(eq(wagersTable.challengerId, discordId), eq(wagersTable.opponentId, discordId)), eq(wagersTable.guildId, guildId))).returning({ id: wagersTable.id }));
  }

  if (flags["payout_data"]) {
    await del("payout_requests", db.delete(payoutRequestsTable)      .where(or(eq(payoutRequestsTable.requesterId, discordId), eq(payoutRequestsTable.opponentId, discordId))).returning({ id: payoutRequestsTable.id }));
    await del("channel_payouts", db.delete(pendingChannelPayoutsTable).where(and(eq(pendingChannelPayoutsTable.discordId, discordId), eq(pendingChannelPayoutsTable.guildId, guildId))).returning({ id: pendingChannelPayoutsTable.id }));
    await del("eos_payouts",     db.delete(pendingEosPayoutsTable)    .where(and(eq(pendingEosPayoutsTable.discordId, discordId), inArray(pendingEosPayoutsTable.seasonId, guildSeasonIds))).returning({ id: pendingEosPayoutsTable.id }));
  }

  if (flags["interviews"]) {
    await del("interviews", db.delete(interviewRequestsTable).where(and(eq(interviewRequestsTable.discordId, discordId), eq(interviewRequestsTable.guildId, guildId))).returning({ id: interviewRequestsTable.id }));
  }

  if (flags["franchise_data"]) {
    const mcaRows = await db.update(franchiseMcaTeamsTable)
      .set({ discordId: null, isHuman: false, updatedAt: new Date() })
      .where(and(eq(franchiseMcaTeamsTable.discordId, discordId), inArray(franchiseMcaTeamsTable.seasonId, guildSeasonIds)))
      .returning({ id: franchiseMcaTeamsTable.id });
    counts["franchise_mca"] = mcaRows.length;
    const rosterResult = await db.update(franchiseRostersTable)
      .set({ discordId: null })
      .where(and(eq(franchiseRostersTable.discordId, discordId), inArray(franchiseRostersTable.seasonId, guildSeasonIds)))
      .returning({ id: franchiseRostersTable.id });
    counts["franchise_rosters"] = rosterResult.length;
    await del("team_season_stats", db.delete(teamSeasonStatsTable)  .where(and(eq(teamSeasonStatsTable.discordId,   discordId), inArray(teamSeasonStatsTable.seasonId,   guildSeasonIds))).returning({ id: teamSeasonStatsTable.id }));
    await del("player_stats",      db.delete(playerSeasonStatsTable).where(and(eq(playerSeasonStatsTable.discordId, discordId), inArray(playerSeasonStatsTable.seasonId,   guildSeasonIds))).returning({ id: playerSeasonStatsTable.id }));
  }

  if (flags["custom_players"]) {
    await del("custom_players", db.delete(customPlayersTable).where(and(eq(customPlayersTable.discordId, discordId), inArray(customPlayersTable.seasonId, guildSeasonIds))).returning({ id: customPlayersTable.id }));
  }

  // Always delete the user profile last
  await db.delete(usersTable).where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)));

  clearSession(guildId, interaction.user.id);

  const deletedLines = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `• ${label}: **${n}** row${n === 1 ? "" : "s"} deleted`);

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("🗑️ User Deleted")
    .setDescription(
      `**@${sess.deleteUsername}** (<@${discordId}>) has been permanently removed.\n\n` +
      (deletedLines.length > 0 ? `**Deleted:**\n${deletedLines.join("\n")}` : "*No associated data found.*"),
    )
    .setFooter({ text: `Deleted by ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({
    content:    "",
    embeds:     [embed],
    components: [cancelRow("← Back to Hub")],
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TEAM REQUEST — COMMISSIONER ACTION BUTTONS
// Triggered from the notification posted to the commissioner channel when an
// unlinked user submits an open-team request via /menu.
// Prefix: treq_
// ══════════════════════════════════════════════════════════════════════════════

export async function handleTreqLinkButton(interaction: ButtonInteraction): Promise<void> {
  const gid     = interaction.guildId!;
  const isAdmin = await isAdminUser(interaction.user.id, gid)
    || (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false);
  if (!isAdmin) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const [, uid, ...teamParts] = interaction.customId.split("|");
  const team = teamParts.join("|");

  const targetMember = await interaction.guild?.members.fetch(uid!).catch(() => null);
  const memberName   = targetMember?.nickname ?? targetMember?.user.username ?? uid!;

  setSession(gid, interaction.user.id, {
    flow:               "link",
    linkTeam:           team,
    linkMemberId:       uid!,
    linkMemberName:     memberName,
    linkCommChannelId:  interaction.channelId,
    linkCommMsgId:      interaction.message.id,
  });

  await interaction.message.edit({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("🔔 Open Team Request — Being Processed")
      .setDescription(`<@${uid}> has requested an open team.`)
      .addFields(
        { name: "🏈 Team Requested", value: team, inline: true },
        { name: "⏳ Status", value: `Being linked by <@${interaction.user.id}>...`, inline: true },
      )
      .setTimestamp()],
    components: [],
  });

  const modal = new ModalBuilder()
    .setCustomId("ud_modal_link")
    .setTitle(`Link @${memberName} → ${team}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("new_user")
          .setLabel("Award new member bonus? (yes / no)")
          .setStyle(TextInputStyle.Short)
          .setValue("yes")
          .setRequired(true)
          .setMaxLength(3),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("referrer_id")
          .setLabel("Referrer Discord ID (leave blank if none)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("e.g. 123456789012345678"),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleTreqDenyButton(interaction: ButtonInteraction): Promise<void> {
  const gid     = interaction.guildId!;
  const isAdmin = await isAdminUser(interaction.user.id, gid)
    || (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false);
  if (!isAdmin) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const [, uid, ...teamParts] = interaction.customId.split("|");
  const team  = teamParts.join("|");
  const msgId = interaction.message.id;

  const modal = new ModalBuilder()
    .setCustomId(`treq_deny_reason|${uid}|${msgId}|${team}`)
    .setTitle("Deny Team Request")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Reason for denial (sent to user via DM)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleTreqDenyReasonModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const [, uid, msgId, ...teamParts] = interaction.customId.split("|");
  const team   = teamParts.join("|");
  const reason = interaction.fields.getTextInputValue("reason").trim();

  let dmSent = false;
  try {
    const targetUser = await interaction.client.users.fetch(uid!).catch(() => null);
    if (targetUser) {
      await targetUser.send({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Team Request Denied")
          .setDescription(`Your request for the **${team}** has been reviewed and denied.`)
          .addFields({ name: "📋 Reason", value: reason })
          .setFooter({ text: "Contact a commissioner if you have questions." })
          .setTimestamp()],
      });
      dmSent = true;
    }
  } catch { /* user may have DMs disabled */ }

  try {
    if (interaction.channelId) {
      const channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const msg = await (channel as TextChannel).messages.fetch(msgId!).catch(() => null);
        await msg?.delete().catch(() => null);
      }
    }
  } catch { /* ignore */ }

  await interaction.editReply({
    content: `✅ Request for **${team}** denied. ${dmSent ? `<@${uid}> was notified via DM.` : "Could not send DM — user may have DMs disabled."}`,
  });
}
