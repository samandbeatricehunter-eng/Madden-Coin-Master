/**
 * Selector-based /menu hub with nested submenus.
 *
 * Every menu screen is a StringSelectMenu (customId: `menu_cat`) whose option
 * `value` is a dot-delimited tree path (e.g. `coaches`, `coaches.rosters.my`).
 * Each selector also includes a "🏠 Back to Main Menu" option with value
 * `__home` — there are no back/close buttons on menu screens.
 *
 * Leaf nodes dispatch to existing `ac_*` action handlers via
 * `handleActionsInteraction(interaction, overrideId)`.
 *
 * The admin "League Operations" leaf delegates to the existing
 * `buildAdminHubPage` so the admin sub-hub is unchanged.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder, AttachmentBuilder,
} from "discord.js";
import path from "path";
import { fileURLToPath } from "url";
import { statSync } from "fs";
import { THEME, goldEmbed } from "../discord/theme.js";
import type { ServerSettings } from "../db/server-settings.js";

// ── Banner image ──────────────────────────────────────────────────────────────

export const MENU_BANNER_FILENAME = "rec-embed-banner.png";
// Resolve relative to this source file. __dirname here is
// .../artifacts/discord-bot/src/lib/menu at runtime, and the asset lives in
// .../artifacts/discord-bot/assets/, so we walk up THREE levels.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_BANNER_PATH = path.resolve(__dirname, "../../../assets", MENU_BANNER_FILENAME);
const MENU_BANNER_EXISTS = (() => {
  try { return statSync(MENU_BANNER_PATH).isFile(); }
  catch { return false; }
})();
if (!MENU_BANNER_EXISTS) {
  console.warn(`[menu-hub] banner not found at ${MENU_BANNER_PATH} — menu will render without banner`);
}

export function buildMenuBannerAttachment(): AttachmentBuilder[] {
  if (!MENU_BANNER_EXISTS) return [];
  return [new AttachmentBuilder(MENU_BANNER_PATH, { name: MENU_BANNER_FILENAME })];
}

// ── Tree types ────────────────────────────────────────────────────────────────

export interface MenuCtx {
  settings: ServerSettings;
  isAdmin: boolean;
  isCommissioner: boolean;
  seasonNum?: number;
  weekStr?: string;
  // Unaddressed-item counts surfaced as "(N)" suffixes on menu labels.
  commOfficeTotal?: number;     // sum of Commissioner's Office pending items
  gotwUnvotedCount?: number;    // GOTW matchups the user hasn't voted on
  gotyUnvotedCount?: number;    // 1 if active GOTY round and user hasn't voted
  gotyActive?: boolean;         // whether an open GOTY round exists
}

type MenuBranch        = { kind: "branch";      children: MenuNode[] };
type MenuLeafAction    = { kind: "action";      action: string };
type MenuLeafPlaceholder = { kind: "placeholder"; body: string };
type MenuLeafOps       = { kind: "ops" }; // delegates to buildAdminHubPage

export type MenuNode = {
  path: string;          // dot-delimited from root, also the select option value
  emoji: string;
  label: string;
  description: string;
  visible?: (ctx: MenuCtx) => boolean;
} & (MenuBranch | MenuLeafAction | MenuLeafPlaceholder | MenuLeafOps);

// ── Tree definition ───────────────────────────────────────────────────────────

const MCA_VISIBLE  = (c: MenuCtx) => c.settings.mcaImportEnabled || c.isAdmin;
const ECO_VISIBLE  = (c: MenuCtx) => !!c.settings.coinEconomy;

const ROOT_NODES: MenuNode[] = [
  {
    path: "coaches_office", emoji: "🏈",
    label: "Coaches Office",
    description: "Rosters, schedule, store, trainers, press, rivalries, cap tools",
    visible: MCA_VISIBLE,
    kind: "branch",
    children: [
      {
        path: "coaches_office.rosters", emoji: "👥",
        label: "Rosters",
        description: "My team, all rosters, and free agents",
        kind: "branch",
        children: [
          { path: "coaches_office.rosters.myteam", emoji: "📋", label: "My Team", description: "Open your roster and team card", kind: "action", action: "ac_myroster" },
          { path: "coaches_office.rosters.all", emoji: "👥", label: "All Rosters", description: "Browse any team's roster", kind: "action", action: "ac_anyroster" },
          { path: "coaches_office.rosters.freeagents", emoji: "🟢", label: "Free Agents", description: "Browse available free agents", kind: "action", action: "ac_freeagents" },
        ],
      },
      {
        path: "coaches_office.management", emoji: "🧠",
        label: "Management",
        description: "Schedule, store, trainers, press, rivalries, cap, potential FAs",
        kind: "branch",
        children: [
          { path: "coaches_office.management.schedule", emoji: "📅", label: "Schedule", description: "View the full season schedule", kind: "action", action: "ac_schedule" },
          {
            path: "coaches_office.management.store", emoji: "🛒",
            label: "Store",
            description: "Legends, custom players, upgrades, training packages, and contracts",
            visible: ECO_VISIBLE,
            kind: "branch",
            children: [
              {
                path: "coaches_office.management.store.players", emoji: "⭐",
                label: "Players",
                description: "Purchase legends or build custom players",
                kind: "branch",
                children: [
                  { path: "coaches_office.management.store.players.legends", emoji: "⭐", label: "Legends", description: "Purchase legends", kind: "action", action: "ac_legends" },
                  { path: "coaches_office.management.store.players.custom", emoji: "🧬", label: "Custom Players", description: "Build custom players", kind: "action", action: "ac_custom_players" },
                ],
              },
              {
                path: "coaches_office.management.store.upgrades", emoji: "⬆️",
                label: "Upgrades",
                description: "Dev trait upgrades and age resets",
                kind: "branch",
                children: [
                  { path: "coaches_office.management.store.upgrades.dev", emoji: "⬆️", label: "Dev Trait Upgrade", description: "Upgrade a player's dev trait", kind: "action", action: "ac_buy_devup" },
                  { path: "coaches_office.management.store.upgrades.age", emoji: "⏳", label: "Age Reset", description: "Reset a player's age", kind: "action", action: "ac_buy_agereset" },
                ],
              },
              { path: "coaches_office.management.store.training", emoji: "📈", label: "Training Packages", description: "Buy one-time training packages", kind: "action", action: "ac_buy_training" },
              {
                path: "coaches_office.management.store.contracts", emoji: "📄",
                label: "Contracts",
                description: "Contract extensions, salary reductions, and bonus reductions",
                kind: "branch",
                children: [
                  { path: "coaches_office.management.store.contracts.extension", emoji: "📄", label: "Contract Extension", description: "Extend a player's contract", kind: "action", action: "ac_buy_contract_ext" },
                  { path: "coaches_office.management.store.contracts.salary", emoji: "💸", label: "Salary Reduction", description: "Reduce a player's salary", kind: "action", action: "ac_buy_salary_red" },
                  { path: "coaches_office.management.store.contracts.bonus", emoji: "💰", label: "Bonus Reduction", description: "Reduce a player's bonus", kind: "action", action: "ac_buy_bonus_red" },
                ],
              },
            ],
          },
          { path: "coaches_office.management.trainers", emoji: "🏋️", label: "Hire/Manage Trainers", description: "Hire positional trainers or manage active trainer contracts, focus, and firing", kind: "action", action: "ac_my_trainers" },
          { path: "coaches_office.management.press", emoji: "🎙️", label: "Call Press Conference", description: "Answer interview questions and earn coins", kind: "action", action: "ac_press_open" },
          { path: "coaches_office.management.rivalries", emoji: "⚔️", label: "Rivalries", description: "View your top H2H rivalries", kind: "action", action: "ac_rivalries" },
          { path: "coaches_office.management.cap", emoji: "💼", label: "Cap Manager", description: "Open cap management tools", kind: "action", action: "ac_cap_manager" },
          { path: "coaches_office.management.potential_fas", emoji: "🔎", label: "Potential FAs", description: "Browse potential free agents", kind: "action", action: "ac_cap_pfa" },
        ],
      },
    ],
  },
  { path: "wallet", emoji: "🏦",
    label: "Wallet",
    description: "Balances, wagers, transfers, transactions, purchases",
    visible: ECO_VISIBLE,
    kind: "branch",
    children: [
      { path: "wallet.balance", emoji: "💰", label: "Wallet Summary", description: "Wallet, global wallet, savings, and interest estimates", kind: "action", action: "ac_coins" },
      { path: "wallet.wager", emoji: "⚔️", label: "Place Wager", description: "Challenge another user to a coin wager", visible: (c) => ECO_VISIBLE(c) && !!c.settings.wagerEnabled, kind: "action", action: "ac_wager" },
      { path: "wallet.transfer", emoji: "🏦", label: "Transfer Money", description: "Deposit or withdraw savings", kind: "action", action: "ac_transfer" },
      { path: "wallet.transactions", emoji: "🧾", label: "Transactions", description: "Recent transactions and milestone payouts", kind: "action", action: "ac_myprofile" },
      { path: "wallet.pending", emoji: "⏳", label: "Pending Purchases", description: "Pending purchases awaiting commissioner application", kind: "action", action: "ac_myprofile" },
    ],
  },

  {
    path: "league_center", emoji: "📊",
    label: "League Center",
    description: "Standings, rankings, stats, league info",
    visible: MCA_VISIBLE,
    kind: "branch",
    children: [
      { path: "league_center.standings", emoji: "📈", label: "Standings", description: "Current league standings", kind: "action", action: "ac_standings" },
      { path: "league_center.sos", emoji: "🧱", label: "Strength of Schedule", description: "H2H opponent strength; CPU games excluded", kind: "action", action: "ac_strength_of_schedule" },
      {
        path: "league_center.power_rankings", emoji: "🥇",
        label: "Power Rankings",
        description: "Season, all-time, and global rankings",
        kind: "branch",
        children: [
          { path: "league_center.power_rankings.season", emoji: "🥇", label: "Season PR", description: "This season's power rankings", kind: "action", action: "ac_seasonpr" },
          { path: "league_center.power_rankings.alltime", emoji: "🏆", label: "All-Time PR", description: "All-time league power rankings", kind: "action", action: "ac_alltimepr" },
          { path: "league_center.power_rankings.global", emoji: "🌐", label: "Global PR", description: "Global cross-server power rankings", kind: "action", action: "ac_globalpr" },
        ],
      },
      { path: "league_center.competitive_rating", emoji: "🏆", label: "Competitive Rating", description: "Global H2H rating ranked inside this league", kind: "action", action: "ac_competitive_rating" },
      {
        path: "league_center.stats", emoji: "📊",
        label: "Stats",
        description: "User and player stats",
        kind: "branch",
        children: [
          { path: "league_center.stats.users", emoji: "👤", label: "User Stats", description: "View any user's stats", kind: "action", action: "ac_anyuserstats" },
          { path: "league_center.stats.players", emoji: "🏈", label: "Player Stats", description: "Browse all players and open player cards", kind: "action", action: "ac_allplayers" },
        ],
      },
      {
        path: "league_center.info", emoji: "📜",
        label: "League Info",
        description: "Rules, teams, roles, milestones",
        kind: "branch",
        children: [
          { path: "league_center.info.rules", emoji: "📜", label: "Rules", description: "Browse league rules", kind: "action", action: "ac_rules" },
          { path: "league_center.info.open_teams", emoji: "🔴", label: "Open Teams", description: "View open teams", kind: "action", action: "ac_openteams" },
          { path: "league_center.info.active_teams", emoji: "🟢", label: "Active Teams", description: "View active user team assignments", kind: "action", action: "ac_activeteams" },
          { path: "league_center.info.roles", emoji: "🏅", label: "League Roles", description: "View automated roles and current holders", kind: "action", action: "ac_view_roles" },
          { path: "league_center.info.milestones", emoji: "🎯", label: "Milestones", description: "Career milestone payouts", kind: "action", action: "ac_milestonepayouts" },
        ],
      },
    ],
  },

  {
    path: "media_room", emoji: "🎙️",
    label: "Media Room",
    description: "Streams, GOTW, award voting",
    kind: "branch",
    children: [
      { path: "media_room.streams", emoji: "📺", label: "Streams", description: "View streams posted in the last 1.5 hours", kind: "action", action: "ac_active_streams" },
      { path: "media_room.gotw", emoji: "🏆", label: "GOTW Voting", description: "Vote on this week's Game of the Week", kind: "action", action: "ac_gotw_vote" },
      {
        path: "media_room.awards", emoji: "🎬",
        label: "Award Voting",
        description: "Game of the Year and Play of the Year",
        kind: "branch",
        children: [
          { path: "media_room.awards.goty", emoji: "🎮", label: "GOTY", description: "Nominate, browse, vote, and view winners", kind: "action", action: "ac_goty_hub" },
          { path: "media_room.awards.poty", emoji: "🎬", label: "POTY", description: "Browse and vote on POTY highlights", kind: "action", action: "ac_poty_vote" },
        ],
      },
    ],
  },

  {
    path: "commissioner", emoji: "⚙️",
    label: "Commissioner's Office",
    description: "Staff tools, reviews, imports, economy, users, settings",
    visible: (c) => c.isAdmin || c.isCommissioner,
    kind: "ops",
  },
];

// ── Tree lookup ───────────────────────────────────────────────────────────────

export const MENU_HOME_VALUE = "__home";
export const MENU_ADMIN_HOME_VALUE = "__admin_home";
export const MENU_UNLINKED_HOME_VALUE = "__unlinked_home";

export function getRootNodes(): MenuNode[] {
  return ROOT_NODES;
}

export function findNode(path: string): MenuNode | null {
  function walk(nodes: MenuNode[]): MenuNode | null {
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.kind === "branch") {
        const r = walk(n.children);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(ROOT_NODES);
}

function filterVisible(nodes: MenuNode[], ctx: MenuCtx): MenuNode[] {
  return nodes.filter((n) => !n.visible || n.visible(ctx));
}

// ── Hub embed (banner only) ───────────────────────────────────────────────────

export function buildMenuHubEmbed(
  _settings?: ServerSettings,
  _isAdmin?: boolean,
  _seasonNum?: number,
  _weekStr?: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(THEME.GOLD)
    .setImage(`attachment://${MENU_BANNER_FILENAME}`);
}

// ── Selector row builders ─────────────────────────────────────────────────────

function labelWithBadge(node: MenuNode, ctx?: MenuCtx): string {
  let badge = 0;
  if (ctx) {
    const action = node.kind === "action" ? node.action : "";
    if (node.path === "media_room.gotw" || action === "ac_gotw_vote") {
      badge = ctx.gotwUnvotedCount ?? 0;
    } else if (node.path === "media_room.goty" || action === "ac_goty_hub") {
      badge = ctx.gotyUnvotedCount ?? 0;
    }
  }
  const base = node.label.substring(0, 100);
  if (badge > 0) {
    const suffix = ` (${badge})`;
    return (base.length + suffix.length > 100 ? base.slice(0, 100 - suffix.length) : base) + suffix;
  }
  return base;
}

function buildSelector(
  placeholder: string,
  options: MenuNode[],
  includeHomeOption: boolean,
  ctx?: MenuCtx,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_cat")
    .setPlaceholder(placeholder);

  for (const n of options) {
    select.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(labelWithBadge(n, ctx))
        .setValue(n.path)
        .setDescription(n.description.substring(0, 100))
        .setEmoji(n.emoji),
    );
  }
  if (includeHomeOption) {
    select.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Back to Main Menu")
        .setValue(MENU_HOME_VALUE)
        .setDescription("Return to the top menu")
        .setEmoji("🏠"),
    );
  }
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export function buildMenuHubRows(
  ctx: MenuCtx,
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const cats = filterVisible(ROOT_NODES, ctx);
  return [buildSelector("📂 Select a category…", cats, false, ctx)];
}

// ── Sub-page rendering ────────────────────────────────────────────────────────

export interface MenuPage {
  embed: EmbedBuilder;
  rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
}

/** Render a branch (sub-menu) or placeholder node as a selector page. */
export function buildBranchPage(node: MenuNode, ctx: MenuCtx): MenuPage {
  if (node.kind === "placeholder") {
    const embed = goldEmbed({
      title: `${node.emoji} ${node.label}`,
      description: node.body,
      seasonNum: ctx.seasonNum,
      weekStr: ctx.weekStr,
    });
    return {
      embed,
      rows: [buildSelector("📂 Select an option…", [], true)],
    };
  }

  if (node.kind !== "branch") {
    // shouldn't happen, but render a safe fallback
    const embed = goldEmbed({
      title: `${node.emoji} ${node.label}`,
      description: node.description,
      seasonNum: ctx.seasonNum,
      weekStr: ctx.weekStr,
    });
    return { embed, rows: [buildSelector("📂 Select an option…", [], true)] };
  }

  const children = filterVisible(node.children, ctx);
  const embed = goldEmbed({
    title: `${node.emoji} ${node.label}`,
    description: `${node.description}\n\nPick an option below.`,
    seasonNum: ctx.seasonNum,
    weekStr: ctx.weekStr,
  });
  return {
    embed,
    rows: [buildSelector("📂 Select an option…", children, true)],
  };
}

// ── Admin hub (unchanged: buttons + nested admin selector) ────────────────────

export type AdminCategoryId =
  | "commissioner_office" | "gameday_review"
  | "league_data" | "ao_payouts" | "user_data"
  | "store" | "server" | "troubleshoot";

interface AdminCategoryDef {
  id: AdminCategoryId;
  emoji: string;
  label: string;
  description: string;
}

const ADMIN_CATEGORIES: AdminCategoryDef[] = [
  { id: "commissioner_office", emoji: "🏛️", label: "Review Queues",  description: "Pending review and gameday review queues" },
  { id: "league_data",         emoji: "📥", label: "Imports & Data", description: "EA import and league data sync tools" },
  { id: "gameday_review",      emoji: "🎮", label: "Gameday Tools",  description: "Gameday review, channel rebuilds, and GOTW reruns" },
  { id: "ao_payouts",          emoji: "💰", label: "Economy",        description: "Payouts, corrections, milestone and EOS payout tools" },
  { id: "user_data",           emoji: "👤", label: "Users & Store",  description: "User data, team links, store, archetypes, and prices" },
  { id: "server",              emoji: "⚙️", label: "Server Tools",   description: "Features, channels, rules, admins, and server configuration" },
  { id: "troubleshoot",        emoji: "🔧", label: "Troubleshoot",   description: "Repair, maintenance, audits, and bug reporting" },
];

interface CategoryPage {
  embed: EmbedBuilder;
  rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

export function buildAdminHubPage(
  seasonNum?: number,
  weekStr?: string,
  commOfficeTotal?: number,
): CategoryPage {
  const adminLabel = (c: AdminCategoryDef): string => {
    if (c.id === "commissioner_office" && commOfficeTotal && commOfficeTotal > 0) {
      return `${c.label} (${commOfficeTotal})`.slice(0, 100);
    }
    return c.label.slice(0, 100);
  };

  const embed = goldEmbed({
    title:       "⚙️ Commissioner's Office",
    description:
      "Commissioner tools — choose a staff workspace to manage your league.\n\n" +
      ADMIN_CATEGORIES.map((c) => `${c.emoji} **${adminLabel(c)}** — ${c.description}`).join("\n"),
    seasonNum, weekStr,
    variant: "admin",
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_admin_cat")
    .setPlaceholder("🔧 Select an admin category…")
    .addOptions(
      ADMIN_CATEGORIES.map((c) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(adminLabel(c))
          .setValue(c.id)
          .setDescription(c.description.substring(0, 100))
          .setEmoji(c.emoji),
      ),
    );

  const homeSelect = new StringSelectMenuBuilder()
    .setCustomId("menu_cat")
    .setPlaceholder("🏠 Navigation…")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Back to Main Menu")
        .setValue(MENU_HOME_VALUE)
        .setDescription("Return to the top menu")
        .setEmoji("🏠"),
    );

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(homeSelect),
  ];

  return { embed, rows };
}

/** Selector row used at the bottom of admin sub-pages — replaces the old
 *  menu_admin_back / menu_back / ac_close button row. */
function adminSubPageNavRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_cat")
    .setPlaceholder("🧭 Navigation…")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Back to Admin Hub")
        .setValue(MENU_ADMIN_HOME_VALUE)
        .setDescription("Return to Commissioner’s Office")
        .setEmoji("⬅"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Back to Main Menu")
        .setValue(MENU_HOME_VALUE)
        .setDescription("Return to the top menu")
        .setEmoji("🏠"),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/** Selector row used at the bottom of unlinked sub-pages — replaces the old
 *  menu_back / ac_close button row. */
function unlinkedSubPageNavRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_unlinked_cat")
    .setPlaceholder("🧭 Navigation…")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Back to Main Menu")
        .setValue(MENU_UNLINKED_HOME_VALUE)
        .setDescription("Return to the top menu")
        .setEmoji("🏠"),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function chunkRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
  }
  return rows;
}

function btn(id: string, label: string, style: ButtonStyle = ButtonStyle.Primary): ButtonBuilder {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

export function buildAdminCategoryPage(
  catId: AdminCategoryId,
  seasonNum?: number,
  weekStr?: string,
): CategoryPage {
  const def = ADMIN_CATEGORIES.find((c) => c.id === catId)!;
  const embed = goldEmbed({
    title:       `${def.emoji} ${def.label}`,
    description: `${def.description}\n\nPick an action below.`,
    seasonNum, weekStr,
    variant: "admin",
  });

  let buttons: ButtonBuilder[] = [];

  switch (catId) {
    case "league_data": {
      buttons.push(
        btn("ao_league_data", "📥 Import EA Data", ButtonStyle.Success),
        btn("ao_advance_week", "⏩ Advance Week", ButtonStyle.Primary),
        btn("ao_set_week", "📅 Set Current Week", ButtonStyle.Secondary),
        btn("ao_set_season_num", "🔢 Set Season Number", ButtonStyle.Secondary),
      );
      break;
    }
    case "gameday_review": {
      buttons.push(
        btn("ao_gameday_review", "🎮 Open Gameday Review", ButtonStyle.Success),
        btn("ao_post_game_channels", "🎮 Create Gameday Channel", ButtonStyle.Primary),
        btn("ao_post_matchups", "🏆 Re-Run GOTW", ButtonStyle.Secondary),
      );
      break;
    }
    case "commissioner_office": {
      buttons.push(
        btn("co_home", "🏛️ Pending Review", ButtonStyle.Success),
        btn("ao_gameday_review", "🎮 Gameday Review", ButtonStyle.Primary),
      );
      break;
    }
    case "ao_payouts": {
      buttons.push(btn("ao_payouts", "💰 Manage Economy", ButtonStyle.Success));
      break;
    }
    case "user_data": {
      buttons.push(
        btn("ao_user_data", "👤 Manage Users", ButtonStyle.Success),
        btn("ao_store_settings", "🏪 Manage Store", ButtonStyle.Primary),
      );
      break;
    }
    case "store":        buttons.push(btn("ao_store_settings", "🏪 Manage Store", ButtonStyle.Success)); break;
    case "server":       buttons.push(btn("ao_server_settings","⚙️ Server Settings", ButtonStyle.Success)); break;
    case "troubleshoot": {
      buttons.push(
        btn("ao_troubleshoot", "🔧 Open Troubleshoot Hub", ButtonStyle.Danger),
        btn("ao_report_bug",   "🐛 Report Bug",            ButtonStyle.Danger),
      );
      break;
    }
  }

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  for (const r of chunkRows(buttons)) rows.push(r);
  rows.push(adminSubPageNavRow());

  return { embed, rows };
}

// ── Unlinked welcome hub (users not yet on a team) ────────────────────────────

export function buildUnlinkedMenuEmbed(_seasonNum?: number, _weekStr?: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(THEME.GOLD)
    .setImage(`attachment://${MENU_BANNER_FILENAME}`);
}

export function buildUnlinkedMenuRows(): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  // Unlinked users need Team Requests access, plus read-only browsing.
  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_unlinked_cat")
    .setPlaceholder("📂 Select a category…")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Team Requests").setValue("teams")
        .setDescription("Open teams, waitlist, request a team").setEmoji("🟢"),
      new StringSelectMenuOptionBuilder().setLabel("Rosters & Schedule").setValue("rosters")
        .setDescription("Browse any team and the schedule").setEmoji("🏈"),
      new StringSelectMenuOptionBuilder().setLabel("League Info").setValue("league")
        .setDescription("Standings and user stats").setEmoji("📊"),
      new StringSelectMenuOptionBuilder().setLabel("Power Rankings").setValue("rankings")
        .setDescription("Season, all-time, global").setEmoji("🏆"),
      new StringSelectMenuOptionBuilder().setLabel("Rules & Reports").setValue("rules")
        .setDescription("Rules and report violations").setEmoji("📜"),
    );

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
}

/** Unlinked legacy page builder — kept for the unlinked select menu, which
 *  still uses the old flat category buttons (Team Requests etc.). */
export function buildUnlinkedCategoryPage(
  catId: "teams" | "rosters" | "league" | "rankings" | "rules",
  ctx: MenuCtx,
): CategoryPage {
  const def: Record<typeof catId, { emoji: string; label: string; description: string }> = {
    teams:    { emoji: "🟢", label: "Team Requests",      description: "Open teams, waitlist, request a team" },
    rosters:  { emoji: "🏈", label: "Rosters & Schedule", description: "Browse any team and the schedule" },
    league:   { emoji: "📊", label: "League Info",        description: "Standings and user stats" },
    rankings: { emoji: "🏆", label: "Power Rankings",     description: "Season, all-time, global" },
    rules:    { emoji: "📜", label: "Rules & Reports",    description: "Rules and report violations" },
  };
  const d = def[catId];
  const embed = goldEmbed({
    title:       `${d.emoji} ${d.label}`,
    description: `${d.description}\n\nPick an action below.`,
    seasonNum: ctx.seasonNum, weekStr: ctx.weekStr,
  });
  let buttons: ButtonBuilder[] = [];
  switch (catId) {
    case "teams":
      buttons.push(
        btn("ac_openteams",       "🔴 Open Teams",       ButtonStyle.Secondary),
        btn("ac_activeteams",     "🟢 User Teams",       ButtonStyle.Secondary),
        btn("ac_req_openteam",    "📬 Request Team"),
        btn("ac_req_addwaitlist", "📋 Add Waitlist",     ButtonStyle.Success),
        btn("ac_req_rmwaitlist",  "❌ Leave Waitlist",   ButtonStyle.Danger),
      );
      break;
    case "rosters":
      buttons.push(
        btn("ac_myroster",  "📋 My Roster"),
        btn("ac_anyroster", "👥 Rosters"),
        btn("ac_schedule",  "📅 Schedule"),
      );
      break;
    case "league":
      buttons.push(
        btn("ac_standings",    "📈 Standings"),
        btn("ac_anyuserstats", "👤 Any User Stats"),
      );
      break;
    case "rankings":
      buttons.push(
        btn("ac_seasonpr",  "🥇 Season PR"),
        btn("ac_alltimepr", "🏆 All-Time PR"),
        btn("ac_globalpr",  "🌐 Global PR"),
      );
      break;
    case "rules":
      buttons.push(
        btn("ac_rules",     "📜 View Rules",       ButtonStyle.Secondary),
        btn("ac_autopilot", "✈️ Auto-Pilot",       ButtonStyle.Secondary),
        btn("ac_violation", "🚨 Report Violation", ButtonStyle.Danger),
      );
      break;
  }
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  for (const r of chunkRows(buttons)) rows.push(r);
  rows.push(unlinkedSubPageNavRow());
  return { embed, rows };
}
