/**
 * /admin-operations hub — admin-facing interactions with prefix ao_
 * Session TTL: 15 minutes (keyed by `${guildId}:${userId}`)
 */
import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  EmbedBuilder, Colors, TextChannel, ChannelType, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder, ComponentType, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  seasonsTable, franchiseScheduleTable, usersTable, gameChannelsTable,
  gotwHistoryTable, franchiseMcaTeamsTable,
  playerSeasonStatsTable, playerStatWeekProcessedTable,
  gameLogTable, userRecordsTable, statPaddingViolationsTable,
  defaultTeamLogosTable, waitlistTable,
  serverSettingsTable, franchiseRostersTable, inventoryTable, legendsTable, customPlayersTable,
  guildChannelsTable, gameSchedulesTable,
} from "@workspace/db";
import { eq, and, sql, ne, desc, inArray } from "drizzle-orm";
import {
  getOrCreateActiveSeason, addBalance, logTransaction,
  getGuildChannel, CHANNEL_KEYS,
  getOrSeedRules, setRules, getAllSections,
  getScheduleSeasonId,
} from "../db/db-helpers.js";
import { WEEK_SEQUENCE, weekLabel } from "../helpers/week-helpers.js";
import { lookupNflDivision } from "../constants.js";
import { runWildcardAutomation, runOffseasonHistoricalPost } from "../franchise/wildcard-automation.js";
import { runEosAutoPost } from "../franchise/eos-auto-post.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";
import { runWeeklyMatchupsFlow } from "../franchise/weekly-matchups-runner.js";
import { PLAYOFF_WEEK_META, runPlayoffMatchupsFlow, payoutPlayoffRoundResults, autoDivisionBonus } from "../franchise/playoff-matchups-runner.js";
import axios from "axios";
import { autoPayoutPlayoffGotw, purgeChannel } from "../helpers/gotw-helpers.js";
import { checkAndNotifyWaitlist } from "../league/waitlist-helpers.js";
import { globalLogoPath } from "../franchise/gcs-reader.js";
import { buildAdminOpsEmbed, buildAdminOpsRows } from "./admin-helpers/admin-ops-ui.js";
import { buildPayoutHubEmbed, buildPayoutHubRows } from "./admin-payout-handlers.js";
import { buildUserDataHubEmbed, buildUserDataHubRows } from "./admin-user-handlers.js";
import {
  buildTroubleshootEmbed, buildTroubleshootRows,
  handleTsMilestoneAudit,
} from "./admin-troubleshoot-handlers.js";
import { runNewServerInit, runExistingServerInit } from "./admin-helpers/server-init.js";
import { registerCommandsForGuild } from "../discord/register-commands.js";
import { buildLeagueDataMainMenu } from "./league-data-handlers.js";
import { getServerSettings, buildSettingsEmbed, buildSettingsRows } from "../db/server-settings.js";
import { setGuildChannel, getRosterSeasonId } from "../db/db-helpers.js";
import { runWeeklyTrainerTick, expireAllActiveTrainersForSeason } from "../economy/positional-trainer.js";
import { rebuildHistoricalChannel } from "../franchise/wildcard-automation.js";
import { ensureScheduleRow, buildHeaderEmbed, buildHeaderRow } from "./game-scheduling-handlers.js";
import { nextAdvanceDeadline, formatAllZones, discordTimestampLong } from "../discord/timezones.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type AnyInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

interface AoSession {
  guildId: string;
  userId: string;
  rulesSection?: string;
  rulesPage?: number;
  adminsAddPage?: number;
  expiresAt: number;
}

// ── Session management ─────────────────────────────────────────────────────────

const aoSessions = new Map<string, AoSession>();
const AO_SESSION_TTL = 15 * 60 * 1000;

function getAoSession(guildId: string, userId: string): AoSession {
  const key = `${guildId}:${userId}`;
  let sess = aoSessions.get(key);
  if (!sess || sess.expiresAt < Date.now()) {
    sess = { guildId, userId, expiresAt: Date.now() + AO_SESSION_TTL };
    aoSessions.set(key, sess);
  }
  sess.expiresAt = Date.now() + AO_SESSION_TTL;
  return sess;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

const RULES_PAGE_CHAR_LIMIT = 3800;

export function buildRulesPages(rules: string[]): string[] {
  if (rules.length === 0) return ["_No rules in this section yet._"];
  const pages: string[] = [];
  let current = "";
  for (let i = 0; i < rules.length; i++) {
    const line = `**${i + 1}.** ${rules[i]}`;
    const candidate = current ? current + "\n\n" + line : line;
    if (candidate.length > RULES_PAGE_CHAR_LIMIT && current) {
      pages.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) pages.push(current);
  return pages;
}

function buildRulesEmbed(
  section: string,
  sectionMeta: { title: string; color: number },
  rules: string[],
  page = 0,
): EmbedBuilder {
  const pages   = buildRulesPages(rules);
  const maxPage = Math.max(0, pages.length - 1);
  const safePage = Math.min(Math.max(0, page), maxPage);
  const content  = pages[safePage] ?? "_No rules in this section yet._";
  const footer   = pages.length > 1
    ? `Section: ${section} · ${rules.length} rule${rules.length !== 1 ? "s" : ""} · Page ${safePage + 1}/${pages.length}`
    : `Section: ${section} · ${rules.length} rule${rules.length !== 1 ? "s" : ""}`;

  return new EmbedBuilder()
    .setColor(sectionMeta.color)
    .setTitle(sectionMeta.title)
    .setDescription(content)
    .setFooter({ text: footer });
}

function buildRulesButtonsWithPage(rulesCount: number, page: number, totalPages: number): ActionRowBuilder<ButtonBuilder>[] {
  const editDisabled   = rulesCount === 0;
  const deleteDisabled = rulesCount === 0;
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_rules_add").setLabel("➕ Add Rule").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_rules_edit").setLabel("✏️ Edit Rule").setStyle(ButtonStyle.Primary).setDisabled(editDisabled),
    new ButtonBuilder().setCustomId("ao_rules_delete").setLabel("🗑️ Delete Rule").setStyle(ButtonStyle.Danger).setDisabled(deleteDisabled),
    new ButtonBuilder().setCustomId("ao_rules_back_sections").setLabel("← Sections").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
  if (totalPages <= 1) return [row1];
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ao_rules_page:${page - 1}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`ao_rules_page:${page + 1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );
  return [row1, row2];
}


// ── Main dispatch ──────────────────────────────────────────────────────────────

export async function handleAdminOperationsInteraction(interaction: AnyInteraction): Promise<boolean> {
  const id      = interaction.customId;
  const guildId = interaction.guildId!;
  const userId  = interaction.user.id;
  const sess    = getAoSession(guildId, userId);

  // ── Hub close ────────────────────────────────────────────────────────────────
  if (id === "ao_hub_close") {
    await (interaction as ButtonInteraction).update({
      embeds: [new EmbedBuilder().setColor(Colors.DarkGrey).setDescription("✖ Hub closed.")],
      components: [],
    });
    return true;
  }

  // ── Back to hub main screen ─────────────────────────────────────────────────
  if (id === "ao_hub_back") {
    const season  = await getOrCreateActiveSeason(guildId).catch(() => null);
    const wkStr   = season ? weekLabel(season.currentWeek) : undefined;
    await (interaction as ButtonInteraction).update({
      embeds: [buildAdminOpsEmbed(season?.seasonNumber ?? undefined, wkStr)],
      components: buildAdminOpsRows(),
    });
    return true;
  }

  // ── Advance Period (24/48/72/96/120h) ───────────────────────────────────────
  if (id === "ao_advance_period_open") {
    const settings = await getServerSettings(guildId);
    const current  = settings.advancePeriodHours ?? 72;
    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("⏱️ Advance Period")
      .setDescription(
        `How long between each Advance Week?\n\n` +
        `**Current: ${current}h**\n\n` +
        `This drives the "Next Advance" deadline shown on every game channel header. ` +
        `Games can't be scheduled to land within 1h of the deadline.`
      );
    const opts = [24, 48, 72, 96, 120];
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      opts.map((h) =>
        new ButtonBuilder()
          .setCustomId(`ao_advance_period_set:${h}`)
          .setLabel(`${h}h`)
          .setStyle(h === current ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    );
    await (interaction as ButtonInteraction).update({ embeds: [embed], components: [row] });
    return true;
  }

  if (id.startsWith("ao_advance_period_set:")) {
    const h = parseInt(id.split(":")[1] ?? "72", 10);
    if (![24, 48, 72, 96, 120].includes(h)) {
      await (interaction as ButtonInteraction).reply({ content: "Invalid value.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await db.update(serverSettingsTable)
      .set({ advancePeriodHours: h, updatedAt: new Date() })
      .where(eq(serverSettingsTable.guildId, guildId));
    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Advance Period Updated")
      .setDescription(`Advance Period is now **${h}h**. New game channel headers will reflect the new "Next Advance" deadline.`);
    const opts = [24, 48, 72, 96, 120];
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      opts.map((opt) =>
        new ButtonBuilder()
          .setCustomId(`ao_advance_period_set:${opt}`)
          .setLabel(`${opt}h`)
          .setStyle(opt === h ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    );
    await (interaction as ButtonInteraction).update({ embeds: [embed], components: [row] });
    return true;
  }

  // ── Set Week ─────────────────────────────────────────────────────────────────
  if (id === "ao_set_week") {
    await handleSetWeek(interaction as ButtonInteraction);
    return true;
  }

  if (id === "ao_setwk_sel") {
    await handleSetWeekSelect(interaction as StringSelectMenuInteraction, sess);
    return true;
  }

  // ── Advance Week ─────────────────────────────────────────────────────────────
  if (id === "ao_advance_week") {
    await handleAdvanceWeek(interaction as ButtonInteraction);
    return true;
  }

  if (id === "ao_advance_confirm") {
    await handleAdvanceConfirm(interaction as ButtonInteraction);
    return true;
  }

  // ── Set Season Number ─────────────────────────────────────────────────────────
  if (id === "ao_set_season_num") {
    await handleSetSeasonNum(interaction as ButtonInteraction);
    return true;
  }

  if (id === "ao_set_season_num_sel") {
    await handleSetSeasonNumSel(interaction as StringSelectMenuInteraction);
    return true;
  }

  if (id.startsWith("ao_set_season_num_confirm:")) {
    await handleSetSeasonNumConfirm(interaction as ButtonInteraction);
    return true;
  }

  // ── Rules ────────────────────────────────────────────────────────────────────
  if (id === "ao_rules") {
    await handleRulesHub(interaction as ButtonInteraction, sess);
    return true;
  }

  if (id === "ao_rules_section") {
    await handleRulesSection(interaction as StringSelectMenuInteraction, sess);
    return true;
  }

  if (id === "ao_rules_back_sections") {
    await handleRulesHub(interaction as ButtonInteraction, sess);
    return true;
  }

  if (id === "ao_rules_add") {
    await handleRulesAdd(interaction as ButtonInteraction, sess);
    return true;
  }

  if (id === "ao_rules_edit") {
    await handleRulesEdit(interaction as ButtonInteraction, sess);
    return true;
  }

  if (id === "ao_rules_edit_sel") {
    await handleRulesEditSel(interaction as StringSelectMenuInteraction, sess);
    return true;
  }

  if (id === "ao_rules_delete") {
    await handleRulesDelete(interaction as ButtonInteraction, sess);
    return true;
  }

  // Rules pagination
  if (id.startsWith("ao_rules_page:")) {
    await handleRulesPage(interaction as ButtonInteraction, sess);
    return true;
  }

  // Modal submits — Rules
  if (id === "ao_modal_rules_add") {
    await handleModalRulesAdd(interaction as ModalSubmitInteraction, sess);
    return true;
  }
  if (id === "ao_modal_rules_edit") {
    await handleModalRulesEdit(interaction as ModalSubmitInteraction, sess);
    return true;
  }
  if (id === "ao_modal_rules_delete") {
    await handleModalRulesDelete(interaction as ModalSubmitInteraction, sess);
    return true;
  }

  // ── Payouts hub ───────────────────────────────────────────────────────────────
  if (id === "ao_payouts") {
    await handlePayoutsHub(interaction as ButtonInteraction);
    return true;
  }

  // ── Draft Lottery setup (step 1 — show role picker) ──────────────────────────
  if (id === "ao_lottery") {
    const { handleLotterySetup } = await import("./lottery-handler.js");
    await handleLotterySetup(interaction as ButtonInteraction);
    return true;
  }

  // ── Post Matchups/GOTW ────────────────────────────────────────────────────────
  if (id === "ao_post_matchups") {
    await handlePostMatchups(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_post_matchups_confirm") {
    await handlePostMatchupsConfirm(interaction as ButtonInteraction);
    return true;
  }

  // ── Post Game Channels ────────────────────────────────────────────────────────
  if (id === "ao_post_game_channels") {
    await handlePostGameChannels(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_modal_post_game_channels") {
    await handlePostGameChannelsModal(interaction as ModalSubmitInteraction);
    return true;
  }

  // ── Waitlist hub ──────────────────────────────────────────────────────────────
  if (id === "ao_waitlist") {
    await handleWaitlistHub(interaction as ButtonInteraction);
    return true;
  }
  if (id.startsWith("ao_waitlist_edit:")) {
    await handleWaitlistEdit(interaction as ButtonInteraction, sess);
    return true;
  }
  if (id === "ao_modal_waitlist_edit") {
    await handleModalWaitlistEdit(interaction as ModalSubmitInteraction);
    return true;
  }
  if (id.startsWith("ao_waitlist_delete:")) {
    await handleWaitlistDelete(interaction as ButtonInteraction);
    return true;
  }

  // ── Admins hub ────────────────────────────────────────────────────────────────
  if (id === "ao_admins") {
    await handleAdminsHub(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_admins_add") {
    await handleAdminsAdd(interaction as ButtonInteraction, sess);
    return true;
  }
  if (id === "ao_admins_add_sel") {
    await handleAdminsAddSel(interaction as StringSelectMenuInteraction);
    return true;
  }
  if (id === "ao_admins_delete") {
    await handleAdminsDelete(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_admins_delete_sel") {
    await handleAdminsDeleteSel(interaction as StringSelectMenuInteraction);
    return true;
  }

  // ── Commissioner hub ──────────────────────────────────────────────────────────
  if (id === "ao_commissioner") {
    await handleCommissionerHub(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_commish_add") {
    await handleCommissionerAdd(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_commish_add_afc" || id === "ao_commish_add_nfc" || id === "ao_commish_add_other") {
    await handleCommissionerAddSel(interaction as StringSelectMenuInteraction);
    return true;
  }
  if (id === "ao_commish_remove") {
    await handleCommissionerRemove(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_commish_remove_sel") {
    await handleCommissionerRemoveSel(interaction as StringSelectMenuInteraction);
    return true;
  }

  // ── League Data hub ───────────────────────────────────────────────────────────
  if (id === "ao_league_data") {
    await handleLeagueDataHub(interaction as ButtonInteraction);
    return true;
  }

  // ── User Data hub ─────────────────────────────────────────────────────────────
  if (id === "ao_user_data") {
    await handleUserDataHub(interaction as ButtonInteraction);
    return true;
  }

  // ── Store Settings hub ────────────────────────────────────────────────────────
  if (id === "ao_store_settings") {
    await handleStoreSettingsHub(interaction as ButtonInteraction);
    return true;
  }

  // ── Server Settings hub ───────────────────────────────────────────────────────
  if (id === "ao_server_settings") {
    await handleServerSettingsHub(interaction as ButtonInteraction);
    return true;
  }

  // ── Server Features (feature toggle) sub-menu ────────────────────────────────
  if (id === "ao_server_features") {
    await handleServerFeaturesHub(interaction as ButtonInteraction);
    return true;
  }

  // ── Server Setup sub-menu ─────────────────────────────────────────────────────
  if (id === "ao_server_setup") {
    await handleServerSetupHub(interaction as ButtonInteraction);
    return true;
  }

  // ── Economy Inflation panel ───────────────────────────────────────────────────
  if (id === "ao_inflation") {
    await handleInflationPanel(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_inflation_toggle") {
    await handleInflationToggle(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_inflation_recompute") {
    await handleInflationRecompute(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_inflation_target") {
    await handleInflationTargetModal(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_inflation_range") {
    await handleInflationRangeModal(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_modal_inflation_target") {
    await handleInflationTargetSubmit(interaction as ModalSubmitInteraction);
    return true;
  }
  if (id === "ao_modal_inflation_range") {
    await handleInflationRangeSubmit(interaction as ModalSubmitInteraction);
    return true;
  }

  // ── Init Existing Server ──────────────────────────────────────────────────────
  if (id === "ao_init_existing") {
    await handleInitExisting(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_modal_init_existing") {
    await handleModalInitExisting(interaction as ModalSubmitInteraction);
    return true;
  }

  // ── Init NEW Server ───────────────────────────────────────────────────────────
  if (id === "ao_init_new") {
    await handleInitNew(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_init_new_proceed") {
    await handleInitNewProceed(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_modal_init_new") {
    await handleModalInitNew(interaction as ModalSubmitInteraction);
    return true;
  }

  // ── Set Franchise Length ──────────────────────────────────────────────────────
  if (id === "ao_set_franchise_len") {
    await handleSetFranchiseLen(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_modal_franchise_len") {
    await handleModalFranchiseLen(interaction as ModalSubmitInteraction);
    return true;
  }

  // ── Milestone Audit ───────────────────────────────────────────────────────────
  if (id === "ao_milestone_audit") {
    await handleTsMilestoneAudit(interaction as ButtonInteraction);
    return true;
  }

  // ── Manual Channel Link picker ────────────────────────────────────────────────
  if (id === "ao_manual_channel_link") {
    await handleManualChannelLinkPicker(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_manual_ch_select") {
    await handleManualChannelSelect(interaction as StringSelectMenuInteraction);
    return true;
  }
  if (id.startsWith("ao_ch_assign:")) {
    await handleChannelAssign(interaction as StringSelectMenuInteraction);
    return true;
  }
  // Direct "set channel for KEY" shortcut (e.g. Comm Office → Set GOTY Channel)
  if (id.startsWith("ao_ch_pick:")) {
    const key = id.split(":").slice(1).join(":");
    await openChannelPickerForKey(interaction as ButtonInteraction, key);
    return true;
  }

  // ── Troubleshoot hub ──────────────────────────────────────────────────────────
  if (id === "ao_troubleshoot") {
    await handleTroubleshootHub(interaction as ButtonInteraction);
    return true;
  }

  // ── Report Bug ────────────────────────────────────────────────────────────────
  if (id === "ao_report_bug") {
    await handleReportBug(interaction as ButtonInteraction);
    return true;
  }
  if (id === "ao_modal_report_bug") {
    await handleModalReportBug(interaction as ModalSubmitInteraction);
    return true;
  }

  return false;
}

// ── Payouts Hub ────────────────────────────────────────────────────────────────

async function handlePayoutsHub(interaction: ButtonInteraction) {
  await interaction.update({
    embeds: [buildPayoutHubEmbed()],
    components: buildPayoutHubRows() as ActionRowBuilder<any>[],
  });
}

// ── Post Matchups/GOTW ─────────────────────────────────────────────────────────

async function handlePostMatchups(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const week    = weekLabel(season.currentWeek ?? "1");

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("📋 Post Matchups/GOTW")
        .setDescription(
          `This will re-run the full weekly matchups flow for **${week}**.\n\n` +
          "• Posts matchup embeds to the matchups channel\n" +
          "• Posts a GOTW poll to the GOTW channel\n" +
          "• Creates game channels if not already created\n\n" +
          "⚠️ This does **not** award payouts or advance the week."
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_post_matchups_confirm").setLabel("✅ Confirm & Post").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handlePostMatchupsConfirm(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("📋 Posting Matchups...")
        .setDescription("Running the matchups flow — please wait."),
    ],
    components: [],
  });

  try {
    const season      = await getOrCreateActiveSeason(guildId);
    const currentWeek = season.currentWeek ?? "1";
    const backRow     = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ) as ActionRowBuilder<any>,
    ];

    if (PLAYOFF_WEEK_META[currentWeek]) {
      // ── Playoff week — use the playoff matchups / GOTW flow ──────────────────
      const summary = await runPlayoffMatchupsFlow(
        interaction.client,
        season,
        currentWeek as keyof typeof PLAYOFF_WEEK_META,
        guildId,
      );
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle("✅ Playoff Matchups Posted")
            .setDescription(summary || `Playoff matchup flow completed for **${weekLabel(currentWeek)}**.`),
        ],
        components: backRow,
      });
    } else {
      // ── Regular season week ───────────────────────────────────────────────────
      const weekNum        = parseInt(currentWeek, 10);
      const displayWeekNum = isNaN(weekNum) ? 1 : weekNum;

      await runWeeklyMatchupsFlow({
        client:          interaction.client,
        guild:           interaction.guild,
        season,
        displayWeekNum,
        payoutWeekIndex: null,
        guildId,
        replyFn: async ({ content, components }) => {
          await interaction.followUp({ content, components: components ?? [], ephemeral: true }).catch(() => {});
        },
      });

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle("✅ Matchups Posted")
            .setDescription(`Matchup flow completed for **${weekLabel(currentWeek)}**.`),
        ],
        components: backRow,
      });
    }
  } catch (err) {
    console.error("[admin-operations] Post Matchups error:", err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Matchups Post Failed")
          .setDescription(`Error: ${err}`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        ) as ActionRowBuilder<any>,
      ],
    });
  }
}

// ── Post Game Channels ─────────────────────────────────────────────────────────

async function handlePostGameChannels(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_post_game_channels")
    .setTitle("Post Game Channels");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("week_num")
        .setLabel("Week # (1-18, 19=Wild Card, 20-22=playoffs)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2)
        .setPlaceholder("e.g. 7"),
    ),
  );
  await interaction.showModal(modal);
}

async function handlePostGameChannelsModal(interaction: ModalSubmitInteraction) {
  // Defer immediately. On Railway cold-starts the modal submit can arrive after
  // Discord's 3s window — in that case deferReply throws 10062 and we can no
  // longer reply to the interaction. We still want to DO the work (create the
  // channels), so we track the interaction as dead and fall back to posting the
  // status report in the originating channel instead of editing the reply.
  let interactionDead = false;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err: unknown) {
    const code = (err as { code?: number } | null)?.code;
    if (code === 10062) {
      console.warn("[handlePostGameChannelsModal] deferReply failed (cold-start 10062) — continuing without interaction reply");
      interactionDead = true;
    } else {
      console.error("[handlePostGameChannelsModal] deferReply failed:", err);
      interactionDead = true;
    }
  }

  // Unified reply helper — uses editReply while the interaction is alive,
  // otherwise posts the message into the channel the modal was opened from.
  const reply = async (payload: { content?: string; embeds?: EmbedBuilder[] }) => {
    if (!interactionDead) {
      try {
        await interaction.editReply(payload);
        return;
      } catch (err: unknown) {
        const code = (err as { code?: number } | null)?.code;
        if (code !== 10062 && code !== 10008) console.error("[handlePostGameChannelsModal] editReply failed:", err);
        interactionDead = true;
      }
    }
    const ch = interaction.channel;
    if (ch && "send" in ch) {
      try {
        await (ch as import("discord.js").TextChannel).send(payload);
      } catch (err) {
        console.error("[handlePostGameChannelsModal] channel.send fallback failed:", err);
      }
    }
  };

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const guild   = interaction.guild;

  if (!guild) {
    await reply({ content: "❌ Could not access guild." });
    return;
  }

  const raw     = interaction.fields.getTextInputValue("week_num").trim();
  const weekNum = parseInt(raw, 10);
  if (isNaN(weekNum) || weekNum < 1 || weekNum > 22) {
    await reply({ content: "❌ Invalid week number. Enter 1–18 for regular season, 19–22 for playoffs." });
    return;
  }

  const playoffIndexMap: Record<number, number> = { 19: 1018, 20: 1019, 21: 1020, 22: 1022 };
  const weekIndex = weekNum <= 18 ? weekNum - 1 : (playoffIndexMap[weekNum] ?? -1);
  if (weekIndex === -1) {
    await reply({ content: "❌ Could not resolve week index." });
    return;
  }

  const isPlayoff = weekNum > 18;
  const playoffLabels: Record<number, string> = { 19: "Wild Card", 20: "Divisional Round", 21: "Conference Championship", 22: "Super Bowl" };
  const displayLabel = isPlayoff
    ? `Season ${season.seasonNumber} — ${playoffLabels[weekNum] ?? `Playoff Wk ${weekNum}`}`
    : `Season ${season.seasonNumber} — Week ${weekNum}`;

  // ── Load schedule games for the week ─────────────────────────────────────
  // Use schedule season fallback: if the active season has no schedule data yet,
  // fall back to the most recent season that does (same pattern as getRosterSeasonId).
  const schedSeasonId = await getScheduleSeasonId(guildId);
  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  schedSeasonId),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ));

  if (games.length === 0) {
    await reply({
      content: `❌ No schedule data found for **${displayLabel}**. Run \`/franchiseupdate\` or import the schedule first.`,
    });
    return;
  }

  // ── Build team → Discord ID maps ─────────────────────────────────────────
  const [mcaTeams, defaultLogos, allUsers] = await Promise.all([
    db.select({
      teamId:    franchiseMcaTeamsTable.teamId,
      fullName:  franchiseMcaTeamsTable.fullName,
      nickName:  franchiseMcaTeamsTable.nickName,
      discordId: franchiseMcaTeamsTable.discordId,
      logoUrl:   franchiseMcaTeamsTable.logoUrl,
    }).from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.seasonId, schedSeasonId)),
    db.select({
      teamId:   defaultTeamLogosTable.teamId,
      fullName: defaultTeamLogosTable.fullName,
      nickName: defaultTeamLogosTable.nickName,
      logoUrl:  defaultTeamLogosTable.logoUrl,
    }).from(defaultTeamLogosTable),
    db.select({ discordId: usersTable.discordId, team: usersTable.team })
      .from(usersTable).where(eq(usersTable.guildId, guildId)),
  ]);

  const defaultById   = new Map<number, string>();
  const defaultByName = new Map<string, string>();
  for (const d of defaultLogos) {
    defaultById.set(d.teamId, d.logoUrl);
    defaultByName.set(d.fullName.toLowerCase().trim(), d.logoUrl);
    defaultByName.set(d.nickName.toLowerCase().trim(), d.logoUrl);
  }

  const teamToDiscord = new Map<string, string>();
  const teamToMca     = new Map<string, typeof mcaTeams[0]>();
  const discordIdToMca = new Map<string, typeof mcaTeams[0]>();
  for (const t of mcaTeams) {
    const keys = [t.fullName.toLowerCase().trim(), t.nickName.toLowerCase().trim()];
    for (const k of keys) {
      if (!teamToMca.has(k)) teamToMca.set(k, t);
      if (t.discordId && !t.discordId.startsWith("unlinked_") && !teamToDiscord.has(k))
        teamToDiscord.set(k, t.discordId);
    }
    if (t.discordId && !t.discordId.startsWith("unlinked_")) discordIdToMca.set(t.discordId, t);
  }

  const discordIdToProperTeam = new Map<string, string>();
  for (const u of allUsers) {
    if (u.team && !u.discordId.startsWith("unlinked_")) {
      const k = u.team.toLowerCase().trim();
      if (!teamToDiscord.has(k)) teamToDiscord.set(k, u.discordId);
      discordIdToProperTeam.set(u.discordId, u.team);
    }
  }

  // Alias full team names to real Discord IDs resolved via nickname, and enrich discordIdToMca
  for (const t of mcaTeams) {
    const byNick = teamToDiscord.get(t.nickName.toLowerCase().trim());
    if (byNick) {
      if (!teamToDiscord.has(t.fullName.toLowerCase().trim()))
        teamToDiscord.set(t.fullName.toLowerCase().trim(), byNick);
      if (!discordIdToMca.has(byNick)) discordIdToMca.set(byNick, t);
    }
  }

  function resolveLogoPath(teamName: string, mca: typeof mcaTeams[0] | undefined): string | null {
    const key = teamName.toLowerCase().trim();
    if (mca?.logoUrl) return mca.logoUrl;
    if (mca?.teamId != null) { const b = defaultById.get(mca.teamId); if (b) return b; }
    const exact = defaultByName.get(key);
    if (exact) return exact;
    for (const d of defaultLogos) { if (key.includes(d.nickName.toLowerCase().trim())) return d.logoUrl; }
    if (mca?.teamId != null && mca.teamId <= 31) return globalLogoPath(mca.teamId);
    return null;
  }

  // H2H only: both teams must map to a Discord user
  const h2hGames = games.filter(g =>
    teamToDiscord.has(g.awayTeamName.toLowerCase().trim()) &&
    teamToDiscord.has(g.homeTeamName.toLowerCase().trim()),
  );

  if (h2hGames.length === 0) {
    await reply({
      content: `ℹ️ No H2H matchups found for **${displayLabel}** — all ${games.length} game${games.length !== 1 ? "s" : ""} are CPU matchups. No channels created.`,
    });
    return;
  }

  // Find or create the GAMEDAY category
  await guild.channels.fetch();
  const matchupCategory = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes("GAMEDAY"),
  );
  if (!matchupCategory) {
    await reply({ content: "❌ Could not find a **GAMEDAY CENTER** category. Create one in Discord first." });
    return;
  }

  // ── Wipe every existing game channel in GAMEDAY before recreating ────────
  // Per user spec: clicking Post Game Channels nukes EVERY child channel under
  // the GAMEDAY category (any week, any season) plus their DB rows, then
  // recreates fresh channels for this week. This keeps the category from
  // accumulating dead channels across the season.
  const deletedChannelIds: string[] = [];
  const childChannels = guild.channels.cache.filter(c => c.parentId === matchupCategory.id);
  let wipedCount = 0;
  for (const ch of childChannels.values()) {
    try {
      await ch.delete("Post Game Channels — wiping previous week's channels");
      deletedChannelIds.push(ch.id);
      wipedCount++;
    } catch (err) {
      // Don't queue the DB rows for deletion if the channel itself survived —
      // otherwise we'd end up with a live channel that has no schedule row.
      console.error(`[handlePostGameChannelsModal] Failed to delete channel ${ch.id} (${ch.name}):`, err);
    }
  }
  if (deletedChannelIds.length > 0) {
    try {
      await db.delete(gameSchedulesTable).where(inArray(gameSchedulesTable.channelId, deletedChannelIds));
      await db.delete(gameChannelsTable).where(inArray(gameChannelsTable.channelId, deletedChannelIds));
    } catch (err) {
      console.error("[handlePostGameChannelsModal] Failed to clean DB rows for wiped channels:", err);
    }
  }

  // Load existing channel records for this week (to avoid duplicates).
  // Build a Map so we can verify the Discord channel still exists — stale DB rows
  // (from channels deleted in Discord) must not block recreation.
  const existingChannelRows = await db.select()
    .from(gameChannelsTable)
    .where(and(
      eq(gameChannelsTable.seasonId,  schedSeasonId),
      eq(gameChannelsTable.weekIndex, weekIndex),
    ));
  const existingRowByKey = new Map(
    existingChannelRows.map(r => [
      `${r.awayTeamName.toLowerCase().trim()}|${r.homeTeamName.toLowerCase().trim()}`,
      r,
    ]),
  );

  const results: string[] = [];
  let created = 0;

  for (const g of h2hGames) {
    const awayDiscordId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim())!;
    const homeDiscordId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim())!;
    const awayProper    = discordIdToProperTeam.get(awayDiscordId) ?? g.awayTeamName;
    const homeProper    = discordIdToProperTeam.get(homeDiscordId) ?? g.homeTeamName;
    const gameKey       = `${awayProper.toLowerCase().trim()}|${homeProper.toLowerCase().trim()}`;

    const existingRow = existingRowByKey.get(gameKey);
    if (existingRow) {
      // Verify the Discord channel still exists — if it was deleted, clean up the
      // stale DB row and fall through to recreate the channel.
      const liveChannel = guild.channels.cache.get(existingRow.channelId);
      if (liveChannel) {
        // Channel exists — check if the scheduling header was ever posted.
        const [existingSched] = await db.select()
          .from(gameSchedulesTable)
          .where(eq(gameSchedulesTable.channelId, existingRow.channelId))
          .limit(1);

        if (existingSched?.headerMessageId) {
          // Fully set up — skip entirely.
          results.push(`⏭️ **${awayProper} vs ${homeProper}** — channel already exists (<#${existingRow.channelId}>)`);
          continue;
        }

        // Channel + DB row exist but header is missing (previous run failed at that step).
        // Post the header now without touching the channel.
        try {
          const sched = await ensureScheduleRow({
            guildId,
            channelId:    existingRow.channelId,
            seasonId:     season.id,
            weekIndex,
            awayDiscordId,
            homeDiscordId,
            awayTeamName: awayProper,
            homeTeamName: homeProper,
            status:       "unscheduled",
          });
          const settings = await getServerSettings(guildId);
          const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
          const awayMember = awayDiscordId && !awayDiscordId.startsWith("unlinked_")
            ? await guild.members.fetch(awayDiscordId).catch(() => null) : null;
          const homeMember = homeDiscordId && !homeDiscordId.startsWith("unlinked_")
            ? await guild.members.fetch(homeDiscordId).catch(() => null) : null;
          const awayTag = awayMember ? `<@${awayDiscordId}> (@${awayMember.displayName})` : awayProper;
          const homeTag = homeMember ? `<@${homeDiscordId}> (@${homeMember.displayName})` : homeProper;
          const tc = liveChannel as import("discord.js").TextChannel;
          const headerMsg = await tc.send({
            content:
              `🏈 **${awayProper} @ ${homeProper}** — ${displayLabel}\n` +
              `${awayTag}  vs  ${homeTag}\n` +
              `Schedule your game using the buttons below. Good luck!`,
            components: [buildHeaderRow(sched)],
          });
          await headerMsg.pin().catch(() => {});
          await db.update(gameSchedulesTable)
            .set({ headerMessageId: headerMsg.id })
            .where(eq(gameSchedulesTable.id, sched.id));
          results.push(`✅ Posted missing header to existing <#${existingRow.channelId}>`);
        } catch (hdrErr) {
          console.error(`[handlePostGameChannelsModal] Failed to recover header for ${existingRow.channelId}:`, hdrErr);
          results.push(`⚠️ Channel exists but header posting failed (<#${existingRow.channelId}>)`);
        }
        continue;
      }
      // Channel was deleted — remove the stale row so the insert below succeeds.
      await db.delete(gameChannelsTable).where(eq(gameChannelsTable.id, existingRow.id));
      existingRowByKey.delete(gameKey);
    }

    const awayNick = discordIdToMca.get(awayDiscordId)?.nickName ?? discordIdToProperTeam.get(awayDiscordId) ?? g.awayTeamName.split(/\s+/).pop()!;
    const homeNick = discordIdToMca.get(homeDiscordId)?.nickName ?? discordIdToProperTeam.get(homeDiscordId) ?? g.homeTeamName.split(/\s+/).pop()!;
    const chanName = `${toChannelName(awayNick)}-vs-${toChannelName(homeNick)}`;

    // Delete any orphaned Discord channel with the same name that has no DB row
    // (happens when a previous run failed after channel creation but before DB insert).
    const orphan = guild.channels.cache.find(
      c => c.parentId === matchupCategory.id && c.name === chanName,
    );
    if (orphan) {
      await orphan.delete("Post Game Channels — replacing orphaned matchup channel").catch(() => {});
    }

    try {
      // ── Permission overwrites: deny @everyone, allow bot + Commissioner role + both players + bot-admins ──
      const commRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "commissioner");
      const botAdmins = await db.select({ discordId: usersTable.discordId })
        .from(usersTable)
        .where(and(eq(usersTable.guildId, guildId), eq(usersTable.isAdmin, true)));
      const overwrites: import("discord.js").OverwriteResolvable[] = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.client.user!.id,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels] },
      ];
      if (commRole) overwrites.push({ id: commRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      if (awayDiscordId && !awayDiscordId.startsWith("unlinked_")) overwrites.push({ id: awayDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      if (homeDiscordId && !homeDiscordId.startsWith("unlinked_")) overwrites.push({ id: homeDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      for (const a of botAdmins) {
        if (a.discordId && a.discordId !== awayDiscordId && a.discordId !== homeDiscordId && !a.discordId.startsWith("unlinked_")) {
          overwrites.push({ id: a.discordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        }
      }

      const newChannel = await guild.channels.create({
        name:   chanName,
        type:   ChannelType.GuildText,
        parent: matchupCategory.id,
        permissionOverwrites: overwrites,
      });

      try {
        await db.insert(gameChannelsTable).values({
          seasonId:     schedSeasonId,
          weekIndex,
          channelId:    newChannel.id,
          awayTeamName: awayProper,
          homeTeamName: homeProper,
        });
      } catch (dbErr) {
        console.error(`[handlePostGameChannelsModal] game_channels INSERT failed for ${chanName}:`, dbErr);
      }
      created++;
      results.push(`✅ Created <#${newChannel.id}>`);

      // ── Scheduling header ──────────────────────────────────────────────────
      try {
        const sched = await ensureScheduleRow({
          guildId,
          channelId:    newChannel.id,
          seasonId:     season.id,
          weekIndex,
          awayDiscordId,
          homeDiscordId,
          awayTeamName: awayProper,
          homeTeamName: homeProper,
          status:       "unscheduled",
        });
        const settings = await getServerSettings(guildId);
        const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
        const awayMember = awayDiscordId && !awayDiscordId.startsWith("unlinked_")
          ? await guild.members.fetch(awayDiscordId).catch(() => null) : null;
        const homeMember = homeDiscordId && !homeDiscordId.startsWith("unlinked_")
          ? await guild.members.fetch(homeDiscordId).catch(() => null) : null;
        const awayTag = awayMember ? `<@${awayDiscordId}> (@${awayMember.displayName})` : awayProper;
        const homeTag = homeMember ? `<@${homeDiscordId}> (@${homeMember.displayName})` : homeProper;
        const headerMsg = await newChannel.send({
          content:
            `🏈 **${awayProper} @ ${homeProper}** — ${displayLabel}\n` +
            `${awayTag}  vs  ${homeTag}\n` +
            `Schedule your game using the buttons below. Good luck!`,
          components: [buildHeaderRow(sched)],
        });
        await headerMsg.pin().catch(() => {});
        await db.update(gameSchedulesTable)
          .set({ headerMessageId: headerMsg.id })
          .where(eq(gameSchedulesTable.id, sched.id));
      } catch (hdrErr) {
        console.error(`[handlePostGameChannelsModal] Failed to post scheduling header for ${chanName}:`, hdrErr);
      }
    } catch (err) {
      console.error(`[handlePostGameChannelsModal] Channel creation error for ${chanName}:`, err);
      results.push(`❌ Failed to create channel for **${awayProper} vs ${homeProper}**`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(created > 0 ? Colors.Green : Colors.Blurple)
    .setTitle(`🎮 Post Game Channels — ${displayLabel}`)
    .setDescription(results.length > 0 ? results.join("\n") : "No H2H games processed.")
    .addFields(
      { name: "Channels Created", value: String(created),              inline: true },
      { name: "H2H Games",        value: String(h2hGames.length),      inline: true },
      { name: "Total Schedule",   value: String(games.length),         inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── Waitlist Hub ───────────────────────────────────────────────────────────────

async function handleWaitlistHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  const entries = await db.select()
    .from(waitlistTable)
    .where(and(
      eq(waitlistTable.guildId, guildId),
      eq(waitlistTable.status, "waiting"),
    ))
    .orderBy(waitlistTable.addedAt);

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  if (entries.length === 0) {
    await (interaction as any).update({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("📋 Waitlist")
          .setDescription("✅ No users are currently on the waitlist."),
      ],
      components: [backRow],
    });
    return;
  }

  const lines = entries.map((e, i) =>
    `**${i + 1}.** <@${e.discordId}>${e.team ? ` — waiting for: **${e.team}**` : " — any open team"} ` +
    `(added <t:${Math.floor(e.addedAt.getTime() / 1000)}:R>)`
  );

  const btnRows: ActionRowBuilder<ButtonBuilder>[] = [];
  const PAGE_SIZE = 3;
  for (let i = 0; i < Math.min(entries.length, PAGE_SIZE * 5); i += PAGE_SIZE) {
    const slice = entries.slice(i, i + PAGE_SIZE);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...slice.map((e, j) => {
        const idx = i + j;
        return new ButtonBuilder()
          .setCustomId(`ao_waitlist_edit:${e.id}`)
          .setLabel(`✏️ #${idx + 1} Edit`)
          .setStyle(ButtonStyle.Primary);
      }),
      ...slice.map((e, j) => {
        const idx = i + j;
        return new ButtonBuilder()
          .setCustomId(`ao_waitlist_delete:${e.id}`)
          .setLabel(`🗑️ #${idx + 1} Delete`)
          .setStyle(ButtonStyle.Danger);
      }),
    );
    btnRows.push(row);
  }
  btnRows.push(backRow);

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📋 Waitlist")
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: `${entries.length} user${entries.length !== 1 ? "s" : ""} waiting` }),
    ],
    components: btnRows as ActionRowBuilder<any>[],
  });
}

async function handleWaitlistEdit(interaction: ButtonInteraction, _sess: AoSession) {
  const entryId = parseInt(interaction.customId.split(":")[1]!, 10);
  const guildId = interaction.guildId!;

  const [entry] = await db.select().from(waitlistTable)
    .where(and(eq(waitlistTable.id, entryId), eq(waitlistTable.guildId, guildId)))
    .limit(1);

  if (!entry) {
    await interaction.reply({ content: "❌ Waitlist entry not found.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_waitlist_edit")
    .setTitle("Edit Waitlist Entry");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("entry_id")
        .setLabel("Entry ID (do not change)")
        .setStyle(TextInputStyle.Short)
        .setValue(String(entry.id))
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("team")
        .setLabel("Team they're waiting for (blank = any)")
        .setStyle(TextInputStyle.Short)
        .setValue(entry.team ?? "")
        .setRequired(false)
        .setMaxLength(50),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalWaitlistEdit(interaction: ModalSubmitInteraction) {
  const guildId = interaction.guildId!;
  const entryId = parseInt(interaction.fields.getTextInputValue("entry_id"), 10);
  const team    = interaction.fields.getTextInputValue("team").trim() || null;

  if (isNaN(entryId)) {
    await interaction.reply({ content: "❌ Invalid entry ID.", ephemeral: true });
    return;
  }

  const [updated] = await db.update(waitlistTable)
    .set({ team })
    .where(and(eq(waitlistTable.id, entryId), eq(waitlistTable.guildId, guildId)))
    .returning();

  if (!updated) {
    await interaction.reply({ content: "❌ Entry not found.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `✅ Updated waitlist entry for <@${updated.discordId}>${team ? ` — now waiting for **${team}**` : " — now waiting for any open team"}.`,
    ephemeral: true,
  });
}

async function handleWaitlistDelete(interaction: ButtonInteraction) {
  const entryId = parseInt(interaction.customId.split(":")[1]!, 10);
  const guildId = interaction.guildId!;

  const [deleted] = await db.delete(waitlistTable)
    .where(and(eq(waitlistTable.id, entryId), eq(waitlistTable.guildId, guildId)))
    .returning();

  if (!deleted) {
    await interaction.reply({ content: "❌ Entry not found or already deleted.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `🗑️ Removed <@${deleted.discordId}> from the waitlist.`,
    ephemeral: true,
  });
}

// ── Admins Hub ─────────────────────────────────────────────────────────────────

const ADMIN_CAP = 4;

async function handleAdminsHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  const admins = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId)));

  const lines = admins.length > 0
    ? admins.map((a, i) =>
        `**${i + 1}.** <@${a.discordId}> (${a.discordUsername})${a.team ? ` — ${a.team}` : ""}`
      )
    : ["_No bot admins set._"];

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_admins_add").setLabel("➕ Add Admin").setStyle(ButtonStyle.Success)
      .setDisabled(admins.length >= ADMIN_CAP),
    new ButtonBuilder().setCustomId("ao_admins_delete").setLabel("🗑️ Remove Admin").setStyle(ButtonStyle.Danger)
      .setDisabled(admins.length === 0),
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🛡️ View/Edit Admins")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `${admins.length}/${ADMIN_CAP} admin slots used` }),
    ],
    components: [backRow as ActionRowBuilder<any>],
  });
}

async function handleAdminsAdd(interaction: ButtonInteraction, _sess: AoSession) {
  const guildId = interaction.guildId!;

  const currentAdmins = await db.select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId)));

  if (currentAdmins.length >= ADMIN_CAP) {
    await interaction.reply({ content: `❌ Admin cap (${ADMIN_CAP}) reached. Remove an admin first.`, ephemeral: true });
    return;
  }

  const adminIds = new Set(currentAdmins.map(a => a.discordId));
  const nonAdmins = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), eq(usersTable.isAdmin, false)))
    .orderBy(usersTable.discordUsername)
    .limit(25);

  const eligible = nonAdmins.filter(u => !adminIds.has(u.discordId));

  if (eligible.length === 0) {
    await interaction.reply({ content: "❌ No eligible users found to promote.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_admins_add_sel")
    .setPlaceholder("Select a user to grant admin...")
    .addOptions(
      eligible.map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${u.discordUsername}${u.team ? ` (${u.team})` : ""}`)
          .setValue(u.discordId)
          .setDescription(u.team ?? "No team linked"),
      ),
    );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("➕ Add Admin")
        .setDescription(`Select a user to grant bot-admin status. (${ADMIN_CAP - currentAdmins.length} slot${ADMIN_CAP - currentAdmins.length !== 1 ? "s" : ""} remaining)`),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_admins").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleAdminsAddSel(interaction: StringSelectMenuInteraction) {
  const guildId      = interaction.guildId!;
  const targetId     = interaction.values[0]!;

  const currentCount = (await db.select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId)))).length;

  if (currentCount >= ADMIN_CAP) {
    await interaction.reply({ content: `❌ Admin cap (${ADMIN_CAP}) reached.`, ephemeral: true });
    return;
  }

  const [result] = await db.update(usersTable)
    .set({ isAdmin: true, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)))
    .returning({ discordUsername: usersTable.discordUsername });

  if (!result) {
    await interaction.reply({ content: "❌ User not found.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `✅ <@${targetId}> (${result.discordUsername}) has been granted bot-admin status.`,
    ephemeral: true,
  });
}

async function handleAdminsDelete(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  const admins = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId)));

  if (admins.length === 0) {
    await interaction.reply({ content: "❌ No admins to remove.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_admins_delete_sel")
    .setPlaceholder("Select admin to remove...")
    .addOptions(
      admins.map(a =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${a.discordUsername}${a.team ? ` (${a.team})` : ""}`)
          .setValue(a.discordId)
          .setDescription(a.team ?? "No team linked"),
      ),
    );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Remove Admin")
        .setDescription("Select the admin to remove. This will revoke their bot-admin access immediately."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_admins").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleAdminsDeleteSel(interaction: StringSelectMenuInteraction) {
  const guildId  = interaction.guildId!;
  const targetId = interaction.values[0]!;

  const [result] = await db.update(usersTable)
    .set({ isAdmin: false, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)))
    .returning({ discordUsername: usersTable.discordUsername });

  if (!result) {
    await interaction.reply({ content: "❌ User not found.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `✅ Bot-admin status revoked for <@${targetId}> (${result.discordUsername}).`,
    ephemeral: true,
  });
}

// ── Commissioner Management Hub ────────────────────────────────────────────────

const COMMISSIONER_CAP = 5;

async function handleCommissionerHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const guild   = interaction.guild!;
  const ownerId = guild.ownerId;

  const nonOwnerCommissioners = await db
    .select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId), ne(usersTable.discordId, ownerId)))
    .orderBy(usersTable.discordUsername);

  const [ownerEntry] = await db
    .select({ team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, ownerId), eq(usersTable.guildId, guildId)))
    .limit(1);

  const total = 1 + nonOwnerCommissioners.length;
  const lines: string[] = [];
  const ownerTeam = ownerEntry?.team ? ` — **${ownerEntry.team}**` : "";
  lines.push(`**1.** <@${ownerId}> 👑${ownerTeam}`);
  nonOwnerCommissioners.forEach((c, i) => {
    const teamInfo = c.team ? ` — **${c.team}**` : "";
    lines.push(`**${i + 2}.** <@${c.discordId}>${teamInfo}`);
  });

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle("👑 Commissioner Management")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `${total}/${COMMISSIONER_CAP} slots used · 👑 = Server Owner (permanent primary)` }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_commish_add").setLabel("➕ Add").setStyle(ButtonStyle.Success)
          .setDisabled(total >= COMMISSIONER_CAP),
        new ButtonBuilder().setCustomId("ao_commish_remove").setLabel("🗑️ Remove").setStyle(ButtonStyle.Danger)
          .setDisabled(nonOwnerCommissioners.length === 0),
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleCommissionerAdd(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const guild   = interaction.guild!;
  const ownerId = guild.ownerId;

  const nonOwnerCount = (await db
    .select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId), ne(usersTable.discordId, ownerId))))
    .length;

  if (1 + nonOwnerCount >= COMMISSIONER_CAP) {
    await interaction.reply({ content: `❌ Commissioner cap (${COMMISSIONER_CAP}) reached. Remove one first.`, ephemeral: true });
    return;
  }

  const adminIds = new Set(
    (await db.select({ discordId: usersTable.discordId })
      .from(usersTable)
      .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId))))
      .map(u => u.discordId),
  );
  adminIds.add(ownerId);

  const allLinked = await db
    .select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), eq(usersTable.isAdmin, false)))
    .orderBy(usersTable.discordUsername);

  const eligible = allLinked.filter(u => u.team && !adminIds.has(u.discordId));

  if (eligible.length === 0) {
    await interaction.reply({ content: "❌ No eligible linked users to promote.", ephemeral: true });
    return;
  }

  const afcUsers: typeof eligible = [];
  const nfcUsers: typeof eligible = [];
  const otherUsers: typeof eligible = [];

  for (const u of eligible) {
    const conf = lookupNflDivision(u.team!)?.conference;
    if (conf === "AFC")       afcUsers.push(u);
    else if (conf === "NFC")  nfcUsers.push(u);
    else                      otherUsers.push(u);
  }

  const makeMenu = (customId: string, placeholder: string, users: typeof eligible) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          users.slice(0, 25).map(u =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${u.discordUsername}${u.team ? ` (${u.team})` : ""}`)
              .setValue(u.discordId)
              .setDescription(u.team ?? "No team"),
          ),
        ),
    ) as ActionRowBuilder<any>;

  const remaining = COMMISSIONER_CAP - 1 - nonOwnerCount;
  const components: ActionRowBuilder<any>[] = [];
  if (afcUsers.length)   components.push(makeMenu("ao_commish_add_afc",   "AFC — select a user…",   afcUsers));
  if (nfcUsers.length)   components.push(makeMenu("ao_commish_add_nfc",   "NFC — select a user…",   nfcUsers));
  if (otherUsers.length) components.push(makeMenu("ao_commish_add_other", "Other — select a user…", otherUsers));
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_commissioner").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    ) as ActionRowBuilder<any>,
  );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("➕ Add Commissioner")
        .setDescription(
          `Select a linked user to promote to Commissioner. **${remaining} slot${remaining !== 1 ? "s" : ""} remaining.**\n\n` +
          "Pick from the AFC, NFC, or Other dropdown below. Only one selection at a time.",
        ),
    ],
    components,
  });
}

async function handleCommissionerAddSel(interaction: StringSelectMenuInteraction) {
  const guildId  = interaction.guildId!;
  const guild    = interaction.guild!;
  const ownerId  = guild.ownerId;
  const targetId = interaction.values[0]!;

  const nonOwnerCount = (await db
    .select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId), ne(usersTable.discordId, ownerId))))
    .length;

  if (1 + nonOwnerCount >= COMMISSIONER_CAP) {
    await interaction.reply({ content: `❌ Commissioner cap (${COMMISSIONER_CAP}) reached.`, ephemeral: true });
    return;
  }

  const [user] = await db
    .select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!user) {
    await interaction.reply({ content: "❌ User not found in the database.", ephemeral: true });
    return;
  }

  await db.update(usersTable)
    .set({ isAdmin: true, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)));

  const member = await guild.members.fetch(targetId).catch(() => null);
  const notices: string[] = [];

  if (member) {
    await guild.roles.fetch().catch(() => null);
    const commRole = guild.roles.cache.find(r => r.name === "Commissioner");
    if (commRole) {
      await member.roles.add(commRole, "Promoted to Commissioner via admin hub").catch(err => {
        console.error("[commissioner-add] Failed to add Commissioner role:", err);
        notices.push("⚠️ Could not assign Commissioner role — check bot permissions.");
      });
    } else {
      notices.push("⚠️ 'Commissioner' role not found — run `/admin-initialize` to create it.");
    }

    const baseNick = user.team ?? member.user.username;
    const newNick  = `${baseNick} (Commissioner)`.slice(0, 32);
    await member.setNickname(newNick, "Promoted to Commissioner").catch(err => {
      console.error("[commissioner-add] Failed to set nickname:", err);
      notices.push("⚠️ Could not update nickname — check bot rank vs member rank.");
    });
  } else {
    notices.push("⚠️ Could not fetch guild member — role and nickname not applied.");
  }

  const extra = notices.length > 0 ? `\n\n${notices.join("\n")}` : "";
  await interaction.reply({
    content: `✅ <@${targetId}> has been promoted to Commissioner.${extra}`,
    ephemeral: true,
  });
}

async function handleCommissionerRemove(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const guild   = interaction.guild!;
  const ownerId = guild.ownerId;

  const commissioners = await db
    .select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.isAdmin, true), eq(usersTable.guildId, guildId), ne(usersTable.discordId, ownerId)))
    .orderBy(usersTable.discordUsername);

  if (commissioners.length === 0) {
    await interaction.reply({ content: "❌ No removable commissioners. The server owner (👑) is always the primary commissioner and cannot be removed here.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_commish_remove_sel")
    .setPlaceholder("Select a commissioner to remove…")
    .addOptions(
      commissioners.map(c =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${c.discordUsername}${c.team ? ` (${c.team})` : ""}`)
          .setValue(c.discordId)
          .setDescription(c.team ?? "No team linked"),
      ),
    );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Remove Commissioner")
        .setDescription(
          "Select a commissioner to demote. They will receive the **Approved Member** role and lose commissioner access.\n\n" +
          "The server owner 👑 is always the primary commissioner and cannot be removed.",
        ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_commissioner").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleCommissionerRemoveSel(interaction: StringSelectMenuInteraction) {
  const guildId  = interaction.guildId!;
  const guild    = interaction.guild!;
  const ownerId  = guild.ownerId;
  const targetId = interaction.values[0]!;

  if (targetId === ownerId) {
    await interaction.reply({ content: "❌ The server owner cannot be removed as commissioner.", ephemeral: true });
    return;
  }

  const [user] = await db
    .select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!user) {
    await interaction.reply({ content: "❌ User not found.", ephemeral: true });
    return;
  }

  await db.update(usersTable)
    .set({ isAdmin: false, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, guildId)));

  const member = await guild.members.fetch(targetId).catch(() => null);
  const notices: string[] = [];

  if (member) {
    await guild.roles.fetch().catch(() => null);

    const commRole = guild.roles.cache.find(r => r.name === "Commissioner");
    if (commRole && member.roles.cache.has(commRole.id)) {
      await member.roles.remove(commRole, "Demoted from Commissioner via admin hub").catch(err => {
        console.error("[commissioner-remove] Failed to remove Commissioner role:", err);
        notices.push("⚠️ Could not remove Commissioner role — check bot permissions.");
      });
    }

    const approvedRole = guild.roles.cache.find(r => r.name === "Approved Member");
    if (approvedRole && !member.roles.cache.has(approvedRole.id)) {
      await member.roles.add(approvedRole, "Demoted from Commissioner").catch(err => {
        console.error("[commissioner-remove] Failed to add Approved Member role:", err);
        notices.push("⚠️ Could not assign Approved Member role — check bot permissions.");
      });
    }

    const stripped = member.displayName.replace(/\s*\(Commissioner\)\s*$/i, "").trim();
    if (stripped !== member.displayName) {
      await member.setNickname(stripped, "Commissioner removed").catch(err => {
        console.error("[commissioner-remove] Failed to strip nickname:", err);
        notices.push("⚠️ Could not update nickname — check bot rank vs member rank.");
      });
    }
  } else {
    notices.push("⚠️ Could not fetch guild member — role and nickname not updated.");
  }

  const extra = notices.length > 0 ? `\n\n${notices.join("\n")}` : "";
  await interaction.reply({
    content: `✅ <@${targetId}> has been removed as Commissioner and reassigned to Approved Member.${extra}`,
    ephemeral: true,
  });
}

// ── League Data Hub ────────────────────────────────────────────────────────────

async function handleLeagueDataHub(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const menu    = await buildLeagueDataMainMenu(guildId);
  await (interaction as any).update(menu);
}

// ── User Data Hub ──────────────────────────────────────────────────────────────

async function handleUserDataHub(interaction: ButtonInteraction) {
  await (interaction as any).update({
    embeds: [buildUserDataHubEmbed()],
    components: buildUserDataHubRows() as ActionRowBuilder<any>[],
  });
}

// ── Store Settings Hub ─────────────────────────────────────────────────────────

async function handleStoreSettingsHub(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏪 Store & Purchase Settings")
    .setDescription(
      "Use the buttons below to manage your league's store settings.\n\n" +
      "📋 **Archetypes** — Browse and edit custom player archetype attributes\n" +
      "⭐ **Legend Templates** — Set base attribute templates for each legend model\n" +
      "🎨 **Core Attributes** — Toggle which attributes are core (⭐) vs non-core"
    )
    .setFooter({ text: "Changes take effect immediately" });

  await (interaction as any).update({
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ss_arch").setLabel("📋 Archetypes").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ss_lt").setLabel("⭐ Legend Templates").setStyle(ButtonStyle.Primary),
      ) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ss_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

// ── Server Settings Hub ────────────────────────────────────────────────────────

async function handleServerSettingsHub(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("⚙️ Server Settings")
    .setDescription(
      "**🎛️ Server Features**\n" +
      "Toggle coin economy, legends, custom players, wagers, MCA import, and other feature flags on or off.\n\n" +
      "**🔧 Server Setup**\n" +
      "Initialize the server, manage rules, waitlist, admins, commissioner, channel links, and franchise length.",
    )
    .setFooter({ text: "Select an option below" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_server_features").setLabel("🎛️ Server Features").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_server_setup").setLabel("🔧 Server Setup").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_inflation").setLabel("📈 Economy Inflation").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({ embeds: [embed], components: [row] });
}

// ── Economy Inflation Panel ────────────────────────────────────────────────────

async function handleInflationPanel(interaction: ButtonInteraction) {
  const { getInflationState, formatMultiplier, inflationBadge } = await import("../economy/inflation.js");
  const guildId = interaction.guildId!;
  const state   = await getInflationState(guildId);

  const fmtDate = state.computedAt
    ? `<t:${Math.floor(state.computedAt.getTime() / 1000)}:R>`
    : "never";

  const minMult = formatMultiplier(state.minBps);
  const maxMult = formatMultiplier(state.maxBps);

  const embed = new EmbedBuilder()
    .setColor(state.enabled ? Colors.Green : Colors.Grey)
    .setTitle("📈 Economy Inflation")
    .setDescription(
      "Per-guild price scaling that gently counteracts coin stacking.\n" +
      "When the median active-user balance rises above the target, every " +
      "store price (legends, attrs, dev ups, age resets, custom players, " +
      "contract mods) scales up proportionally. **Payouts are never inflated** " +
      "— only what users spend.\n\n" +
      "Formula: `multiplier = clamp(√(median / target), min, max)`, " +
      "snapped to the nearest 5%."
    )
    .addFields(
      {
        name: "Status",
        value: state.enabled ? "✅ **Enabled**" : "⏸️ **Disabled** (prices use base values)",
        inline: true,
      },
      {
        name: "Current Multiplier",
        value: `**${inflationBadge(state.multiplierBps)}**`,
        inline: true,
      },
      {
        name: "Last Recomputed",
        value: fmtDate,
        inline: true,
      },
      {
        name: "Median Balance (last sample)",
        value: `${state.medianBalance.toLocaleString()} coins (${state.sampleSize} active users)`,
        inline: true,
      },
      {
        name: "Target Median",
        value: `${state.targetMedian.toLocaleString()} coins`,
        inline: true,
      },
      {
        name: "Multiplier Range",
        value: `${minMult} – ${maxMult}`,
        inline: true,
      },
    )
    .setFooter({ text: "Recomputed automatically once every 24h" });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_inflation_toggle")
      .setLabel(state.enabled ? "⏸️ Disable" : "▶️ Enable")
      .setStyle(state.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_inflation_target")
      .setLabel("🎯 Set Target Median")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_inflation_range")
      .setLabel("📐 Set Min/Max")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_inflation_recompute")
      .setLabel("🔄 Recompute Now")
      .setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_server_settings").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({ embeds: [embed], components: [row1, row2] });
}

async function handleInflationToggle(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const settings = await getServerSettings(guildId);
  await db.update(serverSettingsTable)
    .set({ inflationEnabled: !settings.inflationEnabled, updatedAt: new Date() })
    .where(eq(serverSettingsTable.guildId, guildId));
  return handleInflationPanel(interaction);
}

async function handleInflationRecompute(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const { recomputeInflationForGuild } = await import("../economy/inflation.js");
  await recomputeInflationForGuild(interaction.guildId!);
  return handleInflationPanel(interaction);
}

async function handleInflationTargetModal(interaction: ButtonInteraction) {
  const settings = await getServerSettings(interaction.guildId!);
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_inflation_target")
    .setTitle("Set Target Median Balance");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("target")
        .setLabel("Target median balance (coins)")
        .setStyle(TextInputStyle.Short)
        .setValue(String(settings.inflationTargetMedian ?? 500))
        .setPlaceholder("e.g. 500 — multiplier hits 1.00x at this median")
        .setRequired(true),
    ),
  );
  await interaction.showModal(modal);
}

async function handleInflationRangeModal(interaction: ButtonInteraction) {
  const settings = await getServerSettings(interaction.guildId!);
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_inflation_range")
    .setTitle("Set Multiplier Range");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("min")
        .setLabel("Minimum multiplier (e.g. 0.90)")
        .setStyle(TextInputStyle.Short)
        .setValue(((settings.inflationMinBps ?? 9000) / 10000).toFixed(2))
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("max")
        .setLabel("Maximum multiplier (e.g. 2.00)")
        .setStyle(TextInputStyle.Short)
        .setValue(((settings.inflationMaxBps ?? 20000) / 10000).toFixed(2))
        .setRequired(true),
    ),
  );
  await interaction.showModal(modal);
}

export async function handleInflationTargetSubmit(interaction: any) {
  const raw = interaction.fields.getTextInputValue("target").trim();
  const value = Math.max(1, Math.round(Number(raw)));
  if (!Number.isFinite(value)) {
    return interaction.reply({ content: "❌ Invalid number.", ephemeral: true });
  }
  await db.update(serverSettingsTable)
    .set({ inflationTargetMedian: value, updatedAt: new Date() })
    .where(eq(serverSettingsTable.guildId, interaction.guildId!));
  // Recompute immediately so the new target is reflected in the panel.
  const { recomputeInflationForGuild } = await import("../economy/inflation.js");
  await recomputeInflationForGuild(interaction.guildId!);
  return interaction.reply({ content: `✅ Target median set to **${value.toLocaleString()}** coins. Multiplier recomputed.`, ephemeral: true });
}

export async function handleInflationRangeSubmit(interaction: any) {
  const minRaw = Number(interaction.fields.getTextInputValue("min").trim());
  const maxRaw = Number(interaction.fields.getTextInputValue("max").trim());
  if (!Number.isFinite(minRaw) || !Number.isFinite(maxRaw) || minRaw <= 0 || maxRaw <= 0 || minRaw >= maxRaw) {
    return interaction.reply({ content: "❌ Need 0 < min < max (e.g. 0.90 and 2.00).", ephemeral: true });
  }
  const minBps = Math.round(minRaw * 10000);
  const maxBps = Math.round(maxRaw * 10000);
  await db.update(serverSettingsTable)
    .set({ inflationMinBps: minBps, inflationMaxBps: maxBps, updatedAt: new Date() })
    .where(eq(serverSettingsTable.guildId, interaction.guildId!));
  const { recomputeInflationForGuild } = await import("../economy/inflation.js");
  await recomputeInflationForGuild(interaction.guildId!);
  return interaction.reply({ content: `✅ Multiplier range set to **${minRaw.toFixed(2)}x – ${maxRaw.toFixed(2)}x**. Recomputed.`, ephemeral: true });
}

async function handleServerFeaturesHub(interaction: ButtonInteraction) {
  const guildId  = interaction.guildId!;
  const settings = await getServerSettings(guildId);

  await (interaction as any).update({
    embeds: [buildSettingsEmbed(settings)],
    components: buildSettingsRows(settings),
  });
}

async function handleServerSetupHub(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🔧 Server Setup")
    .setDescription(
      "**⚡ Init Existing Server** — Seeds DB settings, season, and team slots for a server that already has Discord channels.\n\n" +
      "**🏗️ Init NEW Server** — Full initialization: creates all channels, roles, categories, seeds DB, and posts setup guide. " +
      "⚠️ **Deletes ALL existing channels.**\n\n" +
      "**🔗 Manual Channel Link** — Map an existing Discord channel to a known bot channel key (commish log, matchups, etc.).\n\n" +
      "**📏 Set Franchise Length** — Change the number of seasons for this franchise.\n\n" +
      "**📜 Rules / 📋 Waitlist / 👥 Admins / 🏆 Commissioner** — Manage league governance data.",
    )
    .setFooter({ text: "Server Setup sub-menu" })
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_init_existing").setLabel("⚡ Init Existing Server").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_init_new").setLabel("🏗️ Init NEW Server").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ao_manual_channel_link").setLabel("🔗 Manual Channel Link").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_set_franchise_len").setLabel("📏 Set Franchise Length").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_rules").setLabel("📜 Rules").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_waitlist").setLabel("📋 Waitlist").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_admins").setLabel("👥 Admins").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_commissioner").setLabel("🏆 Commissioner").setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_server_settings").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({ embeds: [embed], components: [row1, row2, row3] });
}

// ── Init Existing Server ───────────────────────────────────────────────────────

async function handleInitExisting(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_init_existing")
    .setTitle("Init Existing Server");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("starting_week")
        .setLabel("Starting Week (e.g. training_camp, week_1)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("training_camp")
        .setValue("training_camp"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("franchise_length")
        .setLabel("Franchise Length (seasons, 1-30)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("10")
        .setValue("10"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("current_season")
        .setLabel("Current Season Number")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("1")
        .setValue("1"),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalInitExisting(interaction: ModalSubmitInteraction) {
  const guildId             = interaction.guildId!;
  const startingWeek        = interaction.fields.getTextInputValue("starting_week").trim() || "training_camp";
  const franchiseLength     = Math.max(1, Math.min(30, parseInt(interaction.fields.getTextInputValue("franchise_length").trim(), 10) || 10));
  const currentSeasonNumber = Math.max(1, Math.min(30, parseInt(interaction.fields.getTextInputValue("current_season").trim(), 10) || 1));

  await interaction.deferReply({ ephemeral: true });

  try {
    const { log } = await runExistingServerInit({
      guildId, userId: interaction.user.id, userTag: interaction.user.tag,
      startingWeek, franchiseLength, currentSeasonNumber,
    });

    await registerCommandsForGuild(guildId);
    log.push("⚡ Slash commands re-registered for this server.");

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Existing Server Initialized")
      .setDescription(log.join("\n"))
      .setFooter({ text: "No channels were modified — only DB data was updated" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("[handleModalInitExisting]", err);
    await interaction.editReply({ content: `❌ Initialization failed: ${(err as Error).message}` });
  }
}

// ── Init NEW Server ────────────────────────────────────────────────────────────

async function handleInitNew(interaction: ButtonInteraction) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("⚠️ Init NEW Server — Destructive Warning")
    .setDescription(
      "**This will PERMANENTLY DELETE all existing Discord channels** and rebuild the server from scratch.\n\n" +
      "This includes ALL categories, text channels, and voice channels. This action **cannot be undone**.\n\n" +
      "Only proceed on a brand-new server or if you are completely rebuilding the league server structure.\n\n" +
      "Click **Proceed** to enter setup options, or **Cancel** to go back.",
    )
    .setFooter({ text: "ALL channels will be deleted — this is irreversible" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_init_new_proceed").setLabel("⚠️ Proceed — I understand channels will be deleted").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ao_server_setup").setLabel("← Cancel").setStyle(ButtonStyle.Secondary),
  );

  await (interaction as any).update({ embeds: [embed], components: [row] });
}

async function handleInitNewProceed(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_init_new")
    .setTitle("Initialize New Server");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("starting_week")
        .setLabel("Starting Week (e.g. training_camp, week_1)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("training_camp")
        .setValue("training_camp"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("franchise_length")
        .setLabel("Franchise Length (seasons, 1-30)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("10")
        .setValue("10"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("current_season")
        .setLabel("Current Season Number")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("1")
        .setValue("1"),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalInitNew(interaction: ModalSubmitInteraction) {
  const guildId             = interaction.guildId!;
  const guild               = interaction.guild;
  const startingWeek        = interaction.fields.getTextInputValue("starting_week").trim() || "training_camp";
  const franchiseLength     = Math.max(1, Math.min(30, parseInt(interaction.fields.getTextInputValue("franchise_length").trim(), 10) || 10));
  const currentSeasonNumber = Math.max(1, Math.min(30, parseInt(interaction.fields.getTextInputValue("current_season").trim(), 10) || 1));

  if (!guild) {
    await interaction.reply({ content: "❌ Must be run inside a Discord server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const { embed, log } = await runNewServerInit({
      guildId,
      userId:              interaction.user.id,
      userTag:             interaction.user.tag,
      guild,
      startingWeek,
      franchiseLength,
      currentSeasonNumber,
      editReply:    (content) => interaction.editReply({ content }),
      fetchChannel: (id)      => interaction.client.channels.fetch(id),
    });

    await registerCommandsForGuild(guildId);
    log.push("⚡ Slash commands registered for this server.");

    const logEmbed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("📋 Initialization Log")
      .setDescription(log.join("\n").slice(0, 4000))
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
    );

    await interaction.editReply({ embeds: [embed, logEmbed], components: [row] });
  } catch (err) {
    console.error("[handleModalInitNew]", err);
    await interaction.editReply({ content: `❌ Initialization failed: ${(err as Error).message}` });
  }
}

// ── Set Franchise Length ───────────────────────────────────────────────────────

async function handleSetFranchiseLen(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const settings = await getServerSettings(guildId);

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_franchise_len")
    .setTitle("Set Franchise Length");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("franchise_length")
        .setLabel("Franchise Length (number of seasons, 1-30)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("10")
        .setValue(String(settings.maxSeasons ?? 10)),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalFranchiseLen(interaction: ModalSubmitInteraction) {
  const guildId = interaction.guildId!;
  const raw     = interaction.fields.getTextInputValue("franchise_length").trim();
  const limit   = parseInt(raw, 10);

  if (isNaN(limit) || limit < 1 || limit > 30) {
    await interaction.reply({ content: "❌ Please enter a whole number between 1 and 30.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  await db.update(serverSettingsTable)
    .set({ maxSeasons: limit, updatedAt: new Date() })
    .where(eq(serverSettingsTable.guildId, guildId));

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📏 Franchise Length Updated")
    .setDescription(`Franchise length set to **${limit}** season(s).`)
    .setFooter({ text: "Use Server Setup to view all setup options" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── Manual Channel Link ────────────────────────────────────────────────────────

const MANUAL_LINKABLE: { label: string; value: string; description: string }[] = [
  { label: "Commissioner Log",    value: CHANNEL_KEYS.COMMISSIONER_LOG,    description: "General commissioner log"        },
  { label: "Transaction Log",     value: CHANNEL_KEYS.TRANSACTION_LOG,     description: "Coin movement transactions"      },
  { label: "Upgrades Log",        value: CHANNEL_KEYS.UPGRADES_LOG,        description: "Dev/age/attribute upgrades"      },
  { label: "Draft Purchases Log", value: CHANNEL_KEYS.DRAFT_PURCHASES_LOG, description: "Legend & custom player purchases" },
  { label: "Import Log",          value: CHANNEL_KEYS.IMPORT_LOG,          description: "Week import confirmations"       },
  { label: "Violation Log",       value: CHANNEL_KEYS.VIOLATION_LOG,       description: "Rule violation reports"         },
  { label: "Commissioner",        value: CHANNEL_KEYS.COMMISSIONER,        description: "Legacy fallback channel"        },
  { label: "Transactions",        value: CHANNEL_KEYS.TRANSACTIONS,        description: "Legacy transaction channel"     },
  { label: "Announcements",       value: CHANNEL_KEYS.ANNOUNCEMENTS,       description: "League announcements"           },
  { label: "Matchups",            value: CHANNEL_KEYS.MATCHUPS,            description: "Weekly matchups post"           },
  { label: "Schedule",            value: CHANNEL_KEYS.SCHEDULE,            description: "Season schedule"               },
  { label: "GOTW",                value: CHANNEL_KEYS.GOTW,                description: "Game of the Week poll"         },
  { label: "Headlines",           value: CHANNEL_KEYS.HEADLINES,           description: "Media headlines"               },
  { label: "GOTY",                value: CHANNEL_KEYS.GOTY,                description: "Game of the Year"              },
  { label: "Draft Tracker",       value: CHANNEL_KEYS.DRAFT_TRACKER,       description: "Draft tracker"                 },
  { label: "Payouts",             value: CHANNEL_KEYS.PAYOUTS,             description: "Payout announcements"         },
  { label: "Welcome",             value: CHANNEL_KEYS.WELCOME,             description: "New member welcome"            },
  { label: "General",             value: CHANNEL_KEYS.GENERAL,             description: "General channel"              },
  { label: "Stream",              value: CHANNEL_KEYS.STREAM,              description: "Stream notifications"          },
  { label: "Highlights",          value: CHANNEL_KEYS.HIGHLIGHTS,          description: "Game highlights"              },
];

async function handleManualChannelLinkPicker(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;

  // Load all currently saved channel links for this guild in one query
  const savedLinks = await db.select()
    .from(guildChannelsTable)
    .where(eq(guildChannelsTable.guildId, guildId));
  const linkMap = new Map(savedLinks.map(r => [r.channelKey, r.channelId]));

  // Resolve channel names from the guild channel cache
  await interaction.guild?.channels.fetch().catch(() => null);
  const chCache = interaction.guild?.channels.cache;
  const chName  = (id: string | undefined) => {
    if (!id) return null;
    const ch = chCache?.get(id);
    return ch ? `#${ch.name}` : `#${id}`;
  };

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_manual_ch_select")
    .setPlaceholder("Select a channel function to link…")
    .addOptions(
      MANUAL_LINKABLE.map(item => {
        const linkedName = chName(linkMap.get(item.value));
        const desc = linkedName
          ? `Currently: ${linkedName}`.slice(0, 50)
          : item.description.slice(0, 50);
        return new StringSelectMenuOptionBuilder()
          .setLabel(item.label)
          .setValue(item.value)
          .setDescription(desc);
      }),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const linkedCount = MANUAL_LINKABLE.filter(i => linkMap.has(i.value)).length;
  const embed = new EmbedBuilder()
    .setTitle("🔗 Manual Channel Link")
    .setDescription(
      `**${linkedCount}/${MANUAL_LINKABLE.length}** channel functions are currently linked.\n\n` +
      "Select a function below to assign it to a channel — you'll see the server's channels listed in a dropdown. " +
      "Choose **🗑️ Clear link** to remove an existing link (the bot will fall back to the commissioner channel).",
    )
    .setColor(0x5865f2);

  await (interaction as any).update({
    embeds: [embed],
    components: [row as ActionRowBuilder<any>],
  });
}

async function handleManualChannelSelect(interaction: StringSelectMenuInteraction) {
  const key = interaction.values[0]!;
  await openChannelPickerForKey(interaction, key);
}

// Opens the per-key channel-picker UI. Reusable from elsewhere (e.g. the
// Commissioner's Office "Set GOTY Channel" shortcut button).
export async function openChannelPickerForKey(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  key: string,
) {
  const keyLabel = MANUAL_LINKABLE.find(k => k.value === key)?.label ?? key;

  // Fetch guild text channels
  await interaction.guild?.channels.fetch().catch(() => null);
  const textChannels = (interaction.guild?.channels.cache
    .filter(ch => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(ch => ({ id: ch.id, name: ch.name })) ?? []) as { id: string; name: string }[];

  const CLEAR_OPTION = new StringSelectMenuOptionBuilder()
    .setLabel("🗑️ Clear link (use fallback)")
    .setValue("CLEAR")
    .setDescription("Remove this channel link; bot falls back to commissioner channel");

  const rows: ActionRowBuilder<any>[] = [];

  // First dropdown: first 24 text channels + clear option (max 25)
  const firstBatch = textChannels.slice(0, 24);
  const firstMenu  = new StringSelectMenuBuilder()
    .setCustomId(`ao_ch_assign:${key}`)
    .setPlaceholder(`Assign channel for: ${keyLabel}`)
    .addOptions([
      CLEAR_OPTION,
      ...firstBatch.map(ch =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`#${ch.name}`.slice(0, 100))
          .setValue(ch.id),
      ),
    ]);
  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(firstMenu) as ActionRowBuilder<any>);

  // Second dropdown: channels 25–49 if they exist (max 25 per menu)
  const secondBatch = textChannels.slice(24, 49);
  if (secondBatch.length > 0) {
    const secondMenu = new StringSelectMenuBuilder()
      .setCustomId(`ao_ch_assign:${key}`)
      .setPlaceholder("…more channels")
      .addOptions(
        secondBatch.map(ch =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`#${ch.name}`.slice(0, 100))
            .setValue(ch.id),
        ),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(secondMenu) as ActionRowBuilder<any>);
  }

  // Back button row
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ao_manual_channel_link").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Hub").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
    ) as ActionRowBuilder<any>,
  );

  const embed = new EmbedBuilder()
    .setTitle(`🔗 ${keyLabel}`)
    .setDescription(`Select a channel from the dropdown${secondBatch.length > 0 ? "s" : ""} below to link it, or choose **🗑️ Clear link** to remove the current assignment.`)
    .setColor(0x5865f2);

  await (interaction as any).update({ embeds: [embed], components: rows });
}

async function handleChannelAssign(interaction: StringSelectMenuInteraction) {
  const guildId  = interaction.guildId!;
  const key      = interaction.customId.split(":").slice(1).join(":"); // everything after first ":"
  const value    = interaction.values[0]!;
  const keyLabel = MANUAL_LINKABLE.find(k => k.value === key)?.label ?? key;

  if (value === "CLEAR") {
    await setGuildChannel(guildId, key, null);
    await interaction.reply({
      content: `✅ **${keyLabel}** link cleared — messages will fall back to the commissioner channel.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await setGuildChannel(guildId, key, value);
  await interaction.reply({
    content: `✅ **${keyLabel}** linked to <#${value}>.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ── Troubleshoot Hub ───────────────────────────────────────────────────────────

async function handleTroubleshootHub(interaction: ButtonInteraction) {
  await (interaction as any).update({
    embeds: [buildTroubleshootEmbed()],
    components: buildTroubleshootRows() as ActionRowBuilder<any>[],
  });
}

// ── Report Bug ─────────────────────────────────────────────────────────────────

async function handleReportBug(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ao_modal_report_bug")
    .setTitle("Report a Bug");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("bug_title")
        .setLabel("Bug Title / Summary")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. GOTW bonus not awarded in Week 7")
        .setRequired(true)
        .setMaxLength(200),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("bug_description")
        .setLabel("Description / Steps to Reproduce")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Describe what happened, what you expected, and any relevant details...")
        .setRequired(true)
        .setMaxLength(1500),
    ),
  );

  await interaction.showModal(modal);
}

async function handleModalReportBug(interaction: ModalSubmitInteraction) {
  const guildId     = interaction.guildId!;
  const title       = interaction.fields.getTextInputValue("bug_title").trim();
  const description = interaction.fields.getTextInputValue("bug_description").trim();

  await interaction.deferReply({ ephemeral: true });

  try {
    const commLogChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG);
    if (commLogChannelId) {
      const ch = (interaction.client.channels.cache.get(commLogChannelId)
        ?? await interaction.client.channels.fetch(commLogChannelId).catch(() => null)) as TextChannel | null;
      if (ch?.isTextBased()) {
        await (ch as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Red)
              .setTitle(`🐛 Bug Report: ${title}`)
              .setDescription(description)
              .setFooter({ text: `Reported by ${interaction.user.username} (${interaction.user.id})` })
              .setTimestamp(),
          ],
        });
      }
    }

    await interaction.editReply({ content: `✅ Bug report submitted: **${title}**. It has been logged to the commissioner log.` });
  } catch (err) {
    console.error("[admin-operations] Bug report error:", err);
    await interaction.editReply({ content: `❌ Failed to submit bug report: ${err}` });
  }
}

// ── Set Week ───────────────────────────────────────────────────────────────────

async function handleSetWeek(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const current = season.currentWeek ?? "1";

  const weekOptions = WEEK_SEQUENCE.map(w => ({
    label: weekLabel(w),
    value: w,
    default: w === current,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_setwk_sel")
    .setPlaceholder(`Current: ${weekLabel(current)}`)
    .addOptions(weekOptions.map(o =>
      new StringSelectMenuOptionBuilder()
        .setLabel(o.label)
        .setValue(o.value)
        .setDefault(o.default),
    ));

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📅 Set Week")
        .setDescription(
          `Current week: **${weekLabel(current)}**\n\n` +
          "Select a week to set. **No auto-actions will run** — channels, GOTW, and articles are NOT triggered.\n" +
          "Use **⏩ Advance Week** if you want all auto-actions."
        ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>, backRow],
  });
}

async function handleSetWeekSelect(interaction: StringSelectMenuInteraction, _sess: AoSession) {
  const guildId = interaction.guildId!;
  const newWeek = interaction.values[0]!;
  const season  = await getOrCreateActiveSeason(guildId);
  const oldLabel = weekLabel(season.currentWeek ?? "1");
  const newLabel = weekLabel(newWeek);

  await db.update(seasonsTable)
    .set({ currentWeek: newWeek })
    .where(eq(seasonsTable.id, season.id));

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📅 Week Updated")
    .setDescription(
      `Week changed from **${oldLabel}** → **${newLabel}**.\n\n` +
      "No auto-actions were triggered. Use **⏩ Advance Week** for full auto-processing."
    )
    .setTimestamp();

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({ embeds: [embed], components: [backRow] });
}

// ── Advance Week ───────────────────────────────────────────────────────────────

async function handleAdvanceWeek(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const current = season.currentWeek ?? "1";

  const currentIdx = WEEK_SEQUENCE.indexOf(current);
  const nextIdx    = currentIdx === -1 ? 0 : Math.min(currentIdx + 1, WEEK_SEQUENCE.length - 1);
  const nextWeek   = WEEK_SEQUENCE[nextIdx]!;

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_advance_confirm").setLabel("✅ Confirm Advance").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("✖ Cancel").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("⏩ Advance Week — Confirm")
        .setDescription(
          `**Current week:** ${weekLabel(current)}\n` +
          `**Next week:** **${weekLabel(nextWeek)}**\n\n` +
          "This will run **all auto-actions**:\n" +
          "• Create matchup channels for H2H games\n" +
          "• Award GOTW participation bonuses\n" +
          "• Process playoff payouts (if applicable)\n" +
          "• And more...\n\n" +
          "**Are you sure?**"
        ),
    ],
    components: [confirmRow],
  });
}

async function handleAdvanceConfirm(interaction: ButtonInteraction) {
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("⏩ Advancing Week...")
        .setDescription("Please wait — running all auto-actions..."),
    ],
    components: [],
  });

  try {
    await performAdvanceWeek(interaction);
  } catch (err) {
    console.error("[admin-operations] Advance week error:", err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Advance Week Failed")
          .setDescription(`An error occurred: ${err}`),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        ) as ActionRowBuilder<any>,
      ],
    });
  }
}

// ── Advance Week — Core Logic (adapted from advanceweek.ts) ───────────────────

async function postCommissionerNotice(
  client:  import("discord.js").Client,
  guildId: string,
  message: string,
): Promise<void> {
  try {
    const chId = await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG);
    if (!chId) return;
    const ch = (client.channels.cache.get(chId) ?? await client.channels.fetch(chId).catch(() => null)) as TextChannel | null;
    if (ch?.isTextBased()) await (ch as TextChannel).send({ content: message }).catch(() => {});
  } catch (err) {
    console.error("[admin-operations] Failed to post commissioner notice:", err);
  }
}

function toChannelName(teamName: string): string {
  return teamName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");
}

async function performAdvanceWeek(interaction: ButtonInteraction): Promise<void> {
  const guildId    = interaction.guildId!;
  const season     = await getOrCreateActiveSeason(guildId);

  const announceChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.ANNOUNCEMENTS);
  const offseasonWipeIds  = (await Promise.all([
    getGuildChannel(guildId, CHANNEL_KEYS.PAYOUTS),
    getGuildChannel(guildId, CHANNEL_KEYS.HIGHLIGHTS),
    getGuildChannel(guildId, CHANNEL_KEYS.STREAM),
    getGuildChannel(guildId, CHANNEL_KEYS.HEADLINES),
    getGuildChannel(guildId, CHANNEL_KEYS.MATCHUPS),
    getGuildChannel(guildId, CHANNEL_KEYS.SCHEDULE),
    getGuildChannel(guildId, CHANNEL_KEYS.ANNOUNCEMENTS),
  ])).filter((id): id is string => !!id);

  const currentIdx    = WEEK_SEQUENCE.indexOf(season.currentWeek ?? "1");
  const wouldClamp    = currentIdx !== -1 && currentIdx + 1 >= WEEK_SEQUENCE.length;
  const isTrainingEnd = season.currentWeek === "training_camp" && wouldClamp;

  // ── Auto-rollover: Training Camp → Week 1 of next season ─────────────────────
  let autoRolloverNote = "";
  if (isTrainingEnd) {
    const maxSeasons   = await getMaxSeasons(guildId);
    const nextNumber   = (season.seasonNumber ?? 0) + 1;

    if (nextNumber > maxSeasons) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("🏁 Franchise Complete")
            .setDescription(
              `This franchise has reached its **${maxSeasons}-season limit**.\n\n` +
              `Season ${season.seasonNumber} is the final season — you cannot advance past it.\n\n` +
              `• Use **🔢 Set Season Number** to re-activate any previous season.\n` +
              `• Or increase the franchise length via \`/admin-initialize\`.`
            ),
        ],
        components: buildAdminOpsRows(),
      });
      return;
    }

    // Rollover current-season legends → permanent (4-cap per user)
    const PERMANENT_CAP = 4;
    const currentLegends = await db.select().from(inventoryTable)
      .where(and(
        eq(inventoryTable.seasonId, season.id),
        eq(inventoryTable.itemType, "legend"),
        sql`${inventoryTable.legendCategory} = 'current'`,
      ));
    let legendsPromoted = 0, legendsReturned = 0;
    const byUser: Record<string, typeof currentLegends> = {};
    for (const item of currentLegends) {
      if (!byUser[item.discordId]) byUser[item.discordId] = [];
      byUser[item.discordId]!.push(item);
    }
    for (const [userId, legends] of Object.entries(byUser)) {
      const [userRow] = await db.select({ team: usersTable.team }).from(usersTable)
        .where(and(eq(usersTable.discordId, userId), eq(usersTable.guildId, guildId))).limit(1);
      const teamName = userRow?.team ?? null;
      const [countRow] = await db.select({ c: sql<string>`count(*)` }).from(inventoryTable)
        .where(and(
          eq(inventoryTable.discordId, userId),
          eq(inventoryTable.itemType, "legend"),
          sql`${inventoryTable.legendCategory} = 'permanent'`,
        ));
      const existing  = parseInt(countRow?.c ?? "0", 10);
      const slotsLeft = Math.max(0, PERMANENT_CAP - existing);
      const toPromote = legends.slice(0, slotsLeft);
      const toReturn  = legends.slice(slotsLeft);
      for (const item of toPromote) {
        await db.update(inventoryTable)
          .set({ legendCategory: "permanent", ...(teamName ? { team: teamName } : {}) })
          .where(eq(inventoryTable.id, item.id));
        legendsPromoted++;
      }
      for (const item of toReturn) {
        if (item.legendId) {
          await db.update(legendsTable).set({ isAvailable: true }).where(eq(legendsTable.id, item.legendId));
        }
        await db.delete(inventoryTable).where(eq(inventoryTable.id, item.id));
        await db.update(usersTable)
          .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, userId));
        legendsReturned++;
      }
    }

    // Rollover active custom players → permanent inventory
    const activeCustomPlayers = await db.select().from(customPlayersTable)
      .where(and(eq(customPlayersTable.seasonId, season.id), ne(customPlayersTable.status, "refunded")));
    let customPlayersRolled = 0;
    const tierToItemType = (tier: string): "custom_player_gold" | "custom_player_silver" | "custom_player_bronze" =>
      tier === "gold" ? "custom_player_gold" : tier === "silver" ? "custom_player_silver" : "custom_player_bronze";
    for (const cp of activeCustomPlayers) {
      const [existingCp] = await db.select({ id: inventoryTable.id }).from(inventoryTable)
        .where(and(
          eq(inventoryTable.discordId, cp.discordId),
          eq(inventoryTable.seasonId, season.id),
          eq(inventoryTable.itemType, tierToItemType(cp.packageTier)),
          sql`${inventoryTable.playerName} = ${`${cp.firstName} ${cp.lastName}`}`,
          sql`${inventoryTable.legendCategory} = 'permanent'`,
        )).limit(1);
      if (existingCp) continue;
      const [cpUser] = await db.select({ team: usersTable.team }).from(usersTable)
        .where(and(eq(usersTable.discordId, cp.discordId), eq(usersTable.guildId, guildId))).limit(1);
      await db.insert(inventoryTable).values({
        discordId:      cp.discordId,
        seasonId:       season.id,
        purchaseId:     0,
        itemType:       tierToItemType(cp.packageTier),
        playerName:     `${cp.firstName} ${cp.lastName}`,
        playerPosition: cp.position,
        legendCategory: "permanent",
        ...(cpUser?.team ? { team: cpUser.team } : {}),
      });
      customPlayersRolled++;
    }

    // Activate Season N+1 — prefer the record pre-seeded at Superbowl → Offseason;
    // fall back to creating a fresh one if that step was skipped.
    await db.update(seasonsTable)
      .set({ isActive: false })
      .where(eq(seasonsTable.guildId, guildId));

    const existingNext = await db.select().from(seasonsTable)
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.seasonNumber, nextNumber)))
      .limit(1);

    let newSeasonRecord: { id: number; seasonNumber: number } | undefined;
    let carryTeams = 0, carryRosters = 0;

    if (existingNext.length > 0) {
      // Season N+1 was already seeded at Superbowl → Offseason — just activate it.
      const [activated] = await db.update(seasonsTable)
        .set({ isActive: true })
        .where(eq(seasonsTable.id, existingNext[0]!.id))
        .returning({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber });
      newSeasonRecord = activated;
      // Count existing carry-forward rows for the summary note
      const [tc] = await db.select({ c: sql<string>`count(*)` }).from(franchiseMcaTeamsTable)
        .where(eq(franchiseMcaTeamsTable.seasonId, existingNext[0]!.id));
      const [rc] = await db.select({ c: sql<string>`count(*)` }).from(franchiseRostersTable)
        .where(eq(franchiseRostersTable.seasonId, existingNext[0]!.id));
      carryTeams  = parseInt(tc?.c ?? "0", 10);
      carryRosters = parseInt(rc?.c ?? "0", 10);
    } else {
      // Fallback: create Season N+1 and copy teams/rosters now
      const [created] = await db.insert(seasonsTable)
        .values({ guildId, seasonNumber: nextNumber, isActive: true })
        .returning({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber });
      newSeasonRecord = created;

      if (newSeasonRecord) {
        const prevTeams = await db.select().from(franchiseMcaTeamsTable)
          .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
        if (prevTeams.length > 0) {
          const teamRows = prevTeams.map(t => ({
            seasonId: newSeasonRecord!.id, teamId: t.teamId, fullName: t.fullName,
            nickName: t.nickName, userName: t.userName, isHuman: t.isHuman, discordId: t.discordId,
          }));
          await db.insert(franchiseMcaTeamsTable).values(teamRows).onConflictDoNothing();
          carryTeams = teamRows.length;

          const prevRosters = await db.select().from(franchiseRostersTable)
            .where(eq(franchiseRostersTable.seasonId, season.id));
          if (prevRosters.length > 0) {
            const rosterRows = prevRosters.map(r => ({
              seasonId: newSeasonRecord!.id, teamId: r.teamId, teamName: r.teamName,
              discordId: r.discordId, playerId: r.playerId, firstName: r.firstName,
              lastName: r.lastName, position: r.position, overall: r.overall,
              devTrait: r.devTrait, age: r.age, jerseyNum: r.jerseyNum,
              contractYearsLeft: r.contractYearsLeft, attributes: r.attributes,
            }));
            for (let i = 0; i < rosterRows.length; i += 500) {
              await db.insert(franchiseRostersTable).values(rosterRows.slice(i, i + 500)).onConflictDoNothing();
            }
            carryRosters = rosterRows.length;
          }
        }
      }
    }

    const isLastSeason = nextNumber === maxSeasons;
    const rosterNote = carryTeams > 0
      ? `• ${carryTeams} team links + ${carryRosters} roster rows active for Season ${nextNumber}.`
      : "• No roster data seeded — MCA import required.";
    autoRolloverNote = [
      `🎉 **Season ${nextNumber} of ${maxSeasons} has begun!**` + (isLastSeason ? " ⚠️ This is the final season." : ""),
      `• ${legendsPromoted} legend(s) moved to permanent vaults${legendsReturned > 0 ? `; ${legendsReturned} returned to store (vault full)` : ""}.`,
      customPlayersRolled > 0 ? `• ${customPlayersRolled} custom player(s) rolled over to permanent inventories.` : "",
      rosterNote,
    ].filter(Boolean).join("\n");
    console.log(`[admin-operations] Auto season rollover: Season ${season.seasonNumber} → ${nextNumber} (guildId=${guildId})`);

    // Point season reference at the new active record for the week update below
    Object.assign(season, { id: newSeasonRecord!.id, seasonNumber: nextNumber });
  }

  const nextIdx = isTrainingEnd ? 0 : (currentIdx === -1 ? 0 : Math.min(currentIdx + 1, WEEK_SEQUENCE.length - 1));
  const newWeek = WEEK_SEQUENCE[nextIdx]!;

  await db.update(seasonsTable)
    .set({ currentWeek: newWeek })
    .where(eq(seasonsTable.id, season.id));

  // ── Stamp last_advance_at on serverSettings (drives game-channel header
  // "Next Advance" deadline computation) ──────────────────────────────────────
  const advanceStampedAt = new Date();
  try {
    await db.update(serverSettingsTable)
      .set({ lastAdvanceAt: advanceStampedAt })
      .where(eq(serverSettingsTable.guildId, guildId));
  } catch (advErr) {
    console.error("[admin-operations] Failed to stamp lastAdvanceAt:", advErr);
  }

  // ── Announce the advance to #general — tags @everyone, shows the next
  // advance deadline in all 4 league time zones. Silent no-op if the guild
  // hasn't set a General channel (admins can set one in Commissioner's Office). ─
  try {
    const settingsForAnnounce = await getServerSettings(guildId);
    const periodHours = settingsForAnnounce?.advancePeriodHours ?? 72;
    const generalChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.GENERAL);
    if (generalChannelId) {
      const ch = (interaction.client.channels.cache.get(generalChannelId)
        ?? await interaction.client.channels.fetch(generalChannelId).catch(() => null)) as TextChannel | null;
      if (ch?.isTextBased()) {
        const nextDeadline = nextAdvanceDeadline(advanceStampedAt, periodHours);
        const newWeekPreview = WEEK_SEQUENCE[
          (season.currentWeek === "training_camp" ? 0 : Math.min((WEEK_SEQUENCE.indexOf(season.currentWeek as any) ?? -1) + 1, WEEK_SEQUENCE.length - 1))
        ]!;
        const announceEmbed = new EmbedBuilder()
          .setColor(Colors.Gold)
          .setTitle(`📅 League Advanced — Now ${weekLabel(newWeekPreview)}`)
          .setDescription(
            `The league has just advanced to **${weekLabel(newWeekPreview)}**.\n` +
            `**Advance period:** ${periodHours} hours.\n\n` +
            `**Next Advance:** ${discordTimestampLong(nextDeadline)}`,
          )
          .addFields({ name: "🌎 Next Advance — All Time Zones", value: formatAllZones(nextDeadline) })
          .setTimestamp(advanceStampedAt);
        await ch.send({
          content: "@everyone — the league has advanced. ⏱️ Get your games in before the next advance!",
          embeds:  [announceEmbed],
          allowedMentions: { parse: ["everyone"] },
        }).catch(err => console.error("[admin-operations] Advance announce send failed:", err));
      }
    } else {
      console.log(`[admin-operations] No GENERAL channel linked for guild ${guildId} — skipping advance announcement.`);
    }
  } catch (annErr) {
    console.error("[admin-operations] Advance announcement error:", annErr);
  }

  const channelLines: string[] = [];

  // ── Positional Trainer weekly tick (one roll per active trainer per advance) ─
  // Fires when leaving a regular-season week (1..18). The "currentWeekIndex"
  // used for cooldown math is the week we're leaving.
  const oldWeekNumForTrainer = parseInt(season.currentWeek ?? "0", 10);
  if (!isNaN(oldWeekNumForTrainer) && oldWeekNumForTrainer >= 1 && oldWeekNumForTrainer <= 18) {
    try {
      const rosterSeasonId = await getRosterSeasonId(guildId);
      const tickSummary = await runWeeklyTrainerTick({
        client:           interaction.client,
        guildId,
        seasonId:         season.id,
        rosterSeasonId,
        currentWeekIndex: oldWeekNumForTrainer - 1,
      });
      if (tickSummary.ticked > 0) {
        channelLines.push(
          `🏋️ Trainer ticks (W${oldWeekNumForTrainer}): ${tickSummary.hits} hit / ${tickSummary.misses} miss` +
          (tickSummary.expired > 0 ? ` · ${tickSummary.expired} contract(s) completed` : "") +
          (tickSummary.skipped > 0 ? ` · ${tickSummary.skipped} already ticked` : ""),
        );
      }
    } catch (err) {
      console.error("[admin-operations] Trainer weekly tick error:", err);
    }
  }

  // ── Regular-season-end auto-expire — any remaining active trainers are
  // closed out when entering wildcard (paid upfront, no refund). ──────────────
  if (newWeek === "wildcard") {
    try {
      const expired = await expireAllActiveTrainersForSeason(guildId, season.id);
      if (expired > 0) {
        channelLines.push(`🏋️ Auto-expired **${expired}** positional trainer contract(s) (end of regular season).`);
      }
    } catch (err) {
      console.error("[admin-operations] Trainer wildcard expire error:", err);
    }
  }

  // ── Wipe preseason stats when advancing from Training Camp → Week 1 ─────────
  let preseasonWipeNote = "";
  if (season.currentWeek === "training_camp" && newWeek === "1") {
    try {
      await Promise.all([
        db.delete(playerSeasonStatsTable)      .where(eq(playerSeasonStatsTable.seasonId,      season.id)),
        db.delete(playerStatWeekProcessedTable).where(eq(playerStatWeekProcessedTable.seasonId, season.id)),
        db.delete(gameLogTable)                .where(eq(gameLogTable.seasonId,                 season.id)),
        db.delete(userRecordsTable)            .where(eq(userRecordsTable.seasonId,              season.id)),
        db.delete(statPaddingViolationsTable)  .where(eq(statPaddingViolationsTable.seasonId,   season.id)),
      ]);
      preseasonWipeNote =
        "✅ Preseason stats cleared (player stats, game logs, W/L records, and violation flags have been reset for the regular season).";
      console.log(`[admin-operations] Preseason stats wiped for season ${season.id}`);
    } catch (err) {
      preseasonWipeNote = "⚠️ Preseason stat wipe partially failed — check logs.";
      console.error("[admin-operations] Preseason stat wipe error:", err);
    }
  }

  // ── GOTW bonus + cleanup for the week we're leaving ───────────────────────────
  const oldWeekNum = parseInt(season.currentWeek ?? "1", 10);
  if (!isNaN(oldWeekNum) && oldWeekNum >= 1 && oldWeekNum <= 18) {
    const oldWeekIndex = oldWeekNum - 1;

    try {
      const [gotwRow] = await db.select()
        .from(gotwHistoryTable)
        .where(and(
          eq(gotwHistoryTable.seasonId,  season.id),
          eq(gotwHistoryTable.weekIndex, oldWeekIndex),
        ))
        .limit(1);

      if (gotwRow) {
        const scheduleGames = await db.select()
          .from(franchiseScheduleTable)
          .where(and(
            eq(franchiseScheduleTable.seasonId,  season.id),
            eq(franchiseScheduleTable.weekIndex, oldWeekIndex),
          ));

        const mcaForGotw = await db.select({
          discordId: franchiseMcaTeamsTable.discordId,
          fullName:  franchiseMcaTeamsTable.fullName,
          nickName:  franchiseMcaTeamsTable.nickName,
        })
          .from(franchiseMcaTeamsTable)
          .where(eq(franchiseMcaTeamsTable.seasonId, season.id));

        const gotwNameToId = new Map<string, string>();
        for (const t of mcaForGotw) {
          if (t.discordId) {
            gotwNameToId.set(t.fullName.toLowerCase().trim(), t.discordId);
            gotwNameToId.set(t.nickName.toLowerCase().trim(), t.discordId);
          }
        }

        const gotwGame = scheduleGames.find(g => {
          const awayId = gotwNameToId.get(g.awayTeamName.toLowerCase().trim());
          const homeId = gotwNameToId.get(g.homeTeamName.toLowerCase().trim());
          if (awayId && homeId) {
            return (
              (awayId === gotwRow.discordId1 && homeId === gotwRow.discordId2) ||
              (awayId === gotwRow.discordId2 && homeId === gotwRow.discordId1)
            );
          }
          const away = g.awayTeamName.toLowerCase().trim();
          const home = g.homeTeamName.toLowerCase().trim();
          const t1   = gotwRow.teamName1.toLowerCase().trim();
          const t2   = gotwRow.teamName2.toLowerCase().trim();
          return (
            (away.includes(t1) || t1.includes(away)) && (home.includes(t2) || t2.includes(home)) ||
            (away.includes(t2) || t2.includes(away)) && (home.includes(t1) || t1.includes(home))
          );
        });

        if (gotwGame && gotwGame.status === 3) {
          const GOTW_BONUS = 10;
          await addBalance(gotwRow.discordId1, GOTW_BONUS, guildId);
          await logTransaction(gotwRow.discordId1, GOTW_BONUS, "addcoins",
            `GOTW participant bonus — Week ${oldWeekNum}`, "system");
          await addBalance(gotwRow.discordId2, GOTW_BONUS, guildId);
          await logTransaction(gotwRow.discordId2, GOTW_BONUS, "addcoins",
            `GOTW participant bonus — Week ${oldWeekNum}`, "system");

          channelLines.push(
            `🏆 GOTW bonus: **+${GOTW_BONUS} coins** awarded to <@${gotwRow.discordId1}> & <@${gotwRow.discordId2}>`,
          );

          for (const discordId of [gotwRow.discordId1, gotwRow.discordId2]) {
            try {
              const user = await interaction.client.users.fetch(discordId);
              await user.send(
                `🏆 **GOTW Bonus!** You participated in this week's Game of the Week and earned **+${GOTW_BONUS} coins**!`
              ).catch(() => {});
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      console.error("[admin-operations] GOTW bonus error:", err);
    }
  }

  // ── Playoff payouts — fires when leaving a playoff week ──────────────────────
  const leavingPlayoffMeta = PLAYOFF_WEEK_META[season.currentWeek ?? ""];
  if (leavingPlayoffMeta) {
    const leavingLabel = leavingPlayoffMeta.label;

    try {
      const roundPayoutSummary = await payoutPlayoffRoundResults(
        interaction.client,
        season,
        season.currentWeek!,
        guildId,
      );
      if (roundPayoutSummary) channelLines.push(roundPayoutSummary);
    } catch (err) {
      console.error("[admin-operations] Playoff round payout error:", err);
      await postCommissionerNotice(
        interaction.client, guildId,
        `⚠️ **${leavingLabel} Payout Failed**\n` +
        `An error occurred while issuing playoff W/L records and coins: ${err}.\n` +
        "Payouts for this round were NOT fully issued. Use the admin economy tools to issue missing coins manually.",
      );
    }

    try {
      const payoutSummary = await autoPayoutPlayoffGotw(
        interaction.client,
        season.id,
        leavingPlayoffMeta.weekIndex,
        season.currentWeek!,
        guildId,
      );
      if (payoutSummary) channelLines.push(payoutSummary);
    } catch (err) {
      console.error("[admin-operations] Playoff GOTW payout error:", err);
      await postCommissionerNotice(
        interaction.client, guildId,
        `⚠️ **${leavingLabel} GOTW Payout Failed**\nPlayoff GOTW poll payouts errored: ${err}.`,
      );
    }
  }

  const oldLabel = weekLabel(season.currentWeek ?? "1");
  const newLabel = weekLabel(newWeek);

  // ── Channel lifecycle ──────────────────────────────────────────────────────
  const guild = interaction.guild;

  if (guild) {
    const oldChannels = await db.select()
      .from(gameChannelsTable)
      .where(eq(gameChannelsTable.seasonId, season.id));

    let deleted = 0;
    for (const row of oldChannels) {
      try {
        const ch = guild.channels.cache.get(row.channelId)
          ?? await guild.channels.fetch(row.channelId).catch(() => null);
        if (ch) {
          await ch.delete("Advance week — removing previous week's matchup channels");
          deleted++;
        }
      } catch (_) {}
    }

    if (oldChannels.length > 0) {
      await db.delete(gameChannelsTable)
        .where(eq(gameChannelsTable.seasonId, season.id));
      if (deleted > 0) channelLines.push(`🗑️ Removed **${deleted}** previous matchup channel${deleted !== 1 ? "s" : ""}`);
    }

    // Also sweep the GAMEDAY category for any orphaned Discord channels that have
    // no DB row (e.g. created by a previous run that failed before the DB insert).
    const gamedayCategory = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes("GAMEDAY"),
    );
    if (gamedayCategory) {
      const orphans = guild.channels.cache.filter(
        c => c.parentId === gamedayCategory.id && c.name.includes("-vs-"),
      );
      for (const [, ch] of orphans) {
        try { await ch.delete("Advance week — sweeping orphaned matchup channel"); deleted++; }
        catch (_) {}
      }
    }

    const newWeekNum = parseInt(newWeek, 10);
    let channelWeekIndex: number | null = null;
    let channelWeekDisplayLabel = weekLabel(newWeek);

    if (!isNaN(newWeekNum) && newWeekNum >= 1 && newWeekNum <= 18) {
      channelWeekIndex = newWeekNum - 1;
    } else if (PLAYOFF_WEEK_META[newWeek]) {
      channelWeekIndex = PLAYOFF_WEEK_META[newWeek]!.weekIndex;
    }

    if (channelWeekIndex !== null) {
      const weekIndex = channelWeekIndex;

      const games = await db.select()
        .from(franchiseScheduleTable)
        .where(and(
          eq(franchiseScheduleTable.seasonId,  season.id),
          eq(franchiseScheduleTable.weekIndex, weekIndex),
        ));

      const [mcaTeams, defaultLogos] = await Promise.all([
        db.select({
          fullName:  franchiseMcaTeamsTable.fullName,
          nickName:  franchiseMcaTeamsTable.nickName,
          discordId: franchiseMcaTeamsTable.discordId,
          teamId:    franchiseMcaTeamsTable.teamId,
          logoUrl:   franchiseMcaTeamsTable.logoUrl,
        }).from(franchiseMcaTeamsTable)
          .where(eq(franchiseMcaTeamsTable.seasonId, season.id)),
        db.select({
          teamId:   defaultTeamLogosTable.teamId,
          fullName: defaultTeamLogosTable.fullName,
          nickName: defaultTeamLogosTable.nickName,
          logoUrl:  defaultTeamLogosTable.logoUrl,
        }).from(defaultTeamLogosTable),
      ]);

      const defaultById   = new Map<number, string>();
      const defaultByName = new Map<string, string>();
      for (const d of defaultLogos) {
        defaultById.set(d.teamId, d.logoUrl);
        defaultByName.set(d.fullName.toLowerCase().trim(), d.logoUrl);
        defaultByName.set(d.nickName.toLowerCase().trim(), d.logoUrl);
      }

      const teamToDiscord = new Map<string, string>();
      const teamToMca     = new Map<string, typeof mcaTeams[0]>();
      for (const t of mcaTeams) {
        const keys = [
          t.fullName.toLowerCase().trim(),
          t.nickName.toLowerCase().trim(),
          String(t.teamId),
        ];
        for (const key of keys) {
          if (!teamToMca.has(key)) teamToMca.set(key, t);
          if (t.discordId && !t.discordId.startsWith("unlinked_") && !teamToDiscord.has(key))
            teamToDiscord.set(key, t.discordId);
        }
      }

      const discordIdToMca = new Map<string, typeof mcaTeams[0]>();
      for (const t of mcaTeams) {
        if (t.discordId && !t.discordId.startsWith("unlinked_")) discordIdToMca.set(t.discordId, t);
      }

      const allUsers = await db.select({
        discordId: usersTable.discordId,
        team:      usersTable.team,
      }).from(usersTable).where(eq(usersTable.guildId, guildId));
      for (const u of allUsers) {
        if (u.team && !u.discordId.startsWith("unlinked_") && !teamToDiscord.has(u.team.toLowerCase().trim())) {
          teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
        }
      }

      const discordIdToProperTeam = new Map<string, string>();
      for (const u of allUsers) {
        if (u.team && !u.discordId.startsWith("unlinked_")) discordIdToProperTeam.set(u.discordId, u.team);
      }

      // Alias full team names to real Discord IDs resolved via nickname, and enrich discordIdToMca
      for (const t of mcaTeams) {
        const byNick = teamToDiscord.get(t.nickName.toLowerCase().trim());
        if (byNick) {
          if (!teamToDiscord.has(t.fullName.toLowerCase().trim()))
            teamToDiscord.set(t.fullName.toLowerCase().trim(), byNick);
          if (!discordIdToMca.has(byNick)) discordIdToMca.set(byNick, t);
        }
      }

      const h2hGames = games.filter(g => {
        const awayId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim());
        const homeId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim());
        return awayId && homeId;
      });

      if (h2hGames.length === 0 && games.length > 0) {
        channelLines.push("📭 No H2H matchups found in schedule for this week — no channels created");
      } else if (games.length === 0) {
        channelLines.push("📭 No schedule data found for this week — run `/franchiseupdate` first");
      }

      await guild.channels.fetch();
      const matchupCategory = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes("GAMEDAY"),
      );
      const resolvedCategoryId = matchupCategory?.id ?? null;

      if (!resolvedCategoryId) {
        channelLines.push("⚠️ Could not find a GAMEDAY CENTER category in this server — matchup channels not created.");
      }

      let created = 0;
      for (const g of resolvedCategoryId ? h2hGames : []) {
        const awayDiscordId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim())!;
        const homeDiscordId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim())!;
        const awayProper    = discordIdToProperTeam.get(awayDiscordId) ?? g.awayTeamName;
        const homeProper    = discordIdToProperTeam.get(homeDiscordId) ?? g.homeTeamName;
        const awayNick      = discordIdToMca.get(awayDiscordId)?.nickName ?? discordIdToProperTeam.get(awayDiscordId) ?? g.awayTeamName.split(/\s+/).pop()!;
        const homeNick      = discordIdToMca.get(homeDiscordId)?.nickName ?? discordIdToProperTeam.get(homeDiscordId) ?? g.homeTeamName.split(/\s+/).pop()!;
        const chanName      = `${toChannelName(awayNick)}-vs-${toChannelName(homeNick)}`;

        try {
          // ── Private channel: deny @everyone, allow the 2 players + Commissioner role + bot-admins ──
          const commRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "commissioner");
          const botAdmins = await db.select({ discordId: usersTable.discordId })
            .from(usersTable)
            .where(and(eq(usersTable.guildId, guildId), eq(usersTable.isAdmin, true)));
          const overwrites: import("discord.js").OverwriteResolvable[] = [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.client.user!.id,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels] },
          ];
          if (commRole) overwrites.push({ id: commRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
          if (awayDiscordId && !awayDiscordId.startsWith("unlinked_")) overwrites.push({ id: awayDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
          if (homeDiscordId && !homeDiscordId.startsWith("unlinked_")) overwrites.push({ id: homeDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
          for (const a of botAdmins) {
            if (a.discordId && a.discordId !== awayDiscordId && a.discordId !== homeDiscordId && !a.discordId.startsWith("unlinked_")) {
              overwrites.push({ id: a.discordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
            }
          }
          const newChannel = await guild.channels.create({
            name:   chanName,
            type:   ChannelType.GuildText,
            parent: resolvedCategoryId!,
            permissionOverwrites: overwrites,
          });

          try {
            await db.insert(gameChannelsTable).values({
              seasonId:     season.id,
              weekIndex,
              channelId:    newChannel.id,
              awayTeamName: awayProper,
              homeTeamName: homeProper,
            });
          } catch (dbErr) {
            console.error(`[admin-operations] game_channels INSERT failed for ${chanName}:`, dbErr);
          }

          // ── Scheduling header ────────────────────────────────────────────────
          try {
            const sched = await ensureScheduleRow({
              guildId,
              channelId:      newChannel.id,
              seasonId:       season.id,
              weekIndex,
              awayDiscordId,
              homeDiscordId,
              awayTeamName:   awayProper,
              homeTeamName:   homeProper,
              status:         "unscheduled",
            });
            const settings  = await getServerSettings(guildId);
            const deadline  = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
            // Resolve server nicknames so both players are tagged AND named.
            const awayMember = awayDiscordId && !awayDiscordId.startsWith("unlinked_")
              ? await guild.members.fetch(awayDiscordId).catch(() => null) : null;
            const homeMember = homeDiscordId && !homeDiscordId.startsWith("unlinked_")
              ? await guild.members.fetch(homeDiscordId).catch(() => null) : null;
            const awayTag = awayMember ? `<@${awayDiscordId}> (@${awayMember.displayName})` : awayProper;
            const homeTag = homeMember ? `<@${homeDiscordId}> (@${homeMember.displayName})` : homeProper;
            const headerMsg = await newChannel.send({
              content:
                `🏈 **${awayProper} @ ${homeProper}** — ${channelWeekDisplayLabel}\n` +
                `${awayTag}  vs  ${homeTag}\n` +
                `Schedule your game using the buttons below. Good luck!`,
              components: [buildHeaderRow(sched)],
            });
            await headerMsg.pin().catch(() => {});
            await db.update(gameSchedulesTable)
              .set({ headerMessageId: headerMsg.id })
              .where(eq(gameSchedulesTable.id, sched.id));
          } catch (hdrErr) {
            console.error(`[admin-operations] Failed to post scheduling header for ${chanName}:`, hdrErr);
          }

          created++;
        } catch (chErr) {
          console.error(`[admin-operations] Failed to create channel for ${chanName}:`, chErr);
          channelLines.push(`⚠️ Could not create channel for **${g.awayTeamName} vs ${g.homeTeamName}**`);
        }
      }

      if (created > 0) {
        channelLines.push(`✅ Created **${created}** matchup channel${created !== 1 ? "s" : ""}${resolvedCategoryId ? `` : ""}`);
      }
    }
  }

  // ── Build reply embed ──────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(autoRolloverNote ? Colors.Gold : Colors.Green)
    .setTitle(autoRolloverNote ? "🎉 Season Rollover — Week 1 Begins!" : "📅 League Week Updated")
    .addFields(
      { name: "Previous Week", value: oldLabel,         inline: true },
      { name: "Current Week",  value: `**${newLabel}**`, inline: true },
    )
    .setTimestamp();

  if (autoRolloverNote) {
    embed.addFields({ name: "🔄 Season Rollover", value: autoRolloverNote });
  }

  if (channelLines.length > 0) {
    embed.addFields({ name: "📺 Matchup Channels", value: channelLines.join("\n") });
  }

  if (preseasonWipeNote) {
    embed.addFields({ name: "🧹 Preseason Data Cleared", value: preseasonWipeNote });
  }

  if (newWeek === "wildcard") {
    embed.addFields({
      name: "🏈 Wildcard Week — Auto-Actions Running",
      value: [
        "The following are running automatically in the background:",
        "• Playoff seeds set from MCA standings",
        "• Division winner bonuses issued to seeds 1–4 each conference",
        "• Matchup embeds + GOTW polls posted",
        "",
        "Seeds 1–4 earn **+75 coins/playoff win**.",
        "Seeds 5–7 (wildcard) earn **+100 coins/playoff win**.",
        "All playoff losers receive **+50 coins** upon elimination.",
      ].join("\n"),
    });
    embed.setColor(Colors.Yellow);
  }

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  ) as ActionRowBuilder<any>;

  await interaction.editReply({ embeds: [embed], components: [backRow] });

  // ── Wildcard automation + auto-reseed + division bonus + matchup flow ─────
  if (newWeek === "wildcard" && season.currentWeek === "18") {
    (async () => {
      // 1. Auto-reseed playoff seeds from saved MCA standings
      try {
        const apiDomain  = (process.env["REPLIT_DOMAINS"] ?? "").split(",")[0]?.trim() ?? "";
        const apiBase    = `https://${apiDomain}/api`;
        const webhookKey = process.env["MADDEN_WEBHOOK_KEY"] ?? "";
        const reseedRes  = await axios.post(`${apiBase}/internal/reseed-from-standings`, {}, {
          validateStatus: () => true,
          headers: webhookKey ? { Authorization: `Bearer ${webhookKey}` } : {},
        });
        const body = typeof reseedRes.data === "object" && reseedRes.data !== null
          ? reseedRes.data as { ok: boolean; message?: string; details?: { applied: number } }
          : { ok: false, message: `HTTP ${reseedRes.status}` };
        if (body.ok) {
          console.log(`[admin-operations] Auto-reseed: ${body.details?.applied ?? "?"} seeds applied.`);
        } else {
          console.error("[admin-operations] Auto-reseed failed:", body.message);
          await postCommissionerNotice(
            interaction.client, guildId,
            "⚠️ **Wildcard Auto-Reseed Failed**\n" +
            `The automatic playoff seeding from standings failed: ${body.message ?? "unknown error"}.\n` +
            "Playoff seeds were not set. Use the API endpoint manually or set seeds via the admin economy tools.",
          );
        }
      } catch (err) {
        console.error("[admin-operations] Auto-reseed error:", err);
        await postCommissionerNotice(
          interaction.client, guildId,
          `⚠️ **Wildcard Auto-Reseed Error**\nReseed threw an exception: ${err}.\nPlayoff seeds may not be set correctly.`,
        );
      }

      // 2. Division winner bonus (seeds 1–4 each conference)
      try {
        const divResult = await autoDivisionBonus(interaction.client, guildId);
        console.log("[admin-operations] Division bonus result:", divResult);
      } catch (err) {
        console.error("[admin-operations] Division bonus error:", err);
        await postCommissionerNotice(
          interaction.client, guildId,
          `⚠️ **Division Winner Bonus Failed**\nThe automatic division winner bonus threw an error: ${err}.\n` +
          "Issue the bonus manually via the economy admin tools.",
        );
      }

      // 3. Wildcard automation (in-game awards, season PR, GOTY poll, etc.)
      try {
        await runWildcardAutomation(interaction.client, season.id, season.seasonNumber, interaction.guild);
      } catch (err) {
        console.error("[admin-operations] Wildcard automation error:", err);
      }

      // 4. Playoff matchup embeds + GOTW polls
      try {
        const matchupSummary = await runPlayoffMatchupsFlow(interaction.client, season, "wildcard", guildId);
        console.log("[admin-operations] Wildcard matchups:", matchupSummary);
      } catch (err) {
        console.error("[admin-operations] Wildcard matchups flow error:", err);
        await postCommissionerNotice(
          interaction.client, guildId,
          `⚠️ **Wildcard Matchups Flow Failed**\nFailed to post Wild Card matchup embeds and GOTW polls: ${err}.`,
        );
      }
    })();
  }

  // ── Divisional / Conference / Superbowl matchup flow ──────────────────────
  if (["divisional", "conference", "superbowl"].includes(newWeek)) {
    (async () => {
      try {
        const matchupSummary = await runPlayoffMatchupsFlow(
          interaction.client, season, newWeek as keyof typeof PLAYOFF_WEEK_META, guildId,
        );
        console.log(`[admin-operations] ${newWeek} matchups:`, matchupSummary);
      } catch (err) {
        console.error(`[admin-operations] ${newWeek} matchups flow error:`, err);
        await postCommissionerNotice(
          interaction.client, guildId,
          `⚠️ **${weekLabel(newWeek)} Matchups Flow Failed**\nFailed to post matchup embeds and GOTW polls: ${err}.`,
        );
      }
    })();
  }

  // ── EOS payout auto-post ──────────────────────────────────────────────────
  if (newWeek === "wildcard") {
    (async () => {
      try {
        const result = await runEosAutoPost(interaction.client, season.id, guildId);
        const lines = [
          `📋 **End-of-Season Payout Summaries Posted** to the commissioner log.`,
          `• **${result.posted}** user payout${result.posted !== 1 ? "s" : ""} queued for approval`,
        ];
        if (result.skipped > 0) lines.push(`• **${result.skipped}** already had records for this season (skipped)`);
        if (result.errors > 0)  lines.push(`• ⚠️ **${result.errors}** failed — check bot console`);
        lines.push("Use the **Edit Amount** buttons in the commissioner log to adjust before approving.");
        await interaction.followUp({ content: lines.join("\n"), ephemeral: true });
      } catch (err) {
        console.error("[admin-operations] EOS auto-post error:", err);
        await interaction.followUp({ content: `⚠️ EOS auto-post failed: ${err}`, ephemeral: true }).catch(() => {});
      }
    })();
  }

  // ── Offseason historical post + channel wipes + roster carryforward ──────
  if (newWeek === "offseason") {
    (async () => {
      try {
        await runOffseasonHistoricalPost(interaction.client, season.id, season.seasonNumber);
      } catch (err) {
        console.error("[admin-operations] Offseason historical post error:", err);
      }

      // ── Auto-carryforward: seed Season N+1 with current season's roster ─────
      try {
        const maxSeasons  = await getMaxSeasons(guildId);
        const nextNumber  = (season.seasonNumber ?? 0) + 1;

        if (nextNumber <= maxSeasons) {
          // Create Season N+1 as inactive staging record (idempotent)
          const existingNext = await db.select({ id: seasonsTable.id })
            .from(seasonsTable)
            .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.seasonNumber, nextNumber)))
            .limit(1);

          let nextSeasonId: number;
          if (existingNext.length > 0) {
            nextSeasonId = existingNext[0]!.id;
          } else {
            const [created] = await db.insert(seasonsTable)
              .values({ guildId, seasonNumber: nextNumber, isActive: false })
              .returning({ id: seasonsTable.id });
            nextSeasonId = created!.id;
          }

          // Upsert team links from Season N → Season N+1
          const prevTeams = await db.select().from(franchiseMcaTeamsTable)
            .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
          let carryTeams = 0;
          for (const t of prevTeams) {
            await db.insert(franchiseMcaTeamsTable)
              .values({
                seasonId: nextSeasonId, teamId: t.teamId, fullName: t.fullName,
                nickName: t.nickName, userName: t.userName, isHuman: t.isHuman,
                discordId: t.discordId, updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [franchiseMcaTeamsTable.seasonId, franchiseMcaTeamsTable.teamId],
                set: {
                  fullName: t.fullName, nickName: t.nickName, userName: t.userName,
                  isHuman: t.isHuman, discordId: t.discordId, updatedAt: new Date(),
                },
              });
            carryTeams++;
          }

          // Replace rosters in Season N+1 with Season N's most recent import
          await db.delete(franchiseRostersTable).where(eq(franchiseRostersTable.seasonId, nextSeasonId));
          const prevRosters = await db.select().from(franchiseRostersTable)
            .where(eq(franchiseRostersTable.seasonId, season.id));
          let carryRosters = 0;
          if (prevRosters.length > 0) {
            const rosterRows = prevRosters.map(r => ({
              seasonId: nextSeasonId, teamId: r.teamId, teamName: r.teamName,
              discordId: r.discordId, playerId: r.playerId, firstName: r.firstName,
              lastName: r.lastName, position: r.position, overall: r.overall,
              devTrait: r.devTrait, age: r.age, jerseyNum: r.jerseyNum,
              contractYearsLeft: r.contractYearsLeft, attributes: r.attributes,
            }));
            for (let i = 0; i < rosterRows.length; i += 500) {
              await db.insert(franchiseRostersTable).values(rosterRows.slice(i, i + 500));
            }
            carryRosters = rosterRows.length;
          }

          console.log(`[admin-operations] Offseason carryforward: ${carryTeams} teams + ${carryRosters} rosters seeded into Season ${nextNumber} (id=${nextSeasonId})`);
          await interaction.followUp({
            content:
              `📋 **Season ${nextNumber} roster seeded automatically.**\n` +
              `• ${carryTeams} team links + ${carryRosters} roster rows copied from Season ${season.seasonNumber ?? "N"}.\n` +
              `MCA will overwrite with fresh data on next import.`,
            ephemeral: true,
          }).catch(() => {});
        }
      } catch (err) {
        console.error("[admin-operations] Offseason carryforward error:", err);
        await interaction.followUp({
          content: `⚠️ Season roster carryforward failed — check bot logs. You can re-run manually with \`/season carryforward\` if needed.`,
          ephemeral: true,
        }).catch(() => {});
      }

      for (const chId of offseasonWipeIds) {
        try {
          const ch = interaction.client.channels.cache.get(chId)
            ?? await interaction.client.channels.fetch(chId).catch(() => null);
          if (ch?.isTextBased()) {
            await purgeChannel(ch as TextChannel).catch(err =>
              console.error(`[admin-operations] Offseason wipe error (${chId}):`, err),
            );
          }
        } catch (err) {
          console.error(`[admin-operations] Could not wipe channel ${chId}:`, err);
        }
      }

      try {
        const announceCh = announceChannelId
          ? (interaction.client.channels.cache.get(announceChannelId)
              ?? await interaction.client.channels.fetch(announceChannelId).catch(() => null))
          : null;
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `📣 **The rule change voting period has begun!**\n\n` +
              `If you are requesting a specific rule change to be voted on by the league, ` +
              `please post it in the **League Announcements** channel immediately to be considered.\n\n` +
              `⚠️ This opportunity **ends once the Draft has begun**. Get your proposals in now!`,
          });
        }
      } catch (err) {
        console.error("[admin-operations] Offseason announcement error:", err);
      }
    })();
  }

  // ── Training Camp announcement ────────────────────────────────────────────
  if (newWeek === "training_camp") {
    (async () => {
      try {
        const announceCh = announceChannelId
          ? (interaction.client.channels.cache.get(announceChannelId)
              ?? await interaction.client.channels.fetch(announceChannelId).catch(() => null))
          : null;
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `🏕️ **Training Camp has begun!**\n\n` +
              `The offseason is over — it's time to build your roster and get ready for the upcoming season.\n\n` +
              `📋 All attribute upgrades, dev upgrades, and store purchases are now open for the new season.`,
          });
        }
      } catch (err) {
        console.error("[admin-operations] Training Camp announcement error:", err);
      }
    })();
  }

  // ── New season announcement + full schedule ───────────────────────────────
  if (newWeek === "1" && (!season.currentWeek || season.currentWeek === "offseason" || season.currentWeek === "training_camp")) {
    (async () => {
      try {
        const announceCh = announceChannelId
          ? (interaction.client.channels.cache.get(announceChannelId)
              ?? await interaction.client.channels.fetch(announceChannelId).catch(() => null))
          : null;
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `🏈 **A new season has begun!**\n\n` +
              `We have officially advanced to **Season ${season.seasonNumber}**.\n` +
              `Good luck to everyone this season — let's get to work! 💪`,
          });
        }
      } catch (err) {
        console.error("[admin-operations] New season announcement error:", err);
      }

      try {
        await db.update(usersTable).set({ playoffSeed: null, playoffConference: null });
        console.log("[admin-operations] Cleared playoff seeds for new season");
      } catch (err) {
        console.error("[admin-operations] Failed to clear playoff seeds:", err);
      }

      try {
        const commId = await getGuildChannel(guildId, CHANNEL_KEYS.TRANSACTIONS)
          ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER);
        if (commId) {
          const commCh = interaction.client.channels.cache.get(commId)
            ?? await interaction.client.channels.fetch(commId).catch(() => null);
          if (commCh?.isTextBased()) {
            const messages = await (commCh as TextChannel).messages.fetch({ limit: 100 });
            for (const msg of messages.values()) {
              if (!msg.components.length || !msg.editable) continue;
              const NON_REFUNDABLE = new Set(["legend", "custom_player"]);
              let modified = false;
              const newRows: ReturnType<typeof ButtonBuilder.from>[][] = [];
              for (const row of msg.components) {
                if (row.type !== ComponentType.ActionRow) continue;
                const kept: ReturnType<typeof ButtonBuilder.from>[] = [];
                for (const c of (row as any).components ?? []) {
                  if (c.type !== ComponentType.Button) {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                    continue;
                  }
                  const cid: string = c.customId ?? "";
                  if (!cid.startsWith("refund_purchase:")) {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                    continue;
                  }
                  const purchaseType: string = cid.split(":")[3] ?? "";
                  if (NON_REFUNDABLE.has(purchaseType) || purchaseType.startsWith("custom_player")) {
                    modified = true;
                  } else {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                  }
                }
                if (kept.length > 0) newRows.push(kept);
              }
              if (modified) {
                const actionRows = newRows.map(btns =>
                  new ActionRowBuilder<ButtonBuilder>().addComponents(btns)
                );
                await msg.edit({ components: actionRows }).catch(() => null);
              }
            }
          }
        }
      } catch (err) {
        console.error("[admin-operations] Refund button removal error:", err);
      }

    })();
  }

  // ── Weekly matchups flow ──────────────────────────────────────────────────
  const _newWeekNum = parseInt(newWeek, 10);
  if (!isNaN(_newWeekNum) && _newWeekNum >= 1 && _newWeekNum <= 18) {
    (async () => {
      try {
        await runWeeklyMatchupsFlow({
          client:          interaction.client,
          guild:           interaction.guild,
          season,
          displayWeekNum:  _newWeekNum,
          payoutWeekIndex: (!isNaN(oldWeekNum) && oldWeekNum >= 1) ? oldWeekNum - 1 : null,
          guildId,
          replyFn: async ({ content, components }) => {
            await interaction.followUp({
              content,
              components: components ?? [],
              ephemeral:  true,
            });
          },
        });
      } catch (err) {
        console.error("[admin-operations] Weekly matchups flow error:", err);
        try {
          await interaction.followUp({
            content: `⚠️ Week advanced, but the weekly matchups flow failed: ${err}`,
            ephemeral: true,
          });
        } catch { /* nothing */ }
      }
    })();
  }

  // ── Playoff matchups flow ─────────────────────────────────────────────────
  if (PLAYOFF_WEEK_META[newWeek]) {
    (async () => {
      try {
        const summary = await runPlayoffMatchupsFlow(
          interaction.client,
          season,
          newWeek,
          guildId,
        );
        await interaction.followUp({ content: summary, ephemeral: true }).catch(() => {});
      } catch (err) {
        console.error("[admin-operations] Playoff matchups flow error:", err);
        try {
          await interaction.followUp({
            content: `⚠️ Week advanced, but the playoff matchups flow failed: ${err}`,
            ephemeral: true,
          });
        } catch { /* nothing */ }
      }
    })();
  }

  // ── Waitlist scan ─────────────────────────────────────────────────────────
  checkAndNotifyWaitlist(
    interaction.client,
    interaction.guild,
    guildId,
  ).catch(err => console.error("[admin-operations] Waitlist scan error:", err));
}

// ── Set Season Number ──────────────────────────────────────────────────────────

async function getMaxSeasons(guildId: string): Promise<number> {
  const [row] = await db.select({ maxSeasons: serverSettingsTable.maxSeasons })
    .from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId))
    .limit(1);
  return row?.maxSeasons ?? 10;
}

async function handleSetSeasonNum(interaction: ButtonInteraction) {
  const guildId   = interaction.guildId!;
  const [season, maxSeasons] = await Promise.all([
    getOrCreateActiveSeason(guildId),
    getMaxSeasons(guildId),
  ]);
  const current = season.seasonNumber ?? 1;

  const options = Array.from({ length: maxSeasons }, (_, i) => i + 1).map(n =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`Season ${n}${n === current ? " (current)" : ""}`)
      .setValue(String(n))
      .setDefault(n === current),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_set_season_num_sel")
    .setPlaceholder(`Current: Season ${current} of ${maxSeasons}`)
    .addOptions(options);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("🔢 Set Season Number")
        .setDescription(
          `Select the season number to activate.\n\n` +
          `Current season: **Season ${current} of ${maxSeasons}**\n\n` +
          `⚠️ This sets the active season record only — it does **not** roll over inventories or player data. ` +
          `Use **Advance Week** through Training Camp for a full season rollover.`
        ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function handleSetSeasonNumSel(interaction: StringSelectMenuInteraction) {
  const guildId   = interaction.guildId!;
  const target    = parseInt(interaction.values[0]!, 10);
  const maxSeasons = await getMaxSeasons(guildId);
  const isLast    = target >= maxSeasons;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(isLast ? Colors.Orange : Colors.Blue)
        .setTitle("🔢 Confirm Season Change")
        .setDescription(
          `Set the active season to **Season ${target} of ${maxSeasons}**?\n\n` +
          (isLast ? "⚠️ This is the **final season** of the franchise.\n\n" : "") +
          `This will activate (or create) the Season ${target} record. ` +
          `Coin balances and inventories are unchanged.`
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ao_set_season_num_confirm:${target}`)
          .setLabel(`✅ Set to Season ${target}`)
          .setStyle(isLast ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ao_set_season_num").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function handleSetSeasonNumConfirm(interaction: ButtonInteraction) {
  const guildId    = interaction.guildId!;
  const target     = parseInt(interaction.customId.split(":")[1]!, 10);
  const maxSeasons = await getMaxSeasons(guildId);

  // Check if this season already exists for THIS guild only.
  const [existing] = await db.select().from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.seasonNumber, target)))
    .limit(1);

  // Deactivate all seasons for THIS guild only (not all guilds).
  await db.update(seasonsTable)
    .set({ isActive: false })
    .where(eq(seasonsTable.guildId, guildId));

  let activeSeason;
  if (existing) {
    // Activate the existing season record for this guild.
    const [updated] = await db.update(seasonsTable)
      .set({ isActive: true })
      .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.seasonNumber, target)))
      .returning();
    activeSeason = updated;
  } else {
    // Season doesn't exist yet for this guild — create it.
    const [created] = await db.insert(seasonsTable)
      .values({ guildId, seasonNumber: target, isActive: true })
      .returning();
    activeSeason = created;
  }

  const isLast = target >= maxSeasons;
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(isLast ? Colors.Orange : Colors.Green)
        .setTitle(`📅 Season Set to ${target} of ${maxSeasons}`)
        .setDescription(
          `The active season is now **Season ${target}**.\n\n` +
          `Season ID: \`${activeSeason?.id ?? "?"}\`` +
          (isLast ? "\n\n🏁 **This is the final season of the franchise.**" : "")
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

// ── Rules Hub ─────────────────────────────────────────────────────────────────

async function handleRulesHub(interaction: ButtonInteraction | StringSelectMenuInteraction, _sess: AoSession) {
  const guildId  = interaction.guildId!;
  const sections = await getAllSections(guildId);
  const entries  = Object.entries(sections);

  if (entries.length === 0) {
    await (interaction as any).update({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("📋 Rules")
          .setDescription("No rule sections found. Run `/adminrules new-section` to create one first."),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
        ) as ActionRowBuilder<any>,
      ],
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_rules_section")
    .setPlaceholder("Select a section to view/edit...")
    .addOptions(
      entries.slice(0, 25).map(([key, meta]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(meta.title.replace(/[\u{1F300}-\u{1FFFF}]/gu, "").trim() || key)
          .setValue(key)
          .setDescription(`Section: ${key}`),
      ),
    );

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await (interaction as any).update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📋 View / Edit Rules")
        .setDescription("Select a section to view its rules and manage them."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      backRow,
    ],
  });
}

async function handleRulesSection(interaction: StringSelectMenuInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  const section = interaction.values[0]!;
  sess.rulesSection = section;
  sess.rulesPage    = 0;

  const sections = await getAllSections(guildId);
  const meta     = sections[section];
  if (!meta) {
    await interaction.update({ content: "❌ Section not found.", components: [] });
    return;
  }

  const rules      = await getOrSeedRules(section, guildId);
  const totalPages = buildRulesPages(rules).length;
  const embed      = buildRulesEmbed(section, meta, rules, 0);
  const btns       = buildRulesButtonsWithPage(rules.length, 0, totalPages);

  await interaction.update({ embeds: [embed], components: btns });
}

async function handleRulesPage(interaction: ButtonInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  const page    = parseInt(interaction.customId.split(":")[1] ?? "0", 10);
  const section = sess.rulesSection;

  if (!section) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  sess.rulesPage = page;

  const sections = await getAllSections(guildId);
  const meta     = sections[section];
  if (!meta) {
    await interaction.update({ content: "❌ Section not found.", components: [] });
    return;
  }

  const rules      = await getOrSeedRules(section, guildId);
  const totalPages = buildRulesPages(rules).length;
  const safePage   = Math.min(Math.max(0, page), Math.max(0, totalPages - 1));
  const embed      = buildRulesEmbed(section, meta, rules, safePage);
  const btns       = buildRulesButtonsWithPage(rules.length, safePage, totalPages);

  await interaction.update({ embeds: [embed], components: btns });
}

async function handleRulesAdd(interaction: ButtonInteraction, sess: AoSession) {
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_rules_add")
    .setTitle("Add New Rule");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_text")
        .setLabel("Rule Text")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Enter the full text of the new rule...")
        .setRequired(true)
        .setMaxLength(1500),
    ),
  );

  await interaction.showModal(modal);
}

async function handleRulesEdit(interaction: ButtonInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(sess.rulesSection, guildId);
  if (rules.length === 0) {
    await interaction.reply({ content: "❌ No rules to edit in this section.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ao_rules_edit_sel")
    .setPlaceholder("Select the rule number to edit...")
    .addOptions(
      rules.slice(0, 25).map((text, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Rule ${i + 1}`)
          .setValue(String(i + 1))
          .setDescription(text.length > 50 ? text.slice(0, 47) + "..." : text),
      ),
    );

  const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_rules_back_sections").setLabel("← Back to Sections").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("✏️ Edit Rule — Select Rule Number")
        .setDescription("Choose which rule you want to edit. A form will appear with the current text pre-filled."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      cancelRow,
    ],
  });
}

async function handleRulesEditSel(interaction: StringSelectMenuInteraction, sess: AoSession) {
  const guildId  = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const ruleNum = parseInt(interaction.values[0]!, 10);
  const rules   = await getOrSeedRules(sess.rulesSection, guildId);
  const ruleText = rules[ruleNum - 1] ?? "";

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_rules_edit")
    .setTitle(`Edit Rule ${ruleNum}`);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_num")
        .setLabel("Rule Number (do not change)")
        .setStyle(TextInputStyle.Short)
        .setValue(String(ruleNum))
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_text")
        .setLabel("Rule Text")
        .setStyle(TextInputStyle.Paragraph)
        .setValue(ruleText)
        .setRequired(true)
        .setMaxLength(1500),
    ),
  );

  await interaction.showModal(modal);
}

async function handleRulesDelete(interaction: ButtonInteraction, sess: AoSession) {
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("ao_modal_rules_delete")
    .setTitle("Delete Rule");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_num")
        .setLabel("Rule Number to Delete")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 3")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(3),
    ),
  );

  await interaction.showModal(modal);
}

// ── Rules Modal Handlers ───────────────────────────────────────────────────────

async function handleModalRulesAdd(interaction: ModalSubmitInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const newText = interaction.fields.getTextInputValue("rule_text").trim();
  if (!newText) {
    await interaction.reply({ content: "❌ Rule text cannot be empty.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(sess.rulesSection, guildId);
  rules.push(newText);
  await setRules(sess.rulesSection, rules, interaction.user.id, guildId);

  const sections = await getAllSections(guildId);
  const meta     = sections[sess.rulesSection]!;
  const totalPages = buildRulesPages(rules).length;
  const page       = Math.min(sess.rulesPage ?? 0, Math.max(0, totalPages - 1));
  const embed    = buildRulesEmbed(sess.rulesSection, meta, rules, page);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Rule Added")
        .setDescription(`Rule **#${rules.length}** has been added to **${meta.title}**.`),
      embed,
    ],
    components: buildRulesButtonsWithPage(rules.length, page, totalPages),
    ephemeral: true,
  });
}

async function handleModalRulesEdit(interaction: ModalSubmitInteraction, sess: AoSession) {
  const guildId  = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const ruleNum  = parseInt(interaction.fields.getTextInputValue("rule_num"), 10);
  const newText  = interaction.fields.getTextInputValue("rule_text").trim();

  if (isNaN(ruleNum) || ruleNum < 1) {
    await interaction.reply({ content: "❌ Invalid rule number.", ephemeral: true });
    return;
  }
  if (!newText) {
    await interaction.reply({ content: "❌ Rule text cannot be empty.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(sess.rulesSection, guildId);
  if (ruleNum > rules.length) {
    await interaction.reply({ content: `❌ Rule #${ruleNum} does not exist. This section has ${rules.length} rule(s).`, ephemeral: true });
    return;
  }

  rules[ruleNum - 1] = newText;
  await setRules(sess.rulesSection, rules, interaction.user.id, guildId);

  const sections  = await getAllSections(guildId);
  const meta      = sections[sess.rulesSection]!;
  const totalPages = buildRulesPages(rules).length;
  const page       = Math.min(sess.rulesPage ?? 0, Math.max(0, totalPages - 1));
  const embed      = buildRulesEmbed(sess.rulesSection, meta, rules, page);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Rule Updated")
        .setDescription(`Rule **#${ruleNum}** in **${meta.title}** has been updated.`),
      embed,
    ],
    components: buildRulesButtonsWithPage(rules.length, page, totalPages),
    ephemeral: true,
  });
}

async function handleModalRulesDelete(interaction: ModalSubmitInteraction, sess: AoSession) {
  const guildId = interaction.guildId!;
  if (!sess.rulesSection) {
    await interaction.reply({ content: "❌ Session expired — please start over.", ephemeral: true });
    return;
  }

  const ruleNum = parseInt(interaction.fields.getTextInputValue("rule_num"), 10);
  if (isNaN(ruleNum) || ruleNum < 1) {
    await interaction.reply({ content: "❌ Invalid rule number.", ephemeral: true });
    return;
  }

  const rules = await getOrSeedRules(sess.rulesSection, guildId);
  if (ruleNum > rules.length) {
    await interaction.reply({ content: `❌ Rule #${ruleNum} does not exist. This section has ${rules.length} rule(s).`, ephemeral: true });
    return;
  }

  const [deleted] = rules.splice(ruleNum - 1, 1);
  await setRules(sess.rulesSection, rules, interaction.user.id, guildId);

  const sections   = await getAllSections(guildId);
  const meta       = sections[sess.rulesSection]!;
  const totalPages = buildRulesPages(rules).length;
  const page       = Math.min(sess.rulesPage ?? 0, Math.max(0, totalPages - 1));
  const embed      = buildRulesEmbed(sess.rulesSection, meta, rules, page);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Rule Deleted")
        .setDescription(
          `Rule **#${ruleNum}** has been removed from **${meta.title}**.\n` +
          `_Deleted text: "${deleted?.slice(0, 100)}${(deleted?.length ?? 0) > 100 ? "..." : ""}"_\n\n` +
          `Remaining rules have been renumbered.`
        ),
      embed,
    ],
    components: buildRulesButtonsWithPage(rules.length, page, totalPages),
    ephemeral: true,
  });
}
