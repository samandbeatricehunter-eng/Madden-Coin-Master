/**
 * New selector-based /menu hub.
 *
 * Top-level navigation is a StringSelectMenu (customId: `menu_cat`).
 * Each category renders a sub-page with the existing `ac_*` (user) or `ao_*`
 * (admin) action buttons so all existing handlers keep working unchanged.
 *
 * Admin operations are nested inside the user menu under "League Operations"
 * which only renders for admins.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder,
} from "discord.js";
import { THEME, goldEmbed } from "./theme.js";
import type { ServerSettings } from "./server-settings.js";

// ── Category catalog ──────────────────────────────────────────────────────────

export type UserCategoryId =
  | "economy" | "rosters" | "league" | "rankings"
  | "payouts" | "rules" | "teams" | "admin";

export type AdminCategoryId =
  | "week" | "ao_payouts" | "post" | "league_data"
  | "user_data" | "store" | "server" | "troubleshoot";

interface CategoryDef<T extends string> {
  id: T;
  emoji: string;
  label: string;
  description: string;
}

const USER_CATEGORIES: CategoryDef<UserCategoryId>[] = [
  { id: "economy",  emoji: "💰", label: "Economy & Social",   description: "Purchases, wagers, coins, interviews, tweets" },
  { id: "rosters",  emoji: "🏈", label: "Rosters & Schedule", description: "My roster, all rosters, schedule" },
  { id: "league",   emoji: "📊", label: "League Info",        description: "Standings, any user's stats" },
  { id: "rankings", emoji: "🏆", label: "Power Rankings",     description: "Season PR, all-time PR, global PR" },
  { id: "payouts",  emoji: "💵", label: "Payouts",            description: "Weekly, end-of-season, and milestones" },
  { id: "teams",    emoji: "🟢", label: "Team Requests",      description: "Open teams, waitlist, request a team" },
  { id: "rules",    emoji: "📜", label: "Rules & Reports",    description: "Rules, auto-pilot, report a violation" },
  { id: "admin",    emoji: "⚙️", label: "League Operations",  description: "Commissioner tools (admin only)" },
];

const ADMIN_CATEGORIES: CategoryDef<AdminCategoryId>[] = [
  { id: "week",         emoji: "📅", label: "Week & Season",   description: "Set week, advance week, set season number" },
  { id: "ao_payouts",   emoji: "💰", label: "Payouts",         description: "All payout management" },
  { id: "post",         emoji: "📢", label: "Post Content",    description: "Matchups, GOTW, articles, media cycle" },
  { id: "league_data",  emoji: "🏈", label: "League Data",     description: "EA connection, imports, season data" },
  { id: "user_data",    emoji: "👤", label: "User Data",       description: "Manage user economy, records, links" },
  { id: "store",        emoji: "🏪", label: "Store Settings",  description: "Archetypes, templates, prices, caps" },
  { id: "server",       emoji: "⚙️", label: "Server Settings", description: "Features, init, rules, admins, waitlist" },
  { id: "troubleshoot", emoji: "🔧", label: "Troubleshoot",    description: "Repair and maintenance tools" },
];

// ── Hub embed + selector ──────────────────────────────────────────────────────

function buildHubHeader(settings: ServerSettings, isAdmin: boolean): string {
  const lines: string[] = [];
  lines.push("Choose a category from the menu below.");
  lines.push("All replies are private — only you can see them.");
  if (!settings.coinEconomy) lines.push("\n_Economy features are disabled by the commissioner._");
  if (isAdmin) lines.push("\n👑 **You have admin access** — see _League Operations_ for commissioner tools.");
  return lines.join("\n");
}

export function buildMenuHubEmbed(
  settings: ServerSettings,
  isAdmin: boolean,
  seasonNum?: number,
  weekStr?: string,
): EmbedBuilder {
  return goldEmbed({
    title: "🏈 League Menu",
    description: buildHubHeader(settings, isAdmin),
    seasonNum, weekStr,
  });
}

function visibleUserCategories(settings: ServerSettings, isAdmin: boolean): CategoryDef<UserCategoryId>[] {
  const mcaVisible   = settings.mcaImportEnabled || isAdmin;
  const ecoVisible   = settings.coinEconomy;
  return USER_CATEGORIES.filter((c) => {
    if (c.id === "admin")    return isAdmin;
    if (c.id === "economy")  return ecoVisible;
    if (c.id === "payouts")  return ecoVisible;
    if (c.id === "rosters")  return mcaVisible;
    if (c.id === "league")   return mcaVisible;
    return true;
  });
}

export function buildMenuHubRows(
  settings: ServerSettings,
  isAdmin: boolean,
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const cats = visibleUserCategories(settings, isAdmin);

  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_cat")
    .setPlaceholder("📂 Select a category…")
    .addOptions(
      cats.map((c) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.label)
          .setValue(c.id)
          .setDescription(c.description.substring(0, 100))
          .setEmoji(c.emoji),
      ),
    );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const closeRow  = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close Menu").setStyle(ButtonStyle.Secondary),
  );

  return [selectRow, closeRow];
}

// ── Sub-pages: each category renders its category embed + ac_ action buttons ──

function chunkRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
  }
  return rows;
}

function backToMenuRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("menu_back").setLabel("⬅ Back to Menu").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  );
}

function btn(id: string, label: string, style: ButtonStyle = ButtonStyle.Primary): ButtonBuilder {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

interface CategoryPage {
  embed: EmbedBuilder;
  rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

export function buildUserCategoryPage(
  catId: UserCategoryId,
  settings: ServerSettings,
  isAdmin: boolean,
  seasonNum?: number,
  weekStr?: string,
): CategoryPage {
  const mcaVisible   = settings.mcaImportEnabled || isAdmin;
  const ecoVisible   = settings.coinEconomy;
  const wagerVisible = settings.coinEconomy && settings.wagerEnabled;

  const def = USER_CATEGORIES.find((c) => c.id === catId)!;
  const embed = goldEmbed({
    title:       `${def.emoji} ${def.label}`,
    description: `${def.description}\n\nPick an action below.`,
    seasonNum, weekStr,
  });

  let buttons: ButtonBuilder[] = [];

  switch (catId) {
    case "economy": {
      if (ecoVisible)   buttons.push(btn("ac_purchase", "💳 Purchase"));
      if (wagerVisible) buttons.push(btn("ac_wager",    "⚔️ Wager"));
      if (ecoVisible)   buttons.push(btn("ac_coins",    "🪙 Bank", ButtonStyle.Secondary));
      buttons.push(
        btn("ac_interview", "🎙️ Interview", ButtonStyle.Secondary),
        btn("ac_tweet",     "🐦 Tweet",     ButtonStyle.Secondary),
      );
      break;
    }
    case "rosters": {
      if (mcaVisible) {
        buttons.push(
          btn("ac_myroster",  "📋 My Roster"),
          btn("ac_anyroster", "👥 Rosters"),
          btn("ac_schedule",  "📅 Schedule"),
        );
      }
      break;
    }
    case "league": {
      if (mcaVisible) {
        buttons.push(
          btn("ac_standings",    "📈 Standings"),
          btn("ac_anyuserstats", "👤 Any User Stats"),
        );
      }
      break;
    }
    case "rankings": {
      buttons.push(
        btn("ac_seasonpr",  "🥇 Season PR"),
        btn("ac_alltimepr", "🏆 All-Time PR"),
        btn("ac_globalpr",  "🌐 Global PR"),
      );
      break;
    }
    case "payouts": {
      if (ecoVisible) {
        buttons.push(
          btn("ac_weeklypayouts",    "📅 Weekly"),
          btn("ac_eospayouts",       "💰 End-of-Season"),
          btn("ac_milestonepayouts", "🎯 Milestones"),
        );
      }
      break;
    }
    case "teams": {
      buttons.push(
        btn("ac_openteams",        "🔴 Open Teams",       ButtonStyle.Secondary),
        btn("ac_activeteams",      "🟢 User Teams",       ButtonStyle.Secondary),
        btn("ac_req_openteam",     "📬 Request Team"),
        btn("ac_req_addwaitlist",  "📋 Add Waitlist",     ButtonStyle.Success),
        btn("ac_req_rmwaitlist",   "❌ Leave Waitlist",   ButtonStyle.Danger),
      );
      break;
    }
    case "rules": {
      buttons.push(
        btn("ac_rules",     "📜 View Rules",       ButtonStyle.Secondary),
        btn("ac_autopilot", "✈️ Auto-Pilot",       ButtonStyle.Secondary),
        btn("ac_violation", "🚨 Report Violation", ButtonStyle.Danger),
      );
      break;
    }
    case "admin": {
      // Admin category renders an admin sub-selector instead of buttons.
      return buildAdminHubPage(seasonNum, weekStr);
    }
  }

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  for (const r of chunkRows(buttons)) rows.push(r);
  rows.push(backToMenuRow());

  return { embed, rows };
}

// ── Admin nested hub ──────────────────────────────────────────────────────────

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

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    backToMenuRow(),
  ];

  return { embed, rows };
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
        btn("ao_post_matchups",       "📋 Matchups/GOTW",   ButtonStyle.Secondary),
        btn("ao_post_game_channels",  "🎮 Game Channels",   ButtonStyle.Secondary),
        btn("ao_post_custom_article", "📰 Custom Article",  ButtonStyle.Secondary),
        btn("ao_rerun_media",         "🐦 Media Cycle",     ButtonStyle.Secondary),
        btn("ao_rerun_hist",          "📜 Rerun Historical", ButtonStyle.Secondary),
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
  // From an admin sub-page, "back" returns to the admin hub.
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("menu_admin_back").setLabel("⬅ Back to Admin").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("menu_back").setLabel("🏠 Main Menu").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
    ),
  );

  return { embed, rows };
}

// ── Unlinked welcome hub (users not yet on a team) ────────────────────────────

export function buildUnlinkedMenuEmbed(seasonNum?: number, weekStr?: string): EmbedBuilder {
  return goldEmbed({
    title: "🏈 Welcome to the League",
    description:
      "You are not yet linked to a team. Use the menu below to request a team or browse league info.\n\n" +
      "**🟢 Team Requests** — open teams, waitlist, request a team\n" +
      "**🏈 Rosters & Schedule** — browse any team and the schedule\n" +
      "**📊 League Info** — standings and user stats\n" +
      "**🏆 Power Rankings** — season, all-time, global\n" +
      "**📜 Rules** — full league rulebook",
    seasonNum, weekStr,
    footer: "Contact a commissioner to get linked · /menu expires after 15 min",
  });
}

export function buildUnlinkedMenuRows(): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const select = new StringSelectMenuBuilder()
    .setCustomId("menu_cat")
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

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
    ),
  ];
}
