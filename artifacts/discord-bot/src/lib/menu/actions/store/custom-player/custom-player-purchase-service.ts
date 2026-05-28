import { getInventoryCount, getOrCreateActiveSeason } from "../../../../db/db-helpers.js";
import { LIMITS } from "../../../../constants.js";
import { customPlayersOpen } from "../cutoff-notices.js";
import { createSession } from "../../../../handlers/custom-player-session.js";

export type CustomPlayerStartValidation =
  | {
      ok: true;
      guildId: string;
      discordId: string;
      seasonId: number;
      currentWeek: string | null;
      sessionId: string;
      customsUsed: number;
      customsCap: number;
    }
  | {
      ok: false;
      reason: string;
      title?: string;
    };

/**
 * Phase 9 custom-player boundary.
 *
 * This keeps the existing working CCP builder intact, but moves the entry-point
 * validation and session creation out of the 8k+ line actions handler. The full
 * ccp_* build wizard remains delegated to the proven custom-player interaction
 * handlers until its own extraction pass.
 */
export async function beginCustomPlayerPurchase(input: {
  guildId: string;
  discordId: string;
}): Promise<CustomPlayerStartValidation> {
  const season = await getOrCreateActiveSeason(input.guildId);

  if (!customPlayersOpen(season.currentWeek)) {
    return {
      ok: false,
      title: "🔒 Custom Player Submissions Closed",
      reason: "Custom player submissions closed at the advance to Divisional Round.",
    };
  }

  const invCount = await getInventoryCount(input.discordId, season.id);
  const customsCap = LIMITS.customPlayersPerDraft;

  if (invCount.customs >= customsCap) {
    return {
      ok: false,
      title: "❌ Custom Player Limit Reached",
      reason:
        `You have already purchased **${invCount.customs}** custom player this season ` +
        `(max **${customsCap}** per season). You cannot purchase another until next season.`,
    };
  }

  const sessionId = createSession(input.discordId, input.guildId, season.id);
  return {
    ok: true,
    guildId: input.guildId,
    discordId: input.discordId,
    seasonId: season.id,
    currentWeek: season.currentWeek ?? null,
    sessionId,
    customsUsed: invCount.customs,
    customsCap,
  };
}
