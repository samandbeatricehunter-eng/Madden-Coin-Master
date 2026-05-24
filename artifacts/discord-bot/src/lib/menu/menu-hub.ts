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
import { THEME, goldEmbed } from "../discord/theme.js";
import type { ServerSettings } from "../db/server-settings.js";

// ── Banner image ──────────────────────────────────────────────────────────────

export const MENU_BANNER_FILENAME = "rec-embed-banner.png";
// Resolve relative to this source file so it works regardless of cwd
// (dev runs from repo root; prod runs from artifacts/discord-bot).
// __dirname here is .../artifacts/discord-bot/src/lib at runtime.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_BANNER_PATH = path.resolve(__dirname, "../../assets", MENU_BANNER_FILENAME);

export function buildMenuBannerAttachment(): AttachmentBuilder {
  return new AttachmentBuilder(MENU_BANNER_PATH, { name: MENU_BANNER_FILENAME });
}

// ── Tree types ────────────────────────────────────────────────────────────────

export interface MenuCtx {
  settings: ServerSettings;
  isAdmin: boolean;
  isCommissioner: boolean;
  seasonNum?: number;
  weekStr?: string;
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
    path: "coaches", emoji: "👔",
    label: "Coaches Office",
    description: "Rosters, press, training, age, dev",
    visible: MCA_VISIBLE,
    kind: "branch",
    children: [
      {
        path: "coaches.rosters", emoji: "🏈",
        label: "Rosters & Schedule",
        description: "My roster, all rosters, schedule",
        kind: "branch",
        children: [
          { path: "coaches.rosters.my",  emoji: "📋", label: "My Roster",   description: "View your team's roster",   kind: "action", action: "ac_myroster" },
          { path: "coaches.rosters.any", emoji: "👥", label: "All Rosters", description: "Browse any team's roster",  kind: "action", action: "ac_anyroster" },
          { path: "coaches.rosters.sch", emoji: "📅", label: "Schedule",    description: "Full season schedule",      kind: "action", action: "ac_schedule" },
        ],
      },
      {
        path: "coaches.press", emoji: "🎙️",
        label: "Press Conference",
        description: "Submit a post-game press conference",
        kind: "action", action: "ac_interview",
      },
      {
        path: "coaches.rivalries", emoji: "⚔️",
        label: "Rivalries",
        description: "Track H2H rivalries (coming soon)",
        kind: "placeholder",
        body:
          "**Rivalries** will track your head-to-head matchups against other " +
          "coaches — wins, losses, and rivalry-defining games.\n\n" +
          "🚧 This feature is not built yet. Check back soon!",
      },
      {
        path: "coaches.trainers", emoji: "🧑‍🏫",
        label: "Hire Positional Trainers",
        description: "Hire trainers (coming soon)",
        kind: "placeholder",
        body:
          "**Positional Trainers** will let you hire specialists to boost a " +
          "position group across your roster.\n\n" +
          "🚧 This feature is not built yet. Check back soon!",
      },
      {
        path: "coaches.buy_train", emoji: "🎓",
        label: "Purchase Training Packages",
        description: "Bronze/Silver/Gold attribute boosts",
        visible: ECO_VISIBLE,
        kind: "action", action: "ac_buy_training",
      },
      {
        path: "coaches.buy_age", emoji: "🔄",
        label: "Purchase Age Resets",
        description: "Reset a player's age",
        visible: (c) => ECO_VISIBLE(c) && !!c.settings.ageResetsEnabled,
        kind: "action", action: "ac_buy_agereset",
      },
      {
        path: "coaches.buy_dev", emoji: "📈",
        label: "Purchase Dev Ups",
        description: "Upgrade a player's dev trait",
        visible: (c) => ECO_VISIBLE(c) && !!c.settings.devUpgradesEnabled,
        kind: "action", action: "ac_buy_devup",
      },
    ],
  },

  {
    path: "gm", emoji: "💼",
    label: "GM's Office",
    description: "Bank, payouts, contracts, legends, customs",
    visible: ECO_VISIBLE,
    kind: "branch",
    children: [
      { path: "gm.bank", emoji: "🪙", label: "Bank", description: "Deposit, withdraw, send coins", kind: "action", action: "ac_coins" },
      {
        path: "gm.payouts", emoji: "💵",
        label: "Payouts",
        description: "Weekly, end-of-season, milestones",
        kind: "branch",
        children: [
          { path: "gm.payouts.wk",  emoji: "📅", label: "Weekly Payouts",        description: "This week's payouts",         kind: "action", action: "ac_weeklypayouts" },
          { path: "gm.payouts.eos", emoji: "💰", label: "End-of-Season Payouts", description: "End-of-season stat bonuses",  kind: "action", action: "ac_eospayouts" },
          { path: "gm.payouts.ms",  emoji: "🎯", label: "Milestone Payouts",     description: "Career milestone payouts",    kind: "action", action: "ac_milestonepayouts" },
        ],
      },
      {
        path: "gm.buy_ce", emoji: "📋",
        label: "Purchase Contract Extensions",
        description: "Extend a player's contract",
        visible: (c) => ECO_VISIBLE(c) && !!(c.settings.contractExtensionsEnabled ?? false),
        kind: "action", action: "ac_buy_contract_ext",
      },
      {
        path: "gm.buy_sr", emoji: "💵",
        label: "Purchase Salary Reductions",
        description: "Reduce a player's salary",
        visible: (c) => ECO_VISIBLE(c) && !!(c.settings.salaryReductionsEnabled ?? false),
        kind: "action", action: "ac_buy_salary_red",
      },
      {
        path: "gm.buy_br", emoji: "🎁",
        label: "Purchase Bonus Reductions",
        description: "Reduce a player's signing bonus",
        visible: (c) => ECO_VISIBLE(c) && !!(c.settings.bonusReductionsEnabled ?? false),
        kind: "action", action: "ac_buy_bonus_red",
      },
      {
        path: "gm.buy_lg", emoji: "🏆",
        label: "Purchase Legends",
        description: "Add a legend to your roster",
        visible: (c) => ECO_VISIBLE(c) && !!c.settings.legendsEnabled,
        kind: "action", action: "ac_buy_legend",
      },
      {
        path: "gm.buy_cp", emoji: "🎨",
        label: "Purchase Custom Players",
        description: "Create a custom player",
        visible: (c) => ECO_VISIBLE(c) && !!c.settings.customSuperstarsEnabled,
        kind: "action", action: "ac_buy_custom",
      },
    ],
  },

  {
    path: "wagers", emoji: "⚔️",
    label: "Wagers",
    description: "Challenge another user to a coin wager",
    visible: (c) => ECO_VISIBLE(c) && !!c.settings.wagerEnabled,
    kind: "action", action: "ac_wager",
  },

  {
    path: "standings", emoji: "📊",
    label: "Standings & Stats",
    description: "League standings, user stats, power rankings",
    visible: MCA_VISIBLE,
    kind: "branch",
    children: [
      {
        path: "standings.linfo", emoji: "📈",
        label: "League Info",
        description: "Standings and any user's stats",
        kind: "branch",
        children: [
          { path: "standings.linfo.stand",    emoji: "📈", label: "Standings",      description: "Current standings",  kind: "action", action: "ac_standings" },
          { path: "standings.linfo.anystats", emoji: "👤", label: "Any User Stats", description: "Stats for any user", kind: "action", action: "ac_anyuserstats" },
        ],
      },
      {
        path: "standings.pr", emoji: "🏆",
        label: "Power Rankings",
        description: "Season, all-time, global power rankings",
        kind: "branch",
        children: [
          { path: "standings.pr.season",  emoji: "🥇", label: "Season PR",   description: "This season's PR", kind: "action", action: "ac_seasonpr" },
          { path: "standings.pr.alltime", emoji: "🏆", label: "All-Time PR", description: "All-time PR",      kind: "action", action: "ac_alltimepr" },
          { path: "standings.pr.global",  emoji: "🌐", label: "Global PR",   description: "Global PR",        kind: "action", action: "ac_globalpr" },
        ],
      },
    ],
  },

  {
    path: "leagueinfo", emoji: "📜",
    label: "League Info",
    description: "Rules and reports",
    kind: "branch",
    children: [
      {
        path: "leagueinfo.rules", emoji: "📜",
        label: "Rules & Reports",
        description: "View rules, auto-pilot, report a violation",
        kind: "branch",
        children: [
          { path: "leagueinfo.rules.view",   emoji: "📜", label: "View Rules",       description: "Browse league rules",       kind: "action", action: "ac_rules" },
          { path: "leagueinfo.rules.auto",   emoji: "✈️", label: "Auto-Pilot",       description: "Submit auto-pilot request", kind: "action", action: "ac_autopilot" },
          { path: "leagueinfo.rules.report", emoji: "🚨", label: "Report Violation", description: "Report a rule violation",   kind: "action", action: "ac_violation" },
        ],
      },
    ],
  },

  {
    path: "ops", emoji: "⚙️",
    label: "League Operations",
    description: "Commissioner tools",
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

function buildSelector(
  placeholder: string,
  options: MenuNode[],
  includeHomeOption: boolean,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_cat")
    .setPlaceholder(placeholder);

  for (const n of options) {
    select.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(n.label.substring(0, 100))
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
  return [buildSelector("📂 Select a category…", cats, false)];
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
  | "commissioner_office"
  | "week" | "ao_payouts" | "post" | "league_data"
  | "user_data" | "store" | "server" | "troubleshoot";

interface AdminCategoryDef {
  id: AdminCategoryId;
  emoji: string;
  label: string;
  description: string;
}

const ADMIN_CATEGORIES: AdminCategoryDef[] = [
  { id: "commissioner_office", emoji: "🏛️", label: "Commissioner's Office", description: "Pending purchases, payouts, interviews, stream/highlight + recent history" },
  { id: "week",         emoji: "📅", label: "Week & Season",   description: "Set week, advance week, set season number" },
  { id: "ao_payouts",   emoji: "💰", label: "Payouts",         description: "All payout management" },
  { id: "post",         emoji: "📢", label: "Post Content",    description: "Matchups, GOTW, draft lottery" },
  { id: "league_data",  emoji: "🏈", label: "League Data",     description: "EA connection, imports, season data" },
  { id: "user_data",    emoji: "👤", label: "User Data",       description: "Manage user economy, records, links" },
  { id: "store",        emoji: "🏪", label: "Store Settings",  description: "Archetypes, templates, prices, caps" },
  { id: "server",       emoji: "⚙️", label: "Server Settings", description: "Features, init, rules, admins, waitlist" },
  { id: "troubleshoot", emoji: "🔧", label: "Troubleshoot",    description: "Repair and maintenance tools" },
];

interface CategoryPage {
  embed: EmbedBuilder;
  rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

export function buildAdminHubPage(seasonNum?: number, weekStr?: string): CategoryPage {
  const embed = goldEmbed({
    title:       "⚙️ League Operations",
    description:
      "Commissioner tools — choose a category to manage your league.\n\n" +
      ADMIN_CATEGORIES.map((c) => `${c.emoji} **${c.label}** — ${c.description}`).join("\n"),
    seasonNum, weekStr,
    variant: "admin",
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_admin_cat")
    .setPlaceholder("🔧 Select an admin category…")
    .addOptions(
      ADMIN_CATEGORIES.map((c) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.label)
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
        .setDescription("Return to League Operations")
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
    case "week": {
      buttons.push(
        btn("ao_set_week",       "📅 Set Week"),
        btn("ao_advance_week",   "⏩ Advance Week"),
        btn("ao_set_season_num", "🔢 Set Season"),
      );
      break;
    }
    case "ao_payouts": {
      buttons.push(btn("ao_payouts", "💰 Open Payouts Hub", ButtonStyle.Success));
      break;
    }
    case "post": {
      buttons.push(
        btn("ao_post_matchups",       "📋 Matchups/GOTW",     ButtonStyle.Secondary),
        btn("ao_post_game_channels",  "🎮 Game Channels",     ButtonStyle.Secondary),
        btn("ao_lottery",             "🎰 Draft Lottery",     ButtonStyle.Secondary),
      );
      break;
    }
    case "league_data":  buttons.push(btn("ao_league_data",    "🏈 Open League Data Hub",    ButtonStyle.Success)); break;
    case "user_data":    buttons.push(btn("ao_user_data",      "👤 Open User Data Hub",      ButtonStyle.Success)); break;
    case "store":        buttons.push(btn("ao_store_settings", "🏪 Open Store Settings Hub", ButtonStyle.Success)); break;
    case "server":       buttons.push(btn("ao_server_settings","⚙️ Open Server Settings Hub", ButtonStyle.Success)); break;
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
