export const STORE_ACTION_EXACT_IDS = new Set<string>([
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
]);

export const STORE_ACTION_PREFIXES = [
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
] as const;

export function isStorePurchaseAction(customId: string): boolean {
  return STORE_ACTION_EXACT_IDS.has(customId) || STORE_ACTION_PREFIXES.some((prefix) => customId.startsWith(prefix));
}

export function classifyStorePurchaseAction(customId: string): string {
  if (customId.includes("legend")) return "legend";
  if (customId.includes("custom")) return "custom_player";
  if (customId.includes("training") || customId.startsWith("ac_ht_")) return "training";
  if (customId.includes("contract") || customId.includes("salary") || customId.includes("bonus") || customId.includes("cm")) return "contract_mod";
  if (customId.includes("agereset") || customId.includes("ar")) return "age_reset";
  if (customId.includes("devup") || customId.includes("du")) return "dev_upgrade";
  return "store_menu";
}
