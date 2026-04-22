/**
 * /actions hub — all member-facing interactions with prefix ac_
 * Session TTL: 15 minutes (keyed by `${guildId}:${userId}`)
 */
import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  TextChannel, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userSavingsTable, userRecordsTable, globalUserRecordsTable,
  franchiseRostersTable, franchiseMcaTeamsTable, seasonsTable,
  wagersTable, interviewRequestsTable, coinTransactionsTable,
  seasonStatsTable, teamSeasonStatsTable, purchasesTable, inventoryTable,
  legendsTable, franchiseScheduleTable,
  guildTweetsTable, autoPilotRequestsTable, ruleViolationsTable,
  playerEaIdsTable, customPlayersTable,
  playerSeasonStatsTable, waitlistTable,
} from "@workspace/db";
import { eq, and, or, desc, sql, isNotNull, isNull, ne, sum, max, inArray } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getRosterSeasonId,
  deductBalance, logTransaction, addBalance, getGuildChannel, CHANNEL_KEYS,
  getSeasonStats, getSeasonRules, getCoreAttributes, getInventoryCount,
  getOrSeedRules, getAllSections, isAdminUser,
} from "./db-helpers.js";
import {
  getPayoutValue, getAllPayoutConfig, getMilestoneTiers, getAllPayoutKeys,
} from "./payout-config.js";
import { getServerSettings, requireMcaEnabled } from "./server-settings.js";
import { getArticleStandings, getSeasonRecords, getAllTimeRecords } from "./gcs-fallback.js";
import { devBadge, DEV_LEGEND } from "./dev-trait.js";
import { weekLabel } from "./week-helpers.js";
import {
  INTERVIEW_QUESTIONS, pickThreeIndices, getQuestionPool, interviewTypeLabel,
  type InterviewType,
} from "../commands/interviewrequest.js";
import { buildActionsHubRows, buildUnlinkedHubEmbed, buildUnlinkedHubRows } from "../commands/actions.js";
import { appendUserStatsFields } from "./user-stats-embed.js";
import { PLAYOFF_WEEK_META } from "./playoff-matchups-runner.js";
import {
  insufficientFunds, sendCommissionerNotification, getRosterRows, DEV_LABEL,
} from "./purchase-shared.js";
import { ATTRIBUTES, CORE_ATTRIBUTES, NFL_TEAMS, NFL_DIVISION_MAP, LIMITS, lookupNflDivision } from "./constants.js";
import { createSession } from "./custom-player-session.js";
import { buildAttrPage, buildAttrDropdown, buildNavRow, aupSessions } from "../commands/attribute-up-interactions.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type AnyInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

interface ActionsSession {
  guildId: string;
  userId: string;
  flow?: string;
  // wager flow
  scheduleGameId?: string;
  wagerTeam?: string;
  wagerOpponentId?: string;
  wagerOpponentTeam?: string;
  wagerAmount?: number;
  wagerChallengerId?: string;
  wagerChallengerTeam?: string;
  wagerSpread?: number;
  wagerSide?: "home" | "away";
  wagerHomeTeam?: string;
  wagerAwayTeam?: string;
  wagerHomeDiscordId?: string;
  wagerAwayDiscordId?: string;
  // roster flow
  selectedTeamId?: number;
  selectedTeamName?: string;
  // purchase flow
  purchaseType?: string;
  rosterPosition?: string;
  selectedPlayerId?: number;
  selectedPlayerName?: string;
  selectedPlayerPos?: string;
  selectedPlayerDev?: number;
  selectedPlayerAge?: number;
  selectedLegendId?: number;
  selectedLegendName?: string;
  selectedLegendCost?: number;
  // standings flow
  standingsConf?: "AFC" | "NFC" | "ALL";
  // rules view flow
  acRulesSection?: string;
  // team request / waitlist flow
  pendingTeamRequest?: string;
  expiresAt: number;
}

// ── Session store ──────────────────────────────────────────────────────────────

const sessions = new Map<string, ActionsSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;

function sessionKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

function getSession(guildId: string, userId: string): ActionsSession {
  const key = sessionKey(guildId, userId);
  const existing = sessions.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing;
  const fresh: ActionsSession = { guildId, userId, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(key, fresh);
  return fresh;
}

function touchSession(sess: ActionsSession) {
  sess.expiresAt = Date.now() + SESSION_TTL_MS;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function backToHubRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
  );
}

function cancelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );
}

// Position groups for roster display (mirrors my-roster.ts)
const OFFENSE_GROUPS: { label: string; positions: string[] }[] = [
  { label: "Quarterback",    positions: ["QB"] },
  { label: "Running Back",   positions: ["HB", "FB"] },
  { label: "Wide Receiver",  positions: ["WR"] },
  { label: "Tight End",      positions: ["TE"] },
  { label: "Offensive Line", positions: ["LT", "LG", "C", "RG", "RT"] },
];
const DEFENSE_GROUPS: { label: string; positions: string[] }[] = [
  { label: "Defensive Line",  positions: ["LE", "RE", "DT", "DE", "LEDGE", "REDGE"] },
  { label: "MIKE Linebacker", positions: ["MLB", "MIKE"] },
  { label: "SAM Linebacker",  positions: ["LOLB", "SAM"] },
  { label: "WILL Linebacker", positions: ["ROLB", "WILL"] },
  { label: "Cornerback",      positions: ["CB"] },
  { label: "Safety",          positions: ["FS", "SS", "S"] },
];
const SPECIAL_TEAMS_POSITIONS = ["K", "P", "KR", "PR", "LS"];
const OFFENSE_SET = new Set(OFFENSE_GROUPS.flatMap(g => g.positions));
const DEFENSE_SET = new Set(DEFENSE_GROUPS.flatMap(g => g.positions));

function formatPlayerLine(p: {
  firstName: string; lastName: string;
  position: string; overall: number; devTrait: number;
  jerseyNum: number | null; age: number | null;
  contractYearsLeft: number | null;
}): string {
  const num  = p.jerseyNum != null ? `#${p.jerseyNum} ` : "";
  const age  = p.age != null ? ` | Age ${p.age}` : "";
  const flag = p.contractYearsLeft === 1 ? " 📋" : "";
  return `${num}**${p.firstName} ${p.lastName}** (${p.position}) — OVR ${p.overall}${age}${devBadge(p.devTrait)}${flag}`;
}

function fieldChunks(label: string, lines: string[]): { name: string; value: string }[] {
  if (!lines.length) return [];
  const chunks: { name: string; value: string }[] = [];
  let cur: string[] = [], len = 0;
  for (const line of lines) {
    const add = (cur.length ? 1 : 0) + line.length;
    if (len + add > 1020 && cur.length) {
      chunks.push({ name: chunks.length === 0 ? label : `${label} (cont.)`, value: cur.join("\n") });
      cur = []; len = 0;
    }
    cur.push(line); len += add;
  }
  if (cur.length) chunks.push({ name: chunks.length === 0 ? label : `${label} (cont.)`, value: cur.join("\n") });
  return chunks;
}

async function buildRosterEmbed(guildId: string, seasonId: number, teamId: number, teamLabel: string, embed: EmbedBuilder) {
  const rows = await db.select({
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    position:  franchiseRostersTable.position,
    overall:   franchiseRostersTable.overall,
    devTrait:  franchiseRostersTable.devTrait,
    jerseyNum: franchiseRostersTable.jerseyNum,
    age:       franchiseRostersTable.age,
    contractYearsLeft: franchiseRostersTable.contractYearsLeft,
  }).from(franchiseRostersTable)
    .where(and(eq(franchiseRostersTable.seasonId, seasonId), eq(franchiseRostersTable.teamId, teamId)))
    .orderBy(franchiseRostersTable.overall);

  if (!rows.length) {
    embed.setDescription("No roster data found for this team. Make sure MCA data has been imported.");
    return embed;
  }

  const sorted = [...rows].sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
  const offense = sorted.filter(p => OFFENSE_SET.has(p.position ?? ""));
  const defense = sorted.filter(p => DEFENSE_SET.has(p.position ?? ""));
  const special = sorted.filter(p => SPECIAL_TEAMS_POSITIONS.includes(p.position ?? ""));

  const addGroup = (group: { label: string; positions: string[] }, players: typeof sorted) => {
    const grpRows = group.positions.flatMap(pos =>
      players.filter(p => p.position?.toUpperCase() === pos).map(p => formatPlayerLine(p as any))
    );
    for (const chunk of fieldChunks(`⚡ ${group.label}`, grpRows)) {
      embed.addFields(chunk);
    }
  };

  embed.setTitle(`🏈 ${teamLabel} Roster`).setColor(Colors.Blue).setTimestamp();
  embed.addFields({ name: "📤 Offense", value: "━━━━━━━━━━━", inline: false });
  for (const g of OFFENSE_GROUPS) addGroup(g, offense);
  embed.addFields({ name: "📥 Defense", value: "━━━━━━━━━━━", inline: false });
  for (const g of DEFENSE_GROUPS) addGroup(g, defense);
  if (special.length) {
    const lines = special.map(p => formatPlayerLine(p as any));
    for (const chunk of fieldChunks("🏟️ Special Teams", lines)) embed.addFields(chunk);
  }
  embed.setFooter({ text: DEV_LEGEND });
  return embed;
}

// ── PR helpers (mirrors records.ts) ───────────────────────────────────────────

function calcPRScore(wins: number, losses: number, pointDiff: number): number {
  return 0.6 * (wins - losses) + 0.4 * pointDiff;
}
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
function fmtDiff(n: number): string { return n >= 0 ? `+${n}` : `${n}`; }

// ── Main dispatch ──────────────────────────────────────────────────────────────

export async function handleActionsInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  const id  = interaction.customId;
  const gid = interaction.guildId;
  const uid = interaction.user.id;
  if (!gid) return false;

  const sess = getSession(gid, uid);
  touchSession(sess);

  // ── Close ────────────────────────────────────────────────────────────────────
  if (id === "ac_close") {
    await (interaction as ButtonInteraction).update({
      embeds: [new EmbedBuilder().setColor(Colors.DarkGrey).setDescription("✖ Hub closed.")],
      components: [],
    });
    return true;
  }

  // ── Hub restore ─────────────────────────────────────────────────────────────
  if (id === "ac_hub") {
    const btn = interaction as ButtonInteraction;
    await btn.deferUpdate();
    const [settings, member, user, season] = await Promise.all([
      getServerSettings(gid),
      btn.guild?.members.cache.get(uid) ?? btn.guild?.members.fetch(uid).catch(() => null),
      getOrCreateUser(uid, btn.user.username, gid),
      getOrCreateActiveSeason(gid),
    ]);
    const isDiscordAdmin = (member as import("discord.js").GuildMember | null | undefined)?.permissions?.has(PermissionFlagsBits.Administrator) ?? false;
    const isDbAdmin      = await isAdminUser(uid, gid);
    const isAdmin        = isDiscordAdmin || isDbAdmin;

    if (!user.team && !isAdmin) {
      await btn.editReply({ embeds: [buildUnlinkedHubEmbed()], components: buildUnlinkedHubRows() });
      return true;
    }

    const rules          = await getSeasonRules(season);
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`🏈 League Actions Hub — ${user.team ?? btn.user.username}`)
      .setDescription("Select any action below. All menus are private (visible only to you).")
      .setFooter({ text: "League Actions Hub — selections expire after 15 minutes" });
    await appendUserStatsFields(embed, uid, gid, user, season, settings, rules, btn.user.displayAvatarURL());
    await btn.editReply({
      embeds:     [embed],
      components: buildActionsHubRows(settings, isAdmin),
    });
    return true;
  }

  // ── Row 1: Economy & Social ─────────────────────────────────────────────────

  if (id === "ac_purchase")     { await handlePurchaseMenu(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_wager")        { await handleWagerStart(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_coins")        { await handleCoins(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_interview")    { await handleInterview(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_tweet")        { await handleTweetModal(interaction as ButtonInteraction); return true; }

  // Purchase sub-buttons
  if (id === "ac_buy_attr")     { await handleBuyAttrPosPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_buy_agereset") { await handleBuyAgeResetPosPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_buy_devup")    { await handleBuyDevUpPosPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_buy_legend")   { await handleBuyLegendPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_buy_custom")   { await handleBuyCustomInfo(interaction as ButtonInteraction); return true; }
  if (id.startsWith("ac_buy_attrpos:"))     { await handleBuyAttrPlayerPick(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_buy_arpos:"))       { await handleBuyARPlayerPick(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_buy_dupos:"))       { await handleBuyDUPlayerPick(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_buy_attrplayer:"))  { await handleBuyAttrStart(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_buy_arplayer:"))    { await handleBuyARConfirm(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_buy_duplayer:"))    { await handleBuyDUConfirm(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_buy_ar_confirm")           { await handleBuyAgeResetExecute(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_buy_du_confirm")           { await handleBuyDevUpExecute(interaction as ButtonInteraction, sess); return true; }
  if (id.startsWith("ac_buy_legendsel:"))   { await handleBuyLegendConfirm(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_buy_legend_confirm")       { await handleBuyLegendExecute(interaction as ButtonInteraction, sess); return true; }

  // Coins sub
  if (id === "ac_send_coins_modal")         { await handleSendCoinsModal(interaction as ButtonInteraction); return true; }

  // Wager sub
  if (id === "ac_wager_game")                  { await handleWagerGameSelect(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_wager_pick:"))         { await handleWagerTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_wager_spread")                { await handleWagerSpreadSelect(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_wager_spread_next")           { await handleWagerSpreadNext(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_wager_back_to_team")          { await handleWagerBackToTeam(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_wager_back_to_spread")        { await handleWagerBackToSpread(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_wager_opponent_afc")          { await handleWagerOpponentSelect(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_wager_opponent_nfc")          { await handleWagerOpponentSelect(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_wager_send")                  { await handleWagerSend(interaction as ButtonInteraction, sess); return true; }

  // ── Row 2: Rosters ───────────────────────────────────────────────────────────

  if (id === "ac_myroster")     { await handleMyRoster(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_anyroster")    { await handleAnyRosterTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_anyroster_sel")  { await handleAnyRosterShow(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_freeagents")   { await handleFreeAgentsPosPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_fa_pos")       { await handleFreeAgentsShow(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_playerstats")           { await handlePlayerStatsStart(interaction as ButtonInteraction, sess); return true; }
  if (id.startsWith("ac_ps_conf:"))      { await handlePsTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_ps_team_sel")           { await handlePsPosPick(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_ps_pos_sel:"))   { await handlePsPlayerPick(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_ps_player_sel:")) { await handlePsPlayerCard(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_teamstats")             { await handleTeamStatsTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_teamstats_sel")         { await handleTeamStatsShow(interaction as StringSelectMenuInteraction, sess); return true; }

  // ── Row 3: League Info ───────────────────────────────────────────────────────

  if (id === "ac_standings")    { await handleStandingsConfPick(interaction as ButtonInteraction, sess); return true; }
  if (id.startsWith("ac_standings_conf:"))   { await handleStandingsShow(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_inthehunt")    { await handleInTheHunt(interaction as ButtonInteraction, sess);    return true; }
  if (id === "ac_teamstowatch") { await handleTeamsToWatch(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_anyuserstats")         { await handleAnyUserStatsTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id.startsWith("ac_anyus_conf:")) { await handleAnyUserStatsConfPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_anyus_sel")            { await handleAnyUserStatsShow(interaction as StringSelectMenuInteraction, sess); return true; }

  // ── Row 4: Rankings & Payouts ────────────────────────────────────────────────

  if (id === "ac_seasonpr")     { await handleSeasonPR(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_alltimepr")    { await handleAllTimePR(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_globalpr")     { await handleGlobalPR(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_eospayouts")   { await handleEosPayouts(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_milestonepayouts") { await handleMilestonePayouts(interaction as ButtonInteraction, sess); return true; }

  // ── Row 5: Requests ──────────────────────────────────────────────────────────

  if (id === "ac_activeteams")  { await handleActiveTeams(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_openteams")    { await handleOpenTeams(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_autopilot")    { await handleAutoPilotModal(interaction as ButtonInteraction); return true; }
  if (id === "ac_rules")        { await handleRulesStart(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_rules_section")         { await handleRulesSection(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_rules_goback")          { await handleRulesStart(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_rules_display")         { await handleRulesDisplayChoice(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_rules_display_full")    { await handleRulesDisplayFull(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_rules_display_bynum")   { await handleRulesDisplayByNumModal(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_rules_close")           { await handleRulesClose(interaction as ButtonInteraction); return true; }
  if (id === "ac_modal_rules_bynum")     { await handleRulesByNumSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_violation")         { await handleViolationModal(interaction as ButtonInteraction); return true; }
  if (id === "ac_req_openteam")          { await handleReqOpenTeam(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_req_openteam_sel_afc" ||
      id === "ac_req_openteam_sel_nfc")  { await handleReqOpenTeamSel(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_req_openteam_submit")   { await handleReqOpenTeamSubmit(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_req_addwaitlist")       { await handleReqAddWaitlist(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_req_waitlist_sel_afc" ||
      id === "ac_req_waitlist_sel_nfc")  { await handleReqWaitlistSel(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_req_waitlist_next")     { await handleReqWaitlistNext(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_req_rmwaitlist")        { await handleReqRmWaitlist(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_req_rmwl_confirm")      { await handleReqRmWaitlistConfirm(interaction as ButtonInteraction, sess); return true; }

  // Modal submits
  if (id === "ac_modal_tweet")      { await handleTweetSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_modal_sendcoins")  { await handleSendCoinsSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_modal_wageramount") { await handleWagerAmountSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_modal_autopilot")  { await handleAutoPilotSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_modal_violation")  { await handleViolationSubmit(interaction as ModalSubmitInteraction, sess); return true; }

  // Commissioner autopilot approve/deny
  if (id.startsWith("ac_ap_approve:")) { await handleApproveAutoPilot(interaction as ButtonInteraction); return true; }
  if (id.startsWith("ac_ap_deny:"))    { await handleDenyAutoPilot(interaction as ButtonInteraction); return true; }
  if (id.startsWith("ac_rv_note:"))         { await handleViolationNote(interaction as ButtonInteraction); return true; }
  if (id.startsWith("ac_rv_approve:"))      { await handleViolationApprove(interaction as ButtonInteraction); return true; }
  if (id.startsWith("ac_rv_deny:"))         { await handleViolationDeny(interaction as ButtonInteraction); return true; }
  if (id.startsWith("ac_rv_deny_submit:"))  { await handleViolationDenySubmit(interaction as ModalSubmitInteraction); return true; }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROW 1 — Economy & Social
// ═══════════════════════════════════════════════════════════════════════════════

async function handlePurchaseMenu(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const settings = await getServerSettings(gid);

  const attrOn   = settings.coinEconomy && settings.attributeUpgradesEnabled;
  const ageOn    = settings.coinEconomy && settings.ageResetsEnabled;
  const devOn    = settings.coinEconomy && settings.devUpgradesEnabled;
  const customOn = settings.coinEconomy && settings.customSuperstarsEnabled;
  const legOn    = settings.coinEconomy && settings.legendsEnabled;

  const allButtons: ButtonBuilder[] = [];
  if (attrOn)   allButtons.push(new ButtonBuilder().setCustomId("ac_buy_attr").setLabel("⭐ Attribute Upgrade").setStyle(ButtonStyle.Primary));
  if (ageOn)    allButtons.push(new ButtonBuilder().setCustomId("ac_buy_agereset").setLabel("🔄 Age Reset").setStyle(ButtonStyle.Primary));
  if (devOn)    allButtons.push(new ButtonBuilder().setCustomId("ac_buy_devup").setLabel("📈 Dev Trait Upgrade").setStyle(ButtonStyle.Primary));
  if (customOn) allButtons.push(new ButtonBuilder().setCustomId("ac_buy_custom").setLabel("🎨 Custom Player").setStyle(ButtonStyle.Success));
  if (legOn)    allButtons.push(new ButtonBuilder().setCustomId("ac_buy_legend").setLabel("🏆 Buy a Legend").setStyle(ButtonStyle.Success));

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < allButtons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...allButtons.slice(i, i + 5)));
  }
  rows.push(cancelRow());

  const embed = new EmbedBuilder()
    .setColor(0x1a1a2e)
    .setTitle("💳 Make a Purchase")
    .setDescription(
      allButtons.length === 0
        ? "❌ No purchase types are currently enabled. Please contact a commissioner."
        : "Select a purchase type below."
    )
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: rows });
}

// ── Attribute Upgrade ──────────────────────────────────────────────────────────

async function handleBuyAttrPosPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);
  sess.purchaseType = "attribute"; sess.rosterPosition = undefined;

  const rows = await getRosterRows(interaction as any, seasonId, { position: franchiseRostersTable.position });
  const positions = [...new Set(rows.map((r: any) => r.position as string).filter(Boolean))].sort();

  if (!positions.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No roster data found. Ask a commissioner to import MCA data.")], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_attrpos:")
    .setPlaceholder("Select your player's position…")
    .addOptions(positions.slice(0, 25).map(p => new StringSelectMenuOptionBuilder().setLabel(p).setValue(p)));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("⭐ Attribute Upgrade — Step 1").setDescription("Pick the **position** of the player you want to upgrade.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleBuyAttrPlayerPick(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const position = interaction.values[0]!;
  const gid = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);

  const rows = await getRosterRows(interaction as any, seasonId, {
    playerId: franchiseRostersTable.playerId,
    firstName: franchiseRostersTable.firstName,
    lastName: franchiseRostersTable.lastName,
    overall: franchiseRostersTable.overall,
    devTrait: franchiseRostersTable.devTrait,
    position: franchiseRostersTable.position,
  });
  const filtered = (rows as any[]).filter(r => r.position?.toUpperCase() === position.toUpperCase());

  if (!filtered.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ No players found at position **${position}**.`)], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_attrplayer:")
    .setPlaceholder("Select a player…")
    .addOptions(
      filtered.slice(0, 25).map(r =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${r.firstName} ${r.lastName} — OVR ${r.overall} ${DEV_LABEL[r.devTrait] ?? ""}`)
          .setValue(String(r.playerId)),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("⭐ Attribute Upgrade — Step 2").setDescription(`**Position: ${position}**\nNow pick the player you want to upgrade.`)],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleBuyAttrStart(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  // Hand off to attribute-up-interactions' session system
  const playerId = Number(interaction.values[0]);
  const gid      = interaction.guildId!;
  const uid      = interaction.user.id;
  const seasonId = await getRosterSeasonId(gid);

  const rosterRows = await db.select({
    firstName: franchiseRostersTable.firstName,
    lastName: franchiseRostersTable.lastName,
    position: franchiseRostersTable.position,
    attributes: franchiseRostersTable.attributes,
    playerId: franchiseRostersTable.playerId,
  }).from(franchiseRostersTable)
    .where(and(eq(franchiseRostersTable.seasonId, seasonId), eq(franchiseRostersTable.playerId, playerId)))
    .limit(1);

  if (!rosterRows.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Player not found on your roster.")], components: [backToHubRow()] });
    return;
  }

  const player = rosterRows[0]!;
  const attrs: Record<string, number> = (player.attributes as any) ?? {};
  const playerName = `${player.firstName} ${player.lastName}`.trim();

  // Set up AUP session
  const season = await getOrCreateActiveSeason(gid);
  const coreSet = getCoreAttributes(season);
  const usedRows = await db.select({ attributeName: purchasesTable.attributeName })
    .from(purchasesTable)
    .where(and(
      eq(purchasesTable.seasonId, season.id),
      eq(purchasesTable.playerName, playerName),
      eq(purchasesTable.playerPosition, player.position ?? ""),
      eq(purchasesTable.purchaseType, "attribute"),
      ne(purchasesTable.status, "refunded"),
    ));
  const usedCoreAttrs = new Set(usedRows.map(r => r.attributeName).filter((n): n is string => n !== null && coreSet.has(n as any)));

  const settings = await getServerSettings(gid);
  const legacyMode = settings.legacyCoreAttrMode ?? false;

  const sKey = `${uid}:${playerId}`;
  aupSessions.set(sKey, {
    invokerId: uid,
    targetId: uid,
    playerName,
    playerPosition: player.position ?? "",
    playerId,
    attributes: attrs,
    page: 0,
    usedCoreAttrs,
    legacyCoreAttrMode: legacyMode,
  });

  // Render the paginated attribute browser directly
  const rules   = await getSeasonRules(season);
  const session = aupSessions.get(sKey)!;

  const embed    = buildAttrPage(session, rules, coreSet);
  const dropdown = buildAttrDropdown(session, rules, sKey, coreSet);
  const navRow   = buildNavRow(session, sKey);

  await interaction.update({ embeds: [embed], components: [dropdown, navRow] });
}

// ── Age Reset ─────────────────────────────────────────────────────────────────

async function handleBuyAgeResetPosPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);
  sess.purchaseType = "agereset";

  const rows = await getRosterRows(interaction as any, seasonId, { position: franchiseRostersTable.position });
  const positions = [...new Set(rows.map((r: any) => r.position as string).filter(Boolean))].sort();

  if (!positions.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No roster data found.")], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_arpos:")
    .setPlaceholder("Select position…")
    .addOptions(positions.slice(0, 25).map(p => new StringSelectMenuOptionBuilder().setLabel(p).setValue(p)));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🔄 Age Reset — Step 1").setDescription("Pick the **position** of the player whose age you want to reset.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleBuyARPlayerPick(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const position = interaction.values[0]!;
  const gid = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);

  const rows = await getRosterRows(interaction as any, seasonId, {
    playerId: franchiseRostersTable.playerId,
    firstName: franchiseRostersTable.firstName,
    lastName: franchiseRostersTable.lastName,
    overall: franchiseRostersTable.overall,
    age: franchiseRostersTable.age,
    position: franchiseRostersTable.position,
  });
  const filtered = (rows as any[]).filter(r => r.position?.toUpperCase() === position.toUpperCase());

  if (!filtered.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ No players at ${position}.`)], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_arplayer:")
    .setPlaceholder("Select player…")
    .addOptions(
      filtered.slice(0, 25).map(r =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${r.firstName} ${r.lastName} — Age ${r.age ?? "?"} | OVR ${r.overall}`)
          .setValue(String(r.playerId)),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("🔄 Age Reset — Step 2").setDescription(`Position: **${position}** — Select the player.`)],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleBuyARConfirm(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const playerId = Number(interaction.values[0]);
  const gid = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);

  const rows = await db.select({
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    age:       franchiseRostersTable.age,
    position:  franchiseRostersTable.position,
    playerId:  franchiseRostersTable.playerId,
  }).from(franchiseRostersTable)
    .where(and(eq(franchiseRostersTable.seasonId, seasonId), eq(franchiseRostersTable.playerId, playerId)))
    .limit(1);

  if (!rows.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Player not found.")], components: [backToHubRow()] });
    return;
  }

  const player = rows[0]!;
  sess.selectedPlayerId = playerId;
  sess.selectedPlayerName = `${player.firstName} ${player.lastName}`.trim();
  sess.selectedPlayerPos  = player.position ?? "";
  sess.selectedPlayerAge  = player.age ?? 0;

  const arSeason = await getOrCreateActiveSeason(gid);
  const [rules, user] = await Promise.all([
    getSeasonRules(arSeason),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
  ]);
  const cost = rules?.ageResetCost ?? 500;

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🔄 Confirm Age Reset")
    .setDescription(
      `**${sess.selectedPlayerName}** (${sess.selectedPlayerPos}) — Current Age: **${player.age ?? "?"}**\n\n` +
      `Cost: **${cost.toLocaleString()} coins**\nYour balance: **${user.balance.toLocaleString()} coins**`
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_buy_ar_confirm").setLabel("✅ Confirm Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

async function handleBuyAgeResetExecute(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  if (!sess.selectedPlayerId || !sess.selectedPlayerName) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Session expired. Please start over.")], components: [backToHubRow()] });
    return;
  }

  const season = await getOrCreateActiveSeason(gid);
  const [rules, user, seasonStats] = await Promise.all([
    getSeasonRules(season),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
    getSeasonStats(interaction.user.id, season.id),
  ]);

  const cost      = rules?.ageResetCost ?? 500;
  const maxResets = rules?.ageResetsCap ?? 2;
  const used      = seasonStats?.ageResetsPurchased ?? 0;

  if (used >= maxResets) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ You have used all ${maxResets} age resets this season.`)], components: [backToHubRow()] });
    return;
  }
  if (user.balance < cost) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ Insufficient coins. You need **${cost.toLocaleString()}** but only have **${user.balance.toLocaleString()}**.`)], components: [backToHubRow()] });
    return;
  }

  await deductBalance(interaction.user.id, cost, gid);
  await logTransaction(interaction.user.id, -cost, "purchase", `Age reset — ${sess.selectedPlayerName}`, gid);

  const [inserted] = await db.insert(purchasesTable).values({
    discordId: interaction.user.id,
    seasonId: season.id,
    purchaseType: "age_reset",
    playerName: sess.selectedPlayerName,
    playerPosition: sess.selectedPlayerPos ?? "",
    cost,
    status: "pending",
    notes: `Age reset for ${sess.selectedPlayerName} (age ${sess.selectedPlayerAge} → 23)`,
  }).returning({ id: purchasesTable.id });

  await sendCommissionerNotification(interaction as any, "age_reset", inserted!.id, {
    playerName:   sess.selectedPlayerName,
    playerPosition: sess.selectedPlayerPos ?? "",
    currentAge:   sess.selectedPlayerAge,
    costPer:      cost,
  });

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("⏳ Age Reset Submitted")
      .setDescription(`Your age reset for **${sess.selectedPlayerName}** has been submitted for commissioner approval.\nCost: **${cost.toLocaleString()} coins** deducted.`)],
    components: [backToHubRow()],
  });
}

// ── Dev Trait Upgrade ─────────────────────────────────────────────────────────

async function handleBuyDevUpPosPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);
  sess.purchaseType = "devup";

  const rows = await getRosterRows(interaction as any, seasonId, {
    position: franchiseRostersTable.position,
    devTrait: franchiseRostersTable.devTrait,
  });
  const eligible = (rows as any[]).filter(r => r.devTrait <= 1);
  const positions = [...new Set(eligible.map((r: any) => r.position as string).filter(Boolean))].sort();

  if (!positions.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No eligible players (Normal/Star dev only).")], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_dupos:")
    .setPlaceholder("Select position…")
    .addOptions(positions.slice(0, 25).map(p => new StringSelectMenuOptionBuilder().setLabel(p).setValue(p)));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("📈 Dev Trait Upgrade — Step 1").setDescription("Pick the position of the player you want to upgrade.\n\n*Only Normal and Star players are eligible.*")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleBuyDUPlayerPick(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const position = interaction.values[0]!;
  const gid = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);

  const rows = await getRosterRows(interaction as any, seasonId, {
    playerId: franchiseRostersTable.playerId,
    firstName: franchiseRostersTable.firstName,
    lastName: franchiseRostersTable.lastName,
    overall: franchiseRostersTable.overall,
    devTrait: franchiseRostersTable.devTrait,
    position: franchiseRostersTable.position,
  });
  const filtered = (rows as any[]).filter(r =>
    r.position?.toUpperCase() === position.toUpperCase() && r.devTrait <= 1
  );

  if (!filtered.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ No eligible players at ${position}.`)], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_duplayer:")
    .setPlaceholder("Select player…")
    .addOptions(
      filtered.slice(0, 25).map(r =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${r.firstName} ${r.lastName} — OVR ${r.overall} | ${DEV_LABEL[r.devTrait] ?? "Normal"}`)
          .setValue(String(r.playerId)),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("📈 Dev Trait Upgrade — Step 2").setDescription(`Position: **${position}** — Select the player.`)],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleBuyDUConfirm(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const playerId = Number(interaction.values[0]);
  const gid = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);

  const rows = await db.select({
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    devTrait:  franchiseRostersTable.devTrait,
    position:  franchiseRostersTable.position,
    playerId:  franchiseRostersTable.playerId,
  }).from(franchiseRostersTable)
    .where(and(eq(franchiseRostersTable.seasonId, seasonId), eq(franchiseRostersTable.playerId, playerId)))
    .limit(1);

  if (!rows.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Player not found.")], components: [backToHubRow()] });
    return;
  }

  const player = rows[0]!;
  sess.selectedPlayerId   = playerId;
  sess.selectedPlayerName = `${player.firstName} ${player.lastName}`.trim();
  sess.selectedPlayerPos  = player.position ?? "";
  sess.selectedPlayerDev  = player.devTrait ?? 0;

  const duSeason = await getOrCreateActiveSeason(gid);
  const [rules, user] = await Promise.all([
    getSeasonRules(duSeason),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
  ]);
  const cost    = rules?.devUpsCost ?? 1500;
  const curDev  = DEV_LABEL[player.devTrait ?? 0] ?? "Normal";
  const nextDev = DEV_LABEL[(player.devTrait ?? 0) + 1] ?? "Star";

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📈 Confirm Dev Trait Upgrade")
    .setDescription(
      `**${sess.selectedPlayerName}** (${sess.selectedPlayerPos})\n` +
      `Dev Upgrade: **${curDev} → ${nextDev}**\n\n` +
      `Cost: **${cost.toLocaleString()} coins**\nYour balance: **${user.balance.toLocaleString()} coins**`
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_buy_du_confirm").setLabel("✅ Confirm Upgrade").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

async function handleBuyDevUpExecute(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  if (!sess.selectedPlayerId || !sess.selectedPlayerName) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Session expired. Please start over.")], components: [backToHubRow()] });
    return;
  }

  const season = await getOrCreateActiveSeason(gid);
  const [rules, user, seasonStats] = await Promise.all([
    getSeasonRules(season),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
    getSeasonStats(interaction.user.id, season.id),
  ]);

  const cost      = rules?.devUpsCost ?? 1500;
  const maxDevUps = rules?.devUpsCap ?? 2;
  const used      = seasonStats?.devUpsPurchased ?? 0;

  if (used >= maxDevUps) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ You have used all ${maxDevUps} dev upgrades this season.`)], components: [backToHubRow()] });
    return;
  }
  if (user.balance < cost) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ Insufficient coins. You need **${cost.toLocaleString()}** but only have **${user.balance.toLocaleString()}**.`)], components: [backToHubRow()] });
    return;
  }

  await deductBalance(interaction.user.id, cost, gid);
  await logTransaction(interaction.user.id, -cost, "purchase", `Dev trait upgrade — ${sess.selectedPlayerName}`, gid);

  const [duInserted] = await db.insert(purchasesTable).values({
    discordId: interaction.user.id,
    seasonId: season.id,
    purchaseType: "dev_up",
    playerName: sess.selectedPlayerName,
    playerPosition: sess.selectedPlayerPos ?? "",
    cost,
    status: "pending",
    notes: `Dev up for ${sess.selectedPlayerName}`,
  }).returning({ id: purchasesTable.id });

  await sendCommissionerNotification(interaction as any, "dev_upgrade", duInserted!.id, {
    playerName:     sess.selectedPlayerName,
    playerPosition: sess.selectedPlayerPos ?? "",
    currentDevLabel: DEV_LABEL[sess.selectedPlayerDev ?? 0] ?? "Normal",
    devUpType:       DEV_LABEL[(sess.selectedPlayerDev ?? 0) + 1] ?? "Star",
    costPer:         cost,
  });

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("⏳ Dev Upgrade Submitted")
      .setDescription(`Dev upgrade for **${sess.selectedPlayerName}** has been submitted for commissioner approval.\nCost: **${cost.toLocaleString()} coins** deducted.`)],
    components: [backToHubRow()],
  });
}

// ── Buy Custom Player info ─────────────────────────────────────────────────────

async function handleBuyCustomInfo(interaction: ButtonInteraction) {
  await interaction.deferUpdate();

  const gid       = interaction.guildId!;
  const discordId = interaction.user.id;
  const season    = await getOrCreateActiveSeason(gid);

  const invCount = await getInventoryCount(discordId, season.id);

  const combined = invCount.legends + invCount.customs;
  const cap      = LIMITS.maxLegendsPlusCustomPlayers;

  if (combined >= cap) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ Season Inventory Full")
        .setDescription(
          `You already have **${combined}** combined legends and custom players this season ` +
          `(max **${cap}**). You cannot add another custom player.`,
        )
        .addFields(
          { name: "Legends",        value: `${invCount.legends}`, inline: true },
          { name: "Custom Players", value: `${invCount.customs}`, inline: true },
          { name: "Limit",          value: `${cap} combined`,     inline: true },
        )],
      components: [backToHubRow()],
    });
    return;
  }

  const sessionId = createSession(discordId, gid, season.id);
  const slotsLeft = cap - combined;

  const warningEmbed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("⚠️ Before You Start — Draft Pick Required")
    .setDescription(
      "Purchasing a custom player **does not automatically place them on your roster**.\n\n" +
      "You must use **a draft pick** to select your custom player during the annual draft. " +
      "If you do not have a draft pick available, you will not be able to add this player to your team.",
    )
    .addFields(
      {
        name: "What happens after you purchase?",
        value:
          "1. You build your player's position, archetype, attributes, and appearance.\n" +
          "2. A commissioner adds them to the MCA draft class.\n" +
          "3. You use a draft pick to select them in the draft.\n" +
          "4. They join your roster once drafted.",
      },
      {
        name: "Season inventory slots",
        value: `You have **${combined}** of **${cap}** slots used. **${slotsLeft}** slot${slotsLeft !== 1 ? "s" : ""} remaining.`,
      },
    )
    .setFooter({ text: "Make sure you have a draft pick saved before proceeding." });

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ccp_preconfirm:${sessionId}`)
      .setLabel("✅ I understand, start building")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ccp_cancel:${sessionId}`)
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [warningEmbed], components: [confirmRow] });
}

// ── Buy Legend ─────────────────────────────────────────────────────────────────

async function handleBuyLegendPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const rows = await db.select({
    id:       legendsTable.id,
    name:     legendsTable.name,
    position: legendsTable.position,
    cost:     legendsTable.cost,
  }).from(legendsTable)
    .where(eq(legendsTable.isAvailable, true))
    .orderBy(legendsTable.position, legendsTable.name);

  if (!rows.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No legends are currently available in the store.")], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_legendsel:")
    .setPlaceholder("Select a legend…")
    .addOptions(
      rows.slice(0, 25).map(l =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${l.name} — ${l.position} (${(l.cost ?? 0).toLocaleString()} coins)`)
          .setValue(String(l.id)),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle("🏆 Buy a Legend — Select").setDescription("Choose a legend from the available options below.\n\nMax 4 legends all-time. Legends are permanent across seasons.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleBuyLegendConfirm(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const legendId = Number(interaction.values[0]);
  const row = (await db.select().from(legendsTable).where(eq(legendsTable.id, legendId)).limit(1))[0];
  if (!row) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Legend not found.")], components: [backToHubRow()] });
    return;
  }

  const gid  = interaction.guildId!;
  const user = await getOrCreateUser(interaction.user.id, interaction.user.username, gid);
  sess.selectedLegendId   = legendId;
  sess.selectedLegendName = row.name;
  sess.selectedLegendCost = row.cost ?? 0;

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏆 Confirm Legend Purchase")
    .setDescription(
      `**${row.name}** — ${row.position}\n\n` +
      `Cost: **${(row.cost ?? 0).toLocaleString()} coins**\nYour balance: **${user.balance.toLocaleString()} coins**`
    );

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_buy_legend_confirm").setLabel("✅ Confirm Purchase").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [btnRow] });
}

async function handleBuyLegendExecute(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  if (!sess.selectedLegendId || !sess.selectedLegendName) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Session expired.")], components: [backToHubRow()] });
    return;
  }

  const [legend, season, user] = await Promise.all([
    db.select().from(legendsTable).where(eq(legendsTable.id, sess.selectedLegendId)).limit(1).then(r => r[0]),
    getOrCreateActiveSeason(gid),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
  ]);

  if (!legend) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Legend no longer available.")], components: [backToHubRow()] });
    return;
  }

  const cost = legend.cost ?? 0;
  if (user.balance < cost) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ Insufficient coins. You need **${cost.toLocaleString()}** but only have **${user.balance.toLocaleString()}**.`)], components: [backToHubRow()] });
    return;
  }

  await deductBalance(interaction.user.id, cost, gid);
  await logTransaction(interaction.user.id, -cost, "purchase", `Legend purchase — ${legend.name}`, gid);

  const [lgInserted] = await db.insert(purchasesTable).values({
    discordId: interaction.user.id,
    seasonId: season.id,
    purchaseType: "legend",
    playerName: legend.name,
    playerPosition: legend.position ?? "",
    cost,
    status: "pending",
    notes: `Legend: ${legend.name}`,
  }).returning({ id: purchasesTable.id });

  await sendCommissionerNotification(interaction as any, "legend", lgInserted!.id, {
    legendName:     legend.name,
    legendPosition: legend.position ?? "",
    costPer:        cost,
  });

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("⏳ Legend Submitted")
      .setDescription(`**${legend.name}** submitted for commissioner approval. Cost: **${cost.toLocaleString()} coins** deducted.`)],
    components: [backToHubRow()],
  });
}

// ── Wager ─────────────────────────────────────────────────────────────────────

/** Convert a currentWeek string (e.g. "1", "wildcard") to the integer weekIndex
 *  stored in franchise_schedule rows. Regular seasons are 0-based; playoffs use
 *  the canonical 1018/1019/1020/1022 values from PLAYOFF_WEEK_META. */
function weekKeyToIndex(weekKey: string): number | null {
  const num = parseInt(weekKey, 10);
  if (!isNaN(num) && num >= 1 && num <= 18) return num - 1;
  const meta = PLAYOFF_WEEK_META[weekKey];
  return meta ? meta.weekIndex : null;
}

// ── Wager helpers ─────────────────────────────────────────────────────────────

function spreadLabel(spread: number): string {
  return spread > 0 ? `+${spread}` : `${spread}`;
}

function spreadDescription(myTeam: string, theirTeam: string, spread: number): string {
  if (spread < 0) return `**${myTeam}** must win by more than **${Math.abs(spread)}** points\n\`${myTeam} score − ${Math.abs(spread)} > ${theirTeam} score\``;
  if (spread === 0) return `**${myTeam}** must win outright\n\`${myTeam} score > ${theirTeam} score\``;
  return `**${myTeam}** can lose by up to **${spread}** points and still cover\n\`${myTeam} score > ${theirTeam} score − ${spread}\``;
}

async function buildOpponentSelectRows(
  gid: string,
  excludeDiscordId: string,
  selectedOpponentId?: string,
): Promise<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[]> {
  const linkedUsers = await db.select({
    discordId: usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team: usersTable.team,
  }).from(usersTable)
    .where(and(
      eq(usersTable.guildId, gid),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
      ne(usersTable.discordId, excludeDiscordId),
    ));

  const afcUsers = linkedUsers.filter(u => lookupNflDivision(u.team!)?.conference === "AFC");
  const nfcUsers = linkedUsers.filter(u => lookupNflDivision(u.team!)?.conference === "NFC");

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  if (afcUsers.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ac_wager_opponent_afc")
      .setPlaceholder("AFC — Pick Opponent")
      .addOptions(afcUsers.slice(0, 25).map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${u.team} — ${u.discordUsername}`)
          .setValue(u.discordId)
          .setDefault(u.discordId === selectedOpponentId),
      ));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  if (nfcUsers.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ac_wager_opponent_nfc")
      .setPlaceholder("NFC — Pick Opponent")
      .addOptions(nfcUsers.slice(0, 25).map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${u.team} — ${u.discordUsername}`)
          .setValue(u.discordId)
          .setDefault(u.discordId === selectedOpponentId),
      ));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ac_wager_send")
      .setLabel("📨 Send Wager")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!selectedOpponentId),
    new ButtonBuilder().setCustomId("ac_wager_back_to_spread").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  ));

  return rows;
}

// ── Wager Step 1: Game Select ─────────────────────────────────────────────────

async function handleWagerStart(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const settings = await getServerSettings(gid);
  if (!settings.coinEconomy || !settings.wagerEnabled) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Wagers are currently disabled by the commissioners.")], components: [backToHubRow()] });
    return;
  }

  const season = await getOrCreateActiveSeason(gid);
  const weekIndex = weekKeyToIndex((season as any).currentWeek ?? "1");

  if (weekIndex === null) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager").setDescription("No schedule data found for the current week. Ask a commissioner to import the schedule from MCA.")], components: [backToHubRow()] });
    return;
  }

  let scheduleRows = await db.select({
    id: franchiseScheduleTable.id, homeTeamId: franchiseScheduleTable.homeTeamId,
    awayTeamId: franchiseScheduleTable.awayTeamId, homeTeamName: franchiseScheduleTable.homeTeamName,
    awayTeamName: franchiseScheduleTable.awayTeamName,
  }).from(franchiseScheduleTable)
    .where(and(eq(franchiseScheduleTable.seasonId, season.id), eq(franchiseScheduleTable.weekIndex, weekIndex)))
    .limit(32);

  if (scheduleRows.length === 0 && weekIndex >= 1000) {
    scheduleRows = await db.select({
      id: franchiseScheduleTable.id, homeTeamId: franchiseScheduleTable.homeTeamId,
      awayTeamId: franchiseScheduleTable.awayTeamId, homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
    }).from(franchiseScheduleTable)
      .where(and(eq(franchiseScheduleTable.seasonId, season.id), eq(franchiseScheduleTable.weekIndex, weekIndex - 1000)))
      .limit(32);
  }

  if (!scheduleRows.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager").setDescription("No schedule data found for the current week. Ask a commissioner to import the schedule from MCA.")], components: [backToHubRow()] });
    return;
  }

  // Filter to H2H: both teams must have a linked discord user via franchise_mca_teams
  const mcaTeams = await db.select({
    teamId: franchiseMcaTeamsTable.teamId,
    discordId: franchiseMcaTeamsTable.discordId,
  }).from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), isNotNull(franchiseMcaTeamsTable.discordId)));

  const linkedTeamIds = new Set(mcaTeams.filter(m => m.discordId).map(m => m.teamId));
  const h2hGames = scheduleRows.filter(g => linkedTeamIds.has(g.homeTeamId) && linkedTeamIds.has(g.awayTeamId));

  if (!h2hGames.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager").setDescription("No head-to-head games found this week (both teams must be linked to active users).")], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_wager_game")
    .setPlaceholder("Select a game to wager on…")
    .addOptions(h2hGames.slice(0, 25).map(g =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${g.homeTeamName} vs ${g.awayTeamName}`)
        .setValue(String(g.id)),
    ));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 1 of 4").setDescription("Select the head-to-head game you want to wager on.\n\nOnly games where **both teams are linked to active users** are shown.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

// ── Wager Step 2: Team Pick ───────────────────────────────────────────────────

async function handleWagerGameSelect(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const gameId = Number(interaction.values[0]);
  sess.scheduleGameId = String(gameId);

  const gid = interaction.guildId!;
  const season = await getOrCreateActiveSeason(gid);

  const game = (await db.select().from(franchiseScheduleTable).where(eq(franchiseScheduleTable.id, gameId)).limit(1))[0];
  if (!game) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Game not found.")], components: [backToHubRow()] });
    return;
  }

  // Resolve which discord users are linked to each side
  const [homeMca] = await db.select({ discordId: franchiseMcaTeamsTable.discordId })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, game.homeTeamId)))
    .limit(1);
  const [awayMca] = await db.select({ discordId: franchiseMcaTeamsTable.discordId })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, game.awayTeamId)))
    .limit(1);

  sess.wagerHomeTeam      = game.homeTeamName;
  sess.wagerAwayTeam      = game.awayTeamName;
  sess.wagerHomeDiscordId = homeMca?.discordId ?? undefined;
  sess.wagerAwayDiscordId = awayMca?.discordId ?? undefined;

  const userLine = (homeMca?.discordId && awayMca?.discordId)
    ? `\n🏠 <@${homeMca.discordId}> vs ✈️ <@${awayMca.discordId}>`
    : "";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_wager_pick:home").setLabel(`🏠 ${game.homeTeamName}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_wager_pick:away").setLabel(`✈️ ${game.awayTeamName}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 2 of 4").setDescription(`**${game.homeTeamName} vs ${game.awayTeamName}**${userLine}\n\nWhich team are you backing?`)],
    components: [row],
  });
}

// ── Wager Step 3: Spread Select ───────────────────────────────────────────────

async function handleWagerTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const side = interaction.customId.split(":")[1]! as "home" | "away";
  sess.wagerSide = side;
  sess.wagerTeam = side === "home" ? sess.wagerHomeTeam : sess.wagerAwayTeam;
  sess.wagerChallengerTeam = sess.wagerTeam;

  const myTeam    = sess.wagerTeam ?? "Your Team";
  const theirTeam = side === "home" ? (sess.wagerAwayTeam ?? "Opponent") : (sess.wagerHomeTeam ?? "Opponent");

  const spreadOptions: StringSelectMenuOptionBuilder[] = [];
  for (let s = -10; s <= 10; s++) {
    const label = s === 0 ? "0 (straight win)" : s > 0 ? `+${s}` : `${s}`;
    const desc  = s < 0 ? `${myTeam} must win by more than ${Math.abs(s)}`
      : s === 0        ? `${myTeam} must win outright`
      :                  `${myTeam} can lose by up to ${s} and still cover`;
    spreadOptions.push(new StringSelectMenuOptionBuilder().setLabel(label).setValue(String(s)).setDescription(desc));
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_wager_spread")
    .setPlaceholder("Select your point spread…")
    .addOptions(spreadOptions);

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 3 of 4").setDescription(`You're backing **${myTeam}** vs **${theirTeam}**.\n\nSelect your point spread. Negative means your team must win by more; positive means they can lose by that much and still cover.`)],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleWagerSpreadSelect(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const spread = parseInt(interaction.values[0]!, 10);
  sess.wagerSpread = spread;

  const myTeam    = sess.wagerTeam ?? "Your Team";
  const theirTeam = sess.wagerSide === "home" ? (sess.wagerAwayTeam ?? "Opponent") : (sess.wagerHomeTeam ?? "Opponent");

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("⚔️ Place a Wager — Step 3 of 4 (Spread Confirmed)")
      .setDescription(
        `**Spread: ${spreadLabel(spread)}**\n\n` +
        spreadDescription(myTeam, theirTeam, spread) + "\n\n" +
        `If scores are tied after the spread is applied, the bet is a **push** — both players get their coins back.\n\n` +
        `Click **Next** to enter your wager amount.`,
      )],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_wager_spread_next").setLabel("Next →").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ac_wager_back_to_team").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function handleWagerBackToTeam(interaction: ButtonInteraction, sess: ActionsSession) {
  const homeTeam = sess.wagerHomeTeam ?? "Home";
  const awayTeam = sess.wagerAwayTeam ?? "Away";
  const userLine = (sess.wagerHomeDiscordId && sess.wagerAwayDiscordId)
    ? `\n🏠 <@${sess.wagerHomeDiscordId}> vs ✈️ <@${sess.wagerAwayDiscordId}>`
    : "";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_wager_pick:home").setLabel(`🏠 ${homeTeam}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_wager_pick:away").setLabel(`✈️ ${awayTeam}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 2 of 4").setDescription(`**${homeTeam} vs ${awayTeam}**${userLine}\n\nWhich team are you backing?`)],
    components: [row],
  });
}

async function handleWagerSpreadNext(interaction: ButtonInteraction, _sess: ActionsSession) {
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId("ac_modal_wageramount")
      .setTitle("Wager Amount")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel("Coins to wager (each player stakes this)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. 500")
            .setRequired(true)
            .setMaxLength(10),
        ),
      ),
  );
}

// ── Wager Step 4: Opponent Select → Send ─────────────────────────────────────

async function handleWagerAmountSubmit(interaction: ModalSubmitInteraction, sess: ActionsSession) {
  const amountStr = interaction.fields.getTextInputValue("amount").trim();
  const amount    = parseInt(amountStr, 10);

  if (isNaN(amount) || amount < 1) {
    await interaction.reply({ content: "❌ Invalid amount. Enter a positive whole number.", ephemeral: true });
    return;
  }

  const gid  = interaction.guildId!;
  const user = await getOrCreateUser(interaction.user.id, interaction.user.username, gid);
  if (user.balance < amount) {
    await interaction.reply({ content: `❌ Insufficient coins. You have **${user.balance.toLocaleString()}**, wager is **${amount.toLocaleString()}**.`, ephemeral: true });
    return;
  }

  sess.wagerAmount = amount;

  const myTeam    = sess.wagerTeam ?? "Your Team";
  const theirTeam = sess.wagerSide === "home" ? (sess.wagerAwayTeam ?? "Opponent") : (sess.wagerHomeTeam ?? "Opponent");
  const spread    = sess.wagerSpread ?? 0;

  const rows = await buildOpponentSelectRows(gid, interaction.user.id);

  if (rows.length === 1) {
    await interaction.reply({ content: "❌ No other linked users found to wager against.", ephemeral: true });
    return;
  }

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("⚔️ Place a Wager — Step 4 of 4")
      .setDescription(
        `**Your pick:** ${myTeam} (${spreadLabel(spread)})\n` +
        `**Amount:** ${amount.toLocaleString()} coins each\n\n` +
        spreadDescription(myTeam, theirTeam, spread) + "\n\n" +
        `Select the opponent you want to challenge from the dropdowns below, then click **Send Wager**.`,
      )],
    components: rows as ActionRowBuilder<any>[],
  });
}

async function handleWagerOpponentSelect(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const opponentId = interaction.values[0]!;
  sess.wagerOpponentId = opponentId;

  const gid = interaction.guildId!;
  const [oppRecord] = await db.select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable).where(and(eq(usersTable.discordId, opponentId), eq(usersTable.guildId, gid))).limit(1);
  sess.wagerOpponentTeam = oppRecord?.team ?? undefined;

  const myTeam    = sess.wagerTeam ?? "Your Team";
  const theirTeam = sess.wagerSide === "home" ? (sess.wagerAwayTeam ?? "Opponent") : (sess.wagerHomeTeam ?? "Opponent");
  const spread    = sess.wagerSpread ?? 0;
  const amount    = sess.wagerAmount ?? 0;

  const rows = await buildOpponentSelectRows(gid, interaction.user.id, opponentId);

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("⚔️ Place a Wager — Step 4 of 4")
      .setDescription(
        `**Your pick:** ${myTeam} (${spreadLabel(spread)})\n` +
        `**Amount:** ${amount.toLocaleString()} coins each\n\n` +
        `✅ **Opponent selected:** <@${opponentId}> (${oppRecord?.team ?? "Unknown"})\n\n` +
        `Click **Send Wager** to challenge them, or pick a different opponent above.`,
      )],
    components: rows as ActionRowBuilder<any>[],
  });
}

async function handleWagerBackToSpread(interaction: ButtonInteraction, sess: ActionsSession) {
  const myTeam    = sess.wagerTeam ?? "Your Team";
  const theirTeam = sess.wagerSide === "home" ? (sess.wagerAwayTeam ?? "Opponent") : (sess.wagerHomeTeam ?? "Opponent");
  const spread    = sess.wagerSpread ?? 0;

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("⚔️ Place a Wager — Step 3 of 4 (Spread Confirmed)")
      .setDescription(
        `**Spread: ${spreadLabel(spread)}**\n\n` +
        spreadDescription(myTeam, theirTeam, spread) + "\n\n" +
        `Click **Next** to set your wager amount.`,
      )],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_wager_spread_next").setLabel("Next →").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ac_wager_back_to_team").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function handleWagerSend(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;

  if (!sess.wagerOpponentId || !sess.wagerTeam || !sess.wagerAmount || sess.wagerSpread === undefined || !sess.wagerSide) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Missing wager details. Please start over from the hub.")], components: [backToHubRow()] });
    return;
  }

  const challenger = await getOrCreateUser(interaction.user.id, interaction.user.username, gid);
  if (challenger.balance < sess.wagerAmount) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ Insufficient coins. Your balance: **${challenger.balance.toLocaleString()}**, wager: **${sess.wagerAmount.toLocaleString()}**.`)], components: [backToHubRow()] });
    return;
  }

  const teamFor     = sess.wagerTeam;
  const teamAgainst = sess.wagerSide === "home" ? (sess.wagerAwayTeam ?? "Opponent") : (sess.wagerHomeTeam ?? "Opponent");

  const [oppRecord] = await db.select({ discordUsername: usersTable.discordUsername })
    .from(usersTable).where(and(eq(usersTable.discordId, sess.wagerOpponentId), eq(usersTable.guildId, gid))).limit(1);

  await getOrCreateUser(sess.wagerOpponentId, oppRecord?.discordUsername ?? "Unknown", gid);

  const [wager] = await db.insert(wagersTable).values({
    guildId:            gid,
    challengerId:       interaction.user.id,
    challengerUsername: interaction.user.username,
    opponentId:         sess.wagerOpponentId,
    opponentUsername:   oppRecord?.discordUsername ?? "Unknown",
    amount:             sess.wagerAmount,
    pot:                sess.wagerAmount * 2,
    teamFor,
    teamAgainst,
    status:             "pending",
    spread:             sess.wagerSpread,
    challengerSide:     sess.wagerSide,
    scheduleGameId:     sess.scheduleGameId ? parseInt(sess.scheduleGameId, 10) : undefined,
  }).returning();

  if (!wager) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Failed to create wager record. Please try again.")], components: [backToHubRow()] });
    return;
  }

  // Close the ephemeral menu
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Wager Challenge Sent").setDescription(`Challenge sent to <@${sess.wagerOpponentId}>! Check the channel for the challenge message.\n\n**Wager #${wager.id}**`)],
    components: [],
  });

  // Post public challenge to the channel
  const [challengerMember, opponentMember] = await Promise.all([
    interaction.guild?.members.fetch(interaction.user.id).catch(() => null),
    interaction.guild?.members.fetch(sess.wagerOpponentId).catch(() => null),
  ]);
  const challengerName = challengerMember?.displayName ?? interaction.user.username;
  const opponentName   = opponentMember?.displayName ?? oppRecord?.discordUsername ?? "Opponent";

  const spread    = sess.wagerSpread;
  const spreadStr = spreadLabel(spread);
  const spreadDesc = spreadDescription(teamFor, teamAgainst, spread);

  const challengeEmbed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("⚔️ Wager Challenge!")
    .setDescription(`<@${interaction.user.id}> has challenged <@${sess.wagerOpponentId}> to a coin wager!`)
    .addFields(
      { name: "💰 Stake",                         value: `**${sess.wagerAmount.toLocaleString()} coins** each (pot: **${(sess.wagerAmount * 2).toLocaleString()}**)` },
      { name: `🏈 ${challengerName} is backing`,  value: `**${teamFor}** (spread: ${spreadStr})`, inline: true },
      { name: `🏈 ${opponentName} is backing`,    value: `**${teamAgainst}**`,                    inline: true },
      { name: "📊 Challenger's Spread",            value: spreadDesc },
      { name: "📋 Status",                         value: "⏳ Waiting for opponent to respond…" },
    )
    .setFooter({ text: `Wager #${wager.id}` })
    .setTimestamp();

  const challengeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wager_accept:${wager.id}`).setLabel("✅ Accept Wager").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wager_refuse:${wager.id}`).setLabel("❌ Refuse").setStyle(ButtonStyle.Danger),
  );

  try {
    if (interaction.channel) {
      const msg = await (interaction.channel as any).send({
        content: `<@${sess.wagerOpponentId}> — you have a wager challenge!`,
        embeds:  [challengeEmbed],
        components: [challengeRow],
      });
      await db.update(wagersTable).set({ challengeMessageId: msg.id }).where(eq(wagersTable.id, wager.id));
    }
  } catch (err) {
    console.error("Failed to send wager challenge message:", err);
  }
}

// ── Coins ─────────────────────────────────────────────────────────────────────

async function handleCoins(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid  = interaction.guildId!;
  const user = await getOrCreateUser(interaction.user.id, interaction.user.username, gid);

  const savingsRow = (await db.select({ balance: userSavingsTable.balance }).from(userSavingsTable)
    .where(eq(userSavingsTable.discordId, interaction.user.id))
    .limit(1))[0];

  const savings = savingsRow?.balance ?? 0;
  const total   = user.balance + savings;

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🪙 Your Coin Balance")
    .addFields(
      { name: "💰 Wallet",  value: `**${user.balance.toLocaleString()}** coins`, inline: true },
      { name: "🏦 Savings", value: `**${savings.toLocaleString()}** coins`, inline: true },
      { name: "📊 Total",   value: `**${total.toLocaleString()}** coins`, inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_send_coins_modal").setLabel("📤 Send Coins").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

async function handleSendCoinsModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ac_modal_sendcoins")
    .setTitle("Send Coins")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("recipient").setLabel("Recipient's Discord username or @mention").setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("Amount (coins)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 100"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("note").setLabel("Note (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100),
      ),
    );
  await interaction.showModal(modal);
}

async function handleSendCoinsSubmit(interaction: ModalSubmitInteraction, sess: ActionsSession) {
  const recipientInput = interaction.fields.getTextInputValue("recipient").trim().replace(/[<@!>]/g, "");
  const amountStr      = interaction.fields.getTextInputValue("amount").trim();
  const note           = interaction.fields.getTextInputValue("note").trim();
  const gid            = interaction.guildId!;
  const amount         = parseInt(amountStr, 10);

  if (isNaN(amount) || amount < 1) {
    await interaction.reply({ content: "❌ Invalid amount.", ephemeral: true }); return;
  }

  // Try to find recipient by Discord ID or username
  const recipientRow = (await db.select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername })
    .from(usersTable)
    .where(and(
      eq(usersTable.guildId, gid),
      sql`lower(${usersTable.discordUsername}) = lower(${recipientInput}) OR ${usersTable.discordId} = ${recipientInput}`,
    ))
    .limit(1))[0];

  if (!recipientRow) {
    await interaction.reply({ content: `❌ Could not find user **${recipientInput}** in this server.`, ephemeral: true }); return;
  }

  if (recipientRow.discordId === interaction.user.id) {
    await interaction.reply({ content: "❌ You can't send coins to yourself.", ephemeral: true }); return;
  }

  const sender = await getOrCreateUser(interaction.user.id, interaction.user.username, gid);
  if (sender.balance < amount) {
    await interaction.reply({ content: `❌ Insufficient coins. You have **${sender.balance.toLocaleString()}**, trying to send **${amount.toLocaleString()}**.`, ephemeral: true }); return;
  }

  await getOrCreateUser(recipientRow.discordId, recipientRow.discordUsername, gid);
  await deductBalance(interaction.user.id, amount, gid);
  await addBalance(recipientRow.discordId, amount, gid);
  await logTransaction(interaction.user.id, -amount, "sendcoins_sent",     `Sent to ${recipientRow.discordUsername}${note ? `: ${note}` : ""}`,        gid, recipientRow.discordId);
  await logTransaction(recipientRow.discordId, amount, "sendcoins_received", `Received from ${interaction.user.username}${note ? `: ${note}` : ""}`, gid, interaction.user.id);

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Coins Sent")
      .setDescription(`Sent **${amount.toLocaleString()} coins** to **${recipientRow.discordUsername}**${note ? `\n*"${note}"*` : ""}`)],
    components: [backToHubRow()],
  });
}

// ── Interview ─────────────────────────────────────────────────────────────────

async function handleInterview(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const [, season] = await Promise.all([
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
    getOrCreateActiveSeason(gid),
  ]);
  const currentWeek = (season as any).currentWeek ?? "1";
  const wkLabel     = weekLabel(currentWeek);

  const existing = (await db.select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
    .from(interviewRequestsTable)
    .where(and(
      eq(interviewRequestsTable.discordId, interaction.user.id),
      eq(interviewRequestsTable.guildId, gid),
      eq(interviewRequestsTable.week, currentWeek),
      inArray(interviewRequestsTable.status, ["pending", "approved"]),
    ))
    .limit(1))[0];

  if (existing) {
    const stateLabel = existing.status === "approved" ? "already been approved" : "already been submitted and is pending review";
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Yellow)
        .setTitle("⚠️ Interview Already Submitted")
        .setDescription(`Your interview for **${wkLabel}** has ${stateLabel} (ID: \`${existing.id}\`).\nOnly one interview per week.`)],
      components: [backToHubRow()],
    });
    return;
  }

  // Show type-selection screen
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎙️ Request an Interview")
    .setDescription(
      `Choose the type of interview you'd like to submit for **${wkLabel}**.\n\n` +
      "**Pre-Game** — Talk about preparation, game plan, and expectations before the match.\n" +
      "**Post-Game** — Reflect on what happened, adjustments made, and the result.\n" +
      "**General** — A non-game-specific interview about your franchise and vision.",
    )
    .setFooter({ text: "You'll receive 3 randomly selected questions based on your choice." });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("interview_typepick:pregame")
      .setLabel("🏟️ Pre-Game")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("interview_typepick:postgame")
      .setLabel("📊 Post-Game")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("interview_typepick:general")
      .setLabel("🎤 General")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

export async function handleInterviewTypePick(interaction: ButtonInteraction) {
  const type = interaction.customId.split(":")[1] as InterviewType;
  const gid  = interaction.guildId!;

  const season = await getOrCreateActiveSeason(gid);
  const currentWeek = (season as any).currentWeek ?? "1";
  const wkLabel     = weekLabel(currentWeek);

  // One-per-week guard — reply ephemerally if already submitted
  const existing = (await db.select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
    .from(interviewRequestsTable)
    .where(and(
      eq(interviewRequestsTable.discordId, interaction.user.id),
      eq(interviewRequestsTable.guildId, gid),
      eq(interviewRequestsTable.week, currentWeek),
      inArray(interviewRequestsTable.status, ["pending", "approved"]),
    ))
    .limit(1))[0];

  if (existing) {
    const stateLabel = existing.status === "approved" ? "already been approved" : "already been submitted and is pending review";
    await interaction.reply({
      ephemeral: true,
      content: `⚠️ Your interview for **${wkLabel}** has ${stateLabel} (ID: \`${existing.id}\`). Only one interview per week.`,
    });
    return;
  }

  // Pick 3 questions and immediately show modal — do NOT update the message
  // so dismissing the modal (× or Back) naturally returns to type selection.
  const pool       = getQuestionPool(type);
  const title      = interviewTypeLabel(type);
  const [i1, i2, i3] = pickThreeIndices(pool.length);
  const q1 = pool[i1]!;
  const q2 = pool[i2]!;
  const q3 = pool[i3]!;
  const indicesStr = `${i1},${i2},${i3}`;
  const truncLabel = (q: string) => q.length <= 45 ? q : q.slice(0, 42) + "...";

  const modal = new ModalBuilder()
    .setCustomId(`interview_answer_modal:${indicesStr}:${type}`)
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
        .setPlaceholder("Type your answer here…"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("a2")
        .setLabel(truncLabel(q2))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(1000)
        .setPlaceholder("Type your answer here…"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("a3")
        .setLabel(truncLabel(q3))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(1000)
        .setPlaceholder("Type your answer here…"),
    ),
  );

  await interaction.showModal(modal);
}

// ── Tweet ─────────────────────────────────────────────────────────────────────

async function handleTweetModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ac_modal_tweet")
    .setTitle("Post a Tweet")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("tweet_text")
          .setLabel("Your tweet (max 280 characters)")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(280)
          .setRequired(true)
          .setPlaceholder("Write your tweet here…"),
      ),
    );
  await interaction.showModal(modal);
}

async function handleTweetSubmit(interaction: ModalSubmitInteraction, sess: ActionsSession) {
  const text = interaction.fields.getTextInputValue("tweet_text").trim();
  const gid  = interaction.guildId!;

  if (!text) { await interaction.reply({ content: "❌ Tweet cannot be empty.", ephemeral: true }); return; }

  const [season, user] = await Promise.all([
    getOrCreateActiveSeason(gid),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
  ]);

  const weeklyLimit = await getPayoutValue("tweet_weekly_limit", gid);
  const payout      = await getPayoutValue("tweet_payout", gid);
  const currentWeek = (season as any).currentWeek ?? "1";

  // Count tweets this week
  const tweetsThisWeek = (await db.select({ id: guildTweetsTable.id })
    .from(guildTweetsTable)
    .where(and(
      eq(guildTweetsTable.discordId, interaction.user.id),
      eq(guildTweetsTable.guildId, gid),
      eq(guildTweetsTable.weekNumber, String(currentWeek)),
    ))).length;

  const willEarnCoins = weeklyLimit === 0 || tweetsThisWeek < weeklyLimit;
  const earnedCoins   = willEarnCoins ? payout : 0;

  await db.insert(guildTweetsTable).values({
    discordId:    interaction.user.id,
    guildId:      gid,
    seasonId:     season.id,
    weekNumber:   String(currentWeek),
    tweetText:    text,
    coinsAwarded: earnedCoins,
  });

  if (earnedCoins > 0) {
    await addBalance(interaction.user.id, earnedCoins, gid);
    await logTransaction(interaction.user.id, earnedCoins, "addcoins", `Tweet payout — Week ${currentWeek}`, gid);
  }

  // Post the tweet to the league twitter channel
  const twitterChannelId = await getGuildChannel(gid, CHANNEL_KEYS.LEAGUE_TWITTER);
  if (twitterChannelId) {
    try {
      const ch = await interaction.client.channels.fetch(twitterChannelId);
      if (ch?.isTextBased()) {
        await (ch as TextChannel).send({
          embeds: [new EmbedBuilder()
            .setColor(Colors.Blue)
            .setAuthor({
              name: `@${interaction.user.username}${user.team ? ` · ${user.team}` : ""}`,
              iconURL: interaction.user.displayAvatarURL(),
            })
            .setDescription(text)
            .setFooter({ text: `Week ${currentWeek} 🐦 League Twitter` })
            .setTimestamp()],
        });
      }
    } catch { /* channel fetch/send failure is non-fatal */ }
  }

  const limitNote = !willEarnCoins
    ? `\n*Weekly tweet limit reached (${weeklyLimit}) — no coins awarded.*`
    : earnedCoins > 0
      ? `\n**+${earnedCoins} coins** awarded!`
      : `\n*Tweet posted! (No coin payout configured this week.)*`;

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("🐦 Tweet Posted!")
      .setDescription(`> ${text}${limitNote}`)
      .setFooter({ text: `Week ${currentWeek} • ${user.team ?? interaction.user.username}` })
      .setTimestamp()],
    components: [backToHubRow()],
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROW 2 — Rosters
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMyRoster(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const [user, seasonId] = await Promise.all([
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
    getRosterSeasonId(gid),
  ]);

  if (!user.team) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ You are not linked to a team. Ask a commissioner to link you with `/admin-linkteam`.")],
      components: [backToHubRow()],
    });
    return;
  }

  // Find teamId from franchiseMcaTeams — match on nickName first, then fullName as fallback
  const teamRow = (await db.select({ id: franchiseMcaTeamsTable.id, mcaTeamId: franchiseMcaTeamsTable.teamId, fullName: franchiseMcaTeamsTable.fullName, nickName: franchiseMcaTeamsTable.nickName })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      or(
        sql`lower(${franchiseMcaTeamsTable.nickName}) = lower(${user.team})`,
        sql`lower(${franchiseMcaTeamsTable.fullName}) = lower(${user.team})`,
      ),
    ))
    .limit(1))[0];

  if (!teamRow) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ Team **${user.team}** not found in the franchise database. Make sure MCA data is imported.\n\n*Your linked team name is "**${user.team}**" — ask a commissioner to check it matches your franchise data.*`)],
      components: [backToHubRow()],
    });
    return;
  }

  const displayName = teamRow.fullName ?? user.team;
  const embed = new EmbedBuilder();
  // Pass MCA teamId (not serial PK) — franchiseRostersTable.teamId stores MCA ids
  await buildRosterEmbed(gid, seasonId, teamRow.mcaTeamId, displayName, embed);
  await interaction.update({ embeds: [embed], components: [backToHubRow()] });
}

async function handleAnyRosterTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid      = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);

  // Fetch ALL teams (human and CPU) for this season
  const teams = await db.select({
    id:         franchiseMcaTeamsTable.id,
    mcaTeamId:  franchiseMcaTeamsTable.teamId,
    fullName:   franchiseMcaTeamsTable.fullName,
    nickName:   franchiseMcaTeamsTable.nickName,
    conference: franchiseMcaTeamsTable.conference,
    isHuman:    franchiseMcaTeamsTable.isHuman,
  })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, seasonId))
    .orderBy(franchiseMcaTeamsTable.conference, franchiseMcaTeamsTable.fullName);

  if (!teams.length) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No teams found. Import MCA data first.")],
      components: [backToHubRow()],
    });
    return;
  }

  // Split into AFC and NFC; fall back to NFL_DIVISION_MAP if conference field is missing
  const afcTeams = teams.filter(t => {
    const conf = t.conference?.toUpperCase();
    if (conf === "AFC") return true;
    if (conf === "NFC") return false;
    return NFL_DIVISION_MAP[t.nickName ?? ""]?.conference === "AFC";
  });
  const nfcTeams = teams.filter(t => {
    const conf = t.conference?.toUpperCase();
    if (conf === "NFC") return true;
    if (conf === "AFC") return false;
    return NFL_DIVISION_MAP[t.nickName ?? ""]?.conference === "NFC";
  });

  // Use MCA teamId (not serial PK) as select value — buildRosterEmbed needs MCA teamId
  const makeMenu = (conference: string, list: typeof teams) =>
    new StringSelectMenuBuilder()
      .setCustomId("ac_anyroster_sel")
      .setPlaceholder(`${conference} — pick a team…`)
      .addOptions(
        list.slice(0, 25).map(t =>
          new StringSelectMenuOptionBuilder()
            .setLabel(t.fullName)
            .setDescription(t.isHuman ? "👤 Human" : "🤖 CPU")
            .setValue(String(t.mcaTeamId)),
        ),
      );

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (afcTeams.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeMenu("AFC", afcTeams)));
  if (nfcTeams.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeMenu("NFC", nfcTeams)));
  components.push(cancelRow() as any);

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("👥 View Any Roster")
      .setDescription("Select a team from the **AFC** or **NFC** dropdown below to view their full roster.")
      .setFooter({ text: `${teams.length} teams loaded — 👤 Human · 🤖 CPU` })],
    components,
  });
}

async function handleAnyRosterShow(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  // Value is MCA teamId (integer) — NOT the serial PK
  const mcaTeamId = Number(interaction.values[0]);
  const gid       = interaction.guildId!;
  const seasonId  = await getRosterSeasonId(gid);

  const teamRow = (await db.select({ fullName: franchiseMcaTeamsTable.fullName })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, seasonId), eq(franchiseMcaTeamsTable.teamId, mcaTeamId)))
    .limit(1))[0];
  const teamName = teamRow?.fullName ?? "Unknown Team";

  const embed = new EmbedBuilder();
  await buildRosterEmbed(gid, seasonId, mcaTeamId, teamName, embed);

  const rosterNav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_anyroster").setLabel("← Back to Teams").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("🏠 Hub").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({ embeds: [embed], components: [rosterNav] });
}

// ── Free Agents ───────────────────────────────────────────────────────────────

const FREE_AGENT_POSITIONS = ["QB", "HB", "FB", "WR", "TE", "LT", "LG", "C", "RG", "RT", "DT", "LEDGE", "REDGE", "MIKE", "WILL", "SAM", "CB", "FS", "SS", "K", "P", "LS"];

async function handleFreeAgentsPosPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_fa_pos")
    .setPlaceholder("Select a position…")
    .addOptions(
      FREE_AGENT_POSITIONS.map(p =>
        new StringSelectMenuOptionBuilder().setLabel(p).setValue(p),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("🆓 Free Agents — Select Position").setDescription("Choose a position to view available free agents.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleFreeAgentsShow(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const position = interaction.values[0]!;
  const gid      = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);

  // FA = players with teamId sentinel 999 (Madden free agent pool)
  const FA_TEAM_ID = 999;
  const faRows = await db.select({
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    overall:   franchiseRostersTable.overall,
    devTrait:  franchiseRostersTable.devTrait,
    age:       franchiseRostersTable.age,
    contractYearsLeft: franchiseRostersTable.contractYearsLeft,
  }).from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, seasonId),
      eq(franchiseRostersTable.teamId, FA_TEAM_ID),
      sql`upper(${franchiseRostersTable.position}) = upper(${position})`,
    ))
    .orderBy(desc(franchiseRostersTable.overall))
    .limit(30);

  if (!faRows.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle(`🆓 Free Agents — ${position}`).setDescription(`No free agents found at **${position}** this season.\n\nMake sure MCA data includes free agent information.`)], components: [backToHubRow()] });
    return;
  }

  const lines = faRows.map((p, i) =>
    `**${i + 1}.** ${p.firstName} ${p.lastName} — OVR ${p.overall}${p.age != null ? ` | Age ${p.age}` : ""}${devBadge(p.devTrait ?? 0)}`
  );

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`🆓 Free Agents — ${position}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Showing top ${faRows.length} by OVR • ${DEV_LEGEND}` })
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [backToHubRow()] });
}

// ── Player Stats — 4-step chain ────────────────────────────────────────────────

async function handlePlayerStatsStart(interaction: ButtonInteraction, sess: ActionsSession) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_ps_conf:AFC").setLabel("🔴 AFC Teams").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ac_ps_conf:NFC").setLabel("🔵 NFC Teams").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("📊 Player Stats & Ratings")
      .setDescription("Select a conference, then pick a team → position group → player to view their full player card.")],
    components: [row],
  });
}

async function handlePsTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid  = interaction.guildId!;
  const conf = interaction.customId.split(":")[1] as "AFC" | "NFC";
  await interaction.deferUpdate();

  const season = await getOrCreateActiveSeason(gid);
  const allTeams = await db.select({
    mcaTeamId:  franchiseMcaTeamsTable.teamId,
    fullName:   franchiseMcaTeamsTable.fullName,
    nickName:   franchiseMcaTeamsTable.nickName,
    conference: franchiseMcaTeamsTable.conference,
  })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id))
    .orderBy(franchiseMcaTeamsTable.fullName);

  // Filter to the requested conference; fall back to NFL_DIVISION_MAP if conference is null
  const teams = allTeams.filter(t => {
    const c = t.conference?.toUpperCase();
    if (c === conf) return true;
    if (c === (conf === "AFC" ? "NFC" : "AFC")) return false;
    return NFL_DIVISION_MAP[t.nickName ?? ""]?.conference === conf;
  });

  if (!teams.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ No ${conf} teams found. Make sure rosters have been imported.`)], components: [backToHubRow()] });
    return;
  }

  // Use MCA teamId as value — needed for roster queries downstream
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_ps_team_sel")
    .setPlaceholder(`Select a ${conf} team…`)
    .addOptions(teams.slice(0, 25).map(t =>
      new StringSelectMenuOptionBuilder().setLabel(t.fullName).setValue(String(t.mcaTeamId)),
    ));

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(conf === "AFC" ? Colors.Red : Colors.Blue).setTitle(`📊 Player Stats — ${conf} Teams`)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ac_playerstats").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

// Position group definitions
const PS_POS_GROUPS: { value: string; label: string; positions: string[] }[] = [
  { value: "QB",  label: "🏈 Quarterback (QB)",          positions: ["QB"] },
  { value: "HB",  label: "🏃 Running Back (HB/RB/FB)",   positions: ["HB", "RB", "FB"] },
  { value: "WR",  label: "🙌 Wide Receiver (WR)",         positions: ["WR"] },
  { value: "TE",  label: "📦 Tight End (TE)",             positions: ["TE"] },
  { value: "OL",  label: "🛡️ Offensive Line (OL)",        positions: ["LT", "LG", "C", "RG", "RT"] },
  { value: "DL",  label: "🔴 Defensive Line (DL)",        positions: ["LE", "RE", "DT", "NT"] },
  { value: "LB",  label: "🔵 Linebacker (LB)",            positions: ["LOLB", "MLB", "ROLB", "ILB", "OLB"] },
  { value: "CB",  label: "🔒 Cornerback (CB)",            positions: ["CB"] },
  { value: "S",   label: "🛡️ Safety (FS/SS)",             positions: ["FS", "SS"] },
  { value: "K",   label: "🦵 Specialist (K/P)",           positions: ["K", "P", "KR", "PR"] },
];

async function handlePsPosPick(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  // Value is MCA teamId (not serial PK)
  const teamId = interaction.values[0]!;
  await interaction.deferUpdate();

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const [teamRow] = await db.select({ fullName: franchiseMcaTeamsTable.fullName })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, Number(teamId))))
    .limit(1);
  const teamName = teamRow?.fullName ?? "Unknown Team";

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ac_ps_pos_sel:${teamId}`)
    .setPlaceholder("Select a position group…")
    .addOptions(PS_POS_GROUPS.map(g =>
      new StringSelectMenuOptionBuilder().setLabel(g.label).setValue(g.value),
    ));

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📊 Player Stats — ${teamName}`).setDescription("Choose a position group to browse players.")],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ac_playerstats").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function handlePsPlayerPick(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const parts   = interaction.customId.split(":");
  const teamId  = Number(parts[1]);
  const posGroup = interaction.values[0]!;
  await interaction.deferUpdate();

  const group = PS_POS_GROUPS.find(g => g.value === posGroup)!;
  if (!group) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Unknown position group.")], components: [backToHubRow()] });
    return;
  }

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const players = await db.select({
    id: franchiseRostersTable.playerId,
    firstName: franchiseRostersTable.firstName,
    lastName:  franchiseRostersTable.lastName,
    position:  franchiseRostersTable.position,
    overall:   franchiseRostersTable.overall,
  })
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, season.id),
      eq(franchiseRostersTable.teamId, teamId),
      inArray(franchiseRostersTable.position, group.positions),
    ))
    .orderBy(desc(franchiseRostersTable.overall));

  if (!players.length) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Grey).setDescription(`No ${group.label} players found on this team.`)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ac_playerstats").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ac_ps_player_sel:${teamId}:${posGroup}`)
    .setPlaceholder(`Select a player (${group.label})…`)
    .addOptions(players.slice(0, 25).map(p =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${p.firstName} ${p.lastName} (${p.position}) — OVR ${p.overall}`)
        .setValue(String(p.id)),
    ));

  // teamId is MCA teamId — look up by teamId column, not serial PK
  const [teamRow] = await db.select({ fullName: franchiseMcaTeamsTable.fullName })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)))
    .limit(1);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📊 ${teamRow?.fullName ?? "Team"} — ${group.label}`)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ac_playerstats").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

const DEV_TRAIT_LABELS: Record<number, string> = { 0: "Normal", 1: "Impact", 2: "Star", 3: "Superstar", 4: "⚡ X-Factor" };

const PS_KEY_ATTRS: Record<string, { key: string; label: string }[]> = {
  QB: [
    { key: "throwPowerRating",         label: "THP" },
    { key: "throwAccuracyShortRating", label: "SAC" },
    { key: "throwAccuracyMidRating",   label: "MAC" },
    { key: "throwAccuracyDeepRating",  label: "DAC" },
    { key: "throwOnRunRating",         label: "TOR" },
    { key: "awareRating",              label: "AWR" },
    { key: "speedRating",              label: "SPD" },
    { key: "breakSackRating",          label: "BSK" },
  ],
  HB: [
    { key: "speedRating",          label: "SPD" },
    { key: "accelerationRating",   label: "ACC" },
    { key: "agilityRating",        label: "AGI" },
    { key: "elusivenessRating",    label: "ELU" },
    { key: "breakTackleRating",    label: "BTK" },
    { key: "caryingRating",        label: "CAR" },
    { key: "catchRating",          label: "CTH" },
    { key: "bCVisionRating",       label: "BCV" },
  ],
  WR: [
    { key: "speedRating",              label: "SPD" },
    { key: "agilityRating",            label: "AGI" },
    { key: "catchRating",              label: "CTH" },
    { key: "catchInTrafficRating",     label: "CIT" },
    { key: "shortRouteRunRating",      label: "SRR" },
    { key: "medRouteRunRating",        label: "MRR" },
    { key: "deepRouteRunRating",       label: "DRR" },
    { key: "spectacularCatchRating",   label: "SPC" },
  ],
  TE: [
    { key: "speedRating",          label: "SPD" },
    { key: "catchRating",          label: "CTH" },
    { key: "catchInTrafficRating", label: "CIT" },
    { key: "shortRouteRunRating",  label: "SRR" },
    { key: "passBlockRating",      label: "PBK" },
    { key: "runBlockRating",       label: "RBK" },
    { key: "strengthRating",       label: "STR" },
    { key: "releaseRating",        label: "RLS" },
  ],
  OL: [
    { key: "passBlockRating",    label: "PBK" },
    { key: "runBlockRating",     label: "RBK" },
    { key: "impactBlockRating",  label: "IBL" },
    { key: "strengthRating",     label: "STR" },
    { key: "awareRating",        label: "AWR" },
  ],
  DL: [
    { key: "speedRating",        label: "SPD" },
    { key: "strengthRating",     label: "STR" },
    { key: "powerMovesRating",   label: "PMV" },
    { key: "finessMovesRating",  label: "FMV" },
    { key: "blockShedRating",    label: "BSH" },
    { key: "awareRating",        label: "AWR" },
  ],
  LB: [
    { key: "speedRating",      label: "SPD" },
    { key: "strengthRating",   label: "STR" },
    { key: "tackleRating",     label: "TAK" },
    { key: "hitPowerRating",   label: "HPW" },
    { key: "zoneCoverRating",  label: "ZCV" },
    { key: "manCoverRating",   label: "MCV" },
    { key: "playRecRating",    label: "PRC" },
  ],
  CB: [
    { key: "speedRating",      label: "SPD" },
    { key: "agilityRating",    label: "AGI" },
    { key: "manCoverRating",   label: "MCV" },
    { key: "zoneCoverRating",  label: "ZCV" },
    { key: "pressRating",      label: "PRS" },
    { key: "catchRating",      label: "CTH" },
    { key: "playRecRating",    label: "PRC" },
  ],
  S: [
    { key: "speedRating",      label: "SPD" },
    { key: "agilityRating",    label: "AGI" },
    { key: "zoneCoverRating",  label: "ZCV" },
    { key: "manCoverRating",   label: "MCV" },
    { key: "tackleRating",     label: "TAK" },
    { key: "hitPowerRating",   label: "HPW" },
    { key: "playRecRating",    label: "PRC" },
  ],
  K: [
    { key: "kickPowerRating",    label: "KPW" },
    { key: "kickAccuracyRating", label: "KAC" },
    { key: "speedRating",        label: "SPD" },
  ],
};

async function handlePsPlayerCard(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const parts    = interaction.customId.split(":");
  const teamId   = Number(parts[1]);
  const posGroup = parts[2]!;
  const playerId = Number(interaction.values[0]);
  await interaction.deferUpdate();

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  const [roster, stats] = await Promise.all([
    db.select().from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, season.id),
        eq(franchiseRostersTable.teamId, teamId),
        eq(franchiseRostersTable.playerId, playerId),
      )).limit(1).then(r => r[0]),
    db.select().from(playerSeasonStatsTable)
      .where(and(
        eq(playerSeasonStatsTable.seasonId, season.id),
        eq(playerSeasonStatsTable.playerId, playerId),
      )).limit(1).then(r => r[0]),
  ]);

  if (!roster) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Player not found.")], components: [backToHubRow()] });
    return;
  }

  const devLabel  = DEV_TRAIT_LABELS[roster.devTrait] ?? `Dev ${roster.devTrait}`;
  const contract  = roster.contractYearsLeft == null ? "Unknown" : roster.contractYearsLeft <= 1 ? "📋 Contract Year (Final Season)" : `${roster.contractYearsLeft} years remaining`;
  const archetype = roster.archetypeAbbrev ? `${roster.archetypeAbbrev.replace(/_/g, " ")}` : "—";
  const abilities = roster.abilities as { zone?: string; superstar?: string[] } | null;
  const attrs     = (roster.attributes ?? {}) as Record<string, number>;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`📊 ${roster.firstName} ${roster.lastName} — #${roster.jerseyNum ?? "?"} ${roster.position}`)
    .setDescription(
      `**Team:** ${roster.teamName}  |  **OVR:** ${roster.overall}  |  **Age:** ${roster.age ?? "?"}\n` +
      `**Dev Trait:** ${devLabel}  |  **Archetype:** ${archetype}\n` +
      `**Contract:** ${contract}`,
    );

  // Key attributes for this position group
  const keyAttrs = PS_KEY_ATTRS[posGroup] ?? PS_KEY_ATTRS["QB"]!;
  const attrLines = keyAttrs
    .map(a => {
      const val = attrs[a.key];
      return val != null ? `**${a.label}:** ${val}` : null;
    })
    .filter(Boolean) as string[];

  if (attrLines.length) {
    const mid = Math.ceil(attrLines.length / 2);
    embed.addFields(
      { name: "📈 Key Ratings", value: attrLines.slice(0, mid).join("\n"), inline: true },
      { name: "\u200B",         value: attrLines.slice(mid).join("\n"),    inline: true },
    );
  }

  // Abilities
  if (abilities) {
    const lines: string[] = [];
    if (abilities.superstar) lines.push(...abilities.superstar.map(a => `⭐ ${a}`));
    if (abilities.zone)      lines.push(`⚡ ${abilities.zone} (Zone)`);
    if (lines.length) embed.addFields({ name: "💥 Abilities", value: lines.join("\n"), inline: false });
  }

  // Season Stats — position-appropriate
  if (stats) {
    const pos = roster.position;
    const isQB  = pos === "QB";
    const isHB  = ["HB","RB","FB"].includes(pos);
    const isWR  = ["WR","TE"].includes(pos);
    const isDEF = ["LE","RE","DT","NT","LOLB","MLB","ROLB","ILB","OLB","CB","FS","SS"].includes(pos);
    const isK   = ["K","P"].includes(pos);

    if (isQB && stats.passAtt > 0) {
      const pct = stats.passAtt > 0 ? ((stats.passComp / stats.passAtt) * 100).toFixed(1) : "0.0";
      embed.addFields({ name: "🏈 Season Passing Stats", value: `Yds: **${stats.passYds.toLocaleString()}** | TDs: **${stats.passTDs}** | INTs: **${stats.passInts}**\nComp: ${stats.passComp}/${stats.passAtt} (${pct}%) | Sacked: ${stats.timesSacked}\nRush Yds: ${stats.rushYds} | Rush TDs: ${stats.rushTDs}`, inline: false });
    } else if (isHB && (stats.rushAtt > 0 || stats.recRec > 0)) {
      embed.addFields({ name: "🏃 Season Rushing Stats", value: `Rush Yds: **${stats.rushYds.toLocaleString()}** | TDs: **${stats.rushTDs}** | Att: ${stats.rushAtt}\nFumbles: ${stats.fumbles}\nRec: ${stats.recRec} | Rec Yds: ${stats.recYds} | Rec TDs: ${stats.recTDs}`, inline: false });
    } else if (isWR && stats.recRec > 0) {
      embed.addFields({ name: "🙌 Season Receiving Stats", value: `Rec: **${stats.recRec}** | Yds: **${stats.recYds.toLocaleString()}** | TDs: **${stats.recTDs}**`, inline: false });
    } else if (isDEF && (stats.totalTackles > 0 || stats.sacks > 0 || stats.defInts > 0)) {
      embed.addFields({ name: "🛡️ Season Defense Stats", value: `Tackles: **${stats.totalTackles}** (${stats.tackleSolo} solo / ${stats.tackleAssist} ast)\nSacks: **${stats.sacks}** | INTs: **${stats.defInts}** | FF: ${stats.forcedFumbles}\nTFLs: ${stats.tacklesForLoss} | Def TDs: ${stats.defTDs}`, inline: false });
    } else if (isK) {
      if (stats.fgAtt > 0) embed.addFields({ name: "🦵 Season Kicking Stats", value: `FG: ${stats.fgMade}/${stats.fgAtt} | Long: ${stats.fgLong} yds | XP: ${stats.xpMade}/${stats.xpAtt}`, inline: false });
      if (stats.puntAtt > 0) embed.addFields({ name: "💨 Season Punting Stats", value: `Punts: ${stats.puntAtt} | Yds: ${stats.puntYds.toLocaleString()} | Long: ${stats.puntLong} | In-20: ${stats.puntIn20}`, inline: false });
    } else if (!isQB && !isHB && !isWR && !isDEF && !isK) {
      // fallback — rush if any
      if (stats.rushAtt > 0) embed.addFields({ name: "🏃 Rush", value: `${stats.rushYds} yds / ${stats.rushTDs} TDs`, inline: true });
    }
    if (!isK && !isQB && !isHB && !isWR && !isDEF && stats.recRec > 0) {
      embed.addFields({ name: "🙌 Receiving", value: `${stats.recRec} rec / ${stats.recYds} yds / ${stats.recTDs} TDs`, inline: true });
    }
  } else {
    embed.addFields({ name: "📊 Season Stats", value: "*No stats recorded yet this season.*", inline: false });
  }

  embed.setTimestamp().setFooter({ text: `Season ${season.seasonNumber} · Player ID ${playerId}` });

  await interaction.editReply({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_playerstats").setLabel("← Back to Teams").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_hub").setLabel("🏠 Hub").setStyle(ButtonStyle.Secondary),
    )],
  });
}

// ── Team Stats ────────────────────────────────────────────────────────────────

async function handleTeamStatsTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid      = interaction.guildId!;
  const season   = await getOrCreateActiveSeason(gid);
  const allTeams = await db.select({
    mcaTeamId:  franchiseMcaTeamsTable.teamId,
    fullName:   franchiseMcaTeamsTable.fullName,
    nickName:   franchiseMcaTeamsTable.nickName,
    conference: franchiseMcaTeamsTable.conference,
    isHuman:    franchiseMcaTeamsTable.isHuman,
  })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.isHuman, true)))
    .orderBy(franchiseMcaTeamsTable.fullName);

  if (!allTeams.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No teams found.")], components: [backToHubRow()] });
    return;
  }

  // Split by conference; fall back to NFL_DIVISION_MAP if conference field is null
  const afcTeams = allTeams.filter(t => {
    const c = t.conference?.toUpperCase();
    if (c === "AFC") return true;
    if (c === "NFC") return false;
    return NFL_DIVISION_MAP[t.nickName ?? ""]?.conference === "AFC";
  });
  const nfcTeams = allTeams.filter(t => {
    const c = t.conference?.toUpperCase();
    if (c === "NFC") return true;
    if (c === "AFC") return false;
    return NFL_DIVISION_MAP[t.nickName ?? ""]?.conference === "NFC";
  });

  // Use MCA teamId as value — teamSeasonStatsTable.teamId stores MCA ids
  const makeMenu = (conf: string, list: typeof allTeams) =>
    new StringSelectMenuBuilder()
      .setCustomId("ac_teamstats_sel")
      .setPlaceholder(`${conf} — pick a team…`)
      .addOptions(list.slice(0, 25).map(t =>
        new StringSelectMenuOptionBuilder().setLabel(t.fullName).setValue(String(t.mcaTeamId)),
      ));

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (afcTeams.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeMenu("🔴 AFC", afcTeams)));
  if (nfcTeams.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(makeMenu("🔵 NFC", nfcTeams)));
  components.push(cancelRow() as any);

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🏟️ Team Stats — Select Team").setDescription("Pick a team from the **AFC** or **NFC** dropdown.")],
    components,
  });
}

async function handleTeamStatsShow(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  // Value is MCA teamId (not serial PK)
  const mcaTeamId = Number(interaction.values[0]);
  const gid       = interaction.guildId!;
  const season    = await getOrCreateActiveSeason(gid);

  const [teamRow, statsRow] = await Promise.all([
    db.select({ fullName: franchiseMcaTeamsTable.fullName })
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, mcaTeamId)))
      .limit(1).then(r => r[0]),
    db.select().from(teamSeasonStatsTable)
      .where(and(eq(teamSeasonStatsTable.seasonId, season.id), eq(teamSeasonStatsTable.teamId, mcaTeamId)))
      .limit(1).then(r => r[0]),
  ]);

  const teamName = teamRow?.fullName ?? "Unknown Team";

  if (!statsRow) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle(`🏟️ ${teamName} — Team Stats`).setDescription("No team stats found yet this season. Import MCA data to populate.")], components: [backToHubRow()] });
    return;
  }

  const ppg = statsRow.offPtsPerGame > 0 ? statsRow.offPtsPerGame.toFixed(1) : "N/A";
  const offPct = statsRow.offRedZonePct > 0 ? `${statsRow.offRedZonePct.toFixed(1)}%` : "N/A";
  const defPct = statsRow.defRedZonePct > 0 ? `${statsRow.defRedZonePct.toFixed(1)}%` : "N/A";

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`🏟️ ${teamName} — Season ${season.seasonNumber} Stats`)
    .setDescription(`**Record: ${statsRow.wins}W-${statsRow.losses}L**`)
    .addFields(
      { name: "📤 Offense",       value: `Pass: ${statsRow.offPassYds.toLocaleString()} yds\nRush: ${statsRow.offRushYds.toLocaleString()} yds\nTotal: ${statsRow.offYds.toLocaleString()} yds\nPts/Game: ${ppg}\nRed Zone%: ${offPct}`, inline: true },
      { name: "📥 Defense",       value: `Pass Yds Allowed: ${statsRow.defPassYds.toLocaleString()}\nRush Yds Allowed: ${statsRow.defRushYds.toLocaleString()}\nSacks: ${statsRow.teamSacks}\nINTs: ${statsRow.teamInts}\nRZ% Allowed: ${defPct}`, inline: true },
      { name: "🔄 Turnovers",     value: `Turnover Diff: **${statsRow.turnoverDiff >= 0 ? "+" : ""}${statsRow.turnoverDiff}**\nFumbles Rec: ${statsRow.defFumblesRec}`, inline: true },
    )
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [backToHubRow()] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROW 3 — League Info
// ═══════════════════════════════════════════════════════════════════════════════

async function handleStandingsConfPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_standings_conf:AFC").setLabel("🔴 AFC").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ac_standings_conf:NFC").setLabel("🔵 NFC").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_standings_conf:ALL").setLabel("🌐 Both").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("📈 Standings — Select Conference")],
    components: [row],
  });
}

async function handleStandingsShow(interaction: ButtonInteraction, sess: ActionsSession) {
  const conf = interaction.customId.split(":")[1] as "AFC" | "NFC" | "ALL";
  const gid  = interaction.guildId!;
  await interaction.deferUpdate();

  const season       = await getOrCreateActiveSeason(gid);
  const allStandings = await getArticleStandings(season.id, 18);

  if (conf === "ALL") {
    const afc = allStandings.filter(t => t.conference === "AFC");
    const nfc = allStandings.filter(t => t.conference === "NFC");
    if (!afc.length && !nfc.length) {
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("League Standings").setDescription("No game data yet.")], components: [backToHubRow()] });
      return;
    }
    const embeds: EmbedBuilder[] = [];
    const buildConf = (conference: "AFC" | "NFC", teams: typeof allStandings) => {
      const sorted = [...teams].sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
      const lines  = sorted.map((t, i) => `**${i + 1}.** ${t.teamName} — ${t.wins}W-${t.losses}L (${t.pointDifferential >= 0 ? "+" : ""}${t.pointDifferential} pts)`);
      return new EmbedBuilder()
        .setColor(conference === "AFC" ? Colors.Red : Colors.Blue)
        .setTitle(`🏈 ${conference} Standings — Season ${season.seasonNumber}`)
        .setDescription(lines.join("\n") || "No data");
    };
    if (afc.length) embeds.push(buildConf("AFC", afc));
    if (nfc.length) embeds.push(buildConf("NFC", nfc));
    await interaction.editReply({ embeds, components: [backToHubRow()] });
    return;
  }

  const confTeams = allStandings.filter(t => t.conference === conf);
  if (!confTeams.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle(`${conf} Standings`).setDescription("No data yet.")], components: [backToHubRow()] });
    return;
  }

  const sorted = [...confTeams].sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
  const lines  = sorted.map((t, i) => `**${i + 1}.** ${t.teamName} — ${t.wins}W-${t.losses}L (${t.pointDifferential >= 0 ? "+" : ""}${t.pointDifferential} pts)`);

  const embed = new EmbedBuilder()
    .setColor(conf === "AFC" ? Colors.Red : Colors.Blue)
    .setTitle(`🏈 ${conf} Standings — Season ${season.seasonNumber}`)
    .setDescription(lines.join("\n"))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleInTheHunt(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const season       = await getOrCreateActiveSeason(gid);
  const allStandings = await getArticleStandings(season.id, 18);

  if (!allStandings.length) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("🎯 In The Hunt").setDescription("No standings data yet.")],
      components: [backToHubRow()],
    });
    return;
  }

  const DIVISIONS = ["East", "North", "South", "West"] as const;

  const embeds: EmbedBuilder[] = [];

  for (const conf of ["AFC", "NFC"] as const) {
    const confTeams = allStandings.filter(t => t.conference === conf);
    if (!confTeams.length) continue;

    // Division leaders
    const divWinners = new Set<string>();
    for (const div of DIVISIONS) {
      const leader = confTeams
        .filter(t => t.division === div)
        .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential)[0];
      if (leader) divWinners.add(leader.teamName);
    }

    const sortedWinners   = confTeams.filter(t =>  divWinners.has(t.teamName)).sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
    const sortedWildCards = confTeams.filter(t => !divWinners.has(t.teamName)).sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
    const seeds = [...sortedWinners, ...sortedWildCards];

    const wildCardSeeds = seeds.slice(4, 7);  // seeds 5-7
    const bubbleTeams   = seeds.slice(7, 10); // seeds 8-10
    const cutline       = wildCardSeeds[2];   // last team "in"

    const lines: string[] = [];

    lines.push("**Division Leaders (Seeds 1-4):**");
    sortedWinners.forEach((t, i) => {
      lines.push(`**#${i + 1}** ${t.teamName} — ${t.wins}-${t.losses}`);
    });

    if (wildCardSeeds.length) {
      lines.push("");
      lines.push("**🎯 Wild Card Race (Seeds 5-7):**");
      wildCardSeeds.forEach((t, i) => {
        const pd = t.pointDifferential >= 0 ? `+${t.pointDifferential}` : `${t.pointDifferential}`;
        lines.push(`✅ **#${i + 5}** ${t.teamName} — ${t.wins}-${t.losses} | PD ${pd} *(IN)*`);
      });
    }

    if (bubbleTeams.length && cutline) {
      lines.push("");
      lines.push("**⚠️ On The Bubble:**");
      bubbleTeams.forEach(t => {
        const gb = cutline.wins - t.wins;
        const pd = t.pointDifferential >= 0 ? `+${t.pointDifferential}` : `${t.pointDifferential}`;
        lines.push(`• ${t.teamName} — ${t.wins}-${t.losses} | PD ${pd} *(${gb} win${gb !== 1 ? "s" : ""} back)*`);
      });
    } else if (!wildCardSeeds.length) {
      lines.push("\n*Not enough teams to determine wild card race.*");
    }

    embeds.push(
      new EmbedBuilder()
        .setColor(conf === "AFC" ? Colors.Blue : Colors.Red)
        .setTitle(`🎯 ${conf} Playoff Hunt — Season ${season.seasonNumber}`)
        .setDescription(lines.join("\n"))
        .setTimestamp(),
    );
  }

  if (!embeds.length) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("🎯 In The Hunt").setDescription("No conference data available.")],
      components: [backToHubRow()],
    });
    return;
  }

  await interaction.editReply({ embeds, components: [backToHubRow()] });
}

async function handleTeamsToWatch(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid  = interaction.guildId!;
  await interaction.deferUpdate();

  const season       = await getOrCreateActiveSeason(gid);
  const allStandings = await getArticleStandings(season.id, 18);

  if (!allStandings.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("👀 Teams to Watch").setDescription("No standings data yet.")], components: [backToHubRow()] });
    return;
  }

  // Hot teams: most wins, best point differential among top-4 per conf
  const sorted = [...allStandings].sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
  const hot    = sorted.slice(0, 4);
  const cold   = [...sorted].sort((a, b) => a.wins - b.wins || a.pointDifferential - b.pointDifferential).slice(0, 4);

  const hotLines  = hot.map((t, i)  => `**${i + 1}.** ${t.teamName} (${t.conference}) — ${t.wins}W-${t.losses}L | ${t.pointDifferential >= 0 ? "+" : ""}${t.pointDifferential} pts`);
  const coldLines = cold.map((t, i) => `**${i + 1}.** ${t.teamName} (${t.conference}) — ${t.wins}W-${t.losses}L | ${t.pointDifferential >= 0 ? "+" : ""}${t.pointDifferential} pts`);

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle(`👀 Teams to Watch — Season ${season.seasonNumber}`)
    .addFields(
      { name: "🔥 Best Performing",      value: hotLines.join("\n")  || "N/A", inline: false },
      { name: "❄️ Struggling Teams",     value: coldLines.join("\n") || "N/A", inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleAnyUserStatsTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("👤 Any User Stats — Pick Conference")],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ac_anyus_conf:AFC").setLabel("🔵 AFC").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ac_anyus_conf:NFC").setLabel("🔴 NFC").setStyle(ButtonStyle.Danger),
      ),
      cancelRow(),
    ],
  });
}

async function handleAnyUserStatsConfPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const conf = interaction.customId.split(":")[1] as "AFC" | "NFC";
  const gid  = interaction.guildId!;

  const allUsers = await db.select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(
      eq(usersTable.guildId, gid),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
    ))
    .orderBy(usersTable.team);

  const confUsers = allUsers.filter(u => {
    const teamKey = (u.team ?? "").replace(/^(.*\s)?/, "").trim(); // try nickname last word
    const fullKey = (u.team ?? "").trim();
    const info = NFL_DIVISION_MAP[fullKey] ?? NFL_DIVISION_MAP[teamKey];
    return info?.conference === conf;
  });

  if (!confUsers.length) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ No ${conf} users found.`)],
      components: [backToHubRow()],
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_anyus_sel")
    .setPlaceholder(`Select a ${conf} team owner…`)
    .addOptions(
      confUsers.slice(0, 25).map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${u.team ?? u.discordUsername}`)
          .setDescription(`@${u.discordUsername}`)
          .setValue(u.discordId),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`👤 Any User Stats — ${conf} Owners`)],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleAnyUserStatsShow(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const targetId = interaction.values[0]!;
  const gid      = interaction.guildId!;
  await interaction.deferUpdate();

  const [season, settings] = await Promise.all([
    getOrCreateActiveSeason(gid),
    getServerSettings(gid),
  ]);
  const rules = await getSeasonRules(season);

  const [targetUser, savingsRow, recordRow, seasonStatsRow, globalRecord, eaIds, lastTxns] = await Promise.all([
    db.select().from(usersTable).where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, gid))).limit(1).then(r => r[0]),
    db.select({ balance: userSavingsTable.balance }).from(userSavingsTable).where(eq(userSavingsTable.discordId, targetId)).limit(1).then(r => r[0]),
    db.select().from(userRecordsTable).where(and(eq(userRecordsTable.discordId, targetId), eq(userRecordsTable.seasonId, season.id))).limit(1).then(r => r[0]),
    getSeasonStats(targetId, season.id),
    db.select({ wins: globalUserRecordsTable.wins, losses: globalUserRecordsTable.losses })
      .from(globalUserRecordsTable).where(eq(globalUserRecordsTable.discordId, targetId)).limit(1).then(r => r[0]),
    db.select({ eaId: playerEaIdsTable.eaId, console: playerEaIdsTable.console, slot: playerEaIdsTable.slot })
      .from(playerEaIdsTable).where(eq(playerEaIdsTable.discordId, targetId)).orderBy(playerEaIdsTable.slot),
    db.select({ amount: coinTransactionsTable.amount, description: coinTransactionsTable.description, createdAt: coinTransactionsTable.createdAt })
      .from(coinTransactionsTable)
      .where(and(eq(coinTransactionsTable.discordId, targetId), eq(coinTransactionsTable.guildId, gid)))
      .orderBy(desc(coinTransactionsTable.createdAt)).limit(10),
  ]);

  if (!targetUser) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ User not found.")], components: [backToHubRow()] });
    return;
  }

  // Legends scoped to this guild via seasonId → seasonsTable.guildId join
  const legendRows = await db.select({ legendName: inventoryTable.legendName, legendCategory: inventoryTable.legendCategory })
    .from(inventoryTable)
    .innerJoin(seasonsTable, eq(inventoryTable.seasonId, seasonsTable.id))
    .where(and(
      eq(inventoryTable.itemType, "legend"),
      eq(seasonsTable.guildId, gid),
      eq(inventoryTable.discordId, targetId),
    ));

  // Custom players scoped to this guild via seasonId → seasonsTable.guildId join
  const customPlayerRows = await db.select({
    firstName: customPlayersTable.firstName, lastName: customPlayersTable.lastName,
    position: customPlayersTable.position, packageTier: customPlayersTable.packageTier,
  }).from(customPlayersTable)
    .innerJoin(seasonsTable, eq(customPlayersTable.seasonId, seasonsTable.id))
    .where(and(
      eq(customPlayersTable.discordId, targetId),
      eq(seasonsTable.guildId, gid),
      ne(customPlayersTable.status, "refunded"),
    ));

  const savings = savingsRow?.balance ?? 0;
  const total   = targetUser.balance + savings;
  const ssW     = recordRow?.wins          ?? 0;
  const ssL     = recordRow?.losses        ?? 0;
  const atW     = globalRecord?.wins       ?? 0;
  const atL     = globalRecord?.losses     ?? 0;
  const sbW     = recordRow?.superbowlWins ?? 0;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`👤 ${targetUser.team ?? targetUser.discordUsername} — User Stats`)
    .addFields(
      { name: "💰 Balance",       value: `Wallet: **${targetUser.balance.toLocaleString()}**\nSavings: **${savings.toLocaleString()}**\nTotal: **${total.toLocaleString()}**`, inline: true },
      { name: "📊 Season Record", value: `${ssW}W-${ssL}L`, inline: true },
      { name: "🏆 All-Time",      value: `${atW}W-${atL}L | ${sbW} SB${sbW !== 1 ? "s" : ""}`, inline: true },
    );

  if (eaIds.length) {
    embed.addFields({ name: "🎮 EA IDs", value: eaIds.map(e => `${e.console.toUpperCase()}: **${e.eaId}**`).join("\n"), inline: false });
  }

  if (seasonStatsRow) {
    const { coreAttrPurchased, nonCoreAttrPurchased, devUpsPurchased, ageResetsPurchased } = seasonStatsRow;
    const ecoOn   = settings.coinEconomy;
    const attrOn  = ecoOn && settings.attributeUpgradesEnabled;
    const devOn   = ecoOn && settings.devUpgradesEnabled;
    const ageOn   = ecoOn && settings.ageResetsEnabled;
    const coreFmt    = attrOn ? `${coreAttrPurchased ?? 0} (${rules.coreAttrCap})`       : `${coreAttrPurchased ?? 0} (n/a)`;
    const nonCoreFmt = attrOn ? `${nonCoreAttrPurchased ?? 0} (${rules.nonCoreAttrCap})` : `${nonCoreAttrPurchased ?? 0} (n/a)`;
    const devFmt     = devOn  ? `${devUpsPurchased ?? 0} (${rules.devUpsCap})`           : `${devUpsPurchased ?? 0} (n/a)`;
    const ageFmt     = ageOn  ? `${ageResetsPurchased ?? 0} (${rules.ageResetsCap})`     : `${ageResetsPurchased ?? 0} (n/a)`;
    embed.addFields({
      name: "🛒 This Season's Purchases",
      value: `Core: ${coreFmt} | Non-Core: ${nonCoreFmt} | Dev Ups: ${devFmt} | Age Resets: ${ageFmt}`,
      inline: false,
    });
  }

  const vaultLegends   = legendRows.filter(l => l.legendCategory === "permanent");
  const currentLegends = legendRows.filter(l => l.legendCategory !== "permanent");
  if (legendRows.length) {
    const parts: string[] = [];
    if (currentLegends.length) parts.push(`Season: ${currentLegends.map(l => l.legendName).join(", ")}`);
    if (vaultLegends.length)   parts.push(`Vault: ${vaultLegends.map(l => l.legendName).join(", ")}`);
    embed.addFields({ name: "🏅 Legends", value: parts.join("\n"), inline: false });
  }

  if (customPlayerRows.length) {
    embed.addFields({
      name: "⚡ Custom Players",
      value: customPlayerRows.map(p => `${p.firstName} ${p.lastName} (${p.position}) — ${p.packageTier}`).join("\n"),
      inline: false,
    });
  }

  if (lastTxns.length) {
    const txLines = lastTxns.map(t => {
      const sign = t.amount >= 0 ? "+" : "";
      const ts   = `<t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:d>`;
      return `${ts} **${sign}${t.amount.toLocaleString()}** — ${t.description}`;
    });
    embed.addFields({ name: "📋 Last 10 Transactions", value: txLines.join("\n"), inline: false });
  }

  embed.setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROW 4 — Rankings & Payouts
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSeasonPR(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const season = await getOrCreateActiveSeason(gid);
  const { records } = await getSeasonRecords(season.id);

  if (!records.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📊 Season ${season.seasonNumber} Power Rankings`).setDescription("No game records yet.")], components: [backToHubRow()] });
    return;
  }

  const ranked = records.map(r => ({
    ...r,
    gp: r.wins + r.losses,
    pr: calcPRScore(r.wins, r.losses, r.pointDifferential),
    label: r.team ?? r.discordUsername,
  })).sort((a, b) => b.pr - a.pr);

  const medals = ["🥇", "🥈", "🥉"];
  const lines  = ranked.map((r, i) => {
    const badge   = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct  = r.gp > 0 ? ((r.wins / r.gp) * 100).toFixed(1) : "0.0";
    const postseason = [
      r.playoffWins + r.playoffLosses > 0 ? `PO: ${r.playoffWins}W-${r.playoffLosses}L` : "",
      r.superbowlWins + r.superbowlLosses > 0 ? `🏆SB: ${r.superbowlWins}W-${r.superbowlLosses}L` : "",
    ].filter(Boolean).join(" | ");
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${fmtDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.pr.toFixed(1)}${postseason ? ` *(${postseason})*` : ""}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`📊 Season ${season.seasonNumber} Power Rankings`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleAllTimePR(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const { records } = await getAllTimeRecords();

  // Load current guild roster: discordId → team (null if not on a team)
  const guildUsers = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  }).from(usersTable).where(eq(usersTable.guildId, gid));

  const guildIds    = new Set(guildUsers.map(u => u.discordId));
  const guildTeamMap = new Map(guildUsers.map(u => [u.discordId, u.team ?? null]));

  const filtered = records.filter(r => guildIds.has(r.discordId));

  if (!filtered.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🏆 All-Time Power Rankings").setDescription("No all-time records yet.")], components: [backToHubRow()] });
    return;
  }

  const ranked = filtered.map(r => {
    const currentTeam = guildTeamMap.get(r.discordId);
    let teamSuffix: string;
    if (currentTeam && currentTeam.trim() !== "") {
      teamSuffix = ` (${currentTeam})`;
    } else if (r.team && r.team.trim() !== "") {
      teamSuffix = ` (PREV "${r.team}")`;
    } else {
      teamSuffix = "";
    }
    return {
      ...r,
      gp:    r.wins + r.losses,
      pr:    calcPRScore(r.wins, r.losses, r.pointDifferential),
      label: `${r.discordUsername}${teamSuffix}`,
    };
  }).sort((a, b) => b.pr - a.pr);

  const medals = ["🥇", "🥈", "🥉"];
  const lines  = ranked.map((r, i) => {
    const badge   = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct  = r.gp > 0 ? ((r.wins / r.gp) * 100).toFixed(1) : "0.0";
    const postseason = [
      r.playoffWins + r.playoffLosses > 0 ? `PO: ${r.playoffWins}W-${r.playoffLosses}L` : "",
      r.superbowlWins + r.superbowlLosses > 0 ? `🏆SB: ${r.superbowlWins}W-${r.superbowlLosses}L` : "",
    ].filter(Boolean).join(" | ");
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${fmtDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.pr.toFixed(1)}${postseason ? ` *(${postseason})*` : ""}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle("🏆 All-Time Power Rankings")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleGlobalPR(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  // Step 1: fetch guild members only (for the display list)
  const guildUsers = await db.select({
    discordId:       usersTable.discordId,
    team:            usersTable.team,
    discordUsername: usersTable.discordUsername,
    walletBalance:   usersTable.balance,
  }).from(usersTable)
    .where(and(
      eq(usersTable.guildId, gid),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
      ne(usersTable.discordUsername, "Open Slot"),
    ));

  if (!guildUsers.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🌐 Global Power Rankings").setDescription("No linked users found in this server.")], components: [backToHubRow()] });
    return;
  }

  // Step 2: fetch ALL global records (for accurate global rank)
  const allGlobalRecords = await db.select({
    discordId: globalUserRecordsTable.discordId,
    wins:      globalUserRecordsTable.wins,
    losses:    globalUserRecordsTable.losses,
    pointDiff: globalUserRecordsTable.pointDifferential,
  }).from(globalUserRecordsTable);

  // Step 3: rank ALL global records by PR score
  const globalRanked = allGlobalRecords
    .map(r => ({ discordId: r.discordId, pr: calcPRScore(r.wins ?? 0, r.losses ?? 0, r.pointDiff ?? 0), wins: r.wins ?? 0, losses: r.losses ?? 0, pd: r.pointDiff ?? 0 }))
    .sort((a, b) => b.pr - a.pr);

  const globalRankMap = new Map<string, { rank: number; wins: number; losses: number; pd: number; pr: number }>();
  globalRanked.forEach((r, i) => globalRankMap.set(r.discordId, { rank: i + 1, wins: r.wins, losses: r.losses, pd: r.pd, pr: r.pr }));

  // Step 4: fetch savings balances for guild users
  const guildIds = guildUsers.map(u => u.discordId);
  const savingsRows = guildIds.length
    ? await db.select({ discordId: userSavingsTable.discordId, balance: userSavingsTable.balance })
        .from(userSavingsTable)
        .where(inArray(userSavingsTable.discordId, guildIds))
    : [];
  const savingsMap = new Map(savingsRows.map(s => [s.discordId, s.balance]));

  // Step 5: build display rows for guild users (sorted by global rank)
  const displayRows = guildUsers
    .map(u => {
      const g = globalRankMap.get(u.discordId);
      return {
        discordId: u.discordId,
        username:  u.discordUsername ?? u.discordId,
        team:      u.team ?? "",
        globalRank: g?.rank ?? 99999,
        wins:       g?.wins ?? 0,
        losses:     g?.losses ?? 0,
        pd:         g?.pd ?? 0,
        pr:         g?.pr ?? 0,
        totalCoins: (u.walletBalance ?? 0) + (savingsMap.get(u.discordId) ?? 0),
      };
    })
    .sort((a, b) => a.globalRank - b.globalRank);

  const medals = ["🥇", "🥈", "🥉"];
  const lines = displayRows.map(r => {
    const gp      = r.wins + r.losses;
    const winPct  = gp > 0 ? ((r.wins / gp) * 100).toFixed(1) : "0.0";
    const rankBadge = medals[r.globalRank - 1] ?? `**#${r.globalRank}**`;
    const label   = r.team ? `${r.username} (${r.team})` : r.username;
    return `${rankBadge} ${label} — ${r.wins}W-${r.losses}L | ${fmtDiff(r.pd)} pts | ${winPct}% | PR: ${r.pr.toFixed(1)} | 🪙 ${r.totalCoins.toLocaleString()}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🌐 Global Power Rankings")
    .setDescription(lines.join("\n") || "No data")
    .setFooter({ text: `${displayRows.length} members shown • Global rank shown (#) • Coins = wallet + savings` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleEosPayouts(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const configMap = await getAllPayoutConfig(gid);
  const allKeys   = getAllPayoutKeys();

  const cats: Record<string, string[]> = {};
  for (const meta of allKeys) {
    const val = configMap.get(meta.key as any) ?? meta.defaultValue;
    const cat = meta.category ?? "General";
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(`${meta.description}: **${val.toLocaleString()}** coins`);
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("💰 Payout Tiers");

  for (const [cat, items] of Object.entries(cats)) {
    const chunk = items.join("\n");
    if (chunk) embed.addFields({ name: cat, value: chunk.slice(0, 1024), inline: false });
  }

  embed.setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleMilestonePayouts(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const tiers = await getMilestoneTiers(gid);

  if (!tiers.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("🎯 Milestone Payouts").setDescription("No milestone tiers configured yet. Ask a commissioner to set them up with `/admin-payout`.")], components: [backToHubRow()] });
    return;
  }

  const lines = tiers.map(t =>
    `**Tier ${t.tier}** — ${t.bonus.toLocaleString()} coins (Threshold: ${t.wins.toLocaleString()} wins)`
  );

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🎯 Milestone Payout Tiers")
    .setDescription(lines.join("\n"))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROW 5 — Requests
// ═══════════════════════════════════════════════════════════════════════════════

async function handleActiveTeams(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const users = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  }).from(usersTable)
    .where(and(
      eq(usersTable.guildId, gid),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
    ));

  // Build a map of team → discordId, excluding open slots and unlinked placeholders
  const activeMap = new Map<string, string>();
  for (const u of users) {
    if (!u.discordId.startsWith("unlinked_") && u.team) activeMap.set(u.team, u.discordId);
  }

  if (!activeMap.size) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("🟢 Active Teams").setDescription("No active teams found.")], components: [backToHubRow()] });
    return;
  }

  const CONF_EMOJI: Record<string, string> = { AFC: "🔴", NFC: "🔵" };
  const DIV_ORDER = ["East", "North", "South", "West"] as const;

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`🟢 Active Teams (${activeMap.size})`)
    .setTimestamp();

  for (const conf of ["AFC", "NFC"] as const) {
    for (const div of DIV_ORDER) {
      const divTeams = NFL_TEAMS.filter(t => NFL_DIVISION_MAP[t]?.conference === conf && NFL_DIVISION_MAP[t]?.division === div);
      const activeLines = divTeams
        .filter(t => activeMap.has(t))
        .map(t => `• **${t}** — <@${activeMap.get(t)!}>`);

      if (activeLines.length) {
        embed.addFields({ name: `${CONF_EMOJI[conf]} ${conf} ${div}`, value: activeLines.join("\n"), inline: true });
      }
    }
  }

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleOpenTeams(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const takenRows = await db.select({ team: usersTable.team, discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, gid), isNotNull(usersTable.team)));

  const taken = new Set(
    takenRows
      .filter(r => r.discordId && !r.discordId.startsWith("unlinked_"))
      .map(r => r.team as string),
  );

  const openTeams = NFL_TEAMS.filter(t => !taken.has(t));

  if (!openTeams.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("🔴 Open Teams").setDescription("All 32 teams are currently claimed!")], components: [backToHubRow()] });
    return;
  }

  const afcOpen = openTeams.filter(t => NFL_DIVISION_MAP[t]?.conference === "AFC").sort();
  const nfcOpen = openTeams.filter(t => NFL_DIVISION_MAP[t]?.conference === "NFC").sort();

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(`🔴 Open Teams (${openTeams.length} available)`)
    .setTimestamp();

  if (afcOpen.length) embed.addFields({ name: "🔴 AFC", value: afcOpen.map(t => `• ${t}`).join("\n"), inline: true });
  if (nfcOpen.length) embed.addFields({ name: "🔵 NFC", value: nfcOpen.map(t => `• ${t}`).join("\n"), inline: true });

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleAutoPilotModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ac_modal_autopilot")
    .setTitle("Request Auto-Pilot Coverage")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("weeks")
          .setLabel("How many weeks do you need coverage?")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 2")
          .setMaxLength(3),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Reason for Auto-Pilot request")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder("Briefly explain why you need auto-pilot coverage…"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("arrangement")
          .setLabel("Any arrangement details? (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(300)
          .setPlaceholder("e.g. Back by Week 8, sim-only, specific plays, etc."),
      ),
    );
  await interaction.showModal(modal);
}

async function handleAutoPilotSubmit(interaction: ModalSubmitInteraction, sess: ActionsSession) {
  const weeks       = interaction.fields.getTextInputValue("weeks").trim();
  const reason      = interaction.fields.getTextInputValue("reason").trim();
  const arrangement = interaction.fields.getTextInputValue("arrangement").trim();
  const gid         = interaction.guildId!;

  const weeksNum = parseInt(weeks, 10);
  if (isNaN(weeksNum) || weeksNum < 1) {
    await interaction.reply({ content: "❌ Invalid week count.", ephemeral: true }); return;
  }

  const [season, user] = await Promise.all([
    getOrCreateActiveSeason(gid),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
  ]);

  await db.insert(autoPilotRequestsTable).values({
    discordId:      interaction.user.id,
    guildId:        gid,
    teamName:       user.team ?? null,
    weeksRequested: weeksNum,
    reason:         arrangement ? `${reason}\n\nArrangement: ${arrangement}` : reason,
    status:         "pending",
  });

  // Notify commissioner log
  const logChannelId = await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
    ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER);

  if (logChannelId) {
    const channel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const requestEmbed = new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("✈️ Auto-Pilot Request")
        .setDescription(`**${user.team ?? interaction.user.username}** (<@${interaction.user.id}>) has requested auto-pilot coverage.`)
        .addFields(
          { name: "⏱️ Weeks", value: String(weeksNum), inline: true },
          { name: "📝 Reason", value: reason, inline: false },
        )
        .setTimestamp();
      if (arrangement) requestEmbed.addFields({ name: "📋 Arrangement", value: arrangement, inline: false });

      const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ac_ap_approve:${interaction.user.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ac_ap_deny:${interaction.user.id}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
      );

      await (channel as TextChannel).send({ embeds: [requestEmbed], components: [btnRow] }).catch(console.error);
    }
  }

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("⏳ Auto-Pilot Request Submitted")
      .setDescription(`Your auto-pilot request for **${weeksNum} week${weeksNum !== 1 ? "s" : ""}** has been sent to the commissioners.\n\n**Reason:** ${reason}`)],
  });
}

async function handleApproveAutoPilot(interaction: ButtonInteraction) {
  const targetId = interaction.customId.split(":")[1];
  const gid      = interaction.guildId!;

  await db.update(autoPilotRequestsTable)
    .set({ status: "approved", reviewedBy: interaction.user.id, reviewedAt: new Date() })
    .where(and(
      eq(autoPilotRequestsTable.discordId, targetId!),
      eq(autoPilotRequestsTable.guildId, gid),
      eq(autoPilotRequestsTable.status, "pending"),
    ));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Auto-Pilot Approved").setDescription(`Auto-pilot request for <@${targetId}> has been **approved** by <@${interaction.user.id}>.`)],
    components: [],
  });

  // DM the user
  const client = interaction.client;
  const dUser  = await client.users.fetch(targetId!).catch(() => null);
  if (dUser) {
    await dUser.send({ content: `✅ Your auto-pilot request has been **approved** by the commissioners. You're covered!` }).catch(() => {});
  }
}

async function handleDenyAutoPilot(interaction: ButtonInteraction) {
  const targetId = interaction.customId.split(":")[1];
  const gid      = interaction.guildId!;

  await db.update(autoPilotRequestsTable)
    .set({ status: "denied", reviewedBy: interaction.user.id, reviewedAt: new Date() })
    .where(and(
      eq(autoPilotRequestsTable.discordId, targetId!),
      eq(autoPilotRequestsTable.guildId, gid),
      eq(autoPilotRequestsTable.status, "pending"),
    ));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Auto-Pilot Denied").setDescription(`Auto-pilot request for <@${targetId}> has been **denied** by <@${interaction.user.id}>.`)],
    components: [],
  });

  const client = interaction.client;
  const dUser  = await client.users.fetch(targetId!).catch(() => null);
  if (dUser) {
    await dUser.send({ content: `❌ Your auto-pilot request has been **denied** by the commissioners. Please reach out if you have questions.` }).catch(() => {});
  }
}

// ── Rule Violation ─────────────────────────────────────────────────────────────

async function handleViolationModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ac_modal_violation")
    .setTitle("Report a Rule Violation")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("week_number")
          .setLabel("Week number this occurred")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4)
          .setPlaceholder("e.g. 5"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("violation_type")
          .setLabel("Type of violation")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder("e.g. Stat padding, Rage quit, Missed game, etc."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("offender")
          .setLabel("Offender — username or team name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Describe what happened")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(900)
          .setPlaceholder("Provide details, evidence links, context, etc."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("media_urls")
          .setLabel("Media URLs (optional, space or comma separated)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(500)
          .setPlaceholder("https://... (screenshots, clips, etc.)"),
      ),
    );
  await interaction.showModal(modal);
}

async function handleViolationSubmit(interaction: ModalSubmitInteraction, sess: ActionsSession) {
  const weekNumber    = interaction.fields.getTextInputValue("week_number").trim();
  const violationType = interaction.fields.getTextInputValue("violation_type").trim();
  const offender      = interaction.fields.getTextInputValue("offender").trim();
  const rawDesc       = interaction.fields.getTextInputValue("description").trim();
  const rawMedia      = interaction.fields.getTextInputValue("media_urls").trim();
  const description   = `[${violationType}] Against: ${offender}\n\n${rawDesc}`;
  const gid           = interaction.guildId!;

  // Parse media URLs (space or comma separated)
  const mediaUrls = rawMedia
    ? rawMedia.split(/[\s,]+/).map(u => u.trim()).filter(u => u.startsWith("http"))
    : [];

  const [season, user] = await Promise.all([
    getOrCreateActiveSeason(gid),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
  ]);

  // Insert and retrieve the new violation ID
  const [inserted] = await db.insert(ruleViolationsTable).values({
    reporterId:   interaction.user.id,
    guildId:      gid,
    seasonId:     season.id,
    reporterTeam: user.team ?? null,
    opponentTeam: offender,
    weekNumber,
    description,
    mediaUrls,
    status:       "pending",
  }).returning({ id: ruleViolationsTable.id });

  const violationId = inserted?.id ?? 0;

  // Send to commissioner log
  const logChannelId = await getGuildChannel(gid, CHANNEL_KEYS.VIOLATION_LOG)
    ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
    ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER);

  if (logChannelId) {
    const channel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const reportEmbed = new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🚨 Rule Violation Report")
        .setDescription(`**Reporter:** ${user.team ?? interaction.user.username} (<@${interaction.user.id}>)`)
        .addFields(
          { name: "⚠️ Violation Type",  value: violationType, inline: true },
          { name: "👤 Offender",         value: offender,      inline: true },
          { name: "📅 Week",             value: weekNumber,    inline: true },
          { name: "📝 Description",      value: rawDesc,       inline: false },
        )
        .setTimestamp()
        .setFooter({ text: `Violation ID: ${violationId}` });

      if (mediaUrls.length > 0) {
        reportEmbed.addFields({ name: "🖼️ Media", value: mediaUrls.join("\n"), inline: false });
        if (mediaUrls[0]) reportEmbed.setImage(mediaUrls[0]);
      }

      const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ac_rv_approve:${violationId}`)
          .setLabel("✅ Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`ac_rv_deny:${violationId}`)
          .setLabel("❌ Deny")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`ac_rv_note:${interaction.user.id}`)
          .setLabel("📋 Add Note")
          .setStyle(ButtonStyle.Secondary),
      );

      const commMsg = await (channel as TextChannel).send({ embeds: [reportEmbed], components: [btnRow] }).catch(() => null);
      if (commMsg && violationId) {
        await db.update(ruleViolationsTable)
          .set({ commMessageId: commMsg.id })
          .where(eq(ruleViolationsTable.id, violationId));
      }
    }
  }

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("🚨 Violation Report Submitted")
      .setDescription(`Your report against **${offender}** for **${violationType}** has been sent to the commissioners.\n\nThey will review it and take appropriate action.`)],
  });
}

async function handleViolationApprove(interaction: ButtonInteraction) {
  const violationId = parseInt(interaction.customId.split(":")[1] ?? "0", 10);
  if (!violationId) { await interaction.reply({ content: "❌ Invalid violation ID.", ephemeral: true }); return; }

  const gid = interaction.guildId!;
  const [violation] = await db.select().from(ruleViolationsTable)
    .where(and(eq(ruleViolationsTable.id, violationId), eq(ruleViolationsTable.guildId, gid)));
  if (!violation) { await interaction.reply({ content: "❌ Violation not found.", ephemeral: true }); return; }

  await db.update(ruleViolationsTable)
    .set({ status: "approved" })
    .where(eq(ruleViolationsTable.id, violationId));

  // Post to VIOLATION_LOG channel
  const logChannelId = await getGuildChannel(gid, CHANNEL_KEYS.VIOLATION_LOG)
    ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
    ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER);

  if (logChannelId) {
    const ch = await interaction.client.channels.fetch(logChannelId).catch(() => null);
    if (ch?.isTextBased()) {
      const approvedEmbed = new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Violation Approved")
        .addFields(
          { name: "📝 Description", value: violation.description ?? "N/A", inline: false },
          { name: "👤 Offender",    value: violation.opponentTeam ?? "N/A", inline: true },
          { name: "📅 Week",        value: violation.weekNumber ?? "N/A",   inline: true },
          { name: "🔍 Reviewed by", value: `<@${interaction.user.id}>`,     inline: true },
        )
        .setTimestamp()
        .setFooter({ text: `Violation ID: ${violationId}` });

      if (violation.mediaUrls?.length) {
        approvedEmbed.addFields({ name: "🖼️ Media", value: violation.mediaUrls.join("\n"), inline: false });
        if (violation.mediaUrls[0]) approvedEmbed.setImage(violation.mediaUrls[0]);
      }
      await (ch as TextChannel).send({ embeds: [approvedEmbed] }).catch(console.error);
    }
  }

  // DM reporter
  if (violation.reporterId) {
    const reporter = await interaction.client.users.fetch(violation.reporterId).catch(() => null);
    if (reporter) {
      await reporter.send({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Violation Report Approved")
          .setDescription(`Your violation report (ID: ${violationId}) has been **approved** by the commissioners.\n\nThank you for keeping the league fair.`)
          .setTimestamp()],
      }).catch(console.error);
    }
  }

  // Update the original commissioner message to show resolved state
  await interaction.update({
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("ac_rv_noop")
          .setLabel("✅ Approved")
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleViolationDeny(interaction: ButtonInteraction) {
  const violationId = interaction.customId.split(":")[1] ?? "0";
  const modal = new ModalBuilder()
    .setCustomId(`ac_rv_deny_submit:${violationId}`)
    .setTitle("Deny Violation Report")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Reason for denial")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(800)
          .setPlaceholder("Explain why the report is being denied…"),
      ),
    );
  await interaction.showModal(modal);
}

async function handleViolationDenySubmit(interaction: ModalSubmitInteraction) {
  const violationId = parseInt(interaction.customId.split(":")[1] ?? "0", 10);
  const reason      = interaction.fields.getTextInputValue("reason").trim();
  const gid         = interaction.guildId!;

  if (!violationId) { await interaction.reply({ content: "❌ Invalid violation ID.", ephemeral: true }); return; }

  const [violation] = await db.select().from(ruleViolationsTable)
    .where(and(eq(ruleViolationsTable.id, violationId), eq(ruleViolationsTable.guildId, gid)));
  if (!violation) { await interaction.reply({ content: "❌ Violation not found.", ephemeral: true }); return; }

  await db.update(ruleViolationsTable)
    .set({ status: "denied" })
    .where(eq(ruleViolationsTable.id, violationId));

  // DM reporter with deny reason
  if (violation.reporterId) {
    const reporter = await interaction.client.users.fetch(violation.reporterId).catch(() => null);
    if (reporter) {
      await reporter.send({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Violation Report Denied")
          .setDescription(`Your violation report (ID: ${violationId}) has been **denied** by the commissioners.`)
          .addFields({ name: "📋 Reason", value: reason, inline: false })
          .setTimestamp()],
      }).catch(console.error);
    }
  }

  // Try to update the original commissioner message buttons
  try {
    const logChannelId = await getGuildChannel(gid, CHANNEL_KEYS.VIOLATION_LOG)
      ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
      ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER);
    if (logChannelId && violation.commMessageId) {
      const ch = await interaction.client.channels.fetch(logChannelId).catch(() => null);
      if (ch?.isTextBased()) {
        const msg = await (ch as TextChannel).messages.fetch(violation.commMessageId).catch(() => null);
        if (msg) {
          await msg.edit({
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId("ac_rv_noop")
                  .setLabel("❌ Denied")
                  .setStyle(ButtonStyle.Danger)
                  .setDisabled(true),
              ) as ActionRowBuilder<any>,
            ],
          }).catch(console.error);
        }
      }
    }
  } catch { /* swallow */ }

  await interaction.reply({
    ephemeral: true,
    content: `✅ Violation #${violationId} has been denied and the reporter has been notified.`,
  });
}

async function handleViolationNote(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId(`ac_rv_note_submit:${interaction.customId.split(":")[1]}`)
    .setTitle("Commissioner Note")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel("Commissioner note / ruling")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
  await interaction.showModal(modal);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROW 5 — Rules (read-only view with optional public display)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleRulesStart(interaction: ButtonInteraction, sess: ActionsSession) {
  const guildId  = interaction.guildId!;
  const sections = await getAllSections(guildId);
  const entries  = Object.entries(sections);

  if (entries.length === 0) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("📜 Rules").setDescription("No rule sections have been set up yet.")],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ac_rules_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
        ) as ActionRowBuilder<any>,
      ],
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("ac_rules_section")
    .setPlaceholder("Select a rules section...")
    .addOptions(
      entries.slice(0, 25).map(([key, meta]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(meta.title.replace(/[\u{1F300}-\u{1FFFF}]/gu, "").trim() || key)
          .setValue(key),
      ),
    );

  const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_rules_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle("📜 League Rules")
        .setDescription("Select a section to view the rules."),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select) as ActionRowBuilder<any>,
      closeRow,
    ],
  });
}

async function handleRulesSection(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const guildId = interaction.guildId!;
  const section = interaction.values[0]!;
  sess.acRulesSection = section;

  const sections = await getAllSections(guildId);
  const meta     = sections[section];
  if (!meta) {
    await interaction.update({ content: "❌ Section not found.", components: [] });
    return;
  }

  const rules = await getOrSeedRules(section, guildId);
  const lines = rules.length > 0
    ? rules.map((r, i) => `**${i + 1}.** ${r}`)
    : ["_No rules in this section yet._"];

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(meta.title)
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: `${rules.length} rule${rules.length !== 1 ? "s" : ""}` });

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_rules_display").setLabel("📢 Display Publicly").setStyle(ButtonStyle.Primary).setDisabled(rules.length === 0),
    new ButtonBuilder().setCustomId("ac_rules_goback").setLabel("← Sections").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_rules_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [btnRow] });
}

async function handleRulesDisplayChoice(interaction: ButtonInteraction, sess: ActionsSession) {
  if (!sess.acRulesSection) {
    await interaction.reply({ content: "❌ Session expired — open /menu again.", ephemeral: true });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_rules_display_full").setLabel("📋 Full Section").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_rules_display_bynum").setLabel("🔢 By Rule #").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_rules_goback").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle("📢 Display Rules")
        .setDescription("Choose how to display the rules publicly in this channel:"),
    ],
    components: [row],
  });
}

async function handleRulesDisplayFull(interaction: ButtonInteraction, sess: ActionsSession) {
  const guildId = interaction.guildId!;
  if (!sess.acRulesSection) {
    await interaction.reply({ content: "❌ Session expired — open /menu again.", ephemeral: true });
    return;
  }

  const sections = await getAllSections(guildId);
  const meta     = sections[sess.acRulesSection]!;
  const rules    = await getOrSeedRules(sess.acRulesSection, guildId);
  const lines    = rules.length > 0
    ? rules.map((r, i) => `**${i + 1}.** ${r}`)
    : ["_No rules in this section yet._"];

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(meta.title)
    .setDescription(lines.join("\n\n"))
    .setTimestamp();

  await (interaction.channel as TextChannel | null)?.send({ embeds: [embed] }).catch(console.error);

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Green).setDescription("✅ Rules posted to the channel.")],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ac_rules_goback").setLabel("← Sections").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ac_rules_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

async function handleRulesDisplayByNumModal(interaction: ButtonInteraction, _sess: ActionsSession) {
  const modal = new ModalBuilder()
    .setCustomId("ac_modal_rules_bynum")
    .setTitle("Display Rule by Number");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("rule_num")
        .setLabel("Rule Number")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 3")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(3),
    ),
  );

  await interaction.showModal(modal);
}

async function handleRulesByNumSubmit(interaction: ModalSubmitInteraction, sess: ActionsSession) {
  const guildId = interaction.guildId!;
  if (!sess.acRulesSection) {
    await interaction.reply({ content: "❌ Session expired — open /menu again.", ephemeral: true });
    return;
  }

  const ruleNum = parseInt(interaction.fields.getTextInputValue("rule_num"), 10);
  if (isNaN(ruleNum) || ruleNum < 1) {
    await interaction.reply({ content: "❌ Invalid rule number.", ephemeral: true });
    return;
  }

  const sections = await getAllSections(guildId);
  const meta     = sections[sess.acRulesSection]!;
  const rules    = await getOrSeedRules(sess.acRulesSection, guildId);

  if (ruleNum > rules.length) {
    await interaction.reply({ content: `❌ Rule #${ruleNum} does not exist. This section has ${rules.length} rule(s).`, ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.title} — Rule #${ruleNum}`)
    .setDescription(rules[ruleNum - 1]!)
    .setTimestamp();

  await (interaction.channel as TextChannel | null)?.send({ embeds: [embed] }).catch(console.error);

  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(Colors.Green).setDescription(`✅ Rule #${ruleNum} posted to the channel.`)],
    ephemeral: true,
  });
}

async function handleRulesClose(interaction: ButtonInteraction) {
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.DarkGrey).setDescription("📜 Rules closed.")],
    components: [],
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UNLINKED USER — Request handlers
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helpers: build open-team and all-team dual dropdowns ─────────────────────

function buildOpenTeamSelectRows(
  afcOpen: string[],
  nfcOpen: string[],
  selected?: string,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (afcOpen.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ac_req_openteam_sel_afc")
      .setPlaceholder("🔵 AFC — Pick an open team")
      .addOptions(afcOpen.map(t =>
        new StringSelectMenuOptionBuilder().setLabel(t).setValue(t).setDefault(t === selected),
      ));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  if (nfcOpen.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ac_req_openteam_sel_nfc")
      .setPlaceholder("🔴 NFC — Pick an open team")
      .addOptions(nfcOpen.map(t =>
        new StringSelectMenuOptionBuilder().setLabel(t).setValue(t).setDefault(t === selected),
      ));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  return rows;
}

function buildAllTeamSelectRows(
  selected?: string,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const afc = NFL_TEAMS.filter(t => NFL_DIVISION_MAP[t]?.conference === "AFC").sort();
  const nfc = NFL_TEAMS.filter(t => NFL_DIVISION_MAP[t]?.conference === "NFC").sort();

  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  const afcMenu = new StringSelectMenuBuilder()
    .setCustomId("ac_req_waitlist_sel_afc")
    .setPlaceholder("🔵 AFC — Pick your target team")
    .addOptions(afc.map(t =>
      new StringSelectMenuOptionBuilder().setLabel(t).setValue(t).setDefault(t === selected),
    ));
  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(afcMenu));

  const nfcMenu = new StringSelectMenuBuilder()
    .setCustomId("ac_req_waitlist_sel_nfc")
    .setPlaceholder("🔴 NFC — Pick your target team")
    .addOptions(nfc.map(t =>
      new StringSelectMenuOptionBuilder().setLabel(t).setValue(t).setDefault(t === selected),
    ));
  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(nfcMenu));

  return rows;
}

// ── Request Open Team: step 1 — show dual dropdowns with open teams ───────────

async function handleReqOpenTeam(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  sess.pendingTeamRequest = undefined;

  const takenRows = await db.select({ team: usersTable.team, discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, gid), isNotNull(usersTable.team)));

  const taken    = new Set(takenRows.filter(r => r.discordId && !r.discordId.startsWith("unlinked_")).map(r => r.team as string));
  const open     = NFL_TEAMS.filter(t => !taken.has(t));
  const afcOpen  = open.filter(t => NFL_DIVISION_MAP[t]?.conference === "AFC").sort();
  const nfcOpen  = open.filter(t => NFL_DIVISION_MAP[t]?.conference === "NFC").sort();

  if (!open.length) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Grey)
        .setTitle("🔴 No Open Teams")
        .setDescription("All 32 teams are currently claimed. You can add yourself to the waitlist instead.")],
      components: [backToHubRow()],
    });
    return;
  }

  const selectRows = buildOpenTeamSelectRows(afcOpen, nfcOpen);
  const actionRow  = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_req_openteam_submit").setLabel("✅ Submit Request").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  ) as ActionRowBuilder<any>;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🏈 Request an Open Team")
    .setDescription("Pick a team from either dropdown below, then click **Submit Request**.\n\n⚠️ You may only select **one team**. Selecting from one conference clears the other.");

  await interaction.editReply({ embeds: [embed], components: [...selectRows, actionRow] });
}

// ── Request Open Team: step 2 — user selects a team ─────────────────────────

async function handleReqOpenTeamSel(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const gid  = interaction.guildId!;
  const team = interaction.values[0]!;
  await interaction.deferUpdate();

  sess.pendingTeamRequest = team;

  const takenRows = await db.select({ team: usersTable.team, discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, gid), isNotNull(usersTable.team)));

  const taken   = new Set(takenRows.filter(r => r.discordId && !r.discordId.startsWith("unlinked_")).map(r => r.team as string));
  const open    = NFL_TEAMS.filter(t => !taken.has(t));
  const afcOpen = open.filter(t => NFL_DIVISION_MAP[t]?.conference === "AFC").sort();
  const nfcOpen = open.filter(t => NFL_DIVISION_MAP[t]?.conference === "NFC").sort();

  const selectRows = buildOpenTeamSelectRows(afcOpen, nfcOpen, team);
  const actionRow  = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_req_openteam_submit").setLabel("✅ Submit Request").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  ) as ActionRowBuilder<any>;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🏈 Request an Open Team")
    .setDescription(`Pick a team from either dropdown below, then click **Submit Request**.\n\n✅ **Selected:** ${team}\n\nClick **Submit Request** to send your request to the commissioner.`);

  await interaction.editReply({ embeds: [embed], components: [...selectRows, actionRow] });
}

// ── Request Open Team: step 3 — submit to commissioner log ───────────────────

async function handleReqOpenTeamSubmit(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid  = interaction.guildId!;
  const uid  = interaction.user.id;
  const team = sess.pendingTeamRequest;
  await interaction.deferUpdate();

  if (!team) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Team Selected").setDescription("Please select a team from the dropdown first.")],
      components: [backToHubRow()],
    });
    return;
  }

  // Verify team is still open at submit time
  const takenRows = await db.select({ team: usersTable.team, discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, gid), isNotNull(usersTable.team)));

  const taken = new Set(takenRows.filter(r => r.discordId && !r.discordId.startsWith("unlinked_")).map(r => r.team as string));
  if (taken.has(team)) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("⚠️ Team No Longer Available")
        .setDescription(`The **${team}** were claimed since you started browsing. Please go back and pick another team.`)],
      components: [backToHubRow()],
    });
    return;
  }

  const logChannelId = await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
    ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER);

  if (logChannelId) {
    const channel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle("🔔 Open Team Request")
          .setDescription(`<@${uid}> has requested an open team.`)
          .addFields({ name: "🏈 Team Requested", value: team, inline: true })
          .setTimestamp()],
      }).catch(console.error);
    }
  }

  sess.pendingTeamRequest = undefined;

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Request Submitted")
      .setDescription(`Your request for the **${team}** has been sent to the commissioner. You'll be notified once a decision is made.`)],
    components: [backToHubRow()],
  });
}

// ── Add to Waitlist: step 1 — show dual dropdowns with ALL teams ──────────────

async function handleReqAddWaitlist(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const uid = interaction.user.id;
  await interaction.deferUpdate();

  // Check if already on waitlist
  const [existing] = await db.select({ id: waitlistTable.id, status: waitlistTable.status, team: waitlistTable.team })
    .from(waitlistTable)
    .where(and(eq(waitlistTable.guildId, gid), eq(waitlistTable.discordId, uid)));

  if (existing) {
    const teamInfo = existing.team ? ` for the **${existing.team}**` : "";
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("⚠️ Already on Waitlist")
        .setDescription(`You're already on the waitlist${teamInfo} (status: **${existing.status}**).\n\nUse **Remove from Waitlist** if you'd like to change your team preference.`)],
      components: [backToHubRow()],
    });
    return;
  }

  sess.pendingTeamRequest = undefined;

  const selectRows = buildAllTeamSelectRows();
  const actionRow  = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_req_waitlist_next").setLabel("📋 Add to Waitlist").setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  ) as ActionRowBuilder<any>;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("📋 Add to Waitlist")
    .setDescription(
      "Pick the **specific team** you want to waitlist for, then click **Add to Waitlist**.\n\n" +
      "If that team is already open, you'll be redirected to Request it directly.\n" +
      "If it's taken, you'll be added to the waitlist and notified when they become available.",
    );

  await interaction.editReply({ embeds: [embed], components: [...selectRows, actionRow] });
}

// ── Add to Waitlist: step 2 — user selects their target team ─────────────────

async function handleReqWaitlistSel(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const team = interaction.values[0]!;
  await interaction.deferUpdate();

  sess.pendingTeamRequest = team;

  const selectRows = buildAllTeamSelectRows(team);
  const actionRow  = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_req_waitlist_next").setLabel("📋 Add to Waitlist").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  ) as ActionRowBuilder<any>;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("📋 Add to Waitlist")
    .setDescription(
      "Pick the **specific team** you want to waitlist for, then click **Add to Waitlist**.\n\n" +
      `✅ **Selected:** ${team}\n\nClick **Add to Waitlist** to continue.`,
    );

  await interaction.editReply({ embeds: [embed], components: [...selectRows, actionRow] });
}

// ── Add to Waitlist: step 3 — check open/taken and act ───────────────────────

async function handleReqWaitlistNext(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid  = interaction.guildId!;
  const uid  = interaction.user.id;
  const team = sess.pendingTeamRequest;
  await interaction.deferUpdate();

  if (!team) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ No Team Selected").setDescription("Please select a team from the dropdown first.")],
      components: [backToHubRow()],
    });
    return;
  }

  // Check if team is open or taken
  const takenRows = await db.select({ team: usersTable.team, discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, gid), isNotNull(usersTable.team)));

  const taken = new Set(takenRows.filter(r => r.discordId && !r.discordId.startsWith("unlinked_")).map(r => r.team as string));

  if (!taken.has(team)) {
    // Team is open — redirect to Request Open Team flow
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("🟢 Team Is Open!")
        .setDescription(`The **${team}** are actually available right now! Use **Request Open Team** to claim them directly instead of waiting.`)],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ac_req_openteam").setLabel("🏈 Request Open Team").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
        ) as ActionRowBuilder<any>,
      ],
    });
    return;
  }

  // Team is taken — add to waitlist
  const [existing] = await db.select({ id: waitlistTable.id })
    .from(waitlistTable)
    .where(and(eq(waitlistTable.guildId, gid), eq(waitlistTable.discordId, uid)));

  if (existing) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("⚠️ Already on Waitlist")
        .setDescription("You're already on the waitlist. Use **Remove from Waitlist** first if you want to change your team preference.")],
      components: [backToHubRow()],
    });
    return;
  }

  await db.insert(waitlistTable).values({ guildId: gid, discordId: uid, addedBy: uid, team, status: "waiting" });

  // Notify commissioner
  const logChannelId = await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
    ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER);
  if (logChannelId) {
    const channel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Blue)
          .setTitle("📋 Waitlist Request")
          .setDescription(`<@${uid}> has added themselves to the waitlist for the **${team}**.`)
          .setTimestamp()],
      }).catch(console.error);
    }
  }

  sess.pendingTeamRequest = undefined;

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Added to Waitlist")
      .setDescription(`You've been added to the waitlist for the **${team}**!\n\nYou'll receive a DM when the ${team} become available. The commissioner has also been notified.`)],
    components: [backToHubRow()],
  });
}

// ── Remove from Waitlist: confirm step ───────────────────────────────────────

async function handleReqRmWaitlist(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const uid = interaction.user.id;
  await interaction.deferUpdate();

  const [existing] = await db.select({ id: waitlistTable.id, status: waitlistTable.status, team: waitlistTable.team })
    .from(waitlistTable)
    .where(and(eq(waitlistTable.guildId, gid), eq(waitlistTable.discordId, uid)));

  if (!existing) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("ℹ️ Not on Waitlist").setDescription("You are not currently on the waitlist.")],
      components: [backToHubRow()],
    });
    return;
  }

  const teamInfo = existing.team ? ` for the **${existing.team}**` : "";

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_req_rmwl_confirm").setLabel("✅ Yes, Remove Me").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Cancel").setStyle(ButtonStyle.Secondary),
  ) as ActionRowBuilder<any>;

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("⚠️ Confirm Waitlist Removal")
      .setDescription(`You are currently on the waitlist${teamInfo} (status: **${existing.status}**).\n\nAre you sure you want to remove yourself?`)],
    components: [confirmRow],
  });
}

async function handleReqRmWaitlistConfirm(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const uid = interaction.user.id;
  await interaction.deferUpdate();

  const [existing] = await db.select({ team: waitlistTable.team })
    .from(waitlistTable)
    .where(and(eq(waitlistTable.guildId, gid), eq(waitlistTable.discordId, uid)));

  await db.delete(waitlistTable).where(and(eq(waitlistTable.guildId, gid), eq(waitlistTable.discordId, uid)));

  const teamInfo = existing?.team ? ` (${existing.team})` : "";

  const logChannelId = await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
    ?? await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER);
  if (logChannelId) {
    const channel = await interaction.client.channels.fetch(logChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Grey)
          .setTitle("📋 Waitlist Removal")
          .setDescription(`<@${uid}> has removed themselves from the waitlist${teamInfo}.`)
          .setTimestamp()],
      }).catch(console.error);
    }
  }

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Removed from Waitlist")
      .setDescription("You've been removed from the waitlist. You can re-add yourself at any time.")],
    components: [backToHubRow()],
  });
}
