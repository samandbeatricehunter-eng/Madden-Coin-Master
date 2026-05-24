import {
  Interaction, ButtonInteraction, StringSelectMenuInteraction,
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  purchasesTable, inventoryTable, legendsTable, usersTable,
  interviewRequestsTable, wagersTable,
  franchiseScheduleTable, seasonsTable,
  pendingEosPayoutsTable, seasonStatTierConfigsTable,
  pendingChannelPayoutsTable,
  statPaddingViolationsTable, seasonStatsTable,
} from "@workspace/db";
import { CORE_ATTRIBUTES } from "../lib/constants.js";
import { STAT_CATEGORIES, STAT_TIER_DEFAULTS } from "../lib/economy/stat-categories.js";
import { pendingCoCommActions, purgeExpiredCoCommActions } from "../lib/handlers/pending-cocomm-actions.js";
import { executeAdminAction, type AdminActionContext } from "../lib/handlers/admin-actions.js";
import {
  handleCcpPreConfirm,
  handleCcpPos, handleCcpArch, handleCcpArchPrev, handleCcpArchNext, handleCcpArchPick,
  handleCcpAttrPagePrev, handleCcpAttrPageNext,
  handleCcpOlPos, handleCcpDev, handleCcpPkg,
  handleCcpAttrSel, handleCcpAttrSelPrev, handleCcpAttrSelNext, handleCcpAttrAdjust,
  handleCcpSubmitAttrs, handleCcpConfirm, handleCcpCancel,
  handleCcpModal, handleCcpHand, handleCcpHeight, handleCcpWeight,
  handleCcpApplied, handleCcpRefund, handleCcpRefundModal,
  handleCcpMotionStyle, handleCcpQbDetailsModal, handleCcpAppearanceModal,
} from "../lib/handlers/custom-player-interactions.js";
import { handleViewArchetypeSelect, handleVcaNav, handleVcaAttrPageNav } from "../lib/stats/archetype-viewer.js";
import { handleTeamSelect, handlePositionSelect, handlePlayerSelect } from "../lib/stats/player-stats-viewer.js";
import { handleAcpPositionSelect, handleAcpPlayerSelect } from "../lib/handlers/admin-helpers/inventory.js";
import {
  handleCancel as apHandleCancel,
  handleGotw, handleGotwSelectAfc, handleGotwSelectNfc, handleGotwFinalize,
  handlePotw,
  handlePotwSelectAfc, handlePotwSelectNfc, handlePotwBack, handlePotwFinalize,
  handleClose,
  handleAddCoins, handleAddCoinsSelectAfc, handleAddCoinsSelectNfc, handleAddCoinsNext, handleAddCoinsModal,
  handleRemoveCoins, handleRemoveCoinsSelectAfc, handleRemoveCoinsSelectNfc, handleRemoveCoinsNext, handleRemoveCoinsModal,
  handleTransfer, handleTransferSelectAfc, handleTransferSelectNfc, handleTransferNext, handleTransferModal,
  handleGame, handleGameSelect, handleGameWinnerHome, handleGameWinnerAway, handleGameWinnerCpu,
  handleGameModalHomeWins, handleGameModalAwayWins, handleGameModalCpuWins,
  handleCorrect, handleCorrectWeekSelect, handleCorrectGameSelect,
  handleCorrectNewWinner, handleCorrectSwap, handleCorrectModalSame, handleCorrectModalSwap,
  handleSetPay, handleSetPayReg, handleSetPayRegModal, handleSetPayPlayoff, handleSetPayChannel, handleSetPayChannelModal,
  handleSetPayPo1Btn, handleSetPayPo2Btn, handleSetPayPo1Modal, handleSetPayPo2Modal,
  handleNewMember, handleNewMemberModal,
  handleGotwBonus, handleGotwBonusModal,
  handlePotwBonus, handlePotwBonusModal,
  handleReferral, handleReferralModal,
  handleEos, handleEosKeySelect, handleEosEditModal, handleEosStatTierModal,
  handleMilestone, handleMilestoneAdd, handleMilestoneEdit, handleMilestoneEditModal,
  handleInterviewPayout, handleInterviewPayoutModal,
} from "../lib/handlers/admin-payout-handlers.js";
import {
  handleUdClose, handleUdCancel,
  handleUdViewTeams,
  handleUdLink, handleUdLinkTeamAfc, handleUdLinkTeamNfc, handleUdLinkMember, handleUdLinkNext, handleUdLinkModal,
  handleUdUnlink, handleUdUnlinkTeamAfc, handleUdUnlinkTeamNfc, handleUdUnlinkConfirm,
  handleUdViewEdit, handleUdVeTeamAfc, handleUdVeTeamNfc, handleUdVeLoad,
  handleUdEditEconomy, handleUdEditRecords, handleUdEditAllTime,
  handleUdEditEconomyModal, handleUdEditRecordsModal, handleUdEditAllTimeModal,
  handleUdDelete, handleUdDeleteUserSelect, handleUdDeleteToggle, handleUdDeleteConfirm,
  handleTreqLinkButton, handleTreqDenyButton, handleTreqDenyReasonModal,
} from "../lib/handlers/admin-user-handlers.js";
import {
  handleSsClose, handleSsCancel,
  handleSsArch, handleSsArchPrev, handleSsArchNext, handleSsArchEdit, handleSsArchBackToView,
  handleSsLt, handleSsLtEdit, handleSsLtCreate, handleSsLtBackToPos, handleSsLtBackToModel, handleSsLtBackToView,
  handleSsArchPos, handleSsArchEditGroup,
  handleSsLtPos, handleSsLtLegend, handleSsLtModel, handleSsLtEditGroup,
  handleSsArchEditModal, handleSsLtEditModal,
} from "../lib/handlers/admin-store-handlers.js";
import { eq, and, sql, inArray, count } from "drizzle-orm";
import {
  addBalance, deductBalance, logTransaction,
  getOrCreateActiveSeason, getOrCreateUser, isAdminUser,
  getSeasonRules, getGuildChannel, CHANNEL_KEYS,
} from "../lib/db/db-helpers.js";
import {
  getServerSettings, toggleFeature, buildSettingsEmbed, buildSettingsRows,
  FEATURE_LABELS,
} from "../lib/db/server-settings.js";
import { registerCommandsForGuild } from "../lib/discord/register-commands.js";
import { buildMemberHelpEmbed } from "../lib/menu/help-text.js";
import {
  INTERVIEW_QUESTIONS, getQuestionPool, interviewTypeLabel,
  type InterviewType,
} from "../lib/league/interview-questions.js";
import { handleActionsInteraction, handleInterviewTypePick } from "../lib/handlers/actions-handlers.js";
import { handleAdminOperationsInteraction } from "../lib/handlers/admin-operations-handlers.js";
import { weekLabel } from "../lib/helpers/week-helpers.js";
import {
  DRAFT_TOGGLE_PREFIX, DRAFT_CLOSE_BUTTON_ID,
  getActiveSession, togglePresence, refreshPresence, endDraftSession,
} from "../lib/discord/draft-presence-manager.js";
import {
  scoreH2HMatchups, postGotwToChannel,
} from "../lib/helpers/gotw-helpers.js";
import { buildTeamToDiscord } from "../lib/franchise/weekly-matchups-runner.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/economy/payout-config.js";
import { waitlistTable } from "@workspace/db";
import {
  WAITLIST_ACCEPT_PREFIX, WAITLIST_DENY_PREFIX,
} from "../lib/league/waitlist-helpers.js";
import {
  handleTsRepairRecords,
  handleTsResyncData,
  handleTsEosTestRun,
  handleTsRepairPlayoff,
  handleTsPlayoffProceed,
  handleTsPlayoffConfirm,
  handleTsPlayoffCancel,
  handleTsEosManual,
  handleTsEosManualConfirm,
  handleTsEosManualCancel,
  handleTsEosReset,
  handleTsEosResetConfirm,
  handleTsEosResetCancel,
  handleTsRepairSchedules,
  handleTsSchedReviewWeek,
  handleTsSchedWeekModal,
  handleTsSchedSel,
  handleTsSchedDelete,
  handleTsImportSchedule,
  handleTsRepostSchedulingHeaders,
} from "../lib/handlers/admin-troubleshoot-handlers.js";
import {
  handleLeagueDataButton,
  handleLeagueDataModal,
  handleLeagueDataSelect,
} from "../lib/handlers/league-data-handlers.js";
import { handleMenuButton, handleMenuSelect } from "../lib/menu/menu-router.js";


export const name = "interactionCreate";

export async function execute(interaction: Interaction) {
  // ── Role guard ─────────────────────────────────────────────────────────────
  // All interactions from guild members must have at least one assigned role
  // beyond @everyone (which every user has by default).
  // Exception: /menu and all ac_ interactions are exempt because the menu
  // itself handles the linked/unlinked branching — the unlinked hub is
  // specifically designed for users who have no role yet.
  const isMenuCommand    = interaction.isChatInputCommand() && interaction.commandName === "menu";
  const customId         = (interaction as any).customId as string | undefined;
  const isMenuInteraction = (interaction.isButton() || interaction.isStringSelectMenu())
    && typeof customId === "string"
    && (customId.startsWith("ac_") || customId.startsWith("menu_"));

  if (interaction.inGuild() && interaction.member && !isMenuCommand && !isMenuInteraction) {
    const roles = (interaction.member as any).roles;
    // GuildMemberRoleManager exposes .cache (Collection); raw API payloads give a string[]
    const roleCount: number = roles?.cache?.size ?? (Array.isArray(roles) ? roles.length : 0);
    if (roleCount <= 1) {
      if (interaction.isAutocomplete()) {
        await interaction.respond([]).catch(() => {});
      } else if (interaction.isRepliable()) {
        await interaction.reply({
          content: "❌ You must have a role assigned in this server to use the bot.",
          ephemeral: true,
        }).catch(() => {});
      }
      return;
    }
  }

  if (interaction.isAutocomplete()) {
    const client = interaction.client as any;
    const command = client.commands?.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try { await command.autocomplete(interaction); } catch (err) { console.error("Autocomplete error:", err); }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const client = interaction.client as any;
    const command = client.commands?.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Error executing command ${interaction.commandName}:`, err);
      const errorMsg = { content: "An error occurred while executing that command.", ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(errorMsg).catch(() => {});
      else await interaction.reply(errorMsg).catch(() => {});
    }
    return;
  }

  if (interaction.isButton()) {
    try { await handleButton(interaction); }
    catch (err) {
      console.error(`[button] ${interaction.customId}:`, err);
      const msg = { content: "❌ Something went wrong. Please try again.", ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }

  if (interaction.isStringSelectMenu()) {
    try { await handleSelectMenu(interaction); }
    catch (err) {
      console.error(`[select] ${interaction.customId}:`, err);
      const msg = { content: "❌ Something went wrong. Please try again.", ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }

  if (interaction.isRoleSelectMenu()) {
    try {
      if (interaction.customId === "role_lottery") {
        const { handleLotteryRoleSelect } = await import("../lib/handlers/lottery-handler.js");
        await handleLotteryRoleSelect(interaction);
      }
    } catch (err) {
      console.error(`[roleSelect] ${interaction.customId}:`, err);
      const msg = { content: "❌ Something went wrong. Please try again.", ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    try { await handleModal(interaction); }
    catch (err) {
      console.error(`[modal] ${interaction.customId}:`, err);
      const msg = { content: "❌ Something went wrong. Please try again.", ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  }
}

// ── Button handler ─────────────────────────────────────────────────────────────
async function handleButton(interaction: ButtonInteraction) {
  const parts = interaction.customId.split(":");
  const [action, secondPart, userId, purchaseType] = parts;

  // ── Team request commissioner buttons (treq_link|uid|team, treq_deny|uid|team) ─
  if (interaction.customId.startsWith("treq_link|")) { await handleTreqLinkButton(interaction); return; }
  if (interaction.customId.startsWith("treq_deny|")) { await handleTreqDenyButton(interaction); return; }

  // ── Commissioner's Office (pending transactions hub) ─────────────────────────
  if (interaction.customId.startsWith("co_")) {
    const { handleCommOfficeInteraction } = await import("../lib/handlers/pending-inbox-handlers.js");
    await handleCommOfficeInteraction(interaction);
    return;
  }

  // ── In-channel game scheduling state machine ─────────────────────────────────
  if (interaction.customId.startsWith("gs_")) {
    const { handleGsInteraction } = await import("../lib/handlers/game-scheduling-handlers.js");
    await handleGsInteraction(interaction);
    return;
  }

  // ── In-menu GOTW voting (replaces Discord polls) ─────────────────────────────
  if (interaction.customId.startsWith("gotwv_")) {
    const { handleGotwvInteraction } = await import("../lib/handlers/gotw-voting-handlers.js");
    await handleGotwvInteraction(interaction);
    return;
  }

  // ── In-menu GOTY voting (replaces Discord poll) ──────────────────────────────
  if (interaction.customId.startsWith("gotyv_")) {
    const { handleGotyvInteraction } = await import("../lib/handlers/goty-voting-handlers.js");
    await handleGotyvInteraction(interaction);
    return;
  }

  // ── Admin troubleshoot panel buttons ─────────────────────────────────────────
  if (action === "ts_repair_records")    { await handleTsRepairRecords(interaction);    return; }
  if (action === "ts_resync_data")       { await handleTsResyncData(interaction);       return; }
  if (action === "ts_eos_testrun")       { await handleTsEosTestRun(interaction);       return; }
  if (action === "ts_repair_playoff")    { await handleTsRepairPlayoff(interaction);    return; }
  if (action === "ts_playoff_proceed")   { await handleTsPlayoffProceed(interaction);   return; }
  if (action === "ts_playoff_confirm")   { await handleTsPlayoffConfirm(interaction);   return; }
  if (action === "ts_playoff_cancel")    { await handleTsPlayoffCancel(interaction);    return; }
  if (action === "ts_eos_manual")        { await handleTsEosManual(interaction);        return; }
  if (action === "ts_eos_manual_confirm"){ await handleTsEosManualConfirm(interaction); return; }
  if (action === "ts_eos_manual_cancel") { await handleTsEosManualCancel(interaction);  return; }
  if (action === "ts_eos_reset")         { await handleTsEosReset(interaction);         return; }
  if (action === "ts_eos_reset_confirm") { await handleTsEosResetConfirm(interaction);  return; }
  if (action === "ts_eos_reset_cancel")  { await handleTsEosResetCancel(interaction);   return; }
  if (action === "ts_repair_schedules")     { await handleTsRepairSchedules(interaction);          return; }
  if (action === "ts_sched_review_week")    { await handleTsSchedReviewWeek(interaction);          return; }
  if (action === "ts_sched_delete")         { await handleTsSchedDelete(interaction);              return; }
  if (action === "ts_import_schedule")      { await handleTsImportSchedule(interaction);           return; }
  if (action === "ts_repost_sched_headers") { await handleTsRepostSchedulingHeaders(interaction);  return; }

  // ── League Data wizard — all ld_ prefixed buttons ─────────────────────────
  if (action?.startsWith("ld_")) {
    await handleLeagueDataButton(interaction);
    return;
  }

  // ── New /menu navigation (menu_back, menu_admin_back) ───────────────────────
  if (action?.startsWith("menu_")) {
    const handled = await handleMenuButton(interaction);
    if (handled) return;
  }

  // ── Actions hub — dispatch all ac_ prefixed interactions ─────────────────────
  if (action?.startsWith("ac_")) {
    const handled = await handleActionsInteraction(interaction);
    if (handled) return;
  }

  // ── Admin Operations hub — dispatch all ao_ prefixed interactions ─────────────
  if (action?.startsWith("ao_")) {
    const handled = await handleAdminOperationsInteraction(interaction);
    if (handled) return;
  }

  // ── Interview type picker (pre-game / post-game / general) ───────────────────
  if (action === "interview_typepick") {
    await handleInterviewTypePick(interaction);
    return;
  }

  // ── Archetype viewer — archetype nav ─────────────────────────────────────────
  // Button IDs: vca_prev:POSITION:IDX   vca_next:POSITION:IDX
  if (action === "vca_prev" || action === "vca_next") {
    const position = secondPart ?? "";
    const idx      = parseInt(parts[2] ?? "0", 10);
    await handleVcaNav(interaction, action === "vca_prev" ? "prev" : "next", position, idx);
    return;
  }

  // ── Archetype viewer — attribute page nav ─────────────────────────────────────
  // Button IDs: vca_apage_prev:POSITION:ARCHIDX:ATTRPAGE  vca_apage_next:...
  if (action === "vca_apage_prev" || action === "vca_apage_next") {
    const position    = secondPart ?? "";
    const archIdx     = parseInt(parts[2] ?? "0", 10);
    const attrPage    = parseInt(parts[3] ?? "0", 10);
    await handleVcaAttrPageNav(interaction, action === "vca_apage_prev" ? "prev" : "next", position, archIdx, attrPage);
    return;
  }

  // ── Purchase flow — attribute page nav ────────────────────────────────────────
  // Button IDs: ccp_apage_prev:sessionId   ccp_apage_next:sessionId
  if (action === "ccp_apage_prev") { await handleCcpAttrPagePrev(interaction, secondPart ?? ""); return; }
  if (action === "ccp_apage_next") { await handleCcpAttrPageNext(interaction, secondPart ?? ""); return; }

  // ── Purchase flow — archetype browser nav ─────────────────────────────────────
  if (action === "ccp_arch_prev") { await handleCcpArchPrev(interaction, secondPart ?? ""); return; }
  if (action === "ccp_arch_next") { await handleCcpArchNext(interaction, secondPart ?? ""); return; }
  if (action === "ccp_arch_pick") { await handleCcpArchPick(interaction, secondPart ?? ""); return; }

  // ── Purchase flow — attribute selector page nav ───────────────────────────────
  if (action === "ccp_asel_prev") { await handleCcpAttrSelPrev(interaction, secondPart ?? ""); return; }
  if (action === "ccp_asel_next") { await handleCcpAttrSelNext(interaction, secondPart ?? ""); return; }

  // ── Custom player builder ─────────────────────────────────────────────────────
  if (action === "ccp_attr_plus1")  { await handleCcpAttrAdjust(interaction, secondPart ?? "", 1);  return; }
  if (action === "ccp_attr_minus1") { await handleCcpAttrAdjust(interaction, secondPart ?? "", -1); return; }
  if (action === "ccp_submit_attrs")  { await handleCcpSubmitAttrs(interaction, secondPart ?? "");    return; }
  if (action === "ccp_preconfirm")    { await handleCcpPreConfirm(interaction, secondPart ?? "");    return; }
  if (action === "ccp_confirm")       { await handleCcpConfirm(interaction, secondPart ?? "");        return; }
  if (action === "ccp_cancel")        { await handleCcpCancel(interaction, secondPart ?? "");         return; }
  if (action === "ccp_applied")       { await handleCcpApplied(interaction, secondPart ?? "");        return; }
  if (action === "ccp_refund")        { await handleCcpRefund(interaction, secondPart ?? "");         return; }

  // ── Draft presence — per-user toggle ─────────────────────────────────────
  if (action === DRAFT_TOGGLE_PREFIX) {
    await interaction.deferUpdate();
    const targetDiscordId = secondPart ?? "";

    // Permission check: only the target user or an admin may click this button
    const clickerId  = interaction.user.id;
    const isSelfToggle = clickerId === targetDiscordId;

    let isAdmin = false;
    if (!isSelfToggle) {
      const member = interaction.guild?.members.cache.get(clickerId)
        ?? await interaction.guild?.members.fetch(clickerId).catch(() => null);
      const hasDiscordAdmin = member?.permissions.has(0x8n) ?? false; // ADMINISTRATOR bit
      const hasDbAdmin      = await isAdminUser(clickerId, interaction.guildId!);
      isAdmin = hasDiscordAdmin || hasDbAdmin;
    }

    if (!isSelfToggle && !isAdmin) {
      await interaction.followUp({
        content: "❌ You can only toggle your own presence status.",
        ephemeral: true,
      });
      return;
    }

    const guildId = interaction.guildId ?? "";
    const session = await getActiveSession(guildId);
    if (!session) {
      await interaction.followUp({ content: "⚠️ No active draft session.", ephemeral: true });
      return;
    }

    const newStatus = await togglePresence(session.id, targetDiscordId);
    if (newStatus === null) {
      await interaction.followUp({
        content: "⚠️ That user is not registered in the league.",
        ephemeral: true,
      });
      return;
    }

    await refreshPresence(interaction.client, session.id);

    const label = isSelfToggle
      ? `You are now **${newStatus ? "Present ✅" : "Away 🔴"}**`
      : `<@${targetDiscordId}> is now **${newStatus ? "Present ✅" : "Away 🔴"}**`;

    await interaction.followUp({ content: label, ephemeral: true });
    return;
  }

  // ── Draft presence — close button ─────────────────────────────────────────
  if (action === DRAFT_CLOSE_BUTTON_ID) {
    await interaction.deferUpdate();

    const member = interaction.guild?.members.cache.get(interaction.user.id)
      ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const hasDiscordAdmin = member?.permissions.has(0x8n) ?? false;
    const hasDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);

    if (!hasDiscordAdmin && !hasDbAdmin) {
      await interaction.followUp({
        content: "❌ Only admins can close the draft.",
        ephemeral: true,
      });
      return;
    }

    const session = await getActiveSession(interaction.guildId ?? "");
    if (!session) {
      await interaction.followUp({ content: "⚠️ No active draft session.", ephemeral: true });
      return;
    }

    await interaction.followUp({
      content: "✅ Closing draft room… channel will be deleted in 10 seconds.",
      ephemeral: true,
    });

    endDraftSession(interaction.client, session.id).catch(console.error);
    return;
  }

  // ── Co-Commissioner action approval ────────────────────────────────────────
  if (action === "cocomm-approve" || action === "cocomm-deny") {
    await interaction.deferUpdate();
    // Only full Commissioners (not Co-Commissioners) can approve/deny
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const isFullCommissioner = member?.roles.cache.some(r => r.name === "Commissioner") ?? false;
    if (!isFullCommissioner) {
      await interaction.followUp({ content: "❌ Only Commissioners can approve or deny Co-Commissioner actions.", ephemeral: true });
      return;
    }

    purgeExpiredCoCommActions();
    const actionId = secondPart ?? "";
    const pending  = pendingCoCommActions.get(actionId);

    if (!pending) {
      const expiredEmbed = new EmbedBuilder()
        .setColor(Colors.Grey)
        .setTitle("⏰ Action Expired or Already Handled")
        .setDescription("This Co-Commissioner action is no longer pending.")
        .setTimestamp();
      await interaction.editReply({ embeds: [expiredEmbed], components: [] }).catch(() => {});
      return;
    }

    if (action === "cocomm-deny") {
      pendingCoCommActions.delete(actionId);
      const deniedEmbed = new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ Co-Commissioner Action Denied")
        .addFields(
          { name: "Requested By", value: `<@${pending.issuerId}>`, inline: true },
          { name: "Denied By",    value: `<@${interaction.user.id}>`, inline: true },
          { name: "Action",       value: pending.summaryText },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [deniedEmbed], components: [] }).catch(() => {});
      return;
    }

    // Approve — execute the action
    pendingCoCommActions.delete(actionId);
    const ctx: AdminActionContext = {
      client:  interaction.client,
      guild:   interaction.guild,
      actorId: pending.issuerId,
    };
    const result = await executeAdminAction(pending.action, ctx);
    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Co-Commissioner Action Approved & Executed")
      .addFields(
        { name: "Requested By", value: `<@${pending.issuerId}>`, inline: true },
        { name: "Approved By",  value: `<@${interaction.user.id}>`, inline: true },
        { name: "Action",       value: pending.summaryText },
        { name: "Result",       value: result },
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [approvedEmbed], components: [] }).catch(() => {});
    return;
  }

  // ── Purchase: approve ────────────────────────────────────────────────────────
  if (action === "approve_purchase") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];
    if (!purchase)                      { await interaction.followUp({ content: "❌ Purchase not found.",  ephemeral: true }); return; }
    if (purchase.status === "approved") { await interaction.followUp({ content: "⚠️ Already approved.",    ephemeral: true }); return; }
    if (purchase.status === "refunded") { await interaction.followUp({ content: "⚠️ Already refunded.",    ephemeral: true }); return; }

    await db.update(purchasesTable).set({ status: "approved", approvedAt: new Date() }).where(eq(purchasesTable.id, purchaseId));

    if (purchaseType === "legend" && purchase.legendId) {
      // Look up the owner's current team so the inventory entry is stamped with the team,
      // not the user — this makes the inventory follow the franchise across ownership changes.
      const ownerTeamRows = await db
        .select({ team: usersTable.team })
        .from(usersTable)
        .where(and(eq(usersTable.discordId, userId!), eq(usersTable.guildId, interaction.guildId!)))
        .limit(1);
      const ownerTeam = ownerTeamRows[0]?.team ?? null;

      await db.insert(inventoryTable).values({
        discordId: userId!, seasonId: purchase.seasonId, purchaseId: purchase.id,
        itemType: "legend", legendId: purchase.legendId,
        legendName: purchase.playerName, playerPosition: purchase.playerPosition,
        legendCategory: "current",
        team: ownerTeam,
      });
      await db.update(legendsTable).set({ isAvailable: false }).where(eq(legendsTable.id, purchase.legendId));
    }

    const purchaseTypeLabel: Record<string, string> = {
      legend: "Legend Player",
      attribute: "Attribute Upgrade",
      dev_up: "Dev Upgrade",
      age_reset: "Age Reset",
      custom_player_bronze: "Custom Player (Bronze)",
      custom_player_silver: "Custom Player (Silver)",
      custom_player_gold: "Custom Player (Gold)",
    };
    const itemLabel = purchaseTypeLabel[purchaseType ?? ""] ?? (purchaseType ?? "Store Purchase");
    const itemName = purchase.playerName ?? purchase.attributeName ?? "(unnamed)";
    const purchaseDescLines = [
      `**User:** <@${userId}>`,
      `**Item:** ${itemLabel} — ${itemName}${purchase.playerPosition ? ` (${purchase.playerPosition})` : ""}`,
      `**Cost:** ${purchase.cost.toLocaleString()} coins`,
      purchase.notes ? `**Notes:** ${purchase.notes}` : null,
      `\n✅ Applied in-game by ${interaction.user.toString()}`,
    ].filter(Boolean).join("\n");

    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Applied In-Game")
      .setDescription(purchaseDescLines)
      .setFooter({ text: `Purchase #${purchaseId} • Season ${purchase.seasonId}` })
      .setTimestamp();
    await interaction.editReply({
      embeds: [approvedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("approved_done").setLabel("✅ Applied").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });

    try {
      const user = await interaction.client.users.fetch(userId!);
      let msg = "";
      if (purchaseType === "legend")                      msg = `🏆 Your legend **${purchase.playerName}** has been added to the draft pool! Check \`/inventory\`.`;
      else if (purchaseType === "attribute")              msg = `⚡ Your **${purchase.attributeName}** attribute upgrade has been applied!`;
      else if (purchaseType === "dev_up")                 msg = `📈 Your dev upgrade for **${purchase.playerName}** has been applied!`;
      else if (purchaseType === "age_reset")              msg = `🔄 Your age reset for **${purchase.playerName}** has been applied!`;
      else if (purchaseType?.startsWith("custom_player")) msg = `🎨 Your custom player **${purchase.playerName}** has been applied!`;
      await user.send(`✅ **Purchase #${purchaseId} Approved!**\n${msg}`).catch(() => {});
    } catch (_) {}

    // ── Draft tracker post (legend + custom player only) ──────────────────────
    if (purchaseType === "legend" || purchaseType?.startsWith("custom_player")) {
      try {
        const draftTrackerChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.DRAFT_TRACKER);
        const draftChannel = draftTrackerChannelId ? await interaction.client.channels.fetch(draftTrackerChannelId).catch(() => null) : null;
        if (draftChannel?.isTextBased()) {
          const tierLabel = purchaseType?.startsWith("custom_player")
            ? ` (${purchaseType.replace("custom_player_", "").toUpperCase()} tier)`
            : "";
          const itemLabel = purchaseType === "legend" ? "Legend" : "Custom Player";

          const draftEmbed = new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle(`🏈 ${itemLabel} Purchase — Draft Tracker`)
            .addFields(
              { name: "Player",    value: `<@${userId}>`, inline: true },
              { name: "Item",      value: `${purchase.playerName ?? "Unknown"}${tierLabel}`, inline: true },
              { name: "Purchase",  value: `#${purchaseId}`, inline: true },
            )
            .setTimestamp();

          const draftRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`draft_drafted:${purchaseId}`)
              .setLabel("✅ Drafted")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`draft_revoked:${purchaseId}`)
              .setLabel("❌ Revoked")
              .setStyle(ButtonStyle.Danger),
          );

          const draftMsg = await (draftChannel as any).send({ embeds: [draftEmbed], components: [draftRow] });
          await db.update(purchasesTable)
            .set({ draftTrackerMessageId: draftMsg.id })
            .where(eq(purchasesTable.id, purchaseId));
        }
      } catch (err) { console.error("Failed to post to draft tracker channel:", err); }

      // ── General channel announcement (legend only) ──────────────────────────
      if (purchaseType === "legend") {
        try {
          const generalChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.GENERAL);
          const generalChannel = generalChannelId ? await interaction.client.channels.fetch(generalChannelId).catch(() => null) : null;
          if (generalChannel?.isTextBased()) {
            const announceEmbed = new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle("🏆 Legend Purchased!")
              .setDescription(`<@${userId}> just acquired **${purchase.playerName ?? "a Legend"}** from the store!`)
              .setTimestamp();
            await (generalChannel as any).send({ embeds: [announceEmbed] });
          }
        } catch (err) { console.error("Failed to post legend announcement to general channel:", err); }
      }
    }
    return;
  }

  // ── Purchase: refund ─────────────────────────────────────────────────────────
  if (action === "refund_purchase") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];
    if (!purchase)                      { await interaction.followUp({ content: "❌ Purchase not found.", ephemeral: true }); return; }
    if (purchase.status === "refunded") { await interaction.followUp({ content: "⚠️ Already refunded.",  ephemeral: true }); return; }

    await db.update(purchasesTable).set({ status: "refunded" }).where(eq(purchasesTable.id, purchaseId));
    await addBalance(userId!, purchase.cost, interaction.guildId!);
    await logTransaction(userId!, purchase.cost, "purchase_refund",
      `Refund: ${purchase.purchaseType.replace(/_/g, " ")}${purchase.playerName ? ` — ${purchase.playerName}` : ""}`,
      interaction.guildId!, interaction.user.id);

    if (purchase.purchaseType === "attribute" && purchase.attributeName && purchase.seasonId) {
      const qtyMatch = purchase.notes?.match(/qty:(\d+)/);
      const attrQty  = qtyMatch ? parseInt(qtyMatch[1]!, 10) : 1;
      const isCore   = CORE_ATTRIBUTES.has(purchase.attributeName);
      if (isCore) {
        await db.update(seasonStatsTable)
          .set({ coreAttrPurchased: sql`GREATEST(0, ${seasonStatsTable.coreAttrPurchased} - ${attrQty})` })
          .where(and(eq(seasonStatsTable.discordId, userId!), eq(seasonStatsTable.seasonId, purchase.seasonId)));
      } else {
        await db.update(seasonStatsTable)
          .set({ nonCoreAttrPurchased: sql`GREATEST(0, ${seasonStatsTable.nonCoreAttrPurchased} - ${attrQty})` })
          .where(and(eq(seasonStatsTable.discordId, userId!), eq(seasonStatsTable.seasonId, purchase.seasonId)));
      }
    }

    if (purchaseType === "legend") {
      await db.update(usersTable)
        .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, userId!));
    }
    await db.delete(inventoryTable).where(and(eq(inventoryTable.purchaseId, purchaseId), eq(inventoryTable.discordId, userId!)));

    const refundedEmbed = new EmbedBuilder()
      .setColor(Colors.Red).setTitle("🔄 Purchase Refunded")
      .setDescription(`Purchase **#${purchaseId}** refunded. **${purchase.cost.toLocaleString()} coins** returned.\nRefunded by: ${interaction.user.toString()}`)
      .setTimestamp();
    await interaction.editReply({
      embeds: [refundedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("refunded_done").setLabel("🔄 Refunded").setStyle(ButtonStyle.Danger).setDisabled(true),
      )],
    });

    try {
      const user = await interaction.client.users.fetch(userId!);
      await user.send(`🔄 **Purchase #${purchaseId} Refunded**\n**${purchase.cost.toLocaleString()} coins** returned to your balance.`).catch(() => {});
    } catch (_) {}
    return;
  }

  // ── Draft tracker: drafted (remove message) ──────────────────────────────────
  if (action === "draft_drafted") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();
    try {
      await interaction.message.delete();
    } catch (err) { console.error("Failed to delete draft tracker message:", err); }
    return;
  }

  // ── Draft tracker: revoked (refund + remove message) ─────────────────────────
  if (action === "draft_revoked") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];
    if (!purchase) { await interaction.followUp({ content: "❌ Purchase not found.", ephemeral: true }); return; }
    if (purchase.status === "refunded") { await interaction.followUp({ content: "⚠️ Already refunded.", ephemeral: true }); return; }

    const buyerId = purchase.discordId;

    // Refund coins
    await db.update(purchasesTable).set({ status: "refunded" }).where(eq(purchasesTable.id, purchaseId));
    await addBalance(buyerId, purchase.cost, interaction.guildId!);
    await logTransaction(buyerId, purchase.cost, "purchase_refund",
      `Draft revoked: ${purchase.purchaseType.replace(/_/g, " ")}${purchase.playerName ? ` — ${purchase.playerName}` : ""}`,
      interaction.guildId!, interaction.user.id);

    if (purchase.purchaseType === "attribute" && purchase.attributeName && purchase.seasonId) {
      const qtyMatch = purchase.notes?.match(/qty:(\d+)/);
      const attrQty  = qtyMatch ? parseInt(qtyMatch[1]!, 10) : 1;
      const isCore   = CORE_ATTRIBUTES.has(purchase.attributeName);
      if (isCore) {
        await db.update(seasonStatsTable)
          .set({ coreAttrPurchased: sql`GREATEST(0, ${seasonStatsTable.coreAttrPurchased} - ${attrQty})` })
          .where(and(eq(seasonStatsTable.discordId, buyerId), eq(seasonStatsTable.seasonId, purchase.seasonId)));
      } else {
        await db.update(seasonStatsTable)
          .set({ nonCoreAttrPurchased: sql`GREATEST(0, ${seasonStatsTable.nonCoreAttrPurchased} - ${attrQty})` })
          .where(and(eq(seasonStatsTable.discordId, buyerId), eq(seasonStatsTable.seasonId, purchase.seasonId)));
      }
    }

    // Restore legend to store if applicable
    if (purchase.purchaseType === "legend" && purchase.legendId) {
      await db.update(legendsTable).set({ isAvailable: true }).where(eq(legendsTable.id, purchase.legendId));
      await db.update(usersTable)
        .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, buyerId));
    }

    // Remove from inventory
    await db.delete(inventoryTable).where(eq(inventoryTable.purchaseId, purchaseId));

    // DM the buyer
    try {
      const buyer = await interaction.client.users.fetch(buyerId);
      const itemLabel = purchase.playerName ?? purchase.purchaseType.replace(/_/g, " ");
      await buyer.send(
        `❌ **Your ${itemLabel} purchase (#${purchaseId}) has been revoked by the commissioner.**\n` +
        `**${purchase.cost.toLocaleString()} coins** have been returned to your balance.`
      ).catch(() => {});
    } catch (_) {}

    // Delete the draft tracker message
    try {
      await interaction.message.delete();
    } catch (err) { console.error("Failed to delete draft tracker message after revoke:", err); }
    return;
  }


  // ── Interview: approve ───────────────────────────────────────────────────────
  if (action === "interview_approve") {
    const interviewId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const rows = await db.select().from(interviewRequestsTable).where(eq(interviewRequestsTable.id, interviewId)).limit(1);
    const interview = rows[0];
    if (!interview) { await interaction.followUp({ content: "❌ Interview request not found.", ephemeral: true }); return; }
    if (interview.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This interview has already been **${interview.status}**.`, ephemeral: true });
      return;
    }

    const interviewPayout = await getPayoutValue(PAYOUT_KEYS.INTERVIEW_PAYOUT, interaction.guildId!);
    await addBalance(interview.discordId, interviewPayout, interaction.guildId!);
    await logTransaction(interview.discordId, interviewPayout, "addcoins", "Post-game interview payout", interaction.guildId!, interaction.user.id);
    await db.update(interviewRequestsTable)
      .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(interviewRequestsTable.id, interviewId));

    try {
      const u = await interaction.client.users.fetch(interview.discordId);
      await u.send(`🎙️ Your post-game interview was approved! **+${interviewPayout} coins** added to your balance.`).catch(() => {});
    } catch (_) {}

    const [ivUserRow] = await db.select({ team: usersTable.team })
      .from(usersTable).where(eq(usersTable.discordId, interview.discordId)).limit(1);

    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Interview Approved")
      .setDescription(
        `**Player:** <@${interview.discordId}>${ivUserRow?.team ? ` (${ivUserRow.team})` : ""}\n` +
        (interview.week ? `**Week:** ${interview.week}\n` : "") +
        `**Coins Awarded:** +${interviewPayout} coins\n\n` +
        `✅ Approved by ${interaction.user.toString()}`
      )
      .setFooter({ text: `Interview #${interviewId}` })
      .setTimestamp();
    await interaction.editReply({
      embeds: [approvedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("interview_done").setLabel("✅ Approved").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });

    try {
      const headlinesChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.HEADLINES);
      const headlinesChannel = headlinesChannelId ? await interaction.client.channels.fetch(headlinesChannelId).catch(() => null) : null;
      if (headlinesChannel?.isTextBased()) {
        const interviewUser = await db.select({ team: usersTable.team }).from(usersTable)
          .where(eq(usersTable.discordId, interview.discordId)).limit(1);
        const teamName = interviewUser[0]?.team ?? null;

        const interviewee = await interaction.client.users.fetch(interview.discordId).catch(() => null);

        const headlinesEmbed = new EmbedBuilder()
          .setColor(Colors.Blurple)
          .setTitle("🎙️ Post-Game Interview")
          .setDescription(
            `**<@${interview.discordId}>**${teamName ? ` — ${teamName}` : ""}\n` +
            `💰 **+${interviewPayout} coins** awarded.`
          )
          .addFields(
            {
              name: `❓ Q1: ${interview.question1 ?? ""}`,
              value: interview.answer1 ?? "*No answer provided*",
            },
            {
              name: `❓ Q2: ${interview.question2 ?? ""}`,
              value: interview.answer2 ?? "*No answer provided*",
            },
            {
              name: `❓ Q3: ${interview.question3 ?? ""}`,
              value: interview.answer3 ?? "*No answer provided*",
            },
          )
          .setFooter({ text: `Interview #${interviewId}${interview.week ? ` • ${interview.week}` : ""}` })
          .setTimestamp();

        if (interviewee) headlinesEmbed.setThumbnail(interviewee.displayAvatarURL());

        await (headlinesChannel as TextChannel).send({ content: "@everyone", embeds: [headlinesEmbed] });
      }
    } catch (err) {
      console.error("Failed to post interview approval to headlines channel:", err);
    }

    return;
  }

  // ── Interview: deny (open modal) ─────────────────────────────────────────────
  if (action === "interview_deny") {
    const interviewId = secondPart!;
    const modal = new ModalBuilder().setCustomId(`interview_modal:${interviewId}`).setTitle("Deny Interview Request");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Reason for denial")
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
        .setPlaceholder("Explain why this interview request is being denied..."),
    ));
    await interaction.showModal(modal).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal (deny) error:", err);
    });
    return;
  }

  // ── Wager: opponent accepts ───────────────────────────────────────────────
  if (action === "wager_accept") {
    const wagerId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const rows = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
    const wager = rows[0];
    if (!wager) { await interaction.followUp({ content: "❌ Wager not found.", ephemeral: true }); return; }
    if (wager.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This wager is no longer pending (status: **${wager.status}**).`, ephemeral: true });
      return;
    }
    if (interaction.user.id !== wager.opponentId) {
      await interaction.followUp({ content: "❌ Only the challenged player can accept this wager.", ephemeral: true });
      return;
    }

    // Verify both users still have sufficient funds — scoped to the wager's guild
    const wagerGuildId = wager.guildId ?? interaction.guildId!;
    const [challengerRow] = await db.select({ balance: usersTable.balance })
      .from(usersTable).where(and(eq(usersTable.discordId, wager.challengerId), eq(usersTable.guildId, wagerGuildId))).limit(1);
    const [opponentRow] = await db.select({ balance: usersTable.balance })
      .from(usersTable).where(and(eq(usersTable.discordId, wager.opponentId), eq(usersTable.guildId, wagerGuildId))).limit(1);

    const challengerBal = challengerRow?.balance ?? 0;
    const opponentBal   = opponentRow?.balance   ?? 0;

    if (challengerBal < wager.amount) {
      await db.update(wagersTable).set({ status: "cancelled" }).where(eq(wagersTable.id, wagerId));
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Wager Cancelled")
          .setDescription(`<@${wager.challengerId}> no longer has enough coins to cover this wager.\n**Wager #${wagerId}** has been cancelled.`)
          .setTimestamp()],
        components: [],
      });
      return;
    }
    if (opponentBal < wager.amount) {
      await interaction.followUp({
        content: `❌ You don't have enough coins. Balance: **${opponentBal.toLocaleString()}**, wager: **${wager.amount.toLocaleString()}**.`,
        ephemeral: true,
      });
      return;
    }

    // Deduct from both — coins go into holding (tracked by wager record)
    await addBalance(wager.challengerId, -wager.amount, wagerGuildId);
    await logTransaction(wager.challengerId, -wager.amount, "removecoins",
      `Wager #${wagerId} held: ${wager.teamFor} vs ${wager.teamAgainst}`, wagerGuildId, wager.opponentId);

    await addBalance(wager.opponentId, -wager.amount, wagerGuildId);
    await logTransaction(wager.opponentId, -wager.amount, "removecoins",
      `Wager #${wagerId} held: ${wager.teamAgainst} vs ${wager.teamFor}`, wagerGuildId, wager.challengerId);

    await db.update(wagersTable).set({ status: "active" }).where(eq(wagersTable.id, wagerId));

    // Resolve display names for embed field names (mentions don't render in field names)
    const challengerMember = await interaction.guild?.members.fetch(wager.challengerId).catch(() => null);
    const opponentMember   = await interaction.guild?.members.fetch(wager.opponentId).catch(() => null);
    const challengerName   = challengerMember?.displayName ?? wager.challengerUsername;
    const opponentName     = opponentMember?.displayName   ?? wager.opponentUsername;

    // Edit the challenge message to show active state
    const activeEmbed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("⚔️ Wager Active — Awaiting Result")
      .setDescription(`<@${wager.challengerId}> vs <@${wager.opponentId}>`)
      .addFields(
        { name: "💰 Pot",                           value: `**${wager.pot.toLocaleString()} coins** in holding` },
        { name: `🏈 ${challengerName} is taking`,  value: `**${wager.teamFor}**`,    inline: true },
        { name: `🏈 ${opponentName} is taking`,    value: `**${wager.teamAgainst}**`, inline: true },
        { name: "📋 Status",                       value: "🔒 Coins held — commissioner will declare the winner" },
      )
      .setFooter({ text: `Wager #${wagerId}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [activeEmbed], components: [] });

    // Post to commissioner channel with winner buttons
    const commChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER) ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
    // Derive home/away team names from wager fields
    const homeTeamLabel = wager.challengerSide === "home" ? wager.teamFor : wager.teamAgainst;
    const awayTeamLabel = wager.challengerSide === "away" ? wager.teamFor : wager.teamAgainst;
    const spreadInfo    = wager.spread !== null && wager.spread !== undefined
      ? `Challenger's spread: **${wager.spread > 0 ? "+" : ""}${wager.spread}** on ${wager.teamFor}`
      : "No spread set (straight win)";

    const commEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("⚔️ Wager — Confirm Result")
      .setDescription("Enter the **final score margin** (home score − away score) and the spread will be applied automatically to determine the winner.")
      .addFields(
        { name: "🏠 Home Team",                value: `**${homeTeamLabel}** — <@${wager.challengerSide === "home" ? wager.challengerId : wager.opponentId}>`, inline: true },
        { name: "✈️ Away Team",                value: `**${awayTeamLabel}** — <@${wager.challengerSide === "away" ? wager.challengerId : wager.opponentId}>`, inline: true },
        { name: "💰 Pot",                      value: `**${wager.pot.toLocaleString()} coins**`, inline: false },
        { name: "📊 Spread",                   value: spreadInfo, inline: false },
      )
      .setFooter({ text: `Wager #${wagerId} • Enter the margin via "Confirm Home Win" or "Confirm Away Win"` })
      .setTimestamp();

    const commRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`wager_confirm:home:${wagerId}`)
        .setLabel(`🏠 Confirm Home Win`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`wager_confirm:away:${wagerId}`)
        .setLabel(`✈️ Confirm Away Win`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`wager_rescind:${wagerId}`)
        .setLabel("↩️ Rescind")
        .setStyle(ButtonStyle.Danger),
    );

    try {
      const commChannel = await interaction.client.channels.fetch(commChannelId);
      if (commChannel?.isTextBased()) {
        const commMsg = await (commChannel as any).send({ embeds: [commEmbed], components: [commRow] });
        await db.update(wagersTable)
          .set({ commissionerMessageId: commMsg.id })
          .where(eq(wagersTable.id, wagerId));
      }
    } catch (err) { console.error("Failed to post wager to commissioner channel:", err); }

    // DM both players
    for (const [uid, myTeam, theirTeam] of [
      [wager.challengerId, wager.teamFor,    wager.teamAgainst],
      [wager.opponentId,   wager.teamAgainst, wager.teamFor],
    ] as [string, string, string][]) {
      try {
        const u = await interaction.client.users.fetch(uid);
        await u.send(
          `⚔️ **Wager #${wagerId} is now active!**\n` +
          `**${wager.amount.toLocaleString()} coins** have been held from your balance.\n` +
          `You are taking **${myTeam}** against **${theirTeam}**.\n` +
          `The commissioner will declare the winner once the game is played. The pot of **${wager.pot.toLocaleString()} coins** goes to the winner.`
        ).catch(() => {});
      } catch (_) {}
    }
    return;
  }

  // ── Wager: opponent refuses ───────────────────────────────────────────────
  if (action === "wager_refuse") {
    const wagerId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const rows = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
    const wager = rows[0];
    if (!wager) { await interaction.followUp({ content: "❌ Wager not found.", ephemeral: true }); return; }
    if (wager.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This wager is no longer pending (status: **${wager.status}**).`, ephemeral: true });
      return;
    }
    if (interaction.user.id !== wager.opponentId) {
      await interaction.followUp({ content: "❌ Only the challenged player can refuse this wager.", ephemeral: true });
      return;
    }

    await db.update(wagersTable)
      .set({ status: "refused", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(wagersTable.id, wagerId));

    const refusedEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("❌ Wager Refused")
      .setDescription(`<@${wager.opponentId}> refused the wager challenge from <@${wager.challengerId}>.`)
      .addFields(
        { name: `🏈 <@${wager.challengerId}> was taking`, value: `**${wager.teamFor}**`,    inline: true },
        { name: `🏈 <@${wager.opponentId}> was taking`,   value: `**${wager.teamAgainst}**`, inline: true },
      )
      .setFooter({ text: `Wager #${wagerId}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [refusedEmbed], components: [] });

    // DM the challenger
    try {
      const challenger = await interaction.client.users.fetch(wager.challengerId);
      await challenger.send(
        `❌ <@${wager.opponentId}> (**${wager.opponentUsername}**) refused your wager challenge.\n` +
        `Wager #${wagerId} (${wager.teamFor} vs ${wager.teamAgainst}) — no coins were deducted.`
      ).catch(() => {});
    } catch (_) {}
    return;
  }

  // ── Wager: commissioner opens margin modal (Confirm Home/Away Win) ────────
  if (action === "wager_confirm") {
    // customId format: wager_confirm:<home|away>:<wagerId>
    const winningSide = secondPart as "home" | "away";  // "home" or "away"
    const wagerId     = parseInt(parts[2] ?? "0", 10);

    if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
      await interaction.reply({ content: "❌ Only commissioners can confirm wager results.", ephemeral: true });
      return;
    }

    const [wager] = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
    if (!wager) { await interaction.reply({ content: "❌ Wager not found.", ephemeral: true }); return; }
    if (wager.status !== "active") {
      await interaction.reply({ content: `⚠️ This wager is not active (status: **${wager.status}**).`, ephemeral: true });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`wager_margin:${winningSide}:${wagerId}`)
      .setTitle(`Enter Final Score`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("home_score")
            .setLabel("Home Team Score")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. 28")
            .setRequired(true)
            .setMaxLength(3),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("away_score")
            .setLabel("Away Team Score")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. 21")
            .setRequired(true)
            .setMaxLength(3),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Wager: commissioner rescinds (refunds both sides) ─────────────────────
  if (action === "wager_rescind") {
    const wagerId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
      await interaction.followUp({ content: "❌ Only commissioners can rescind wagers.", ephemeral: true });
      return;
    }

    const [wager] = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
    if (!wager) { await interaction.followUp({ content: "❌ Wager not found.", ephemeral: true }); return; }
    if (wager.status !== "active") {
      await interaction.followUp({ content: `⚠️ This wager is not active (status: **${wager.status}**).`, ephemeral: true });
      return;
    }

    const wagerGuildId = wager.guildId ?? interaction.guildId!;
    await addBalance(wager.challengerId, wager.amount, wagerGuildId);
    await logTransaction(wager.challengerId, wager.amount, "addcoins", `Wager #${wagerId} rescinded — refund`, wagerGuildId, interaction.user.id);
    await addBalance(wager.opponentId, wager.amount, wagerGuildId);
    await logTransaction(wager.opponentId, wager.amount, "addcoins", `Wager #${wagerId} rescinded — refund`, wagerGuildId, interaction.user.id);

    await db.update(wagersTable).set({ status: "rescinded", resolvedAt: new Date(), resolvedBy: interaction.user.id }).where(eq(wagersTable.id, wagerId));

    const embed = new EmbedBuilder()
      .setColor(Colors.Grey)
      .setTitle("↩️ Wager Rescinded")
      .setDescription(`Wager #${wagerId} has been rescinded by <@${interaction.user.id}>.\nBoth players have been refunded **${wager.amount.toLocaleString()} coins**.`)
      .setTimestamp();
    await interaction.editReply({ embeds: [embed], components: [] });

    for (const uid of [wager.challengerId, wager.opponentId]) {
      try {
        const u = await interaction.client.users.fetch(uid);
        await u.send(`↩️ **Wager #${wagerId} has been rescinded** by a commissioner. Your **${wager.amount.toLocaleString()} coins** have been refunded.`).catch(() => {});
      } catch (_) {}
    }
    return;
  }


  // ── Interview: open answer modal (player-facing) ──────────────────────────
  // Format: interview_answer:{targetUserId}:{i1,i2,i3}:{type}
  if (action === "interview_answer") {
    const targetUserId = secondPart!;          // parts[1]
    const indicesStr   = parts[2]!;            // parts[2] = "i1,i2,i3"
    const iType        = (parts[3] ?? "postgame") as InterviewType;

    if (interaction.user.id !== targetUserId) {
      await interaction.reply({ content: "❌ This interview form isn't yours to fill out.", ephemeral: true });
      return;
    }

    const pool    = getQuestionPool(iType);
    const indices = indicesStr.split(",").map(Number);
    const q1 = (pool[indices[0]!] ?? INTERVIEW_QUESTIONS[indices[0]!])!;
    const q2 = (pool[indices[1]!] ?? INTERVIEW_QUESTIONS[indices[1]!])!;
    const q3 = (pool[indices[2]!] ?? INTERVIEW_QUESTIONS[indices[2]!])!;

    const truncLabel = (q: string) => q.length <= 45 ? q : q.slice(0, 42) + "...";
    const title      = interviewTypeLabel(iType);

    const modal = new ModalBuilder()
      .setCustomId(`interview_answer_modal:${indicesStr}:${iType}`)
      .setTitle(`🎙️ ${title}`);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("a1")
          .setLabel(truncLabel(q1))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(1000)
          .setPlaceholder("Type your answer here..."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("a2")
          .setLabel(truncLabel(q2))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(1000)
          .setPlaceholder("Type your answer here..."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("a3")
          .setLabel(truncLabel(q3))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(1000)
          .setPlaceholder("Type your answer here..."),
      ),
    );

    await interaction.showModal(modal).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal error:", err);
    });
    return;
  }

  // ── GOTW: admin confirms recommended game ─────────────────────────────────────
  if (action === "gotw_confirm") {
    // customId: gotw_confirm:{seasonId}:{weekIndex}:{awayDiscordId}:{homeDiscordId}
    const [, rawSeasonId, rawWeekIndex, awayDiscordId, homeDiscordId] = interaction.customId.split(":");
    const seasonId  = parseInt(rawSeasonId  ?? "0", 10);
    const weekIndex = parseInt(rawWeekIndex ?? "0", 10);
    const weekNum   = weekIndex + 1;

    await interaction.deferUpdate();

    // Look up team names for both Discord IDs — always scoped to THIS guild
    const [awayUser] = await db.select({ team: usersTable.team })
      .from(usersTable).where(and(eq(usersTable.discordId, awayDiscordId!), eq(usersTable.guildId, interaction.guildId!))).limit(1);
    const [homeUser] = await db.select({ team: usersTable.team })
      .from(usersTable).where(and(eq(usersTable.discordId, homeDiscordId!), eq(usersTable.guildId, interaction.guildId!))).limit(1);

    const awayTeam = awayUser?.team ?? awayDiscordId ?? "Away Team";
    const homeTeam = homeUser?.team ?? homeDiscordId ?? "Home Team";

    const result = await postGotwToChannel(
      interaction.client, seasonId, weekIndex, weekNum,
      awayTeam, homeTeam, awayDiscordId!, homeDiscordId!, 0,
      interaction.guildId!,
    );

    const gotwChanId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.GOTW);
    if (result) {
      await interaction.editReply({
        content: gotwChanId
          ? `✅ GOTW posted to <#${gotwChanId}>!\n**${awayTeam} vs ${homeTeam}**`
          : `✅ GOTW posted!\n**${awayTeam} vs ${homeTeam}**`,
        components: [],
      });
    } else {
      await interaction.editReply({
        content: gotwChanId
          ? `❌ Failed to post GOTW. Check that the bot has access to <#${gotwChanId}>.`
          : `❌ Failed to post GOTW.`,
        components: [],
      });
    }
    return;
  }

  // ── GOTW: admin wants to pick a different game ────────────────────────────────
  if (action === "gotw_decline") {
    // customId: gotw_decline:{seasonId}:{weekIndex}
    const [, rawSeasonId, rawWeekIndex] = interaction.customId.split(":");
    const seasonId  = parseInt(rawSeasonId  ?? "0", 10);
    const weekIndex = parseInt(rawWeekIndex ?? "0", 10);

    await interaction.deferUpdate();

    // Re-fetch the season and games
    const [season] = await db.select()
      .from(seasonsTable)
      .where(eq(seasonsTable.id, seasonId))
      .limit(1);

    const games = season
      ? await db.select()
          .from(franchiseScheduleTable)
          .where(and(
            eq(franchiseScheduleTable.seasonId,  seasonId),
            eq(franchiseScheduleTable.weekIndex, weekIndex),
          ))
      : [];

    // Build team → Discord ID map using full MCA names (same logic as /weeklymatchups)
    const teamToDiscord = await buildTeamToDiscord(interaction.guildId ?? undefined);

    const scored = await scoreH2HMatchups(seasonId, weekIndex, games, teamToDiscord);

    if (scored.length === 0) {
      await interaction.editReply({
        content: "❌ No H2H matchups available to select from.",
        components: [],
      });
      return;
    }

    // Build select menu — one option per H2H game
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`gotw_select:${seasonId}:${weekIndex}`)
      .setPlaceholder("Select the Game of the Week…")
      .addOptions(
        scored.map(g => {
          const cooldownTag = g.eligible ? "" : " ⚠️ (cooldown)";
          return new StringSelectMenuOptionBuilder()
            .setLabel(`${g.awayTeamName} vs ${g.homeTeamName}${cooldownTag}`.slice(0, 100))
            .setValue(`${g.awayDiscordId}:${g.homeDiscordId}`)
            .setDescription(`${g.awayTeamName} vs ${g.homeTeamName}`.slice(0, 100));
        })
      );

    const menuRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    await interaction.editReply({
      content: "Select the game you'd like to name as GOTW:",
      components: [menuRow],
    });
    return;
  }

  // ── /initialize-server follow-up buttons ─────────────────────────────────────
  if (action === "init_settings") {
    await interaction.deferUpdate();
    const settings = await getServerSettings(interaction.guildId!);
    await interaction.followUp({
      ephemeral: true,
      content: "**⚙️ Server Feature Settings** — toggle any feature on or off:",
      embeds:     [buildSettingsEmbed(settings)],
      components: buildSettingsRows(settings),
    });
    return;
  }

  if (action === "init_teamguide") {
    await interaction.deferUpdate();
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("👥 Team Linking Guide")
      .setDescription(
        "Link each Discord member to their NFL franchise. Repeat for every manager in your league.\n\n" +
        "**Step 1 — Assign a team:**\n" +
        "```/admin-linkteam set  user:@Member  team:Dallas Cowboys```\n" +
        "Start typing the team name to autocomplete it.\n\n" +
        "**Step 2 — Verify all assignments:**\n" +
        "```/admin-linkteam view```\n" +
        "Shows all linked managers and flags anyone still unlinked.\n\n" +
        "**Step 3 — After importing EA data:**\n" +
        "```/admin-linkteam relink```\n" +
        "Re-cascades Discord IDs to roster rows — run this after each new MCA/EA import to make sure rosters and stats are attributed correctly.\n\n" +
        "**Notes:**\n" +
        "• CPU-controlled teams don't need a Discord link\n" +
        "• Reassigning a team preserves the user's coin balance and records\n" +
        "• If a manager leaves, use `/admin-clearteam` to free their slot",
      )
      .setFooter({ text: "Team Linking Guide • /initialize-server setup" });
    await interaction.followUp({ ephemeral: true, embeds: [embed] });
    return;
  }

  if (action === "init_ea") {
    await interaction.deferUpdate();
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("🔗 Connect to EA — Franchise Data Import")
      .setDescription(
        "Choose one of two methods to feed your franchise data into the bot:\n\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "**Option A — EA Direct Connect (Recommended)**\n" +
        "Automatically pulls rosters, schedules, and stats directly from EA with no MCA needed.\n\n" +
        "**Step 1:** Get the EA login link:\n" +
        "```/admin_ea_connect start```\n" +
        "**Step 2:** Log in with the Commissioner's EA account. Copy the redirect URL from your browser.\n\n" +
        "**Step 3:** Paste it back:\n" +
        "```/admin_ea_connect code  redirect_url:<paste URL>```\n" +
        "**Step 4:** If multiple leagues appear, pick yours:\n" +
        "```/admin_ea_connect connect  league_id:<id>```\n" +
        "**Step 5:** Pull data any time:\n" +
        "```/admin_ea_export```\n\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "**Option B — MCA Webhook (Manual)**\n" +
        "Use Madden Companion App → export your franchise data to a webhook URL.\n\n" +
        "**Step 1:** Get your webhook URL:\n" +
        "```/webhookurl```\n" +
        "**Step 2:** In MCA, paste the URL and export league data after each week.",
      )
      .setFooter({ text: "EA Connect Guide • /initialize-server setup" });
    await interaction.followUp({ ephemeral: true, embeds: [embed] });
    return;
  }

  if (action === "init_payouts") {
    await interaction.deferUpdate();
    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("💰 Payout Configuration Guide")
      .setDescription(
        "Configure how coins are awarded at the end of each season.\n\n" +
        "**Set EOS payout amounts:**\n" +
        "```/admin-payout```\n" +
        "Set values for: Champion, Runner-up, 3rd place, Playoff appearance, Regular season wins, etc.\n\n" +
        "**Set stat-based XP tiers:**\n" +
        "```/admin-set-stat-tiers```\n" +
        "Define thresholds for QB/HB/WR/TE/DEF stats that earn bonus coins each week.\n\n" +
        "**Preview what EOS payouts would look like right now:**\n" +
        "```/admin-eos-testrun```\n" +
        "Dry-run the payout calculation — nothing is actually paid out.\n\n" +
        "**Run EOS payouts at season end:**\n" +
        "```/endofseasonpayout```\n" +
        "Distributes all coins based on standings, stats, and milestone tiers.\n\n" +
        "**View current payout tier settings:**\n" +
        "```/view-payout-tiers```",
      )
      .setFooter({ text: "Payout Guide • /initialize-server setup" });
    await interaction.followUp({ ephemeral: true, embeds: [embed] });
    return;
  }

  if (action === "init_post_help") {
    await interaction.deferUpdate();
    try {
      const settings = await getServerSettings(interaction.guildId!).catch(() => null);

      // Find #help-and-faqs by name in the guild
      await interaction.guild?.channels.fetch().catch(() => null);
      let faqChannel = interaction.guild?.channels.cache.find(c => c.name === "help-and-faqs") ?? null;

      if (!faqChannel?.isTextBased()) {
        await interaction.followUp({
          ephemeral: true,
          content: "❌ Could not find the **#help-and-faqs** channel. Make sure it exists on this server.",
        });
        return;
      }

      const { AttachmentBuilder } = await import("discord.js");
      const tc = faqChannel as TextChannel;
      const path = await import("path");
      const { fileURLToPath } = await import("url");
      // Resolve relative to this source file so it works regardless of cwd
      // (dev cwd is repo root; prod cwd is artifacts/discord-bot).
      const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");

      const faqSeason = await getOrCreateActiveSeason(interaction.guildId!).catch(() => null);
      const faqRules  = faqSeason ? await getSeasonRules(faqSeason).catch(() => null) : null;
      const helpMsg = await tc.send({ embeds: [buildMemberHelpEmbed(settings, faqRules)] });
      await helpMsg.pin().catch(() => null);

      const clipGuides: Array<{ caption: string; file: string }> = [
        { caption: "📱 **How to Share Madden Clips — PlayStation (PS5)**", file: "clips-ps5.png"     },
        { caption: "🎮 **How to Share Madden Clips — Xbox**",              file: "clips-xbox.png"    },
        { caption: "🎬 **How to Clip — Twitch**",                          file: "clips-twitch.png"  },
        { caption: "💻 **How to Clip — Discord**",                         file: "clips-discord.png" },
      ];
      let clipsPosted = 0;
      for (const guide of clipGuides) {
        try {
          const attachment = new AttachmentBuilder(path.join(ASSETS_DIR, guide.file), { name: guide.file });
          const msg = await tc.send({ content: guide.caption, files: [attachment] });
          await msg.pin().catch(() => null);
          clipsPosted++;
        } catch { /* skip missing asset */ }
      }

      await interaction.followUp({
        ephemeral: true,
        content: `✅ Help guide posted and pinned in <#${tc.id}> (${clipsPosted} clip guides included).`,
      });
    } catch (err) {
      await interaction.followUp({
        ephemeral: true,
        content: `❌ Failed to post help guide: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }

  // ── Waitlist: accept / deny from DM ──────────────────────────────────────────
  if (interaction.customId.startsWith(WAITLIST_ACCEPT_PREFIX) || interaction.customId.startsWith(WAITLIST_DENY_PREFIX)) {
    const isAccept = interaction.customId.startsWith(WAITLIST_ACCEPT_PREFIX);
    const targetGuildId = interaction.customId.slice(
      isAccept ? WAITLIST_ACCEPT_PREFIX.length : WAITLIST_DENY_PREFIX.length,
    );

    await interaction.deferUpdate().catch(() => {});

    const userId = interaction.user.id;

    // Remove the user from the waitlist regardless of choice
    await db
      .delete(waitlistTable)
      .where(and(eq(waitlistTable.guildId, targetGuildId), eq(waitlistTable.discordId, userId)));

    if (isAccept) {
      // Post in #welcome of the target guild tagging comms
      try {
        const guild       = interaction.client.guilds.cache.get(targetGuildId)
                          ?? await interaction.client.guilds.fetch(targetGuildId).catch(() => null);
        const welcomeId   = guild ? await getGuildChannel(targetGuildId, CHANNEL_KEYS.WELCOME).catch(() => null) : null;
        const welcomeCh   = (welcomeId && guild)
                          ? guild.channels.cache.get(welcomeId) ?? await interaction.client.channels.fetch(welcomeId).catch(() => null)
                          : null;

        if (welcomeCh?.isTextBased()) {
          const commRole   = guild?.roles.cache.find(r => r.name === "Commissioner");
          const coCommRole = guild?.roles.cache.find(r => r.name === "Co-Commissioner");
          const rolePing   = [commRole, coCommRole].filter(Boolean).map(r => `<@&${r!.id}>`).join(" ");
          await (welcomeCh as TextChannel).send({
            content: [
              `📣 ${rolePing ? `${rolePing} ` : ""}**<@${userId}> has accepted their waitlist invite and is ready to be assigned a team!**`,
              "Please assign them a team using `/admin-linkteam set`.",
            ].join("\n"),
          });
        }
      } catch (err) {
        console.error("[waitlist accept] Failed to post in welcome channel:", err);
      }

      await interaction.editReply({
        content: "✅ **You've accepted the invite!** A commissioner will reach out shortly to assign your team. Welcome to the R.E.C. League!",
        components: [],
      }).catch(() => {});
    } else {
      await interaction.editReply({
        content: "You've declined the invite and have been removed from the waitlist. If you change your mind, ask a commissioner to re-add you.",
        components: [],
      }).catch(() => {});
    }
    return;
  }

  // ── Server settings: toggle feature flag ─────────────────────────────────────
  if (action === "settings_toggle") {
    const featureKey = secondPart as keyof typeof FEATURE_LABELS | undefined;
    if (!featureKey) { await interaction.reply({ content: "❌ Unknown feature key.", ephemeral: true }); return; }

    await interaction.deferUpdate();
    const updated = await toggleFeature(featureKey as any, interaction.guildId!);
    const label   = FEATURE_LABELS[featureKey as keyof typeof FEATURE_LABELS] ?? featureKey;
    const state   = (updated as any)[featureKey] ? "✅ Enabled" : "❌ Disabled";

    await interaction.editReply({
      embeds:     [buildSettingsEmbed(updated)],
      components: buildSettingsRows(updated),
    });
    await interaction.followUp({
      content: `**${label}** toggled → ${state}\n⏳ Updating slash commands for this server…`,
      ephemeral: true,
    });

    // Re-register commands for this guild so the command list reflects the new settings
    if (interaction.guildId) {
      registerCommandsForGuild(interaction.guildId).catch(err =>
        console.error("[settings_toggle] Failed to re-register commands:", err),
      );
    }
    return;
  }

  // ── Server settings: done ─────────────────────────────────────────────────────
  if (action === "settings_done") {
    await interaction.update({ components: [] });
    return;
  }

  // ── Admin: seed default stat tiers for a season ───────────────────────────────
  if (action === "seed_stat_defaults") {
    const seasonId = parseInt(secondPart ?? "0", 10);
    if (!seasonId) { await interaction.reply({ content: "❌ Invalid season ID.", ephemeral: true }); return; }

    const adminCheck = await isAdminUser(interaction.user.id, interaction.guildId!).catch(() => false);
    if (!adminCheck) {
      await interaction.reply({ content: "❌ Only admins can seed stat tier defaults.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    // Load existing tiers so we don't overwrite customized values
    const existing = await db.select()
      .from(seasonStatTierConfigsTable)
      .where(eq(seasonStatTierConfigsTable.seasonId, seasonId));

    const existingKeys = new Set(existing.map(r => `${r.statCategory}:${r.tier}`));

    const toInsert: { seasonId: number; statCategory: string; tier: number; threshold: number; payout: number; updatedAt: Date }[] = [];

    for (const cat of STAT_CATEGORIES) {
      const defaults = STAT_TIER_DEFAULTS[cat.key];
      if (!defaults) continue;
      defaults.forEach((d, i) => {
        const tier = i + 1;
        const key = `${cat.key}:${tier}`;
        if (!existingKeys.has(key)) {
          toInsert.push({ seasonId, statCategory: cat.key, tier, threshold: d.threshold, payout: d.payout, updatedAt: new Date() });
        }
      });
    }

    if (toInsert.length === 0) {
      await interaction.editReply({ content: "✅ All tiers are already configured — nothing to seed." });
      return;
    }

    await db.insert(seasonStatTierConfigsTable).values(toInsert).onConflictDoNothing();

    const seededCategories = [...new Set(toInsert.map(r => r.statCategory))];
    const catLabels = seededCategories.map(key => {
      const cat = STAT_CATEGORIES.find(c => c.key === key);
      return cat ? `• **${cat.label}**` : `• ${key}`;
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🌱 Default Stat Tiers Seeded")
          .setColor(Colors.Green)
          .setDescription(
            `Seeded **${toInsert.length} missing tiers** across **${seededCategories.length} categories** for Season ${seasonId}:\n\n` +
            catLabels.join("\n"),
          )
          .setFooter({ text: "Existing custom tiers were not overwritten. Use /admin-set-stat-tier to adjust individual tiers." })
          .setTimestamp(),
      ],
    });
    return;
  }

  // ── EOS payout: commissioner approves ────────────────────────────────────────
  if (action === "eos_approve") {
    const payoutId  = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const [payout] = await db.select().from(pendingEosPayoutsTable)
      .where(eq(pendingEosPayoutsTable.id, payoutId)).limit(1);

    if (!payout) { await interaction.followUp({ content: "❌ Payout not found.", ephemeral: true }); return; }
    if (payout.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This payout has already been **${payout.status}**.`, ephemeral: true });
      return;
    }

    // Always use payout.discordId from the DB — authoritative source of truth
    // regardless of what Discord ID was embedded in the button customId.
    const discordId = payout.discordId;

    await addBalance(discordId, payout.totalCoins, interaction.guildId!);
    await logTransaction(discordId, payout.totalCoins, "addcoins",
      `EOS Season ${payout.seasonId} payout — approved by ${interaction.user.username}`,
      interaction.guildId!, interaction.user.id);
    await db.update(pendingEosPayoutsTable)
      .set({ status: "approved", approvedBy: interaction.user.id, approvedAt: new Date() })
      .where(eq(pendingEosPayoutsTable.id, payoutId));

    type BreakdownItem = { label: string; statValue: number; unit: string; tier: number; coins: number };
    const breakdown = (payout.statBreakdown ?? []) as BreakdownItem[];
    const breakdownLines = breakdown.length > 0
      ? breakdown.map(b => `• **${b.label}**: Tier ${b.tier} (+${b.coins.toLocaleString()} coins)`).join("\n")
      : "*No qualifying stat tiers recorded.*";
    const teamLabel = payout.teamName ? ` (${payout.teamName})` : "";

    // ── Update commissioner embed to "Approved" ────────────────────────────────
    const eosApprovedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ EOS Payout Approved")
      .setDescription(
        `**Team:** <@${discordId}>${teamLabel}\n` +
        `**Season:** ${payout.seasonId}\n\n` +
        `**Stat Breakdown:**\n${breakdownLines}\n\n` +
        `**Total Awarded:** ${payout.totalCoins.toLocaleString()} coins\n\n` +
        `✅ Approved by ${interaction.user.toString()}`,
      )
      .setFooter({ text: `EOS Payout #${payoutId} • Season ${payout.seasonId}` })
      .setTimestamp();
    await interaction.editReply({
      embeds:     [eosApprovedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("eos_approved_done").setLabel("✅ Approved").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });

    // ── Post to public payouts channel ─────────────────────────────────────────
    const PAYOUTS_CHANNEL_ID = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.PAYOUTS);
    try {
      const payoutsCh = PAYOUTS_CHANNEL_ID
        ? await interaction.client.channels.fetch(PAYOUTS_CHANNEL_ID)
        : null;
      if (payoutsCh?.isTextBased()) {
        const publicEmbed = new EmbedBuilder()
          .setColor(Colors.Gold)
          .setTitle("🏆 End-of-Season Payout")
          .setDescription(
            `<@${discordId}>${teamLabel}\n\n` +
            `${breakdownLines}\n\n` +
            `**Total Earned: +${payout.totalCoins.toLocaleString()} 🪙**`,
          )
          .setFooter({ text: `Season ${payout.seasonId} • EOS Payout` })
          .setTimestamp();
        await (payoutsCh as TextChannel).send({ embeds: [publicEmbed] });
      }
    } catch (err) {
      console.error("[eos_approve] Failed to post to payouts channel:", err);
    }

    // ── DM the recipient with their full breakdown ──────────────────────────────
    try {
      const u = await interaction.client.users.fetch(discordId);
      const dmEmbed = new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🏆 End-of-Season Payout — Approved!")
        .setDescription(
          `Your Season ${payout.seasonId} payout has been approved!\n\n` +
          `**Stat Breakdown:**\n${breakdownLines}\n\n` +
          `**Total Added to Balance: +${payout.totalCoins.toLocaleString()} 🪙**`,
        )
        .setFooter({ text: "Coins have been added to your balance" })
        .setTimestamp();
      await u.send({ embeds: [dmEmbed] }).catch(() => {});
    } catch (_) {}
    return;
  }

  // ── EOS payout: commissioner edits amount ────────────────────────────────────
  if (action === "eos_edit") {
    const payoutId = secondPart!;
    const modal = new ModalBuilder()
      .setCustomId(`eos_edit_modal:${payoutId}`)
      .setTitle("Edit EOS Payout Amount");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("new_amount")
          .setLabel("New coin amount to award")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 500"),
      ),
    );
    await interaction.showModal(modal).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal (eos_edit) error:", err);
    });
    return;
  }

  // ── EOS payout: commissioner rejects / deletes a pending payout ─────────────
  if (action === "eos_reject") {
    const payoutId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const [payout] = await db.select().from(pendingEosPayoutsTable)
      .where(eq(pendingEosPayoutsTable.id, payoutId)).limit(1);

    if (!payout) { await interaction.followUp({ content: "❌ Payout not found.", ephemeral: true }); return; }
    if (payout.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This payout has already been **${payout.status}** and can't be rejected.`, ephemeral: true });
      return;
    }

    await db.update(pendingEosPayoutsTable)
      .set({ status: "rejected", approvedBy: interaction.user.id, approvedAt: new Date() })
      .where(eq(pendingEosPayoutsTable.id, payoutId));

    const teamLabel = payout.teamName ? ` (${payout.teamName})` : "";
    const rejectedEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("🗑️ EOS Payout Rejected")
      .setDescription(
        `**Team:** <@${payout.discordId}>${teamLabel}\n` +
        `**Season:** ${payout.seasonId}\n\n` +
        `❌ Rejected by ${interaction.user.toString()} — no coins awarded.`,
      )
      .setFooter({ text: `EOS Payout #${payoutId} • Season ${payout.seasonId}` })
      .setTimestamp();

    await interaction.editReply({
      embeds:     [rejectedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("eos_rejected_done").setLabel("🗑️ Rejected").setStyle(ButtonStyle.Danger).setDisabled(true),
      )],
    });
    return;
  }

  // ── Violation: confirm ──────────────────────────────────────────────────────
  if (action === "violation_confirm") {
    const violationId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
      await interaction.followUp({ content: "❌ Only commissioners can confirm violations.", ephemeral: true });
      return;
    }

    const [violation] = await db
      .select()
      .from(statPaddingViolationsTable)
      .where(eq(statPaddingViolationsTable.id, violationId))
      .limit(1);

    if (!violation) {
      await interaction.followUp({ content: `❌ Violation #${violationId} not found.`, ephemeral: true });
      return;
    }
    if (violation.status !== "pending") {
      await interaction.followUp({ content: `⚠️ Violation #${violationId} is already **${violation.status}**.`, ephemeral: true });
      return;
    }

    // Mark confirmed
    await db
      .update(statPaddingViolationsTable)
      .set({ status: "confirmed", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(statPaddingViolationsTable.id, violationId));

    // ── Post to the violation log channel ──────────────────────────────────────
    const violationLogEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("🚨 Violation Confirmed")
      .setDescription(
        violation.description +
        (violation.discordId ? `\n\n**Owner:** <@${violation.discordId}>` : "") +
        `\n\n✅ Confirmed by ${interaction.user.toString()}`,
      )
      .setFooter({ text: `Violation #${violationId} · ${violation.week} · Season ${violation.seasonId}` })
      .setTimestamp();

    try {
      const violationLogChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.VIOLATION_LOG);
      const vlChannel = violationLogChannelId ? await interaction.client.channels.fetch(violationLogChannelId).catch(() => null) : null;
      if (vlChannel?.isTextBased()) {
        await (vlChannel as TextChannel).send({ embeds: [violationLogEmbed] });
      }
    } catch (err) {
      console.error("[violation_confirm] Failed to post to violation log:", err);
    }

    // ── Edit the commissioner message to show confirmed state ──────────────────
    const confirmedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Violation Confirmed")
      .setDescription(
        violation.description +
        (violation.discordId ? `\n\n**Owner:** <@${violation.discordId}>` : "") +
        `\n\n✅ Confirmed by ${interaction.user.toString()}\n📋 Posted to violation log`,
      )
      .setFooter({ text: `Violation #${violationId} · ${violation.week} · Season ${violation.seasonId}` })
      .setTimestamp();

    await interaction.editReply({
      embeds: [confirmedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("violation_confirmed_done").setLabel("✅ Confirmed").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });

    // ── Check for repeat violations (2 confirmed = penalty notification) ───────
    if (violation.discordId) {
      const [{ value: confirmedCount }] = await db
        .select({ value: count() })
        .from(statPaddingViolationsTable)
        .where(
          and(
            eq(statPaddingViolationsTable.discordId, violation.discordId),
            eq(statPaddingViolationsTable.seasonId, violation.seasonId),
            eq(statPaddingViolationsTable.status, "confirmed"),
          ),
        );

      if (confirmedCount >= 2) {
        const [userRow] = await db.select({ team: usersTable.team }).from(usersTable)
          .where(eq(usersTable.discordId, violation.discordId)).limit(1);

        const penaltyLines = [
          `⚠️ **<@${violation.discordId}>${userRow?.team ? ` (${userRow.team})` : ""}** now has **${confirmedCount} confirmed violation(s)** this season.`,
          ``,
          `📋 **Action required:** Reduce the following player's OVR by **-15**:`,
        ];
        if (violation.playerName) {
          penaltyLines.push(`> **${violation.playerName}** (${violation.teamName})`);
        } else {
          penaltyLines.push(`> Determine the player to penalize based on the violations above.`);
        }
        penaltyLines.push(
          ``,
          `Use the game settings or \`/admin\` tools to apply the OVR reduction.`,
        );

        const repeatViolCommChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER) ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"];
        const commChannel = repeatViolCommChannelId ? await interaction.client.channels.fetch(repeatViolCommChannelId).catch(() => null) : null;

        if (commChannel?.isTextBased()) {
          const penaltyEmbed = new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle("⚠️ Repeat Violation — OVR Penalty Required")
            .setDescription(penaltyLines.join("\n"))
            .setFooter({ text: `Triggered by Violation #${violationId} · Season ${violation.seasonId}` })
            .setTimestamp();
          await (commChannel as TextChannel).send({ embeds: [penaltyEmbed] });
        }
      }
    }

    return;
  }

  // ── Violation: deny ─────────────────────────────────────────────────────────
  if (action === "violation_deny") {
    const violationId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
      await interaction.followUp({ content: "❌ Only commissioners can deny violations.", ephemeral: true });
      return;
    }

    const [violation] = await db
      .select()
      .from(statPaddingViolationsTable)
      .where(eq(statPaddingViolationsTable.id, violationId))
      .limit(1);

    if (!violation) {
      await interaction.followUp({ content: `❌ Violation #${violationId} not found.`, ephemeral: true });
      return;
    }
    if (violation.status !== "pending") {
      await interaction.followUp({ content: `⚠️ Violation #${violationId} is already **${violation.status}**.`, ephemeral: true });
      return;
    }

    await db
      .update(statPaddingViolationsTable)
      .set({ status: "denied", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(statPaddingViolationsTable.id, violationId));

    const deniedEmbed = new EmbedBuilder()
      .setColor(Colors.Grey)
      .setTitle("❌ Violation Denied")
      .setDescription(
        violation.description +
        (violation.discordId ? `\n\n**Owner:** <@${violation.discordId}>` : "") +
        `\n\n❌ Denied by ${interaction.user.toString()} — no action taken`,
      )
      .setFooter({ text: `Violation #${violationId} · ${violation.week} · Season ${violation.seasonId}` })
      .setTimestamp();

    await interaction.editReply({
      embeds: [deniedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("violation_denied_done").setLabel("❌ Denied").setStyle(ButtonStyle.Danger).setDisabled(true),
      )],
    });

    return;
  }

  // ── Admin-Payout Hub ──────────────────────────────────────────────────────────
  if (action === "ap_cancel")             { await apHandleCancel(interaction);    return; }
  if (action === "ap_gotw")              { await handleGotw(interaction);         return; }
  if (action === "ap_gotw_finalize")     { await handleGotwFinalize(interaction); return; }
  if (action === "ap_potw")              { await handlePotw(interaction);         return; }
  if (action === "ap_potw_back")         { await handlePotwBack(interaction);      return; }
  if (action === "ap_potw_finalize")     { await handlePotwFinalize(interaction);  return; }
  if (action === "ap_close")             { await handleClose(interaction);         return; }
  if (action === "ap_addcoins")          { await handleAddCoins(interaction);     return; }
  if (action === "ap_addcoins_next")     { await handleAddCoinsNext(interaction); return; }
  if (action === "ap_removecoins")       { await handleRemoveCoins(interaction);  return; }
  if (action === "ap_removecoins_next")  { await handleRemoveCoinsNext(interaction); return; }
  if (action === "ap_transfer")          { await handleTransfer(interaction);     return; }
  if (action === "ap_transfer_next")     { await handleTransferNext(interaction); return; }
  if (action === "ap_game")              { await handleGame(interaction);         return; }
  if (action === "ap_game_winner_home")  { await handleGameWinnerHome(interaction); return; }
  if (action === "ap_game_winner_away")  { await handleGameWinnerAway(interaction); return; }
  if (action === "ap_game_winner_cpu")   { await handleGameWinnerCpu(interaction);  return; }
  if (action === "ap_correct")           { await handleCorrect(interaction);      return; }
  if (action === "ap_correct_new_winner"){ await handleCorrectNewWinner(interaction); return; }
  if (action === "ap_correct_swap")      { await handleCorrectSwap(interaction);  return; }
  if (action === "ap_setpay")            { await handleSetPay(interaction);          return; }
  if (action === "ap_setpay_reg")        { await handleSetPayReg(interaction);       return; }
  if (action === "ap_setpay_playoff")    { await handleSetPayPlayoff(interaction);   return; }
  if (action === "ap_setpay_channel")    { await handleSetPayChannel(interaction);   return; }
  if (action === "ap_setpay_po1_btn")   { await handleSetPayPo1Btn(interaction);   return; }
  if (action === "ap_setpay_po2_btn")   { await handleSetPayPo2Btn(interaction);   return; }
  if (action === "ap_newmember")         { await handleNewMember(interaction);    return; }
  if (action === "ap_gotwbonus")         { await handleGotwBonus(interaction);    return; }
  if (action === "ap_potwbonus")         { await handlePotwBonus(interaction);    return; }
  if (action === "ap_referral")          { await handleReferral(interaction);     return; }
  if (action === "ap_eos")              { await handleEos(interaction);          return; }
  if (action === "ap_milestone")         { await handleMilestone(interaction);    return; }
  if (action === "ap_ms_add")            { await handleMilestoneAdd(interaction);  return; }
  if (action?.startsWith("ap_ms_edit_")) {
    const tier = parseInt(action.slice("ap_ms_edit_".length), 10);
    if (!isNaN(tier)) { await handleMilestoneEdit(interaction, tier); return; }
  }
  if (action === "ap_interviewpayout")   { await handleInterviewPayout(interaction);  return; }

  // ── Admin User Data Hub ────────────────────────────────────────────────────
  if (action === "ud_close")           { await handleUdClose(interaction);          return; }
  if (action === "ud_cancel")          { await handleUdCancel(interaction);         return; }
  if (action === "ud_view_teams")      { await handleUdViewTeams(interaction);      return; }
  if (action === "ud_link")            { await handleUdLink(interaction);           return; }
  if (action === "ud_link_next")       { await handleUdLinkNext(interaction);       return; }
  if (action === "ud_unlink")          { await handleUdUnlink(interaction);         return; }
  if (action === "ud_unlink_confirm")  { await handleUdUnlinkConfirm(interaction);  return; }
  if (action === "ud_view_edit")       { await handleUdViewEdit(interaction);       return; }
  if (action === "ud_ve_load")         { await handleUdVeLoad(interaction);         return; }
  if (action === "ud_edit_economy")    { await handleUdEditEconomy(interaction);    return; }
  if (action === "ud_edit_records")    { await handleUdEditRecords(interaction);    return; }
  if (action === "ud_edit_alltime")    { await handleUdEditAllTime(interaction);    return; }
  if (action === "ud_delete")          { await handleUdDelete(interaction);         return; }
  if (action === "ud_delete_confirm")  { await handleUdDeleteConfirm(interaction);  return; }
  if (action === "ud_delete_toggle") {
    const category = parts[1] ?? "";
    await handleUdDeleteToggle(interaction, category);
    return;
  }

  // ── Admin Store Settings Hub ───────────────────────────────────────────────
  if (action === "ss_close")          { await handleSsClose(interaction);          return; }
  if (action === "ss_cancel")         { await handleSsCancel(interaction);         return; }
  if (action === "ss_arch")           { await handleSsArch(interaction);           return; }
  if (action === "ss_arch_prev")      { await handleSsArchPrev(interaction);       return; }
  if (action === "ss_arch_next")      { await handleSsArchNext(interaction);       return; }
  if (action === "ss_arch_edit")      { await handleSsArchEdit(interaction);       return; }
  if (action === "ss_arch_back_to_view") { await handleSsArchBackToView(interaction); return; }
  if (action === "ss_lt")             { await handleSsLt(interaction);             return; }
  if (action === "ss_lt_edit")        { await handleSsLtEdit(interaction);         return; }
  if (action === "ss_lt_create")      { await handleSsLtCreate(interaction);       return; }
  if (action === "ss_lt_back_to_pos") { await handleSsLtBackToPos(interaction);   return; }
  if (action === "ss_lt_back_to_model") { await handleSsLtBackToModel(interaction); return; }
  if (action === "ss_lt_back_to_view")  { await handleSsLtBackToView(interaction);  return; }
}

// ── String select menu handler ─────────────────────────────────────────────────
async function handleSelectMenu(interaction: StringSelectMenuInteraction) {
  const parts     = interaction.customId.split(":");
  const action    = parts[0]!;
  const sessionId = parts[1] ?? "";

  // ── League Data wizard — all ld_ prefixed select menus ───────────────────────
  if (action?.startsWith("ld_")) {
    await handleLeagueDataSelect(interaction);
    return;
  }

  // ── In-channel game scheduling select menus ─────────────────────────────────
  if (action?.startsWith("gs_")) {
    const { handleGsInteraction } = await import("../lib/handlers/game-scheduling-handlers.js");
    await handleGsInteraction(interaction);
    return;
  }

  // ── GOTW voting select menus ─────────────────────────────────────────────────
  if (action?.startsWith("gotwv_")) {
    const { handleGotwvInteraction } = await import("../lib/handlers/gotw-voting-handlers.js");
    await handleGotwvInteraction(interaction);
    return;
  }

  // ── Admin troubleshoot — schedule select menu ─────────────────────────────────
  if (action === "ts_sched_sel") {
    await handleTsSchedSel(interaction);
    return;
  }

  // ── New /menu navigation (menu_cat, menu_admin_cat) ─────────────────────────
  if (action?.startsWith("menu_")) {
    const handled = await handleMenuSelect(interaction);
    if (handled) return;
  }

  // ── Actions hub — dispatch all ac_ prefixed interactions ─────────────────────
  if (action?.startsWith("ac_")) {
    const handled = await handleActionsInteraction(interaction);
    if (handled) return;
  }

  // ── Admin Operations hub — dispatch all ao_ prefixed interactions ─────────────
  if (action?.startsWith("ao_")) {
    const handled = await handleAdminOperationsInteraction(interaction);
    if (handled) return;
  }

  // ── Archetype viewer ──────────────────────────────────────────────────────────
  if (action === "vca_pos") { await handleViewArchetypeSelect(interaction); return; }

  // ── View player stats — team select ───────────────────────────────────────────
  // customId format: viewps_team:<seasonId>:<conference>
  if (action === "viewps_team") {
    const seasonId = parseInt(parts[1] ?? "0", 10);
    await handleTeamSelect(interaction, seasonId);
    return;
  }

  // ── View player stats — position select ───────────────────────────────────────
  // customId format: viewps_pos:<seasonId>:<teamId>
  if (action === "viewps_pos") {
    const seasonId = parseInt(parts[1] ?? "0", 10);
    const teamId   = parseInt(parts[2] ?? "0", 10);
    await handlePositionSelect(interaction, seasonId, teamId);
    return;
  }

  // ── View player stats — player select ─────────────────────────────────────────
  // customId format: viewps_player:<seasonId>:<teamId>
  if (action === "viewps_player") {
    const seasonId = parseInt(parts[1] ?? "0", 10);
    const teamId   = parseInt(parts[2] ?? "0", 10);
    await handlePlayerSelect(interaction, seasonId, teamId);
    return;
  }

  // ── Custom player builder ─────────────────────────────────────────────────────
  if (action === "ccp_pos")          { await handleCcpPos(interaction, sessionId);          return; }
  if (action === "ccp_arch")         { await handleCcpArch(interaction, sessionId);         return; }
  if (action === "ccp_ol_pos")       { await handleCcpOlPos(interaction, sessionId);        return; }
  if (action === "ccp_motion_style") { await handleCcpMotionStyle(interaction, sessionId);  return; }
  if (action === "ccp_dev")          { await handleCcpDev(interaction, sessionId);          return; }
  if (action === "ccp_pkg")          { await handleCcpPkg(interaction, sessionId);          return; }
  if (action === "ccp_attr_sel")     { await handleCcpAttrSel(interaction, sessionId);      return; }
  if (action === "ccp_hand")         { await handleCcpHand(interaction, sessionId);         return; }
  if (action === "ccp_height")       { await handleCcpHeight(interaction, sessionId);       return; }
  if (action === "ccp_weight")       { await handleCcpWeight(interaction, sessionId);       return; }

  // ── Admin: add custom player — position select ─────────────────────────────
  // customId: acp_pos:<targetDiscordId>:<seasonId>:<notesEncoded>
  if (action === "acp_pos") { await handleAcpPositionSelect(interaction); return; }

  // ── Admin: add custom player — player select ───────────────────────────────
  // customId: acp_player:<targetDiscordId>:<seasonId>:<notesEncoded>
  if (action === "acp_player") { await handleAcpPlayerSelect(interaction); return; }

  // ── GOTW: admin selected a specific game ─────────────────────────────────────
  if (action === "gotw_select") {
    const seasonId  = parseInt(parts[1] ?? "0", 10);
    const weekIndex = parseInt(parts[2] ?? "0", 10);
    const weekNum   = weekIndex + 1;

    // Value format: {awayDiscordId}:{homeDiscordId}
    const selectedValue  = interaction.values[0] ?? "";
    const [awayDiscordId, homeDiscordId] = selectedValue.split(":");

    await interaction.deferUpdate();

    const [awayUser] = await db.select({ team: usersTable.team })
      .from(usersTable).where(and(eq(usersTable.discordId, awayDiscordId!), eq(usersTable.guildId, interaction.guildId!))).limit(1);
    const [homeUser] = await db.select({ team: usersTable.team })
      .from(usersTable).where(and(eq(usersTable.discordId, homeDiscordId!), eq(usersTable.guildId, interaction.guildId!))).limit(1);

    const awayTeam = awayUser?.team ?? "Away Team";
    const homeTeam = homeUser?.team ?? "Home Team";

    const result = await postGotwToChannel(
      interaction.client, seasonId, weekIndex, weekNum,
      awayTeam, homeTeam, awayDiscordId!, homeDiscordId!, 0,
      interaction.guildId!,
    );

    const gotwChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.GOTW);
    if (result) {
      await interaction.editReply({
        content: gotwChannelId
          ? `✅ GOTW posted to <#${gotwChannelId}>!\n**${awayTeam} vs ${homeTeam}**`
          : `✅ GOTW posted!\n**${awayTeam} vs ${homeTeam}**`,
        components: [],
      });
    } else {
      await interaction.editReply({
        content: gotwChannelId
          ? `❌ Failed to post GOTW. Check that the bot has access to <#${gotwChannelId}>.`
          : `❌ Failed to post GOTW.`,
        components: [],
      });
    }
    return;
  }

  // ── Admin-Payout Hub selects ──────────────────────────────────────────────────
  if (action === "ap_gotw_afc")        { await handleGotwSelectAfc(interaction);      return; }
  if (action === "ap_gotw_nfc")        { await handleGotwSelectNfc(interaction);      return; }
  if (action === "ap_potw_afc")        { await handlePotwSelectAfc(interaction);      return; }
  if (action === "ap_potw_nfc")        { await handlePotwSelectNfc(interaction);      return; }
  if (action === "ap_addcoins_afc")    { await handleAddCoinsSelectAfc(interaction);  return; }
  if (action === "ap_addcoins_nfc")    { await handleAddCoinsSelectNfc(interaction);  return; }
  if (action === "ap_removecoins_afc") { await handleRemoveCoinsSelectAfc(interaction); return; }
  if (action === "ap_removecoins_nfc") { await handleRemoveCoinsSelectNfc(interaction); return; }
  if (action === "ap_transfer_afc")    { await handleTransferSelectAfc(interaction);  return; }
  if (action === "ap_transfer_nfc")    { await handleTransferSelectNfc(interaction);  return; }
  if (action === "ap_game_select")     { await handleGameSelect(interaction);         return; }
  if (action === "ap_correct_week")    { await handleCorrectWeekSelect(interaction);  return; }
  if (action === "ap_correct_game")    { await handleCorrectGameSelect(interaction);  return; }
  if (action === "ap_eos_key")         { await handleEosKeySelect(interaction);       return; }

  // ── Admin User Data Hub — select menus ────────────────────────────────────
  if (action === "ud_link_team_afc")   { await handleUdLinkTeamAfc(interaction);     return; }
  if (action === "ud_link_team_nfc")   { await handleUdLinkTeamNfc(interaction);     return; }
  if (action === "ud_link_member")     { await handleUdLinkMember(interaction);      return; }
  if (action === "ud_unlink_team_afc") { await handleUdUnlinkTeamAfc(interaction);   return; }
  if (action === "ud_unlink_team_nfc") { await handleUdUnlinkTeamNfc(interaction);   return; }
  if (action === "ud_ve_team_afc")     { await handleUdVeTeamAfc(interaction);       return; }
  if (action === "ud_ve_team_nfc")     { await handleUdVeTeamNfc(interaction);       return; }
  if (action === "ud_delete_user")     { await handleUdDeleteUserSelect(interaction); return; }

  // ── Admin Store Settings Hub ────────────────────────────────────────────────
  if (action === "ss_arch_pos")       { await handleSsArchPos(interaction);       return; }
  if (action === "ss_arch_edit_group") { await handleSsArchEditGroup(interaction); return; }
  if (action === "ss_lt_pos")         { await handleSsLtPos(interaction);         return; }
  if (action === "ss_lt_legend")      { await handleSsLtLegend(interaction);      return; }
  if (action === "ss_lt_model")       { await handleSsLtModel(interaction);       return; }
  if (action === "ss_lt_edit_group")  { await handleSsLtEditGroup(interaction);   return; }
}

// ── Wager margin modal handler ─────────────────────────────────────────────────
async function handleWagerMarginModal(interaction: ModalSubmitInteraction) {
  // customId: wager_margin:<winningSide>:<wagerId>
  const parts   = interaction.customId.split(":");
  // parts[1] is the button side (home/away) — not used; spread math determines winner from scores
  const wagerId = parseInt(parts[2] ?? "0", 10);

  const homeScoreStr = interaction.fields.getTextInputValue("home_score").trim();
  const awayScoreStr = interaction.fields.getTextInputValue("away_score").trim();
  const homeScore    = parseInt(homeScoreStr, 10);
  const awayScore    = parseInt(awayScoreStr, 10);

  if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) {
    await interaction.reply({ content: "❌ Invalid scores. Enter non-negative whole numbers.", ephemeral: true });
    return;
  }

  const [wager] = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
  if (!wager) { await interaction.reply({ content: "❌ Wager not found.", ephemeral: true }); return; }
  if (wager.status !== "active") {
    await interaction.reply({ content: `⚠️ This wager is not active (status: **${wager.status}**).`, ephemeral: true });
    return;
  }

  const wagerGuildId = wager.guildId ?? interaction.guildId!;
  const spread       = wager.spread ?? 0;

  // Spread math: challenger net = (challengerSideScore - opponentSideScore) + spread
  // Positive → challenger wins; negative → opponent wins; zero → push
  const challengerScore = wager.challengerSide === "home" ? homeScore : awayScore;
  const opponentScore   = wager.challengerSide === "home" ? awayScore : homeScore;
  const net             = (challengerScore - opponentScore) + spread;

  const isPush     = net === 0;
  const challWins  = net > 0;

  const winnerId   = isPush ? null : challWins ? wager.challengerId : wager.opponentId;
  const loserId    = isPush ? null : challWins ? wager.opponentId   : wager.challengerId;
  const winnerTeam = !winnerId ? null : challWins ? wager.teamFor   : wager.teamAgainst;
  const loserTeam  = !loserId  ? null : challWins ? wager.teamAgainst : wager.teamFor;

  if (isPush) {
    // Refund both
    await addBalance(wager.challengerId, wager.amount, wagerGuildId);
    await logTransaction(wager.challengerId, wager.amount, "addcoins", `Wager #${wagerId} — push (spread tie) refund`, wagerGuildId, interaction.user.id);
    await addBalance(wager.opponentId, wager.amount, wagerGuildId);
    await logTransaction(wager.opponentId, wager.amount, "addcoins", `Wager #${wagerId} — push (spread tie) refund`, wagerGuildId, interaction.user.id);
    await db.update(wagersTable).set({ status: "push", resolvedAt: new Date(), resolvedBy: interaction.user.id }).where(eq(wagersTable.id, wagerId));

    const embed = new EmbedBuilder()
      .setColor(Colors.Grey)
      .setTitle("🤝 Wager Push — Coins Refunded")
      .setDescription(
        `Final score: **${wager.teamFor} ${challengerScore} — ${opponentScore} ${wager.teamAgainst}**\n` +
        `Spread: **${spread > 0 ? "+" : ""}${spread}** → Net: **0** (push)\n\n` +
        `Both players have been refunded **${wager.amount.toLocaleString()} coins**.`,
      )
      .setFooter({ text: `Wager #${wagerId}` }).setTimestamp();

    await interaction.reply({ embeds: [embed] });
    // Also try to clear the buttons from the original commissioner message
    if (wager.commissionerMessageId && interaction.channel) {
      try {
        const msg = await (interaction.channel as any).messages.fetch(wager.commissionerMessageId);
        await msg.edit({ components: [] });
      } catch (_) {}
    }

    for (const uid of [wager.challengerId, wager.opponentId]) {
      try { const u = await interaction.client.users.fetch(uid); await u.send(`🤝 **Wager #${wagerId} — Push!** Scores tied after spread — your **${wager.amount.toLocaleString()} coins** have been refunded.`).catch(() => {}); } catch (_) {}
    }
  } else {
    // Winner takes pot
    await addBalance(winnerId!, wager.pot, wagerGuildId);
    await logTransaction(winnerId!, wager.pot, "addcoins", `Wager #${wagerId} won: ${winnerTeam} vs ${loserTeam}`, wagerGuildId, interaction.user.id);
    await db.update(wagersTable).set({ status: "completed", winnerId: winnerId!, resolvedAt: new Date(), resolvedBy: interaction.user.id }).where(eq(wagersTable.id, wagerId));

    const homeTeamLabel = wager.challengerSide === "home" ? wager.teamFor : wager.teamAgainst;
    const awayTeamLabel = wager.challengerSide === "away" ? wager.teamFor : wager.teamAgainst;

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Wager Resolved")
      .setDescription(`Final: **${homeTeamLabel} ${homeScore} — ${awayScore} ${awayTeamLabel}**`)
      .addFields(
        { name: "📊 Spread Applied", value: `Spread: **${spread > 0 ? "+" : ""}${spread}** on ${wager.teamFor} → Net: **${net > 0 ? "+" : ""}${net}**`, inline: false },
        { name: "🏆 Winner", value: `<@${winnerId!}> (${winnerTeam})`, inline: true },
        { name: "📉 Loser",  value: `<@${loserId!}> (${loserTeam})`,  inline: true },
        { name: "💰 Payout", value: `**${wager.pot.toLocaleString()} coins** → <@${winnerId!}>`, inline: false },
        { name: "🔖 Decided by", value: `<@${interaction.user.id}>`, inline: false },
      )
      .setFooter({ text: `Wager #${wagerId}` }).setTimestamp();

    await interaction.reply({ embeds: [embed] });
    // Also try to clear the buttons from the original commissioner message
    if (wager.commissionerMessageId && interaction.channel) {
      try {
        const msg = await (interaction.channel as any).messages.fetch(wager.commissionerMessageId);
        await msg.edit({ components: [] });
      } catch (_) {}
    }

    try { const wu = await interaction.client.users.fetch(winnerId!); await wu.send(`🏆 **You won Wager #${wagerId}!** You took **${winnerTeam}** and covered the spread — **${wager.pot.toLocaleString()} coins** added to your balance.`).catch(() => {}); } catch (_) {}
    try { const lu = await interaction.client.users.fetch(loserId!); await lu.send(`📉 **Wager #${wagerId} result:** You lost. You took **${loserTeam}** and didn't cover — your **${wager.amount.toLocaleString()} coins** have been paid out to the winner.`).catch(() => {}); } catch (_) {}
  }
}

// ── Modal handler ──────────────────────────────────────────────────────────────
async function handleModal(interaction: ModalSubmitInteraction) {
  const parts  = interaction.customId.split(":");
  const action = parts[0]!;
  const idStr  = parts[1];

  // ── Commissioner's Office — edit-amount modals (co_modal_edit_*) ────────────
  if (interaction.customId.startsWith("co_modal_edit_")) {
    const { handleCommOfficeModal } = await import("../lib/handlers/pending-inbox-handlers.js");
    await handleCommOfficeModal(interaction);
    return;
  }

  // ── Draft Lottery — count modal (modal_lottery:<roleId>) ────────────────────
  if (action === "modal_lottery") {
    const { handleLotteryCountModal } = await import("../lib/handlers/lottery-handler.js");
    await handleLotteryCountModal(interaction);
    return;
  }

  // ── League Data wizard — all ld_ prefixed modal submissions ──────────────────
  if (action?.startsWith("ld_")) {
    await handleLeagueDataModal(interaction);
    return;
  }

  // ── Actions hub — dispatch all ac_ prefixed modal submissions ─────────────────
  if (action?.startsWith("ac_")) {
    const handled = await handleActionsInteraction(interaction);
    if (handled) return;
  }

  // ── Admin Operations hub — dispatch all ao_ prefixed modal submissions ─────────
  if (action?.startsWith("ao_")) {
    const handled = await handleAdminOperationsInteraction(interaction);
    if (handled) return;
  }

  // ── Admin troubleshoot — schedule review modal ────────────────────────────────
  if (action === "ts_modal_sched_week") { await handleTsSchedWeekModal(interaction); return; }

  // ── Wager margin modal (commissioner enters final score) ─────────────────────
  if (action === "wager_margin") { await handleWagerMarginModal(interaction); return; }

  // ── Custom player builder ─────────────────────────────────────────────────────
  if (action === "ccp_modal")            { await handleCcpModal(interaction, idStr ?? "");            return; }
  if (action === "ccp_refund_modal")     { await handleCcpRefundModal(interaction, idStr ?? "");      return; }
  if (action === "ccp_qb_details_modal") { await handleCcpQbDetailsModal(interaction, idStr ?? "");   return; }
  if (action === "ccp_appearance_modal") { await handleCcpAppearanceModal(interaction, idStr ?? "");  return; }

  // ── Interview denial ─────────────────────────────────────────────────────────
  if (action === "interview_modal") {
    const interviewId = parseInt(idStr!, 10);
    const reason      = interaction.fields.getTextInputValue("reason");

    const rows = await db.select().from(interviewRequestsTable).where(eq(interviewRequestsTable.id, interviewId)).limit(1);
    const interview = rows[0];
    if (!interview) { await interaction.reply({ content: "❌ Interview not found.", ephemeral: true }); return; }
    if (interview.status !== "pending") {
      await interaction.reply({ content: `⚠️ This interview has already been **${interview.status}**.`, ephemeral: true });
      return;
    }

    await db.update(interviewRequestsTable)
      .set({ status: "denied", denialReason: reason, resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(interviewRequestsTable.id, interviewId));

    try {
      const u = await interaction.client.users.fetch(interview.discordId);
      await u.send(`❌ **Your post-game interview request was denied.**\n**Reason:** ${reason}\n\nYour interview slot has been reset — you may submit another interview after your next game.`).catch(() => {});
    } catch (_) {}

    try {
      const interviewDenialCommChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER) ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"];
      const commChannel = interviewDenialCommChannelId ? await interaction.client.channels.fetch(interviewDenialCommChannelId).catch(() => null) : null;
      if (commChannel?.isTextBased() && interview.discordMessageId) {
        const msg = await (commChannel as any).messages.fetch(interview.discordMessageId);
        const deniedEmbed = new EmbedBuilder()
          .setColor(Colors.Red).setTitle("❌ Interview Denied")
          .setDescription(`**Denied by:** ${interaction.user.toString()}\n**Reason:** ${reason}`)
          .setTimestamp();
        await msg.edit({
          embeds: [deniedEmbed],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("interview_denied_done").setLabel("❌ Denied").setStyle(ButtonStyle.Danger).setDisabled(true),
          )],
        });
      }
    } catch (err) { console.error("Failed to edit commissioner message after interview denial:", err); }

    await interaction.reply({ content: `✅ Interview **#${interviewId}** denied. The player has been notified and their slot has been reset.`, ephemeral: true });
    return;
  }

  // ── Interview: submit answers (player-facing modal) ───────────────────────
  if (action === "interview_answer_modal") {
    // Format: interview_answer_modal:i1,i2,i3:type
    const indicesStr = idStr!;
    const iType      = (parts[2] ?? "postgame") as InterviewType;
    const pool       = getQuestionPool(iType);
    const indices    = indicesStr.split(",").map(Number);
    const q1 = (pool[indices[0]!] ?? INTERVIEW_QUESTIONS[indices[0]!])!;
    const q2 = (pool[indices[1]!] ?? INTERVIEW_QUESTIONS[indices[1]!])!;
    const q3 = (pool[indices[2]!] ?? INTERVIEW_QUESTIONS[indices[2]!])!;
    const a1 = interaction.fields.getTextInputValue("a1");
    const a2 = interaction.fields.getTextInputValue("a2");
    const a3 = interaction.fields.getTextInputValue("a3");

    await interaction.deferReply({ ephemeral: true });

    const requester     = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
    const requesterTeam = requester.team ?? interaction.user.username;
    const season        = await getOrCreateActiveSeason(interaction.guildId!);
    const currentWeek   = (season as any).currentWeek ?? "1";
    const weekDisplay   = weekLabel(currentWeek);
    const commChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER) ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;

    // Re-check: only one interview per week
    const existingInterview = await db.select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
      .from(interviewRequestsTable)
      .where(and(
        eq(interviewRequestsTable.discordId, interaction.user.id),
        eq(interviewRequestsTable.guildId,   interaction.guildId!),
        eq(interviewRequestsTable.week, currentWeek),
        inArray(interviewRequestsTable.status, ["pending", "approved"]),
      ))
      .limit(1);

    if (existingInterview.length > 0) {
      const dupe = existingInterview[0]!;
      await interaction.editReply({
        content: `⚠️ You already have an interview for ${weekDisplay} (Interview #\`${dupe.id}\`, status: **${dupe.status}**). Only one per week.`,
      });
      return;
    }

    // Create the interview record with questions + answers
    const [interview] = await db.insert(interviewRequestsTable).values({
      discordId: interaction.user.id,
      guildId:   interaction.guildId!,
      week:      currentWeek,
      status:    "pending",
      question1: q1,
      question2: q2,
      question3: q3,
      answer1:   a1,
      answer2:   a2,
      answer3:   a3,
    }).returning();

    const interviewId = interview!.id;

    // ── Commissioner embed with all 3 Q&A pairs ──────────────────────────────
    const submitPayoutVal = await getPayoutValue(PAYOUT_KEYS.INTERVIEW_PAYOUT, interaction.guildId!);
    const typeLabel = interviewTypeLabel(iType);
    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle(`🎙️ ${typeLabel}`)
      .addFields(
        { name: "Player", value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
        { name: "Week",   value: weekDisplay, inline: true },
        { name: `Q1: ${q1.slice(0, 200)}`, value: a1.slice(0, 1000) },
        { name: `Q2: ${q2.slice(0, 200)}`, value: a2.slice(0, 1000) },
        { name: `Q3: ${q3.slice(0, 200)}`, value: a3.slice(0, 1000) },
        { name: "Payout if Approved", value: `+**${submitPayoutVal} coins**` },
      )
      .setFooter({ text: `Interview #${interviewId}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`interview_approve:${interviewId}`)
        .setLabel("✅ Approve Interview")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`interview_deny:${interviewId}`)
        .setLabel("❌ Deny")
        .setStyle(ButtonStyle.Danger),
    );

    try {
      const channel = await interaction.client.channels.fetch(commChannelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as any).send({ embeds: [embed], components: [row] });
        await db.update(interviewRequestsTable)
          .set({ discordMessageId: msg.id })
          .where(eq(interviewRequestsTable.id, interviewId));
      }
    } catch (err) {
      console.error("Failed to post interview to commissioner channel:", err);
    }

    await interaction.editReply({
      content: [
        `✅ **Interview submitted for ${weekDisplay}!** (Interview #\`${interviewId}\`)`,
        `Your answers have been sent to the commissioner for review.`,
        `You'll get a DM once it's approved or denied.`,
      ].join("\n"),
    });
    return;
  }

  // ── EOS payout: edit amount submitted ────────────────────────────────────────
  if (action === "eos_edit_modal") {
    const payoutId = parseInt(idStr ?? "0", 10);
    const rawAmount = interaction.fields.getTextInputValue("new_amount").trim();
    const newAmount = parseInt(rawAmount, 10);

    if (isNaN(newAmount) || newAmount <= 0) {
      await interaction.reply({ content: "❌ Invalid amount — enter a positive whole number.", ephemeral: true });
      return;
    }

    const [payout] = await db.select().from(pendingEosPayoutsTable)
      .where(eq(pendingEosPayoutsTable.id, payoutId)).limit(1);
    if (!payout) { await interaction.reply({ content: "❌ Payout not found.", ephemeral: true }); return; }
    if (payout.status !== "pending") {
      await interaction.reply({ content: `⚠️ This payout is already **${payout.status}** and can't be edited.`, ephemeral: true });
      return;
    }

    await db.update(pendingEosPayoutsTable)
      .set({ totalCoins: newAmount })
      .where(eq(pendingEosPayoutsTable.id, payoutId));

    // Update the commissioner message buttons with new amount
    if (payout.commissionerMessageId) {
      try {
        const commChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER) ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
        const ch = await interaction.client.channels.fetch(commChannelId);
        if (ch?.isTextBased()) {
          const msg = await (ch as TextChannel).messages.fetch(payout.commissionerMessageId).catch(() => null);
          if (msg) {
            const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`eos_approve:${payoutId}:${payout.discordId}`)
                .setLabel(`✅ Approve (${newAmount.toLocaleString()} coins)`)
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`eos_edit:${payoutId}`)
                .setLabel("✏️ Edit Amount")
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setCustomId(`eos_reject:${payoutId}`)
                .setLabel("🗑️ Reject")
                .setStyle(ButtonStyle.Danger),
            );
            await msg.edit({ components: [updatedRow] });
          }
        }
      } catch (err) { console.error("Failed to update commissioner message after EOS edit:", err); }
    }

    await interaction.reply({
      content: `✅ Payout #${payoutId} updated to **${newAmount.toLocaleString()} coins**. Click Approve to award.`,
      ephemeral: true,
    });
    return;
  }

  // ── Admin-Payout Hub modals ────────────────────────────────────────────────
  // ap_modal_potw removed — POTW now uses dropdown select menus, not modals
  if (action === "ap_modal_addcoins")       { await handleAddCoinsModal(interaction);      return; }
  if (action === "ap_modal_removecoins")    { await handleRemoveCoinsModal(interaction);   return; }
  if (action === "ap_modal_transfer")       { await handleTransferModal(interaction);      return; }
  if (action === "ap_modal_game_home_wins") { await handleGameModalHomeWins(interaction);  return; }
  if (action === "ap_modal_game_away_wins") { await handleGameModalAwayWins(interaction);  return; }
  if (action === "ap_modal_game_cpu_wins")  { await handleGameModalCpuWins(interaction);   return; }
  if (action === "ap_modal_correct_same")   { await handleCorrectModalSame(interaction);   return; }
  if (action === "ap_modal_correct_swap")   { await handleCorrectModalSwap(interaction);   return; }
  if (action === "ap_modal_setpay_reg")     { await handleSetPayRegModal(interaction);     return; }
  if (action === "ap_modal_setpay_po1")     { await handleSetPayPo1Modal(interaction);     return; }
  if (action === "ap_modal_setpay_po2")     { await handleSetPayPo2Modal(interaction);     return; }
  if (action === "ap_modal_newmember")      { await handleNewMemberModal(interaction);     return; }
  if (action === "ap_modal_gotwbonus")        { await handleGotwBonusModal(interaction);       return; }
  if (action === "ap_modal_potwbonus")        { await handlePotwBonusModal(interaction);       return; }
  if (action === "ap_modal_interviewpayout")  { await handleInterviewPayoutModal(interaction); return; }
  if (action === "ap_modal_eos_edit")       { await handleEosEditModal(interaction);        return; }
  if (action === "ap_modal_eos_stat_tier")  { await handleEosStatTierModal(interaction);    return; }
  if (action === "ap_modal_milestone_edit") { await handleMilestoneEditModal(interaction);  return; }
  if (action === "ap_modal_setpay_channel") { await handleSetPayChannelModal(interaction);  return; }
  if (action === "ap_modal_referral")       { await handleReferralModal(interaction);        return; }

  // ── Team request denial modal (treq_deny_reason|uid|msgId|team) ────────────
  if (interaction.customId.startsWith("treq_deny_reason|")) { await handleTreqDenyReasonModal(interaction); return; }

  // ── Admin User Data Hub modals ─────────────────────────────────────────────
  if (action === "ud_modal_link")          { await handleUdLinkModal(interaction);          return; }
  if (action === "ud_modal_edit_economy")  { await handleUdEditEconomyModal(interaction);   return; }
  if (action === "ud_modal_edit_records")  { await handleUdEditRecordsModal(interaction);   return; }
  if (action === "ud_modal_edit_alltime")  { await handleUdEditAllTimeModal(interaction);   return; }

  // ── Admin Store Settings Hub modals ────────────────────────────────────────
  if (action === "ss_modal_arch_edit")          { await handleSsArchEditModal(interaction);          return; }
  if (action === "ss_modal_lt_edit")            { await handleSsLtEditModal(interaction);            return; }
}
