import type { RoutedInteraction } from "../../../interactions/router.js";
import { logGuildEvent } from "../../../guild/guild-routing-service.js";
import { classifyStorePurchaseAction, isStorePurchaseAction } from "./store-action-ids.js";
import { routeLegendPurchaseAction } from "./legend/legend-purchase-router.js";
import { routeCustomPlayerPurchaseAction } from "./custom-player/custom-player-purchase-router.js";

/**
 * Phase 9 store/purchase extraction boundary.
 *
 * Store traffic is still protected by one routing boundary, but the Legend flow
 * and Custom Player entry flows are now physically extracted from the legacy 8k+ line actions handler. Other
 * purchase flows continue to delegate to the proven legacy handler until their
 * dedicated extraction phases are complete.
 */
export async function routeStorePurchaseAction(interaction: RoutedInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!isStorePurchaseAction(customId)) return false;

  if (interaction.guildId) {
    void logGuildEvent({
      guildId: interaction.guildId,
      eventType: "store_purchase_action_routed",
      actorDiscordId: interaction.user.id,
      entityType: "discord_component",
      entityId: customId,
      payload: {
        purchaseFlow: classifyStorePurchaseAction(customId),
        consolidationPhase: 9,
      },
    }).catch(() => null);
  }

  const handledByLegendFlow = await routeLegendPurchaseAction(interaction);
  if (handledByLegendFlow) return true;

  const handledByCustomPlayerFlow = await routeCustomPlayerPurchaseAction(interaction);
  if (handledByCustomPlayerFlow) return true;

  const { handleActionsInteraction } = await import("../../../handlers/actions-handlers.js");
  return handleActionsInteraction(interaction as any);
}
