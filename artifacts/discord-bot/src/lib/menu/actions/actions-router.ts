import type { RoutedInteraction } from "../../interactions/router.js";
import { logGuildEvent } from "../../guild/guild-routing-service.js";
import { identifyMenuActionFeature, isKnownMenuAction, acknowledgeUnknownMenuAction } from "./action-groups.js";
import { routeStorePurchaseAction } from "./store/store-action-router.js";
import { routeWalletEconomyAction } from "./wallet/wallet-action-router.js";
import { routeRosterAction } from "./rosters/roster-action-router.js";
import { routeRankingsAwardsAction } from "./rankings-awards/rankings-awards-action-router.js";

/**
 * Consolidated member action router.
 *
 * Phase 6 is intentionally preservation-first:
 * - all ac_* interactions now enter this router before legacy fallback branches;
 * - every action is categorized by feature for audit/logging;
 * - execution still delegates to the existing proven handler until each feature
 *   group is extracted into smaller service-owned files.
 *
 * This prevents behavior loss while removing routing ambiguity.
 */
export async function routeMemberAction(interaction: RoutedInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith("ac_")) return false;

  if (!isKnownMenuAction(customId)) {
    return acknowledgeUnknownMenuAction(interaction, customId);
  }

  const feature = identifyMenuActionFeature(customId);

  if (feature === "store_purchases") {
    return routeStorePurchaseAction(interaction);
  }

  if (feature === "wallet_wagers") {
    return routeWalletEconomyAction(interaction);
  }

  if (feature === "rosters_cap") {
    return routeRosterAction(interaction);
  }

  if (feature === "rankings_awards") {
    return routeRankingsAwardsAction(interaction);
  }

  if (interaction.guildId) {
    void logGuildEvent({
      guildId: interaction.guildId,
      eventType: "menu_action_routed",
      actorDiscordId: interaction.user.id,
      entityType: "discord_component",
      entityId: customId,
      payload: { feature },
    }).catch(() => null);
  }

  const { handleActionsInteraction } = await import("../../handlers/actions-handlers.js");
  return handleActionsInteraction(interaction as any);
}
