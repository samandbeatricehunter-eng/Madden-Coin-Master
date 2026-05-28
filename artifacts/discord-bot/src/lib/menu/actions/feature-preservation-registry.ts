export type ActionFeatureGroup = {
  key: string;
  label: string;
  customIdPrefixes: string[];
  currentHandler: string;
  targetModule: string;
  preservationStatus: "mapped" | "ready-to-extract" | "requires-manual-review";
};

export const ACTION_FEATURE_GROUPS: ActionFeatureGroup[] = [
  {
    key: "menu-core",
    label: "Hub, close, and profile pages",
    customIdPrefixes: ["ac_hub", "ac_close", "ac_myprofile", "ac_profile_"],
    currentHandler: "lib/handlers/actions-handlers.ts",
    targetModule: "lib/menu/actions/core-actions.ts",
    preservationStatus: "mapped",
  },
  {
    key: "store-purchases",
    label: "Store purchases: legends, custom players, age resets, dev upgrades, training, contract mods",
    customIdPrefixes: ["ac_purchase", "ac_buy_", "ac_hire_trainer", "ac_ht_", "ccp_"],
    currentHandler: "lib/handlers/actions-handlers.ts + lib/handlers/custom-player-interactions.ts",
    targetModule: "lib/menu/actions/store-actions.ts",
    preservationStatus: "requires-manual-review",
  },
  {
    key: "wallet-wagers",
    label: "Coins, transfers, savings/bank, wagers",
    customIdPrefixes: ["ac_coins", "ac_send_coins", "ac_transfer", "ac_wager"],
    currentHandler: "lib/handlers/actions-handlers.ts",
    targetModule: "lib/menu/actions/wallet-actions.ts",
    preservationStatus: "ready-to-extract",
  },
  {
    key: "rosters-stats",
    label: "My roster, any roster, free agents, all players, player cards, team stats",
    customIdPrefixes: ["ac_myroster", "ac_anyroster", "ac_rc_", "ac_freeagents", "ac_fa_", "ac_allplayers", "ac_ap_", "ac_teamstats"],
    currentHandler: "lib/handlers/actions-handlers.ts",
    targetModule: "lib/menu/actions/roster-actions.ts",
    preservationStatus: "requires-manual-review",
  },
  {
    key: "league-info",
    label: "Standings, playoff hunt, teams to watch, user stats, schedules, open teams",
    customIdPrefixes: ["ac_standings", "ac_inthehunt", "ac_teamstowatch", "ac_anyuserstats", "ac_anyus_", "ac_schedule", "ac_activeteams", "ac_openteams", "ac_req_openteam"],
    currentHandler: "lib/handlers/actions-handlers.ts",
    targetModule: "lib/menu/actions/league-info-actions.ts",
    preservationStatus: "ready-to-extract",
  },
  {
    key: "rankings-awards",
    label: "Power rankings, weekly payouts, EOS payouts, milestone payouts, GOTW/GOTY voting, role breakdown",
    customIdPrefixes: ["ac_seasonpr", "ac_alltimepr", "ac_globalpr", "ac_weeklypayouts", "ac_eospayouts", "ac_milestonepayouts", "ac_gotw_vote", "ac_goty_vote", "ac_roles_breakdown"],
    currentHandler: "lib/handlers/actions-handlers.ts + gotw/goty handlers",
    targetModule: "lib/menu/actions/rankings-awards-actions.ts",
    preservationStatus: "ready-to-extract",
  },
  {
    key: "requests-rules-social",
    label: "Rules, violations, autopilot, press conference, rivalries",
    customIdPrefixes: ["ac_rules", "ac_violation", "ac_autopilot", "ac_press_open", "ac_interview", "ac_rivalries"],
    currentHandler: "lib/handlers/actions-handlers.ts + feature handlers",
    targetModule: "lib/menu/actions/requests-social-actions.ts",
    preservationStatus: "ready-to-extract",
  },
];

export function findActionFeatureGroup(customId: string): ActionFeatureGroup | null {
  return ACTION_FEATURE_GROUPS.find((group) =>
    group.customIdPrefixes.some((prefix) => customId === prefix || customId.startsWith(prefix)),
  ) ?? null;
}
