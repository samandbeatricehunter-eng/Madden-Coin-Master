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
  tradeBlockListingsTable, tradeBlockISOTable, completedTradesTable,
  franchiseScheduleTable, seasonsTable,
  pendingEosPayoutsTable, seasonStatTierConfigsTable,
  pendingChannelPayoutsTable,
  statPaddingViolationsTable, seasonStatsTable,
} from "@workspace/db";
import { CORE_ATTRIBUTES } from "../lib/constants.js";
import { STAT_CATEGORIES, STAT_TIER_DEFAULTS } from "../lib/stat-categories.js";
import { pendingCoCommActions, purgeExpiredCoCommActions } from "../lib/pending-cocomm-actions.js";
import { executeAdminAction, type AdminActionContext } from "../lib/admin-actions.js";
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
} from "../lib/custom-player-interactions.js";
import { handleViewArchetypeSelect, handleVcaNav, handleVcaAttrPageNav } from "../commands/viewcustomarchetypes.js";
import {
  handleAupPageNav, handleAupSel, handleAupBack, handleAupConfirm, handleAupCancel,
} from "../commands/attribute-up-interactions.js";
import { handleTeamSelect, handlePositionSelect, handlePlayerSelect } from "../commands/viewplayerstats.js";
import { handleAcpPositionSelect, handleAcpPlayerSelect } from "../commands/admin-inventory.js";
import { eq, and, sql, inArray, count } from "drizzle-orm";
import {
  addBalance, deductBalance, logTransaction,
  getOrCreateActiveSeason, getOrCreateUser, isAdminUser,
  getSeasonRules, getGuildChannel, CHANNEL_KEYS,
} from "../lib/db-helpers.js";
import { buildPageResponse } from "../commands/viewtradeblock.js";
import { formatPickInfo, getMyTeam, sendOfferState, buildSendOfferPage } from "../commands/tradeblock.js";
import {
  getServerSettings, toggleFeature, buildSettingsEmbed, buildSettingsRows,
  FEATURE_LABELS,
} from "../lib/server-settings.js";
import { registerCommandsForGuild } from "../lib/register-commands.js";
import { buildMemberHelpEmbed } from "../commands/help.js";
import { INTERVIEW_PAYOUT, INTERVIEW_QUESTIONS } from "../commands/interviewrequest.js";
import { weekLabel } from "../commands/advanceweek.js";
import {
  DRAFT_TOGGLE_PREFIX, DRAFT_CLOSE_BUTTON_ID,
  getActiveSession, togglePresence, refreshPresence, endDraftSession,
} from "../lib/draft-presence-manager.js";
import {
  scoreH2HMatchups, postGotwToChannel,
} from "../lib/gotw-helpers.js";
import { buildTeamToDiscord } from "../lib/weekly-matchups-runner.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";
import { logTradeEvent } from "../lib/league-twitter.js";
import { waitlistTable } from "@workspace/db";
import {
  WAITLIST_ACCEPT_PREFIX, WAITLIST_DENY_PREFIX,
} from "../commands/waitlist.js";


// ── Send-offer in-memory player selection store ────────────────────────────────
// Key: `${senderDiscordId}:${targetDiscordId}`  Value: selected player option values
// Entries are cleared after the modal submits or after 15 minutes (Discord interaction TTL).
const pendingOfferPlayers = new Map<string, string[]>();

export const name = "interactionCreate";

export async function execute(interaction: Interaction) {
  // ── Role guard ─────────────────────────────────────────────────────────────
  // All interactions from guild members must have at least one assigned role
  // beyond @everyone (which every user has by default).
  if (interaction.inGuild() && interaction.member) {
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

  if (interaction.isButton())           { await handleButton(interaction);    return; }
  if (interaction.isStringSelectMenu()) { await handleSelectMenu(interaction); return; }
  if (interaction.isModalSubmit())      { await handleModal(interaction); }
}

// ── Send-offer modal builder ───────────────────────────────────────────────────
// 4 fields: picks offering | coins offering | players+picks wanting | coins wanting
// Opened by so_done (player toggles), so_continue (empty roster fallback)
function buildSendOfferModal(targetId: string): import("discord.js").ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`so_modal:${targetId}`)
    .setTitle("📤 Trade Offer — Picks, Coins & Requests");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("send_picks")
        .setLabel("Picks You're Offering (players from dropdown)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 2027 Round 1, 2026 Round 2 (from Cowboys)")
        .setRequired(false)
        .setMaxLength(300),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("send_coins")
        .setLabel("Coins You're Offering")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Enter a number, or leave blank for none")
        .setRequired(false)
        .setMaxLength(10),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("want_players_picks")
        .setLabel("Players & Picks You Want Back")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("e.g. Tyreek Hill (WR), 2026 R1 — up to 7 players/picks combined")
        .setRequired(false)
        .setMaxLength(600),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("want_coins")
        .setLabel("Coins You Want Back")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Enter a number, or leave blank for none")
        .setRequired(false)
        .setMaxLength(10),
    ),
  );
  return modal;
}

// ── Button handler ─────────────────────────────────────────────────────────────
async function handleButton(interaction: ButtonInteraction) {
  const parts = interaction.customId.split(":");
  const [action, secondPart, userId, purchaseType] = parts;

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

  // ── Attribute-up interactive flow ──────────────────────────────────────────
  if (action === "aup_prev")    { await handleAupPageNav(interaction, "prev"); return; }
  if (action === "aup_next")    { await handleAupPageNav(interaction, "next"); return; }
  if (action === "aup_back")    { await handleAupBack(interaction);            return; }
  if (action === "aup_confirm") { await handleAupConfirm(interaction);         return; }
  if (action === "aup_cancel")  { await handleAupCancel(interaction);          return; }

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

    await addBalance(interview.discordId, INTERVIEW_PAYOUT, interaction.guildId!);
    await logTransaction(interview.discordId, INTERVIEW_PAYOUT, "addcoins", "Post-game interview payout", interaction.guildId!, interaction.user.id);
    await db.update(interviewRequestsTable)
      .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(interviewRequestsTable.id, interviewId));

    try {
      const u = await interaction.client.users.fetch(interview.discordId);
      await u.send(`🎙️ Your post-game interview was approved! **+${INTERVIEW_PAYOUT} coins** added to your balance.`).catch(() => {});
    } catch (_) {}

    const [ivUserRow] = await db.select({ team: usersTable.team })
      .from(usersTable).where(eq(usersTable.discordId, interview.discordId)).limit(1);

    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Interview Approved")
      .setDescription(
        `**Player:** <@${interview.discordId}>${ivUserRow?.team ? ` (${ivUserRow.team})` : ""}\n` +
        (interview.week ? `**Week:** ${interview.week}\n` : "") +
        `**Coins Awarded:** +${INTERVIEW_PAYOUT} coins\n\n` +
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
            `💰 **+${INTERVIEW_PAYOUT} coins** awarded.`
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
    const commEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("⚔️ Wager — Declare Winner")
      .addFields(
        { name: "Player 1 (Challenger)", value: `<@${wager.challengerId}> — **${wager.teamFor}**`,  inline: true },
        { name: "Player 2 (Opponent)",   value: `<@${wager.opponentId}> — **${wager.teamAgainst}**`, inline: true },
        { name: "💰 Pot", value: `**${wager.pot.toLocaleString()} coins** → goes to winner`, inline: false },
      )
      .setFooter({ text: `Wager #${wagerId} • Click the winner below once the game is played` })
      .setTimestamp();

    const commRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`wager_winner:${wagerId}:${wager.challengerId}`)
        .setLabel(`🏆 ${wager.teamFor} Wins`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`wager_winner:${wagerId}:${wager.opponentId}`)
        .setLabel(`🏆 ${wager.teamAgainst} Wins`)
        .setStyle(ButtonStyle.Primary),
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

  // ── Wager: commissioner declares winner ───────────────────────────────────
  if (action === "wager_winner") {
    const wagerId  = parseInt(secondPart ?? "0", 10);
    const winnerId = userId!;
    await interaction.deferUpdate();

    const rows = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
    const wager = rows[0];
    if (!wager) { await interaction.followUp({ content: "❌ Wager not found.", ephemeral: true }); return; }
    if (wager.status !== "active") {
      await interaction.followUp({ content: `⚠️ This wager is not active (status: **${wager.status}**).`, ephemeral: true });
      return;
    }

    const loserId = winnerId === wager.challengerId ? wager.opponentId : wager.challengerId;
    const winnerTeam = winnerId === wager.challengerId ? wager.teamFor : wager.teamAgainst;
    const loserTeam  = winnerId === wager.challengerId ? wager.teamAgainst : wager.teamFor;

    // Pay out the full pot to the winner — always use the wager's own guild
    const wagerGuildId = wager.guildId ?? interaction.guildId!;
    await addBalance(winnerId, wager.pot, wagerGuildId);
    await logTransaction(winnerId, wager.pot, "addcoins",
      `Wager #${wagerId} won: ${winnerTeam} vs ${loserTeam}`, wagerGuildId, interaction.user.id);

    await db.update(wagersTable)
      .set({ status: "completed", winnerId, resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(wagersTable.id, wagerId));

    // Edit the commissioner message
    const resolvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Wager Resolved")
      .setDescription(`**${winnerTeam}** wins!\n<@${winnerId}> collects the pot of **${wager.pot.toLocaleString()} coins**.`)
      .addFields(
        { name: "🏆 Winner", value: `<@${winnerId}> (${winnerTeam})`, inline: true },
        { name: "📉 Loser",  value: `<@${loserId}> (${loserTeam})`,  inline: true },
        { name: "💰 Payout", value: `**${wager.pot.toLocaleString()} coins** → <@${winnerId}>`, inline: false },
        { name: "🔖 Decided by", value: interaction.user.toString(), inline: false },
      )
      .setFooter({ text: `Wager #${wagerId}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [resolvedEmbed], components: [] });

    // DM both players
    try {
      const winnerUser = await interaction.client.users.fetch(winnerId);
      await winnerUser.send(
        `🏆 **You won Wager #${wagerId}!**\n` +
        `You took **${winnerTeam}** and they won — **${wager.pot.toLocaleString()} coins** have been added to your balance.`
      ).catch(() => {});
    } catch (_) {}
    try {
      const loserUser = await interaction.client.users.fetch(loserId);
      await loserUser.send(
        `📉 **Wager #${wagerId} result:** You lost.\n` +
        `You took **${loserTeam}** and they lost to **${winnerTeam}**. Your **${wager.amount.toLocaleString()} coins** have been paid out to the winner.`
      ).catch(() => {});
    } catch (_) {}
    return;
  }

  // ── Stream payout: approve ───────────────────────────────────────────────────
  if (action === "stream_approve") {
    const payoutId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
      await interaction.followUp({ content: "❌ Only commissioners can approve payouts.", ephemeral: true });
      return;
    }

    const [payout] = await db
      .select().from(pendingChannelPayoutsTable)
      .where(eq(pendingChannelPayoutsTable.id, payoutId))
      .limit(1);

    if (!payout) { await interaction.followUp({ content: "❌ Payout record not found.", ephemeral: true }); return; }
    if (payout.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This payout has already been **${payout.status}**.`, ephemeral: true });
      return;
    }

    // Award coins to streamer
    await addBalance(payout.discordId, payout.amount, interaction.guildId!);
    await logTransaction(payout.discordId, payout.amount, "addcoins",
      `Stream payout — Week ${payout.week}`, interaction.guildId!, interaction.user.id);

    // Award coins to H2H opponent if applicable
    if (payout.opponentDiscordId && payout.opponentAmount) {
      await addBalance(payout.opponentDiscordId, payout.opponentAmount, interaction.guildId!);
      await logTransaction(payout.opponentDiscordId, payout.opponentAmount, "addcoins",
        `Stream payout (opponent) — Week ${payout.week}`, interaction.guildId!, interaction.user.id);
    }

    await db.update(pendingChannelPayoutsTable)
      .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(pendingChannelPayoutsTable.id, payoutId));

    // React ✅ to original message
    try {
      const origChannel = await interaction.client.channels.fetch(payout.channelId).catch(() => null);
      if (origChannel?.isTextBased()) {
        const origMsg = await (origChannel as TextChannel).messages.fetch(payout.messageId).catch(() => null);
        if (origMsg) await origMsg.react("✅").catch(() => {});
      }
    } catch (_) {}

    // DM the streamer
    try {
      const u = await interaction.client.users.fetch(payout.discordId);
      await u.send(`🎮 Your stream payout for Week ${payout.week} was approved! **+${payout.amount} coins** added.`).catch(() => {});
    } catch (_) {}

    // DM the opponent if applicable
    if (payout.opponentDiscordId && payout.opponentAmount) {
      try {
        const u = await interaction.client.users.fetch(payout.opponentDiscordId);
        await u.send(`🎮 A league member streamed your Week ${payout.week} game — you received **+${payout.opponentAmount} coins**!`).catch(() => {});
      } catch (_) {}
    }

    // Look up streamer's team and try to recover the stream URL from the original message
    const [streamerUserRow] = await db.select({ team: usersTable.team })
      .from(usersTable).where(eq(usersTable.discordId, payout.discordId)).limit(1);
    const streamerTeam = streamerUserRow?.team ?? null;

    let streamUrl = "(see original message)";
    try {
      const origCh = await interaction.client.channels.fetch(payout.channelId).catch(() => null);
      if (origCh?.isTextBased()) {
        const origMsg = await (origCh as TextChannel).messages.fetch(payout.messageId).catch(() => null);
        const match = origMsg?.content.match(/https?:\/\/(?:[\w-]+\.)?twitch\.tv\/\S+/i);
        if (match) streamUrl = match[0];
      }
    } catch (_) {}

    const isH2H = !!payout.opponentDiscordId;
    const streamDescLines = [
      `**Streamer:** <@${payout.discordId}>${streamerTeam ? ` (${streamerTeam})` : ""}`,
      `**Opponent:** ${isH2H ? `${payout.opponentTeam ?? ""} — <@${payout.opponentDiscordId}>` : "CPU (no payout)"}`,
      `**Stream:** ${streamUrl}`,
      `**Week:** ${payout.week}`,
      "",
      `**Coins Awarded:**`,
      `+${payout.amount} coins → <@${payout.discordId}>`,
      isH2H ? `+${payout.opponentAmount} coins → <@${payout.opponentDiscordId}> (H2H opponent)` : null,
      "",
      `✅ Approved by ${interaction.user.toString()}`,
    ].filter((l): l is string => l !== null).join("\n");

    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Stream Payout Approved")
      .setDescription(streamDescLines)
      .setFooter({ text: `Payout #${payoutId} • Week ${payout.week}` })
      .setTimestamp();

    await interaction.editReply({
      embeds: [approvedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("stream_done").setLabel("✅ Approved").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });
    return;
  }

  // ── Stream payout: deny ──────────────────────────────────────────────────────
  if (action === "stream_deny") {
    const payoutId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
      await interaction.followUp({ content: "❌ Only commissioners can deny payouts.", ephemeral: true });
      return;
    }

    const [payout] = await db
      .select().from(pendingChannelPayoutsTable)
      .where(eq(pendingChannelPayoutsTable.id, payoutId))
      .limit(1);

    if (!payout) { await interaction.followUp({ content: "❌ Payout record not found.", ephemeral: true }); return; }
    if (payout.status !== "pending") {
      await interaction.followUp({ content: `⚠️ Already **${payout.status}**.`, ephemeral: true });
      return;
    }

    await db.update(pendingChannelPayoutsTable)
      .set({ status: "denied", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(pendingChannelPayoutsTable.id, payoutId));

    const [deniedStreamerRow] = await db.select({ team: usersTable.team })
      .from(usersTable).where(eq(usersTable.discordId, payout.discordId)).limit(1);

    const deniedEmbed = new EmbedBuilder()
      .setColor(Colors.Red).setTitle("❌ Stream Payout Denied")
      .setDescription(
        `**Streamer:** <@${payout.discordId}>${deniedStreamerRow?.team ? ` (${deniedStreamerRow.team})` : ""}\n` +
        `**Opponent:** ${payout.opponentDiscordId ? `${payout.opponentTeam ?? ""} — <@${payout.opponentDiscordId}>` : "CPU"}\n` +
        `**Week:** ${payout.week}\n\n` +
        `❌ Denied by ${interaction.user.toString()}`
      )
      .setFooter({ text: `Payout #${payoutId} • Week ${payout.week}` })
      .setTimestamp();

    await interaction.editReply({
      embeds: [deniedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("stream_denied_done").setLabel("❌ Denied").setStyle(ButtonStyle.Danger).setDisabled(true),
      )],
    });
    return;
  }

  // ── Highlight payout: approve ────────────────────────────────────────────────
  if (action === "highlight_approve") {
    const payoutId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
      await interaction.followUp({ content: "❌ Only commissioners can approve payouts.", ephemeral: true });
      return;
    }

    const [payout] = await db
      .select().from(pendingChannelPayoutsTable)
      .where(eq(pendingChannelPayoutsTable.id, payoutId))
      .limit(1);

    if (!payout) { await interaction.followUp({ content: "❌ Payout record not found.", ephemeral: true }); return; }
    if (payout.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This payout has already been **${payout.status}**.`, ephemeral: true });
      return;
    }

    await addBalance(payout.discordId, payout.amount, interaction.guildId!);
    await logTransaction(payout.discordId, payout.amount, "addcoins",
      `Highlight video payout — Week ${payout.week}`, interaction.guildId!, interaction.user.id);

    await db.update(pendingChannelPayoutsTable)
      .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(pendingChannelPayoutsTable.id, payoutId));

    // React ✅ to original message
    try {
      const origChannel = await interaction.client.channels.fetch(payout.channelId).catch(() => null);
      if (origChannel?.isTextBased()) {
        const origMsg = await (origChannel as TextChannel).messages.fetch(payout.messageId).catch(() => null);
        if (origMsg) await origMsg.react("✅").catch(() => {});
      }
    } catch (_) {}

    // DM the poster
    try {
      const u = await interaction.client.users.fetch(payout.discordId);
      await u.send(`🎬 Your highlight video payout for Week ${payout.week} was approved! **+${payout.amount} coins** added.`).catch(() => {});
    } catch (_) {}

    const [hlPosterRow] = await db.select({ team: usersTable.team })
      .from(usersTable).where(eq(usersTable.discordId, payout.discordId)).limit(1);

    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Highlight Payout Approved")
      .setDescription(
        `**Poster:** <@${payout.discordId}>${hlPosterRow?.team ? ` (${hlPosterRow.team})` : ""}\n` +
        `**Week:** ${payout.week}\n\n` +
        `**Coins Awarded:**\n+${payout.amount} coins → <@${payout.discordId}>\n\n` +
        `✅ Approved by ${interaction.user.toString()}`
      )
      .setFooter({ text: `Payout #${payoutId} • Week ${payout.week}` })
      .setTimestamp();

    await interaction.editReply({
      embeds: [approvedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("highlight_done").setLabel("✅ Approved").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });
    return;
  }

  // ── Highlight payout: deny ───────────────────────────────────────────────────
  if (action === "highlight_deny") {
    const payoutId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
      await interaction.followUp({ content: "❌ Only commissioners can deny payouts.", ephemeral: true });
      return;
    }

    const [payout] = await db
      .select().from(pendingChannelPayoutsTable)
      .where(eq(pendingChannelPayoutsTable.id, payoutId))
      .limit(1);

    if (!payout) { await interaction.followUp({ content: "❌ Payout record not found.", ephemeral: true }); return; }
    if (payout.status !== "pending") {
      await interaction.followUp({ content: `⚠️ Already **${payout.status}**.`, ephemeral: true });
      return;
    }

    await db.update(pendingChannelPayoutsTable)
      .set({ status: "denied", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(pendingChannelPayoutsTable.id, payoutId));

    const [hlDeniedPosterRow] = await db.select({ team: usersTable.team })
      .from(usersTable).where(eq(usersTable.discordId, payout.discordId)).limit(1);

    const deniedEmbed = new EmbedBuilder()
      .setColor(Colors.Red).setTitle("❌ Highlight Payout Denied")
      .setDescription(
        `**Poster:** <@${payout.discordId}>${hlDeniedPosterRow?.team ? ` (${hlDeniedPosterRow.team})` : ""}\n` +
        `**Week:** ${payout.week}\n\n` +
        `❌ Denied by ${interaction.user.toString()}`
      )
      .setFooter({ text: `Payout #${payoutId} • Week ${payout.week}` })
      .setTimestamp();

    await interaction.editReply({
      embeds: [deniedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("highlight_denied_done").setLabel("❌ Denied").setStyle(ButtonStyle.Danger).setDisabled(true),
      )],
    });
    return;
  }

  // ── Interview: open answer modal (player-facing) ──────────────────────────
  if (action === "interview_answer") {
    const targetUserId = secondPart!;    // the user who ran /interviewrequest
    const indicesStr   = userId!;        // format: interview_answer:targetUserId:i1,i2,i3

    if (interaction.user.id !== targetUserId) {
      await interaction.reply({ content: "❌ This interview form isn't yours to fill out.", ephemeral: true });
      return;
    }

    const indices = indicesStr.split(",").map(Number);
    const q1 = INTERVIEW_QUESTIONS[indices[0]!]!;
    const q2 = INTERVIEW_QUESTIONS[indices[1]!]!;
    const q3 = INTERVIEW_QUESTIONS[indices[2]!]!;

    const truncLabel = (q: string) => q.length <= 45 ? q : q.slice(0, 42) + "...";

    const modal = new ModalBuilder()
      .setCustomId(`interview_answer_modal:${indicesStr}`)
      .setTitle("🎙️ Post-Game Interview");

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

  // ── Trade Block: Send Offer button (opens modal) ─────────────────────────────
  if (action === "tb_offer" || action === "tb_interested") {
    const listingId       = secondPart!;
    const posterDiscordId = userId!;

    if (interaction.user.id === posterDiscordId) {
      await interaction.reply({ content: "❌ You can't send an offer on your own listing.", ephemeral: true });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`tb_offer_modal:${listingId}:${posterDiscordId}`)
      .setTitle("Send a Trade Offer");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("offer_assets")
          .setLabel("Players / Picks you're offering")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder("e.g. Tyreek Hill (WR) + my 2026 Round 1 pick"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("offer_coins")
          .setLabel("Coins you're including (leave blank for none)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setPlaceholder("e.g. 500"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("offer_message")
          .setLabel("Message (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder("Any note you want to include"),
      ),
    );
    await interaction.showModal(modal).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal (tb_offer) error:", err);
    });
    return;
  }

  // ── Trade Block: Cancel own listing → ask if a deal was reached ──────────────
  if (action === "tb_cancel" || action === "tb_close") {
    const listingId = parseInt(secondPart ?? "0", 10);

    const [listing] = await db.select().from(tradeBlockListingsTable)
      .where(and(eq(tradeBlockListingsTable.id, listingId), eq(tradeBlockListingsTable.status, "active")))
      .limit(1);

    if (!listing) {
      await interaction.reply({ content: "❌ This listing has already been removed.", ephemeral: true });
      return;
    }
    if (listing.discordId !== interaction.user.id) {
      await interaction.reply({ content: "❌ Only the owner of this listing can cancel it.", ephemeral: true });
      return;
    }

    const dealRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`tb_deal_yes:${listingId}:L`)
        .setLabel("✅ Yes — We made a deal")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tb_deal_no:${listingId}:L`)
        .setLabel("❌ No deal, just remove")
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: "🤝 **Was a trade deal reached through this listing?**\nIf yes, we'll announce it to the server!",
      components: [dealRow],
      ephemeral: true,
    });
    return;
  }

  // ── Trade Block ISO: Send Offer button (opens modal) ─────────────────────────
  if (action === "tb_iso_offer") {
    const isoId           = secondPart!;
    const posterDiscordId = userId!;

    if (interaction.user.id === posterDiscordId) {
      await interaction.reply({ content: "❌ You can't make an offer on your own ISO post.", ephemeral: true });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`tb_iso_offer_modal:${isoId}:${posterDiscordId}`)
      .setTitle("Make Your Offer");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("offer_assets")
          .setLabel("Players / Picks you're offering")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder("e.g. CeeDee Lamb (WR) + my 2026 Round 2 pick"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("offer_coins")
          .setLabel("Coins you're including (leave blank for none)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(10)
          .setPlaceholder("e.g. 300"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("offer_message")
          .setLabel("Message (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setPlaceholder("Any note you want to include"),
      ),
    );
    await interaction.showModal(modal).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal (tb_iso_offer) error:", err);
    });
    return;
  }

  // ── Trade Block ISO: Cancel own ISO → ask if a deal was reached ──────────────
  if (action === "tb_cancel_iso" || action === "tb_iso_close") {
    const isoId = parseInt(secondPart ?? "0", 10);

    const [iso] = await db.select().from(tradeBlockISOTable)
      .where(and(eq(tradeBlockISOTable.id, isoId), eq(tradeBlockISOTable.status, "active")))
      .limit(1);

    if (!iso) {
      await interaction.reply({ content: "❌ This ISO has already been removed.", ephemeral: true });
      return;
    }
    if (iso.discordId !== interaction.user.id) {
      await interaction.reply({ content: "❌ Only the owner of this ISO can cancel it.", ephemeral: true });
      return;
    }

    const dealRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`tb_deal_yes:${isoId}:I`)
        .setLabel("✅ Yes — We made a deal")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tb_deal_no:${isoId}:I`)
        .setLabel("❌ No deal, just remove")
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: "🤝 **Was a trade deal reached through this ISO post?**\nIf yes, we'll announce it to the server!",
      components: [dealRow],
      ephemeral: true,
    });
    return;
  }

  // ── Send Offer: skip player dropdown — open offer details modal directly ──────
  // customId: so_continue:TARGET_ID  (empty-roster fallback — no players in DB)
  if (action === "so_continue") {
    const targetId = secondPart!;
    pendingOfferPlayers.delete(`${interaction.user.id}:${targetId}`);
    await interaction.showModal(buildSendOfferModal(targetId)).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal (so_continue) error:", err);
    });
    return;
  }

  // customId: so_tog:TARGET_ID:PLAYER_ID  — toggle a player on/off in the offer
  if (action === "so_tog") {
    const targetId = secondPart!;
    const playerId = userId!; // third colon-segment
    const key      = `${interaction.user.id}:${targetId}`;
    const state    = sendOfferState.get(key);
    if (!state) {
      await interaction.update({ content: "❌ Session expired — please run `/tradeblock send-offer` again.", components: [] });
      return;
    }
    if (state.selected.has(playerId)) {
      state.selected.delete(playerId);
    } else {
      if (state.selected.size >= 7) {
        await interaction.reply({ content: "❌ You can only include up to **7 players** in one offer.", ephemeral: true });
        return;
      }
      state.selected.add(playerId);
    }
    const { content, components } = buildSendOfferPage(state);
    await interaction.update({ content, components });
    return;
  }

  // customId: so_pg:TARGET_ID:prev|next|info  — page navigation
  if (action === "so_pg") {
    const targetId = secondPart!;
    const dir      = userId!; // "prev", "next", or "info" (disabled label btn)
    if (dir === "info") { await interaction.deferUpdate(); return; }
    const key   = `${interaction.user.id}:${targetId}`;
    const state = sendOfferState.get(key);
    if (!state) {
      await interaction.update({ content: "❌ Session expired — please run `/tradeblock send-offer` again.", components: [] });
      return;
    }
    const totalPages = Math.ceil(state.players.length / 15);
    if (dir === "next") state.page = Math.min(state.page + 1, totalPages - 1);
    if (dir === "prev") state.page = Math.max(state.page - 1, 0);
    const { content, components } = buildSendOfferPage(state);
    await interaction.update({ content, components });
    return;
  }

  // customId: so_done:TARGET_ID  — user finished selecting; open the offer detail modal
  if (action === "so_done") {
    const targetId = secondPart!;
    const key      = `${interaction.user.id}:${targetId}`;
    const state    = sendOfferState.get(key);

    // Translate selected playerIds back to the pipe-delimited format so_modal expects
    const selectedValues: string[] = state
      ? [...state.selected].map(pid => {
          const p = state.players.find(x => x.playerId === pid);
          return p ? `${p.playerId}|${p.firstName} ${p.lastName}|${p.position}|${p.overall}` : null;
        }).filter((v): v is string => v !== null)
      : [];

    if (selectedValues.length > 0) {
      pendingOfferPlayers.set(key, selectedValues);
      setTimeout(() => pendingOfferPlayers.delete(key), 15 * 60 * 1000);
    } else {
      pendingOfferPlayers.delete(key);
    }

    // Clean up roster page state — no longer needed after modal opens
    sendOfferState.delete(key);

    await interaction.showModal(buildSendOfferModal(targetId)).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal (so_done) error:", err);
    });
    return;
  }

  if (action === "tb_deal_yes") {
    const listingId   = parseInt(secondPart ?? "0", 10);
    const listingType = userId ?? "L"; // L = regular listing, I = ISO

    const modal = new ModalBuilder()
      .setCustomId(`tb_deal_modal:${listingId}:${listingType}`)
      .setTitle("📢 Announce Completed Trade");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("other_team")
          .setLabel("Who did you trade with? (team name)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder("e.g. Dallas Cowboys"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("what_sent")
          .setLabel("What did YOU send?")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder("e.g. Tyreek Hill (WR, 97 OVR) + 2026 Round 1 Pick"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("what_received")
          .setLabel("What did YOU receive?")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder("e.g. Davante Adams (WR, 95 OVR) + 200 coins"),
      ),
    );
    await interaction.showModal(modal).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal (tb_deal_yes) error:", err);
    });
    return;
  }

  // ── Trade Block: No deal, remove silently ─────────────────────────────────────
  if (action === "tb_deal_no") {
    const listingId   = parseInt(secondPart ?? "0", 10);
    const listingType = userId ?? "L";

    if (listingType === "I") {
      await db.update(tradeBlockISOTable).set({ status: "removed" }).where(eq(tradeBlockISOTable.id, listingId));
    } else {
      await db.update(tradeBlockListingsTable).set({ status: "removed" }).where(eq(tradeBlockListingsTable.id, listingId));
    }
    await interaction.update({ content: "✅ Listing removed from the trade block.", components: [] });

    try {
      const [ndSeason, ndUser] = await Promise.all([
        getOrCreateActiveSeason(interaction.guildId!),
        db.select({ team: usersTable.team }).from(usersTable).where(eq(usersTable.discordId, interaction.user.id)).limit(1),
      ]);
      const ndTeam = ndUser[0]?.team ?? interaction.user.username;
      void logTradeEvent({
        seasonId:  ndSeason.id,
        eventType: listingType === "I" ? "iso_removed" : "listing_removed",
        summary:   `${ndTeam} removed their ${listingType === "I" ? "ISO" : "trade block listing"} (no deal reached)`,
        teamA:     ndTeam,
      });
    } catch (_) {}

    return;
  }

  // ── Trade Block: Admin remove listing ─────────────────────────────────────────
  if (action === "tb_rm") {
    const listingId = parseInt(secondPart ?? "0", 10);
    const admin = await isAdminUser(interaction.user.id, interaction.guildId!);
    if (!admin) {
      await interaction.reply({ content: "❌ Only league commissioners can remove listings.", ephemeral: true });
      return;
    }
    await db.update(tradeBlockListingsTable).set({ status: "removed" }).where(eq(tradeBlockListingsTable.id, listingId));
    await interaction.reply({ content: `✅ Listing #${listingId} removed from the trade block.`, ephemeral: true });
    return;
  }

  // ── Trade Block: Admin remove ISO ─────────────────────────────────────────────
  if (action === "tb_rm_iso") {
    const isoId = parseInt(secondPart ?? "0", 10);
    const admin = await isAdminUser(interaction.user.id, interaction.guildId!);
    if (!admin) {
      await interaction.reply({ content: "❌ Only league commissioners can remove ISO posts.", ephemeral: true });
      return;
    }
    await db.update(tradeBlockISOTable).set({ status: "removed" }).where(eq(tradeBlockISOTable.id, isoId));
    await interaction.reply({ content: `✅ ISO #${isoId} removed from the trade block.`, ephemeral: true });
    return;
  }

  // ── Trade Block: Page navigation ──────────────────────────────────────────────
  if (action === "tb_page") {
    const page        = parseInt(secondPart ?? "0", 10);
    const isAdminMode = (userId ?? "0") === "1";

    await interaction.deferUpdate();
    const season = await getOrCreateActiveSeason(interaction.guildId!);
    const { embed, components } = await buildPageResponse(interaction.user.id, page, isAdminMode, season.id);
    await interaction.editReply({ embeds: [embed], components });
    return;
  }

  // ── Trade Block: Close view ───────────────────────────────────────────────────
  if (action === "tb_close_view") {
    try { await interaction.message.delete(); } catch (_) {
      await interaction.update({ components: [] });
    }
    return;
  }

  // ── Trade Block DM: Accept ───────────────────────────────────────────────────
  if (action === "tb_dm_acc") {
    // customId: tb_dm_acc:OFFEROR_ID:COINS:LISTING_ID:TYPE  (TYPE = L | I)
    const offerorId  = parts[1]!;
    const coins      = parseInt(parts[2] ?? "0", 10);
    const entryId    = parseInt(parts[3] ?? "0", 10);
    const entryType  = parts[4] ?? "L"; // L = listing, I = ISO

    await interaction.deferUpdate();

    const posterDiscordId = interaction.user.id;

    // Pull offer details from the original DM embed
    const originalEmbed  = interaction.message.embeds[0];
    const listingField   = originalEmbed?.fields?.[0]?.value ?? "—";
    const offerField     = originalEmbed?.fields?.[1]?.value ?? "—";

    // Fetch DB info for both teams
    const season        = await getOrCreateActiveSeason(interaction.guildId!);
    const [posterRow]   = await db.select({ team: usersTable.team, discordUsername: usersTable.discordUsername })
      .from(usersTable).where(eq(usersTable.discordId, posterDiscordId)).limit(1);
    const [offerorRow]  = await db.select({ team: usersTable.team, discordUsername: usersTable.discordUsername, balance: usersTable.balance })
      .from(usersTable).where(eq(usersTable.discordId, offerorId)).limit(1);

    // Use in-game team names for both parties — fall back to Discord username only if no team set
    const posterTeam    = posterRow?.team    ?? posterRow?.discordUsername    ?? interaction.user.username;
    const offerorTeam   = offerorRow?.team   ?? offerorRow?.discordUsername  ?? offerorId;

    // ── Coin transfer (offeror → poster) ────────────────────────────────────
    // The offeror offered coins as part of their deal; transfer them to the poster (acceptor).
    let coinNote = "";
    if (!isNaN(coins) && coins > 0) {
      const deducted = await deductBalance(offerorId, coins, interaction.guildId!);
      if (deducted) {
        await addBalance(posterDiscordId, coins, interaction.guildId!);
        coinNote = `\n💰 **${coins.toLocaleString()} coins** transferred from **${offerorTeam}** to **${posterTeam}**.`;
      } else {
        coinNote = `\n⚠️ Coin transfer of **${coins.toLocaleString()}** skipped — **${offerorTeam}** had insufficient balance.`;
      }
    }

    // ── Mark listing/ISO as removed ─────────────────────────────────────────
    if (entryType === "I") {
      await db.update(tradeBlockISOTable).set({ status: "removed" })
        .where(eq(tradeBlockISOTable.id, entryId)).catch(() => {});
    } else {
      await db.update(tradeBlockListingsTable).set({ status: "removed" })
        .where(eq(tradeBlockListingsTable.id, entryId)).catch(() => {});
    }

    // ── Record completed trade ────────────────────────────────────────────────
    // team1 = the offeror (who sent the send-offer); listingField = what they sent.
    // team2 = the poster/acceptor.
    await db.insert(completedTradesTable).values({
      seasonId:          season.id,
      listingId:         entryId || null,
      listingType:       entryType === "I" ? "iso" : "listing",
      team1DiscordId:    offerorId,
      team1Name:         offerorTeam,
      team2Name:         posterTeam,
      whatTeam1Sent:     listingField,
      whatTeam1Received: offerField,
    }).catch(err => console.error("[tb_dm_acc] Failed to insert completedTrade:", err));

    void logTradeEvent({
      seasonId:  season.id,
      eventType: "trade_completed",
      summary:   `${offerorTeam} and ${posterTeam} completed a trade`,
      teamA:     offerorTeam,
      teamB:     posterTeam,
    });

    // ── DM the offeror ────────────────────────────────────────────────────────
    try {
      const offeror = await interaction.client.users.fetch(offerorId);
      await offeror.send({
        content: `✅ **Your trade offer was accepted** by **${posterTeam}**! Check the server for the official trade announcement.${coinNote}`,
      });
    } catch (_) {}

    // ── @everyone announcement in general channel ────────────────────────────
    // The DM embed fields describe the offeror's side:
    //   field 0 (listingField) = what the offeror is sending
    //   field 1 (offerField)   = what the offeror is receiving
    const tradeEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("🔔 TRADE ALERT")
      .setDescription(`**${offerorTeam}** and **${posterTeam}** have completed a trade!`)
      .addFields(
        { name: `📤 ${offerorTeam} sends`,    value: listingField },
        { name: `📥 ${offerorTeam} receives`, value: offerField },
      )
      .setFooter({ text: "Trade accepted via The R.E.C. League trade block" })
      .setTimestamp();

    try {
      const tradeGeneralChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.GENERAL);
      const generalChannel = tradeGeneralChannelId ? await interaction.client.channels.fetch(tradeGeneralChannelId).catch(() => null) : null;
      if (generalChannel?.isTextBased()) {
        await (generalChannel as TextChannel).send({
          content: `@everyone${coinNote}`,
          embeds:  [tradeEmbed],
        });
      }
    } catch (err) { console.error("[tb_dm_acc] Failed to post general announcement:", err); }

    // ── Update the DM message (remove buttons, mark accepted) ────────────────
    await interaction.editReply({
      embeds:     interaction.message.embeds,
      components: [],
    }).catch(() => {});

    await interaction.followUp({
      content: `✅ **Trade accepted!** An announcement has been posted to the server.${coinNote}`,
      ephemeral: false,
    }).catch(() => {});
    return;
  }

  // ── Trade Block DM: Negotiate ─────────────────────────────────────────────────
  if (action === "tb_dm_neg") {
    const offerorId = secondPart!;
    await interaction.update({
      components: [],
      embeds: interaction.message.embeds,
    });
    await interaction.followUp({
      content:
        `🤝 **Negotiations opened!**\n\nYou can reply in this DM or reach out to <@${offerorId}> directly in the server to continue the discussion.`,
      ephemeral: false,
    }).catch(() => {});
    return;
  }

  // ── Trade Block DM: Decline ───────────────────────────────────────────────────
  if (action === "tb_dm_ref") {
    const offerorId = secondPart!;
    await interaction.update({
      components: [],
      embeds: interaction.message.embeds,
    });
    // DM the offeror that they were declined
    try {
      const offeror = await interaction.client.users.fetch(offerorId);
      await offeror.send({
        content: `❌ **Your trade offer was declined** by **${interaction.user.username}**. Feel free to reach out in the server if you'd like to renegotiate.`,
      });
    } catch (_) {}
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
        "```/admin-setpayouts```\n" +
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

      const { TextChannel, AttachmentBuilder } = await import("discord.js");
      const tc = faqChannel as InstanceType<typeof TextChannel>;
      const path = await import("path");
      const ASSETS_DIR = path.join(process.cwd(), "artifacts/discord-bot/assets");

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

  // ── GOTY: commissioner opens winner selection ─────────────────────────────────
  if (action === "goty_select") {
    const seasonId = parseInt(secondPart ?? "0", 10);
    await interaction.deferReply({ ephemeral: true });

    const allUsers = await db.select({ discordId: usersTable.discordId, team: usersTable.team })
      .from(usersTable);
    const teamsWithUsers = allUsers
      .filter(u => u.team)
      .sort((a, b) => (a.team ?? "").localeCompare(b.team ?? ""))
      .slice(0, 25); // Discord select menu max 25

    if (teamsWithUsers.length === 0) {
      await interaction.editReply({ content: "❌ No users with teams found." });
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`goty_winners:${seasonId}`)
      .setPlaceholder("Select 1 or 2 GOTY winners...")
      .setMinValues(1)
      .setMaxValues(2)
      .addOptions(teamsWithUsers.map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(u.team!)
          .setValue(u.discordId)
      ));

    await interaction.editReply({
      content: "Select **1 or 2** GOTY winners. Each will receive coins + 1 free XF promotion.\n*(Select 1 if the other winner's team is now CPU-controlled.)*",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
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
          `Use \`/admin-reverse-transaction\` or the game settings to apply the OVR reduction.`,
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
}

// ── String select menu handler ─────────────────────────────────────────────────
async function handleSelectMenu(interaction: StringSelectMenuInteraction) {
  const parts     = interaction.customId.split(":");
  const action    = parts[0]!;
  const sessionId = parts[1] ?? "";

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

  // ── Attribute-up: user selected an attribute to upgrade ───────────────────
  if (action === "aup_sel") { await handleAupSel(interaction); return; }

  // ── GOTY: commissioner selected the 2 winners ─────────────────────────────────
  if (action === "goty_winners") {
    const seasonId   = parseInt(parts[1] ?? "0", 10);
    const winnerIds  = interaction.values; // 2 Discord user IDs

    await interaction.deferUpdate();

    const gotyCoins = await getPayoutValue(PAYOUT_KEYS.GOTY_WINNER);

    const winnerLines: string[] = [];

    for (const discordId of winnerIds) {
      const [userRow] = await db.select({ team: usersTable.team })
        .from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
      const team = userRow?.team ?? "Unknown";

      if (gotyCoins > 0) {
        await addBalance(discordId, gotyCoins, interaction.guildId!);
        await logTransaction(discordId, gotyCoins, "addcoins",
          `GOTY Award Winner — Season ${seasonId}`, interaction.guildId!, interaction.user.id);
      }

      winnerLines.push(`🏆 <@${discordId}> (${team})`);

      try {
        const u = await interaction.client.users.fetch(discordId);
        await u.send(
          `🎮 **You've been selected as a Game of the Year Award winner!**\n\n` +
          `**+${gotyCoins} 🪙 coins** have been added to your balance!\n\n` +
          `You also receive **1 free XF promotion** for any player on your roster. ` +
          `This cannot be saved and must be used before the start of the next season. ` +
          `Coordinate with the commissioner to apply it!`
        ).catch(() => {});
      } catch (_) {}
    }

    // Post to general channel
    const gotyCount   = winnerIds.length;
    const gotyNoun    = gotyCount === 1 ? "winner" : "winners";
    const gotyEach    = gotyCount === 1 ? "The winner receives" : "Each winner receives";

    try {
      const gotyGeneralChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.GENERAL);
      const generalChannel = gotyGeneralChannelId ? await interaction.client.channels.fetch(gotyGeneralChannelId).catch(() => null) : null;
      if (generalChannel?.isTextBased()) {
        const announceEmbed = new EmbedBuilder()
          .setTitle(`🎮 GAME OF THE YEAR AWARD ${gotyNoun.toUpperCase()}!`)
          .setColor(Colors.Gold)
          .setDescription(
            `Congratulations to this season's **Game of the Year** award ${gotyNoun}!\n\n` +
            winnerLines.join("\n") + "\n\n" +
            `${gotyEach} **+${gotyCoins} 🪙** and a **free XF promotion** for any player on their roster.\n` +
            `⚠️ The XF promotion cannot be saved — it must be used before the start of the next season.`
          )
          .setTimestamp();
        await (generalChannel as TextChannel).send({ content: "@everyone", embeds: [announceEmbed] });
      }
    } catch (err) { console.error("Failed to post GOTY announcement:", err); }

    // Clear the GOTY channel to prepare it for next season
    try {
      const gotyChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.GOTY);
      const gotyChannel = gotyChannelId ? await interaction.client.channels.fetch(gotyChannelId).catch(() => null) : null;
      if (gotyChannel?.isTextBased()) {
        const tc = gotyChannel as TextChannel;
        const msgs = await tc.messages.fetch({ limit: 100 });
        if (msgs.size > 0) {
          await tc.bulkDelete(msgs, true).catch(async () => {
            for (const m of msgs.values()) await m.delete().catch(() => {});
          });
        }
      }
    } catch (err) { console.error("Failed to clear GOTY channel:", err); }

    // Update the commissioner message to show done state
    const doneEmbed = new EmbedBuilder()
      .setTitle("✅ GOTY Winners Selected")
      .setColor(Colors.Green)
      .setDescription(winnerLines.join("\n"))
      .addFields(
        { name: "Coins Awarded", value: `+${gotyCoins} 🪙 each`, inline: true },
        { name: "GOTY Channel", value: "Cleared for next season ✅", inline: true },
      )
      .setFooter({ text: `Selected by ${interaction.user.username}` })
      .setTimestamp();
    await interaction.editReply({ embeds: [doneEmbed], components: [] });
    return;
  }

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

}

// ── Modal handler ──────────────────────────────────────────────────────────────
async function handleModal(interaction: ModalSubmitInteraction) {
  const parts  = interaction.customId.split(":");
  const action = parts[0]!;
  const idStr  = parts[1];

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
    // Format: interview_answer_modal:i1,i2,i3
    const indicesStr = idStr!;
    const indices    = indicesStr.split(",").map(Number);
    const q1 = INTERVIEW_QUESTIONS[indices[0]!]!;
    const q2 = INTERVIEW_QUESTIONS[indices[1]!]!;
    const q3 = INTERVIEW_QUESTIONS[indices[2]!]!;
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
    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("🎙️ Post-Game Interview")
      .addFields(
        { name: "Player", value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
        { name: "Week",   value: weekDisplay, inline: true },
        { name: `Q1: ${q1.slice(0, 200)}`, value: a1.slice(0, 1000) },
        { name: `Q2: ${q2.slice(0, 200)}`, value: a2.slice(0, 1000) },
        { name: `Q3: ${q3.slice(0, 200)}`, value: a3.slice(0, 1000) },
        { name: "Payout if Approved", value: `+**${INTERVIEW_PAYOUT} coins**` },
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

  // ── Send Offer: modal submitted — build & DM the trade offer ─────────────────
  // customId: so_modal:TARGET_ID
  if (action === "so_modal") {
    const targetId        = parts[1]!;
    const sendPicks       = interaction.fields.getTextInputValue("send_picks").trim();
    const sendCoins       = interaction.fields.getTextInputValue("send_coins").trim();
    const wantPlayersPicks = interaction.fields.getTextInputValue("want_players_picks").trim();
    const wantCoins       = interaction.fields.getTextInputValue("want_coins").trim();

    // Retrieve any players selected from the roster dropdown (may be empty if skipped)
    const mapKey        = `${interaction.user.id}:${targetId}`;
    const selectedPlayers = pendingOfferPlayers.get(mapKey) ?? [];
    pendingOfferPlayers.delete(mapKey); // always clean up

    // Require at least one thing being offered
    if (selectedPlayers.length === 0 && !sendPicks && !sendCoins) {
      await interaction.reply({
        content: "❌ You must include at least one thing in your offer (players, picks, or coins).",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const myTeam = await getMyTeam(interaction.user.id, interaction.guildId!);

    // ── Build "Offering" section ───────────────────────────────────────────────
    const offerParts: string[] = [];

    if (selectedPlayers.length > 0) {
      const playerLines = selectedPlayers.map(v => {
        const [, name, pos, ovr] = v.split("|");
        return `• ${name} (${pos}) OVR ${ovr}`;
      });
      offerParts.push(`🏈 **Players (${selectedPlayers.length}):**\n${playerLines.join("\n")}`);
    }
    if (sendPicks)  offerParts.push(`📋 **Picks:** ${sendPicks}`);
    if (sendCoins)  offerParts.push(`💰 **Coins:** ${sendCoins}`);
    const offerValue = offerParts.join("\n");

    // ── Build "Requesting" section ─────────────────────────────────────────────
    const wantParts: string[] = [];
    if (wantPlayersPicks) wantParts.push(wantPlayersPicks);
    if (wantCoins)        wantParts.push(`💰 **Coins:** ${wantCoins}`);
    const wantValue = wantParts.join("\n") || "*Open to discussion*";

    // ── Parse coins for Accept button transfer ─────────────────────────────────
    const parsedCoins = parseInt(sendCoins.replace(/[^0-9]/g, ""), 10);
    const safeCoins   = isNaN(parsedCoins) ? 0 : parsedCoins;

    const dmEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`🤝 Trade Offer from ${myTeam}`)
      .setDescription(`<@${interaction.user.id}> has sent you a trade offer!`)
      .addFields(
        { name: "📦 They're Offering", value: offerValue },
        { name: "🔎 They Want in Return", value: wantValue },
      )
      .setFooter({ text: `Reply to negotiate or reach out to ${interaction.user.username} in the server.` })
      .setTimestamp();

    // Accept button uses tb_dm_acc with entryId=0 (direct offer, not a listing)
    const dmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`tb_dm_acc:${interaction.user.id}:${safeCoins}:0:L`)
        .setLabel("✅ Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tb_dm_neg:${interaction.user.id}`)
        .setLabel("🤝 Negotiate")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`tb_dm_ref:${interaction.user.id}`)
        .setLabel("❌ Decline")
        .setStyle(ButtonStyle.Danger),
    );

    try {
      const targetUser = await interaction.client.users.fetch(targetId);
      await targetUser.send({ embeds: [dmEmbed], components: [dmRow] });
    } catch (_) {
      await interaction.editReply({
        content: `❌ Could not DM <@${targetId}>. They may have DMs disabled. Try reaching out directly in the server.`,
      });
      return;
    }

    const confirmEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Trade Offer Sent")
      .setDescription(`Your offer was sent to <@${targetId}> via DM. They'll see Accept / Negotiate / Decline buttons.`)
      .addFields(
        { name: "📦 You Offered", value: offerValue },
        { name: "🔎 You Want Back", value: wantValue },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [confirmEmbed] });

    try {
      const [soSeason, targetTeam] = await Promise.all([
        getOrCreateActiveSeason(interaction.guildId!),
        getMyTeam(targetId, interaction.guildId!),
      ]);
      void logTradeEvent({
        seasonId:  soSeason.id,
        eventType: "offer_sent",
        summary:   `${myTeam} sent a direct trade offer to ${targetTeam}`,
        teamA:     myTeam,
        teamB:     targetTeam,
      });
    } catch (_) {}

    return;
  }

  // ── Trade Block: offer submitted ──────────────────────────────────────────────
  if (action === "tb_offer_modal") {
    const listingId       = parseInt(idStr ?? "0", 10);
    const posterDiscordId = parts[2]!;
    const offerAssets     = interaction.fields.getTextInputValue("offer_assets");
    const offerCoinsRaw   = interaction.fields.getTextInputValue("offer_coins").trim();
    const offerMessage    = interaction.fields.getTextInputValue("offer_message").trim();
    const offerCoins      = parseInt(offerCoinsRaw, 10);
    const coinsStr        = !isNaN(offerCoins) && offerCoins > 0 ? `💰 ${offerCoins.toLocaleString()} coins` : "";

    await interaction.deferReply({ ephemeral: true });

    const [listing] = await db.select().from(tradeBlockListingsTable)
      .where(eq(tradeBlockListingsTable.id, listingId)).limit(1);

    if (!listing || listing.status !== "active") {
      await interaction.editReply({ content: "❌ This listing is no longer active." });
      return;
    }

    type TItem =
      | { type: "player"; firstName: string; lastName: string; position: string; overall: number }
      | { type: "pick"; description: string }
      | { type: "coins"; amount: number };
    const theirItems = (listing.items as TItem[]).map(item => {
      if (item.type === "player") return `• ${item.firstName} ${item.lastName} (${item.position}) OVR ${item.overall}`;
      if (item.type === "pick")   return `• 📋 ${item.description}`;
      return `• 💰 ${item.amount.toLocaleString()} coins`;
    }).join("\n");

    const senderName = interaction.user.username;
    const offerBody  = [offerAssets, coinsStr].filter(Boolean).join("\n");

    const dmEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`🤝 Trade Offer Received! (Listing #${listingId})`)
      .setDescription(`<@${interaction.user.id}> wants to make a deal!${offerMessage ? `\n\n💬 *"${offerMessage}"*` : ""}`)
      .addFields(
        { name: "📦 Your Listing", value: theirItems + (listing.notes ? `\n🔎 *Asking for: ${listing.notes}*` : "") },
        { name: "📨 Their Offer", value: offerBody || "*See their message above*" },
      )
      .setFooter({ text: `Reply in this DM or reach out to ${senderName} in the server` })
      .setTimestamp();

    const safeOfferCoins = !isNaN(offerCoins) && offerCoins > 0 ? offerCoins : 0;
    const dmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`tb_dm_acc:${interaction.user.id}:${safeOfferCoins}:${listingId}:L`)
        .setLabel("✅ Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tb_dm_neg:${interaction.user.id}`)
        .setLabel("🤝 Negotiate")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`tb_dm_ref:${interaction.user.id}`)
        .setLabel("❌ Decline")
        .setStyle(ButtonStyle.Danger),
    );

    try {
      const poster = await interaction.client.users.fetch(posterDiscordId);
      await poster.send({ embeds: [dmEmbed], components: [dmRow] });
    } catch (_) {}

    await interaction.editReply({ content: "✅ Your offer has been sent! They'll receive Accept / Negotiate / Decline buttons in their DM." });

    try {
      const [tbSeason, offerorRows, posterRows] = await Promise.all([
        getOrCreateActiveSeason(interaction.guildId!),
        db.select({ team: usersTable.team }).from(usersTable).where(eq(usersTable.discordId, interaction.user.id)).limit(1),
        db.select({ team: usersTable.team }).from(usersTable).where(eq(usersTable.discordId, posterDiscordId)).limit(1),
      ]);
      const offerorTeam = offerorRows[0]?.team ?? interaction.user.username;
      const posterTeam  = posterRows[0]?.team ?? "Unknown Team";
      void logTradeEvent({
        seasonId:  tbSeason.id,
        eventType: "offer_sent",
        summary:   `${offerorTeam} sent a trade offer to ${posterTeam} (Listing #${listingId})`,
        teamA:     offerorTeam,
        teamB:     posterTeam,
      });
    } catch (_) {}

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

  // ── Trade Block ISO: offer submitted ──────────────────────────────────────────
  if (action === "tb_iso_offer_modal") {
    const isoId           = parseInt(idStr ?? "0", 10);
    const posterDiscordId = parts[2]!;
    const offerAssets     = interaction.fields.getTextInputValue("offer_assets");
    const offerCoinsRaw   = interaction.fields.getTextInputValue("offer_coins").trim();
    const offerMessage    = interaction.fields.getTextInputValue("offer_message").trim();
    const offerCoins      = parseInt(offerCoinsRaw, 10);
    const coinsStr        = !isNaN(offerCoins) && offerCoins > 0 ? `💰 ${offerCoins.toLocaleString()} coins` : "";

    await interaction.deferReply({ ephemeral: true });

    const [iso] = await db.select().from(tradeBlockISOTable)
      .where(eq(tradeBlockISOTable.id, isoId)).limit(1);

    if (!iso || iso.status !== "active") {
      await interaction.editReply({ content: "❌ This ISO post is no longer active." });
      return;
    }

    const sd = iso.seekingDetails as any;
    let seekingDesc = "";
    if (iso.seekingType === "multi") {
      const seekParts: string[] = [];
      if (sd.positions?.length)  seekParts.push(sd.positions.join(", "));
      if (sd.pickInfo)           seekParts.push(formatPickInfo(sd.pickInfo));
      else if (sd.pickRounds?.length) seekParts.push(`Round ${sd.pickRounds.join("/")} picks`);
      if (sd.wantsCoins)         seekParts.push("💰 Coins");
      seekingDesc = seekParts.join(" · ") || "various assets";
    } else if (iso.seekingType === "player_position") {
      seekingDesc = `${sd.position ?? "?"} player`;
    } else if (iso.seekingType === "draft_pick") {
      seekingDesc = `Round ${(sd.rounds ?? []).join("/")} picks`;
    } else {
      seekingDesc = `${(sd.amount ?? 0).toLocaleString()} coins`;
    }

    const senderName = interaction.user.username;
    const offerBody  = [offerAssets, coinsStr].filter(Boolean).join("\n");

    const dmEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`🤝 Trade Response to Your ISO! (ISO #${isoId})`)
      .setDescription(`<@${interaction.user.id}> is responding to your ISO!${offerMessage ? `\n\n💬 *"${offerMessage}"*` : ""}`)
      .addFields(
        { name: "🔍 Your ISO — Seeking", value: seekingDesc },
        { name: "📨 Their Offer", value: offerBody || "*See their message above*" },
      )
      .setFooter({ text: `Reply in this DM or reach out to ${senderName} in the server` })
      .setTimestamp();

    const safeIsoCoins = !isNaN(offerCoins) && offerCoins > 0 ? offerCoins : 0;
    const dmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`tb_dm_acc:${interaction.user.id}:${safeIsoCoins}:${isoId}:I`)
        .setLabel("✅ Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tb_dm_neg:${interaction.user.id}`)
        .setLabel("🤝 Negotiate")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`tb_dm_ref:${interaction.user.id}`)
        .setLabel("❌ Decline")
        .setStyle(ButtonStyle.Danger),
    );

    try {
      const poster = await interaction.client.users.fetch(posterDiscordId);
      await poster.send({ embeds: [dmEmbed], components: [dmRow] });
    } catch (_) {}

    await interaction.editReply({ content: "✅ Your offer has been sent! They'll receive Accept / Negotiate / Decline buttons in their DM." });

    try {
      const [isoSeason, offerorIsoRows, posterIsoRows] = await Promise.all([
        getOrCreateActiveSeason(interaction.guildId!),
        db.select({ team: usersTable.team }).from(usersTable).where(eq(usersTable.discordId, interaction.user.id)).limit(1),
        db.select({ team: usersTable.team }).from(usersTable).where(eq(usersTable.discordId, posterDiscordId)).limit(1),
      ]);
      const offerorIsoTeam = offerorIsoRows[0]?.team ?? interaction.user.username;
      const posterIsoTeam  = posterIsoRows[0]?.team ?? "Unknown Team";
      void logTradeEvent({
        seasonId:  isoSeason.id,
        eventType: "offer_sent",
        summary:   `${offerorIsoTeam} sent an offer to ${posterIsoTeam}'s ISO (ISO #${isoId})`,
        teamA:     offerorIsoTeam,
        teamB:     posterIsoTeam,
      });
    } catch (_) {}

    return;
  }

  // ── Trade Block: Deal announcement modal submitted ───────────────────────────
  if (action === "tb_deal_modal") {
    const listingId   = parseInt(idStr ?? "0", 10);
    const listingType = parts[2] ?? "L"; // L = listing, I = ISO

    const otherTeam   = interaction.fields.getTextInputValue("other_team").trim();
    const whatSent    = interaction.fields.getTextInputValue("what_sent").trim();
    const whatReceived = interaction.fields.getTextInputValue("what_received").trim();

    await interaction.deferReply({ ephemeral: true });

    // Fetch the listing/ISO to get team1's info
    let team1Name = "Unknown Team";
    let seasonId  = 0;
    try {
      const season = await getOrCreateActiveSeason(interaction.guildId!);
      seasonId = season.id;
      if (listingType === "I") {
        const [iso] = await db.select({ teamName: tradeBlockISOTable.teamName, discordId: tradeBlockISOTable.discordId })
          .from(tradeBlockISOTable).where(eq(tradeBlockISOTable.id, listingId)).limit(1);
        if (iso) {
          team1Name = iso.teamName || "Unknown Team";
          if (iso.discordId !== interaction.user.id) {
            await interaction.editReply({ content: "❌ This listing doesn't belong to you." });
            return;
          }
        }
        await db.update(tradeBlockISOTable).set({ status: "removed" }).where(eq(tradeBlockISOTable.id, listingId));
      } else {
        const [listing] = await db.select({ teamName: tradeBlockListingsTable.teamName, discordId: tradeBlockListingsTable.discordId })
          .from(tradeBlockListingsTable).where(eq(tradeBlockListingsTable.id, listingId)).limit(1);
        if (listing) {
          team1Name = listing.teamName || "Unknown Team";
          if (listing.discordId !== interaction.user.id) {
            await interaction.editReply({ content: "❌ This listing doesn't belong to you." });
            return;
          }
        }
        await db.update(tradeBlockListingsTable).set({ status: "removed" }).where(eq(tradeBlockListingsTable.id, listingId));
      }
    } catch (err) {
      console.error("[tb_deal_modal] DB error:", err);
    }

    // Record the completed trade
    try {
      await db.insert(completedTradesTable).values({
        seasonId,
        listingId:         listingId || null,
        listingType:       listingType === "I" ? "iso" : "listing",
        team1DiscordId:    interaction.user.id,
        team1Name,
        team2Name:         otherTeam,
        whatTeam1Sent:     whatSent,
        whatTeam1Received: whatReceived,
      });
    } catch (err) {
      console.error("[tb_deal_modal] Failed to insert completedTrade:", err);
    }

    void logTradeEvent({
      seasonId,
      eventType: "trade_completed",
      summary:   `${team1Name} and ${otherTeam} completed a trade — ${team1Name} sent: ${whatSent.slice(0, 80)}`,
      teamA:     team1Name,
      teamB:     otherTeam,
    });

    // Build trade announcement embed
    const tradeEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("🔔 TRADE ALERT")
      .setDescription(`**${team1Name}** and **${otherTeam}** have completed a trade!`)
      .addFields(
        { name: `📤 ${team1Name} sends`, value: whatSent },
        { name: `📥 ${team1Name} receives`, value: whatReceived },
      )
      .setFooter({ text: "Trade reported via The R.E.C. League trade block" })
      .setTimestamp();

    // Post to general channel with @everyone
    try {
      const tbDealGeneralChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.GENERAL);
      const generalChannel = tbDealGeneralChannelId ? await interaction.client.channels.fetch(tbDealGeneralChannelId).catch(() => null) : null;
      if (generalChannel?.isTextBased()) {
        await (generalChannel as TextChannel).send({
          content: "@everyone",
          embeds: [tradeEmbed],
        });
      }
    } catch (err) {
      console.error("[tb_deal_modal] Failed to post announcement:", err);
    }

    await interaction.editReply({
      content: `✅ Trade announced in the server! **${team1Name}** ↔ **${otherTeam}** is now on record.`,
    });
    return;
  }

}
