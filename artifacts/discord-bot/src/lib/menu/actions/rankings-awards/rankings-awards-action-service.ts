import type { RoutedInteraction } from "../../../interactions/router.js";
import { logGuildEvent } from "../../../guild/guild-routing-service.js";

export type RankingsAwardsSubdomain =
  | "power_rankings"
  | "payout_summaries"
  | "voting_awards"
  | "watch_lists"
  | "unknown";

const POWER_RANKING_ACTIONS = new Set([
  "ac_globalpr",
  "ac_seasonpr",
  "ac_alltimepr",
]);

const PAYOUT_ACTIONS = new Set([
  "ac_weeklypayouts",
  "ac_eospayouts",
  "ac_milestonepayouts",
]);

const VOTING_AWARD_ACTIONS = new Set([
  "ac_gotw_vote",
  "ac_goty_vote",
  "ac_goty_hub",
  "ac_poty_vote",
  "ac_active_streams",
]);

const WATCH_LIST_ACTIONS = new Set([
  "ac_inthehunt",
  "ac_teamstowatch",
]);

export const rankingsAwardsActionLabels: Record<RankingsAwardsSubdomain, string> = {
  power_rankings: "Power rankings",
  payout_summaries: "Payout summaries",
  voting_awards: "GOTW/GOTY/POTY voting and awards",
  watch_lists: "In-the-hunt and teams-to-watch lists",
  unknown: "Unknown rankings/awards action",
};

export function classifyRankingsAwardsAction(customId: string): RankingsAwardsSubdomain {
  const action = customId.split(":", 1)[0] ?? customId;
  if (POWER_RANKING_ACTIONS.has(action)) return "power_rankings";
  if (PAYOUT_ACTIONS.has(action)) return "payout_summaries";
  if (VOTING_AWARD_ACTIONS.has(action)) return "voting_awards";
  if (WATCH_LIST_ACTIONS.has(action)) return "watch_lists";
  return "unknown";
}

export async function logRankingsAwardsRoute(interaction: RoutedInteraction, subdomain: RankingsAwardsSubdomain): Promise<void> {
  if (!interaction.guildId) return;
  await logGuildEvent({
    guildId: interaction.guildId,
    eventType: "rankings_awards_action_routed",
    actorDiscordId: interaction.user.id,
    entityType: "discord_component",
    entityId: interaction.customId,
    payload: {
      subdomain,
      label: rankingsAwardsActionLabels[subdomain],
    },
  }).catch(() => null);
}
