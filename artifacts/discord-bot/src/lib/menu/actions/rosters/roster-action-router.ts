import type { RoutedInteraction } from "../../../interactions/router.js";
import { logGuildEvent } from "../../../guild/guild-routing-service.js";
import { classifyRosterAction, rosterActionLabels } from "./roster-action-service.js";

/**
 * Phase 13 roster/free-agent/cap boundary.
 *
 * This deliberately preserves existing behavior by delegating the actual render
 * work to the proven legacy handler while moving ownership/routing into a
 * dedicated domain boundary. The next safe extraction can move one sub-flow at a
 * time behind this router without touching the global actions file again.
 */
export async function routeRosterAction(interaction: RoutedInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith("ac_")) return false;

  const subdomain = classifyRosterAction(customId);

  if (interaction.guildId) {
    void logGuildEvent({
      guildId: interaction.guildId,
      eventType: "roster_action_routed",
      actorDiscordId: interaction.user.id,
      entityType: "discord_component",
      entityId: customId,
      payload: { subdomain, label: rosterActionLabels[subdomain] },
    }).catch(() => null);
  }

  const { handleActionsInteraction } = await import("../../../handlers/actions-handlers.js");
  return handleActionsInteraction(interaction as any);
}
