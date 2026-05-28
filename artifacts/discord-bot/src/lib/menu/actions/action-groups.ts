import type { RoutedInteraction } from "../../interactions/router.js";

export type MenuActionFeature =
  | "menu_core"
  | "profile"
  | "store_purchases"
  | "wallet_wagers"
  | "rosters_cap"
  | "league_info"
  | "rankings_awards"
  | "requests_rules_social"
  | "unknown";

export type MenuActionRoute = {
  feature: MenuActionFeature;
  description: string;
  prefixes: string[];
  exact?: string[];
};

export const MENU_ACTION_ROUTES: MenuActionRoute[] = [
  {
    feature: "menu_core",
    description: "Hub restore, close, top-level navigation, and unlinked-user surfaces.",
    exact: ["ac_hub", "ac_close"],
    prefixes: [],
  },
  {
    feature: "profile",
    description: "User profile pages, active teams, and user-specific profile views.",
    exact: ["ac_myprofile", "ac_profile_p1", "ac_profile_p2", "ac_profile_p3", "ac_activeteams"],
    prefixes: ["ac_anyus_", "ac_anyuserstats"],
  },
  {
    feature: "store_purchases",
    description: "Store, Legends, custom players, dev upgrades, age resets, training, trainers, and contract modifiers.",
    exact: [
      "ac_purchase",
      "ac_buy_agereset",
      "ac_buy_devup",
      "ac_buy_legend",
      "ac_buy_custom",
      "ac_buy_training",
      "ac_buy_training_execute",
      "ac_hire_trainer",
      "ac_ht_pos",
      "ac_ht_player",
      "ac_ht_focus",
      "ac_ht_weeks",
      "ac_ht_confirm",
      "ac_my_trainers",
      "ac_buy_contract_ext",
      "ac_buy_salary_red",
      "ac_buy_bonus_red",
      "ac_buy_ar_confirm",
      "ac_buy_du_confirm",
      "ac_buy_legend_confirm",
      "ac_buy_cm_confirm",
    ],
    prefixes: [
      "ac_buy_arpos:",
      "ac_buy_dupos:",
      "ac_buy_arplayer:",
      "ac_buy_duplayer:",
      "ac_buy_legendpos:",
      "ac_buy_legendsel:",
      "ac_buy_trainingpos:",
      "ac_buy_trainingplayer:",
      "ac_buy_training_tier:",
      "ac_buy_training_goal:",
      "ac_ht_tier:",
      "ac_buy_cmpos:",
      "ac_buy_cmpick:",
    ],
  },
  {
    feature: "wallet_wagers",
    description: "Coin balance, send coins, bank transfer, and wager flows.",
    exact: [
      "ac_coins",
      "ac_send_coins_modal",
      "ac_transfer",
      "ac_wager",
      "ac_wager_game",
      "ac_wager_spread",
      "ac_wager_spread_next",
      "ac_wager_back_to_team",
      "ac_wager_back_to_spread",
      "ac_wager_opponent_afc",
      "ac_wager_opponent_nfc",
      "ac_wager_send",
    ],
    prefixes: [
      "ac_transfer_dir:",
      "ac_wager_pick:",
      "ac_modal_sendcoins",
      "ac_modal_transfer:",
      "ac_modal_wageramount",
    ],
  },
  {
    feature: "rosters_cap",
    description: "My roster, any roster, all players, free agents, roster cards, team stats, cap manager, and cap negotiation.",
    exact: [
      "ac_myroster",
      "ac_anyroster",
      "ac_anyroster_sel",
      "ac_allplayers",
      "ac_freeagents",
      "ac_fa",
      "ac_teamstats",
      "ac_teamstats_sel",
      "ac_cap_manager",
      "ac_cap_calc",
      "ac_cap_target",
      "ac_cap_toggle",
      "ac_cap_negotiate",
      "ac_cap_pfa",
    ],
    prefixes: [
      "ac_anyroster_sel_",
      "ac_rc_",
      "ac_ap_",
      "ac_fa_",
      "ac_cap_",
      "ac_modal_ap_",
      "ac_modal_fa_",
    ],
  },
  {
    feature: "league_info",
    description: "Schedule, standings, open teams, autopilot, rules, roles, and general league info.",
    exact: [
      "ac_schedule",
      "ac_standings",
      "ac_openteams",
      "ac_autopilot",
      "ac_rules",
      "ac_rules_close",
      "ac_rules_display",
      "ac_rules_display_bynum",
      "ac_rules_display_full",
      "ac_rules_goback",
      "ac_rules_section",
      "ac_roles_breakdown",
    ],
    prefixes: [
      "ac_standings_conf:",
      "ac_rules_page:",
      "ac_req_",
      "ac_modal_rules_",
      "ac_modal_autopilot",
    ],
  },
  {
    feature: "rankings_awards",
    description: "Power rankings, payout summary buttons, GOTW/GOTY/POTY entrypoints, and league watch lists.",
    exact: [
      "ac_globalpr",
      "ac_seasonpr",
      "ac_alltimepr",
      "ac_weeklypayouts",
      "ac_eospayouts",
      "ac_milestonepayouts",
      "ac_active_streams",
      "ac_gotw_vote",
      "ac_goty_vote",
      "ac_goty_hub",
      "ac_poty_vote",
      "ac_inthehunt",
      "ac_teamstowatch",
    ],
    prefixes: [],
  },
  {
    feature: "requests_rules_social",
    description: "Press/interview, rivalries, violations, waitlist/open-team requests, and social moderation flows.",
    exact: [
      "ac_press_open",
      "ac_interview",
      "ac_rivalries",
      "ac_violation",
    ],
    prefixes: [
      "ac_rv_",
      "ac_modal_violation",
      "ac_req_",
    ],
  },
];

export function actionBase(customId: string): string {
  return customId.split(":", 1)[0] ?? customId;
}

export function identifyMenuActionFeature(customId: string): MenuActionFeature {
  const action = actionBase(customId);
  for (const route of MENU_ACTION_ROUTES) {
    if (route.exact?.includes(action) || route.exact?.includes(customId)) return route.feature;
    if (route.prefixes.some((prefix) => customId.startsWith(prefix) || action.startsWith(prefix))) {
      return route.feature;
    }
  }
  return "unknown";
}

export function isKnownMenuAction(customId: string): boolean {
  return identifyMenuActionFeature(customId) !== "unknown" || customId.startsWith("ac_");
}

export async function acknowledgeUnknownMenuAction(interaction: RoutedInteraction, customId: string): Promise<boolean> {
  if (!interaction.isRepliable()) return true;
  const payload = {
    ephemeral: true,
    content: `That menu action is not recognized by the consolidated router yet. Custom ID: ${customId}`,
  };
  if ((interaction as any).replied || (interaction as any).deferred) {
    await (interaction as any).followUp(payload).catch(() => null);
  } else {
    await (interaction as any).reply(payload).catch(() => null);
  }
  return true;
}
