import type { RoutedInteraction } from "../../../interactions/router.js";
import { classifyRankingsAwardsAction, logRankingsAwardsRoute } from "./rankings-awards-action-service.js";

/**
 * Phase 14 rankings/standings/awards boundary.
 *
 * This is a preservation-first extraction. It gives rankings, payout summary,
 * award voting, and watch-list actions their own route boundary while the
 * existing proven renderer remains the execution fallback. That keeps current
 * behavior intact while preventing the global actions file from continuing to
 * own every feature surface.
 */
export async function routeRankingsAwardsAction(interaction: RoutedInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith("ac_")) return false;

  const subdomain = classifyRankingsAwardsAction(customId);
  await logRankingsAwardsRoute(interaction, subdomain);

  const { handleActionsInteraction } = await import("../../../handlers/actions-handlers.js");
  return handleActionsInteraction(interaction as any);
}
