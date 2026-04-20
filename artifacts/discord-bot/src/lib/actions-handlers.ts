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
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userSavingsTable, userRecordsTable, globalUserRecordsTable,
  franchiseRostersTable, franchiseMcaTeamsTable, seasonsTable,
  wagersTable, interviewRequestsTable, coinTransactionsTable,
  seasonStatsTable, teamSeasonStatsTable, purchasesTable, inventoryTable,
  legendsTable, franchiseScheduleTable,
  guildTweetsTable, autoPilotRequestsTable, ruleViolationsTable,
} from "@workspace/db";
import { eq, and, desc, sql, isNotNull, isNull, ne, sum, max, inArray } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getRosterSeasonId,
  deductBalance, logTransaction, addBalance, getGuildChannel, CHANNEL_KEYS,
  getSeasonStats, getSeasonRules, getCoreAttributes,
} from "./db-helpers.js";
import {
  getPayoutValue, getAllPayoutConfig, getMilestoneTiers, getAllPayoutKeys,
} from "./payout-config.js";
import { getServerSettings, requireMcaEnabled } from "./server-settings.js";
import { getArticleStandings, getSeasonRecords, getAllTimeRecords } from "./gcs-fallback.js";
import { devBadge, DEV_LEGEND } from "./dev-trait.js";
import { weekLabel } from "../commands/advanceweek.js";
import { INTERVIEW_QUESTIONS, pickThreeIndices } from "../commands/interviewrequest.js";
import { buildActionsHubEmbed, buildActionsHubRows } from "../commands/actions.js";
import { aupSessions } from "../commands/attribute-up-interactions.js";
import {
  insufficientFunds, sendCommissionerNotification, getRosterRows, DEV_LABEL,
} from "./purchase-shared.js";
import { ATTRIBUTES, CORE_ATTRIBUTES } from "./constants.js";

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

  // ── Hub restore ─────────────────────────────────────────────────────────────
  if (id === "ac_hub") {
    await (interaction as ButtonInteraction).update({
      embeds:     [buildActionsHubEmbed()],
      components: buildActionsHubRows(),
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
  if (id === "ac_wager_game")               { await handleWagerGameSelect(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id.startsWith("ac_wager_pick:"))      { await handleWagerTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_wager_amount_modal")       { await handleWagerAmountModal(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_wager_send")               { await handleWagerSend(interaction as ButtonInteraction, sess); return true; }

  // ── Row 2: Rosters ───────────────────────────────────────────────────────────

  if (id === "ac_myroster")     { await handleMyRoster(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_anyroster")    { await handleAnyRosterTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_anyroster_sel")  { await handleAnyRosterShow(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_freeagents")   { await handleFreeAgentsPosPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_fa_pos")       { await handleFreeAgentsShow(interaction as StringSelectMenuInteraction, sess); return true; }
  if (id === "ac_playerstats")  { await handlePlayerStatsStart(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_teamstats")    { await handleTeamStatsTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_teamstats_sel")  { await handleTeamStatsShow(interaction as StringSelectMenuInteraction, sess); return true; }

  // ── Row 3: League Info ───────────────────────────────────────────────────────

  if (id === "ac_standings")    { await handleStandingsConfPick(interaction as ButtonInteraction, sess); return true; }
  if (id.startsWith("ac_standings_conf:"))   { await handleStandingsShow(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_teamstowatch") { await handleTeamsToWatch(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_myuserstats")  { await handleMyUserStats(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_anyuserstats") { await handleAnyUserStatsTeamPick(interaction as ButtonInteraction, sess); return true; }
  if (id === "ac_anyus_sel")    { await handleAnyUserStatsShow(interaction as StringSelectMenuInteraction, sess); return true; }

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
  if (id === "ac_violation")    { await handleViolationModal(interaction as ButtonInteraction); return true; }

  // Modal submits
  if (id === "ac_modal_tweet")      { await handleTweetSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_modal_sendcoins")  { await handleSendCoinsSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_modal_wageramount") { await handleWagerAmountSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_modal_autopilot")  { await handleAutoPilotSubmit(interaction as ModalSubmitInteraction, sess); return true; }
  if (id === "ac_modal_violation")  { await handleViolationSubmit(interaction as ModalSubmitInteraction, sess); return true; }

  // Commissioner autopilot approve/deny
  if (id.startsWith("ac_ap_approve:")) { await handleApproveAutoPilot(interaction as ButtonInteraction); return true; }
  if (id.startsWith("ac_ap_deny:"))    { await handleDenyAutoPilot(interaction as ButtonInteraction); return true; }
  if (id.startsWith("ac_rv_note:"))    { await handleViolationNote(interaction as ButtonInteraction); return true; }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROW 1 — Economy & Social
// ═══════════════════════════════════════════════════════════════════════════════

async function handlePurchaseMenu(interaction: ButtonInteraction, sess: ActionsSession) {
  const embed = new EmbedBuilder()
    .setColor(0x1a1a2e)
    .setTitle("💳 Make a Purchase")
    .setDescription("Select a purchase type below.")
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_buy_attr").setLabel("⭐ Attribute Upgrade").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_buy_agereset").setLabel("🔄 Age Reset").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_buy_devup").setLabel("📈 Dev Trait Upgrade").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_buy_custom").setLabel("🎨 Custom Player").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_buy_legend").setLabel("🏆 Buy a Legend").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row1, row2, cancelRow()] });
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

  aupSessions.set(`${uid}:${playerId}`, {
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

  // Show instruction to use the attribute page (acknowledge the interaction)
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`⭐ Attribute Upgrade — ${playerName}`)
      .setDescription(
        `Player loaded. Use \`/buy-attribute\` and search for **${playerName}** to complete the interactive attribute upgrade flow.\n\n` +
        `*Tip: The interactive UI is best experienced through the dedicated \`/buy-attribute\` command which gives you paginated attribute groups.*`,
      )],
    components: [backToHubRow()],
  });
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
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("🎨 Custom Player Builder")
      .setDescription(
        "The Custom Player Builder requires a detailed multi-step setup and is available through the dedicated command.\n\n" +
        "Use **`/buy-customplayer`** to start the interactive custom player creation flow.\n\n" +
        "That command will walk you through:\n" +
        "• Package tier selection\n• Position & archetype\n• Dev trait\n• Abilities & signature package"
      )],
    components: [backToHubRow()],
  });
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

async function handleWagerStart(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  const settings = await getServerSettings(gid);
  if (!settings.coinEconomy || !settings.wagerEnabled) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Wagers are currently disabled by the commissioners.")], components: [backToHubRow()] });
    return;
  }

  const season = await getOrCreateActiveSeason(gid);
  const scheduleRows = await db.select({
    id:           franchiseScheduleTable.id,
    weekIndex:    franchiseScheduleTable.weekIndex,
    homeTeamName: franchiseScheduleTable.homeTeamName,
    awayTeamName: franchiseScheduleTable.awayTeamName,
    status:       franchiseScheduleTable.status,
  }).from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      eq(franchiseScheduleTable.weekIndex, (season as any).currentWeek ?? 1),
    ))
    .limit(25);

  if (!scheduleRows.length) {
    // Fallback: manual wager form (no schedule data)
    const embed = new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("⚔️ Place a Wager")
      .setDescription("No schedule data found for the current week. Use **`/wager`** directly to challenge an opponent.\n\nOr ask a commissioner to import the schedule from MCA.");
    await interaction.update({ embeds: [embed], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_wager_game")
    .setPlaceholder("Select a game to wager on…")
    .addOptions(
      scheduleRows.map(g =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${g.homeTeamName} vs ${g.awayTeamName} (Week ${g.weekIndex})`)
          .setValue(String(g.id)),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 1").setDescription("Select the game you want to wager on.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleWagerGameSelect(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const gameId = Number(interaction.values[0]);
  sess.scheduleGameId = String(gameId);

  const game = (await db.select().from(franchiseScheduleTable).where(eq(franchiseScheduleTable.id, gameId)).limit(1))[0];
  if (!game) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Game not found.")], components: [backToHubRow()] });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ac_wager_pick:home:${game.homeTeamName}`).setLabel(`🏠 ${game.homeTeamName}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ac_wager_pick:away:${game.awayTeamName}`).setLabel(`✈️ ${game.awayTeamName}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚔️ Place a Wager — Step 2").setDescription(`**${game.homeTeamName} vs ${game.awayTeamName}**\n\nWhich team are you betting on?`)],
    components: [row],
  });
}

async function handleWagerTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const parts = interaction.customId.split(":");
  const side  = parts[1]!;
  const team  = parts.slice(2).join(":");
  sess.wagerTeam = team;
  sess.wagerChallengerTeam = team;

  const modal = new ModalBuilder()
    .setCustomId("ac_modal_wageramount")
    .setTitle("Wager Amount")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("How many coins are you wagering?")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 500")
          .setRequired(true)
          .setMaxLength(10),
      ),
    );

  await interaction.showModal(modal);
}

async function handleWagerAmountModal(interaction: ButtonInteraction, sess: ActionsSession) {
  const modal = new ModalBuilder()
    .setCustomId("ac_modal_wageramount")
    .setTitle("Wager Amount")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Wager amount (coins)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

async function handleWagerAmountSubmit(interaction: ModalSubmitInteraction, sess: ActionsSession) {
  const amountStr = interaction.fields.getTextInputValue("amount").trim();
  const amount    = parseInt(amountStr, 10);

  if (isNaN(amount) || amount < 1) {
    await interaction.reply({ content: "❌ Invalid amount. Enter a positive number.", ephemeral: true });
    return;
  }

  sess.wagerAmount = amount;
  const gid = interaction.guildId!;

  // Show wager confirmation — need to pick opponent
  // Find linked users for opponent select
  const users = await db.select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(
      eq(usersTable.guildId, gid),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
      ne(usersTable.discordId, interaction.user.id),
    ));

  if (!users.length) {
    await interaction.reply({ content: "❌ No other linked users found to wager against.", ephemeral: true });
    return;
  }

  const user = await getOrCreateUser(interaction.user.id, interaction.user.username, gid);
  if (user.balance < amount) {
    await interaction.reply({ content: `❌ Insufficient coins. You have **${user.balance.toLocaleString()}**, wager is **${amount.toLocaleString()}**.`, ephemeral: true });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_wager_game")
    .setPlaceholder("Note: Re-select opponent here (use /wager for full flow)")
    .addOptions(users.slice(0, 25).map(u =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${u.team ?? u.discordUsername}`)
        .setValue(u.discordId),
    ));

  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle("⚔️ Wager Ready")
      .setDescription(
        `Your team: **${sess.wagerTeam ?? "Unknown"}**\nAmount: **${amount.toLocaleString()} coins**\n\n` +
        `Use **\`/wager\`** to challenge a specific opponent and complete the wager — the hub flow is a preview. The dedicated command gives full opponent selection and challenge acceptance.\n\n` +
        `Or contact your opponent directly after sending a challenge via \`/wager\`.`
      )],
    components: [backToHubRow()],
  });
}

async function handleWagerSend(interaction: ButtonInteraction, sess: ActionsSession) {
  await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Green).setDescription("✅ Wager challenge sent! Your opponent can accept with the button in the challenge message.")], components: [backToHubRow()] });
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
  const [user, season] = await Promise.all([
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

  const [i1, i2, i3] = pickThreeIndices(INTERVIEW_QUESTIONS.length);
  const q1 = INTERVIEW_QUESTIONS[i1]!;
  const q2 = INTERVIEW_QUESTIONS[i2]!;
  const q3 = INTERVIEW_QUESTIONS[i3]!;
  const indicesStr = `${i1},${i2},${i3}`;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎙️ Post-Game Interview")
    .setDescription(
      `Here are your **3 interview questions** for **${wkLabel}**.\n` +
      `Click **Submit Your Answers** to fill them in.\n\n` +
      `*Questions are selected randomly from a pool of ${INTERVIEW_QUESTIONS.length}.*`,
    )
    .addFields({ name: "Q1", value: q1 }, { name: "Q2", value: q2 }, { name: "Q3", value: q3 })
    .setFooter({ text: `${user.team ?? interaction.user.username} • ${wkLabel}` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`interview_answer:${interaction.user.id}:${indicesStr}`)
      .setLabel("📝 Submit Your Answers")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [row] });
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

  const limitNote = !willEarnCoins
    ? `\n*Weekly tweet limit reached (${weeklyLimit}) — no coins awarded.*`
    : `\n**+${earnedCoins} coins** awarded!`;

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

  // Find teamId from franchiseMcaTeams
  const teamRow = (await db.select({ id: franchiseMcaTeamsTable.id })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      sql`lower(${franchiseMcaTeamsTable.fullName}) = lower(${user.team})`,
    ))
    .limit(1))[0];

  if (!teamRow) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ Team **${user.team}** not found in the franchise database. Make sure MCA data is imported.`)],
      components: [backToHubRow()],
    });
    return;
  }

  const embed = new EmbedBuilder();
  await buildRosterEmbed(gid, seasonId, teamRow.id, user.team, embed);
  await interaction.update({ embeds: [embed], components: [backToHubRow()] });
}

async function handleAnyRosterTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid      = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);
  const teams = await db.select({ id: franchiseMcaTeamsTable.id, fullName: franchiseMcaTeamsTable.fullName, conference: franchiseMcaTeamsTable.conference })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, seasonId), eq(franchiseMcaTeamsTable.isHuman, true)))
    .orderBy(franchiseMcaTeamsTable.conference, franchiseMcaTeamsTable.fullName);

  if (!teams.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No teams found. Import MCA data first.")], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_anyroster_sel")
    .setPlaceholder("Select a team…")
    .addOptions(
      teams.slice(0, 25).map(t =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${t.fullName} (${t.conference ?? "?"})`)
          .setValue(String(t.id)),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("👥 View Any Roster").setDescription("Select a team to view their roster.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleAnyRosterShow(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const teamId = Number(interaction.values[0]);
  const gid    = interaction.guildId!;
  const seasonId = await getRosterSeasonId(gid);

  const teamRow = (await db.select({ fullName: franchiseMcaTeamsTable.fullName }).from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.id, teamId)).limit(1))[0];
  const teamName = teamRow?.fullName ?? "Unknown Team";

  const embed = new EmbedBuilder();
  await buildRosterEmbed(gid, seasonId, teamId, teamName, embed);
  await interaction.update({ embeds: [embed], components: [backToHubRow()] });
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

  // FA = players on team 0 or teamId that signals FA (CPU/free agent)
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
      isNull(franchiseRostersTable.discordId),
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
    .setDescription(lines.slice(0, 20).join("\n"))
    .setFooter({ text: `Showing top ${Math.min(faRows.length, 20)} by OVR • ${DEV_LEGEND}` })
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [backToHubRow()] });
}

// ── Player Stats — hand off to viewps_ handlers ────────────────────────────────

async function handlePlayerStatsStart(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid    = interaction.guildId!;
  const season = await getOrCreateActiveSeason(gid);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`viewps_team:${season.id}:nfc`).setLabel("NFC Teams").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`viewps_team:${season.id}:afc`).setLabel("AFC Teams").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("📊 Player Stats & Ratings")
      .setDescription("Select a conference to browse teams, then choose a player to view their stats.")],
    components: [row],
  });
}

// ── Team Stats ────────────────────────────────────────────────────────────────

async function handleTeamStatsTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid      = interaction.guildId!;
  const season   = await getOrCreateActiveSeason(gid);
  const teams = await db.select({ id: franchiseMcaTeamsTable.id, fullName: franchiseMcaTeamsTable.fullName, conference: franchiseMcaTeamsTable.conference })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.isHuman, true)))
    .orderBy(franchiseMcaTeamsTable.conference, franchiseMcaTeamsTable.fullName);

  if (!teams.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No teams found.")], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_teamstats_sel")
    .setPlaceholder("Select a team…")
    .addOptions(
      teams.slice(0, 25).map(t =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${t.fullName} (${t.conference ?? "?"})`)
          .setValue(String(t.id)),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🏟️ Team Stats — Select Team")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleTeamStatsShow(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const teamId  = Number(interaction.values[0]);
  const gid     = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(gid);

  const [teamRow, statsRow] = await Promise.all([
    db.select({ fullName: franchiseMcaTeamsTable.fullName }).from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.id, teamId)).limit(1).then(r => r[0]),
    db.select().from(teamSeasonStatsTable)
      .where(and(eq(teamSeasonStatsTable.seasonId, season.id), eq(teamSeasonStatsTable.teamId, teamId)))
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
    new ButtonBuilder().setCustomId("ac_standings_conf:AFC").setLabel("🔵 AFC").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_standings_conf:NFC").setLabel("🔴 NFC").setStyle(ButtonStyle.Danger),
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
        .setColor(conference === "AFC" ? Colors.Blue : Colors.Red)
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
    .setColor(conf === "AFC" ? Colors.Blue : Colors.Red)
    .setTitle(`🏈 ${conf} Standings — Season ${season.seasonNumber}`)
    .setDescription(lines.join("\n"))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
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

async function handleMyUserStats(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const [user, season, savingsRow] = await Promise.all([
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
    getOrCreateActiveSeason(gid),
    db.select({ balance: userSavingsTable.balance }).from(userSavingsTable).where(eq(userSavingsTable.discordId, interaction.user.id)).limit(1).then(r => r[0]),
  ]);

  const [recordRow, seasonStatsRow] = await Promise.all([
    db.select().from(userRecordsTable).where(and(eq(userRecordsTable.discordId, interaction.user.id), eq(userRecordsTable.seasonId, season.id))).limit(1).then(r => r[0]),
    getSeasonStats(interaction.user.id, season.id),
  ]);

  const savings     = savingsRow?.balance ?? 0;
  const total       = user.balance + savings;
  const ssW         = recordRow?.wins         ?? 0;
  const ssL         = recordRow?.losses       ?? 0;
  const atW         = 0;
  const atL         = 0;
  const sbW         = recordRow?.superbowlWins ?? 0;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`🧑 ${user.team ?? interaction.user.username} — User Stats`)
    .addFields(
      { name: "💰 Balance",        value: `Wallet: **${user.balance.toLocaleString()}**\nSavings: **${savings.toLocaleString()}**\nTotal: **${total.toLocaleString()}**`, inline: true },
      { name: "📊 Season Record",  value: `${ssW}W-${ssL}L`, inline: true },
      { name: "🏆 All-Time",       value: `${atW}W-${atL}L | ${sbW} SB${sbW !== 1 ? "s" : ""}`, inline: true },
    );

  if (seasonStatsRow) {
    const { coreAttrPurchased, nonCoreAttrPurchased, devUpsPurchased, ageResetsPurchased } = seasonStatsRow;
    embed.addFields({
      name: "🛒 This Season's Purchases",
      value: `Core Attrs: ${coreAttrPurchased ?? 0} | Non-Core: ${nonCoreAttrPurchased ?? 0} | Dev Ups: ${devUpsPurchased ?? 0} | Age Resets: ${ageResetsPurchased ?? 0}`,
      inline: false,
    });
  }

  embed.setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleAnyUserStatsTeamPick(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid   = interaction.guildId!;
  const users = await db.select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, gid), isNotNull(usersTable.team), ne(usersTable.team, "")))
    .orderBy(usersTable.team);

  if (!users.length) {
    await interaction.update({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No linked users found.")], components: [backToHubRow()] });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_anyus_sel")
    .setPlaceholder("Select a team owner…")
    .addOptions(
      users.slice(0, 25).map(u =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${u.team ?? u.discordUsername}`)
          .setDescription(`@${u.discordUsername}`)
          .setValue(u.discordId),
      ),
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("👤 Any User Stats — Select Owner")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
}

async function handleAnyUserStatsShow(interaction: StringSelectMenuInteraction, sess: ActionsSession) {
  const targetId = interaction.values[0]!;
  const gid      = interaction.guildId!;
  await interaction.deferUpdate();

  const season = await getOrCreateActiveSeason(gid);
  const [targetUser, savingsRow, recordRow, seasonStatsRow] = await Promise.all([
    db.select().from(usersTable).where(and(eq(usersTable.discordId, targetId), eq(usersTable.guildId, gid))).limit(1).then(r => r[0]),
    db.select({ balance: userSavingsTable.balance }).from(userSavingsTable).where(eq(userSavingsTable.discordId, targetId)).limit(1).then(r => r[0]),
    db.select().from(userRecordsTable).where(and(eq(userRecordsTable.discordId, targetId), eq(userRecordsTable.seasonId, season.id))).limit(1).then(r => r[0]),
    getSeasonStats(targetId, season.id),
  ]);

  if (!targetUser) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ User not found.")], components: [backToHubRow()] });
    return;
  }

  const savings = savingsRow?.balance ?? 0;
  const total   = targetUser.balance + savings;
  const ssW     = recordRow?.wins         ?? 0;
  const ssL     = recordRow?.losses       ?? 0;
  const atW     = 0;
  const atL     = 0;
  const sbW     = recordRow?.superbowlWins ?? 0;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`👤 ${targetUser.team ?? targetUser.discordUsername} — User Stats`)
    .addFields(
      { name: "💰 Balance",       value: `Wallet: **${targetUser.balance.toLocaleString()}**\nSavings: **${savings.toLocaleString()}**\nTotal: **${total.toLocaleString()}**`, inline: true },
      { name: "📊 Season Record", value: `${ssW}W-${ssL}L`, inline: true },
      { name: "🏆 All-Time",      value: `${atW}W-${atL}L | ${sbW} SB${sbW !== 1 ? "s" : ""}`, inline: true },
    )
    .setTimestamp();

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
    const badge  = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gp > 0 ? ((r.wins / r.gp) * 100).toFixed(1) : "0.0";
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${fmtDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.pr.toFixed(1)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`📊 Season ${season.seasonNumber} Power Rankings`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "PR = 60%×(W-L Diff) + 40%×(Point Diff)" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleAllTimePR(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const { records } = await getAllTimeRecords();
  const guildUsers  = await db.select({ discordId: usersTable.discordId }).from(usersTable).where(eq(usersTable.guildId, gid));
  const guildIds    = new Set(guildUsers.map(u => u.discordId));

  const filtered = records.filter(r => guildIds.has(r.discordId));

  if (!filtered.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🏆 All-Time Power Rankings").setDescription("No all-time records yet.")], components: [backToHubRow()] });
    return;
  }

  const ranked = filtered.map(r => ({
    ...r,
    gp: r.wins + r.losses,
    pr: calcPRScore(r.wins, r.losses, r.pointDifferential),
    label: r.team ?? r.discordUsername,
  })).sort((a, b) => b.pr - a.pr);

  const medals = ["🥇", "🥈", "🥉"];
  const lines  = ranked.map((r, i) => {
    const badge  = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gp > 0 ? ((r.wins / r.gp) * 100).toFixed(1) : "0.0";
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${fmtDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.pr.toFixed(1)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle("🏆 All-Time Power Rankings")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "All-time records across all seasons" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleGlobalPR(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  // Use all linked users cross-server
  const allUsers = await db.select({
    discordId: usersTable.discordId,
    team: usersTable.team,
    discordUsername: usersTable.discordUsername,
    balance: usersTable.balance,
    guildId: usersTable.guildId,
  }).from(usersTable)
    .where(and(isNotNull(usersTable.team), ne(usersTable.team, ""), ne(usersTable.discordUsername, "Open Slot")));

  if (!allUsers.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🌐 Global Power Rankings").setDescription("No linked users found globally.")], components: [backToHubRow()] });
    return;
  }

  const allIds = allUsers.map(u => u.discordId);
  const records = await db.select({
    discordId: globalUserRecordsTable.discordId,
    wins:      globalUserRecordsTable.wins,
    losses:    globalUserRecordsTable.losses,
    pointDiff: globalUserRecordsTable.pointDifferential,
  }).from(globalUserRecordsTable)
    .where(inArray(globalUserRecordsTable.discordId, allIds));

  const userMap = new Map(allUsers.map(u => [u.discordId, u]));

  const ranked = records.map(r => {
    const u    = userMap.get(r.discordId);
    const wins = r.wins ?? 0;
    const loss = r.losses ?? 0;
    const pd   = r.pointDiff ?? 0;
    return { label: u?.team ?? u?.discordUsername ?? r.discordId, wins, losses: loss, pd, pr: calcPRScore(wins, loss, pd), gp: wins + loss };
  }).sort((a, b) => b.pr - a.pr).slice(0, 20);

  const medals = ["🥇", "🥈", "🥉"];
  const lines  = ranked.map((r, i) => {
    const badge  = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gp > 0 ? ((r.wins / r.gp) * 100).toFixed(1) : "0.0";
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${fmtDiff(r.pd)} pts | ${winPct}% | PR: ${r.pr.toFixed(1)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🌐 Global Power Rankings")
    .setDescription(lines.join("\n") || "No data")
    .setFooter({ text: "Cross-server all-time cumulative rankings" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleEosPayouts(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const configMap = await getAllPayoutConfig(gid);
  const allKeys   = getAllPayoutKeys().filter(k => k.key.startsWith("eos_"));

  const cats: Record<string, string[]> = {};
  for (const meta of allKeys) {
    const val = configMap.get(meta.key as any) ?? meta.defaultValue;
    const cat = meta.category ?? "General";
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(`${meta.description}: **${val.toLocaleString()}** coins`);
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("💰 EOS Payout Tiers");

  for (const [cat, items] of Object.entries(cats)) {
    const chunk = items.slice(0, 20).join("\n");
    if (chunk) embed.addFields({ name: cat, value: chunk, inline: false });
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
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
    balance:         usersTable.balance,
  }).from(usersTable)
    .where(and(eq(usersTable.guildId, gid), isNotNull(usersTable.team), ne(usersTable.team, ""), ne(usersTable.discordUsername, "Open Slot")))
    .orderBy(usersTable.team);

  if (!users.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("🟢 Active Teams").setDescription("No active teams found.")], components: [backToHubRow()] });
    return;
  }

  const lines = users.map((u, i) => `**${i + 1}.** ${u.team} — <@${u.discordId}>`);

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`🟢 Active Teams (${users.length})`)
    .setDescription(lines.join("\n"))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [backToHubRow()] });
}

async function handleOpenTeams(interaction: ButtonInteraction, sess: ActionsSession) {
  const gid = interaction.guildId!;
  await interaction.deferUpdate();

  const season  = await getOrCreateActiveSeason(gid);
  const allTeams = await db.select({ id: franchiseMcaTeamsTable.id, fullName: franchiseMcaTeamsTable.fullName, conference: franchiseMcaTeamsTable.conference })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id))
    .orderBy(franchiseMcaTeamsTable.conference, franchiseMcaTeamsTable.fullName);

  const linkedTeams = await db.select({ team: usersTable.team })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, gid), isNotNull(usersTable.team), ne(usersTable.team, "")));

  const linkedSet   = new Set(linkedTeams.map(r => r.team?.toLowerCase()));
  const openTeams   = allTeams.filter(t => !linkedSet.has(t.fullName?.toLowerCase()));

  if (!openTeams.length) {
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Grey).setTitle("🔴 Open Teams").setDescription("All teams are currently claimed!")], components: [backToHubRow()] });
    return;
  }

  const afcOpen = openTeams.filter(t => t.conference === "AFC");
  const nfcOpen = openTeams.filter(t => t.conference === "NFC");

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(`🔴 Open Teams (${openTeams.length} available)`)
    .setTimestamp();

  if (afcOpen.length) embed.addFields({ name: "🔵 AFC", value: afcOpen.map(t => `• ${t.fullName}`).join("\n"), inline: true });
  if (nfcOpen.length) embed.addFields({ name: "🔴 NFC", value: nfcOpen.map(t => `• ${t.fullName}`).join("\n"), inline: true });

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
    );
  await interaction.showModal(modal);
}

async function handleViolationSubmit(interaction: ModalSubmitInteraction, sess: ActionsSession) {
  const weekNumber    = interaction.fields.getTextInputValue("week_number").trim();
  const violationType = interaction.fields.getTextInputValue("violation_type").trim();
  const offender      = interaction.fields.getTextInputValue("offender").trim();
  const rawDesc       = interaction.fields.getTextInputValue("description").trim();
  const description   = `[${violationType}] Against: ${offender}\n\n${rawDesc}`;
  const gid           = interaction.guildId!;

  const [season, user] = await Promise.all([
    getOrCreateActiveSeason(gid),
    getOrCreateUser(interaction.user.id, interaction.user.username, gid),
  ]);

  await db.insert(ruleViolationsTable).values({
    reporterId:   interaction.user.id,
    guildId:      gid,
    seasonId:     season.id,
    reporterTeam: user.team ?? null,
    opponentTeam: offender,
    weekNumber,
    description,
    status:       "pending",
  });

  // Send to commissioner log
  const logChannelId = await getGuildChannel(gid, CHANNEL_KEYS.COMMISSIONER_LOG)
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
          { name: "📝 Description",      value: description,   inline: false },
        )
        .setTimestamp();

      const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ac_rv_note:${interaction.user.id}`)
          .setLabel("📋 Add Commissioner Note")
          .setStyle(ButtonStyle.Secondary),
      );

      await (channel as TextChannel).send({ embeds: [reportEmbed], components: [btnRow] }).catch(console.error);
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
