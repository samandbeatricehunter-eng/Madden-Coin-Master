import { LEGEND_CUSTOM_PURCHASE_WEEKS } from "../../../constants.js";

export function legendPurchasesOpen(currentWeek: string | number | null | undefined): boolean {
  return LEGEND_CUSTOM_PURCHASE_WEEKS.has(String(currentWeek ?? ""));
}

export function customPlayersOpen(currentWeek: string | number | null | undefined): boolean {
  return LEGEND_CUSTOM_PURCHASE_WEEKS.has(String(currentWeek ?? ""));
}

export function legendClosedMessage(): string {
  return "🔒 Legend purchases closed at the advance to Week 16.";
}

export function customPlayerClosedMessage(): string {
  return "🔒 Custom player submissions closed at the advance to Divisional Round.";
}
