import type { ButtonInteraction, Interaction, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";

export type RoutedInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

type PrefixRoute = {
  prefixes: string[];
  handler: (interaction: RoutedInteraction) => Promise<boolean | void>;
};

function customIdOf(interaction: Interaction): string | null {
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    return interaction.customId;
  }
  return null;
}

function actionOf(customId: string): string {
  return customId.split(":", 1)[0] ?? customId;
}

async function safeReply(interaction: RoutedInteraction, content: string): Promise<void> {
  const payload = { content, ephemeral: true, components: [], embeds: [] } as any;
  if (!interaction.isRepliable()) return;
  if ((interaction as any).replied || (interaction as any).deferred) {
    await (interaction as any).followUp(payload).catch(() => null);
    return;
  }
  await (interaction as any).reply(payload).catch(() => null);
}

const routes: PrefixRoute[] = [
  {
    prefixes: ["gd_"],
    handler: async (interaction) => {
      const { handleGamedayInteraction } = await import("../gameday/gameday-dashboard.js");
      return handleGamedayInteraction(interaction as any);
    },
  },
  {
    prefixes: ["gdrev_"],
    handler: async (interaction) => {
      const { handleCommissionerGamedayReviewInteraction } = await import("../gameday/commissioner-gameday-review.js");
      await handleCommissionerGamedayReviewInteraction(interaction as any);
      return true;
    },
  },
  {
    prefixes: ["gs_"],
    handler: async (interaction) => {
      const { handleGsInteraction } = await import("../handlers/game-scheduling-handlers.js");
      return handleGsInteraction(interaction as any);
    },
  },
  {
    prefixes: ["gdrs_"],
    handler: async (interaction) => {
      const { handleAcceptedTimeRescheduleInteraction } = await import("../gameday/reschedule/accepted-time-reschedule.js");
      return handleAcceptedTimeRescheduleInteraction(interaction as any);
    },
  },
  {
    prefixes: ["gotwv_"],
    handler: async (interaction) => {
      const { handleGotwvInteraction } = await import("../handlers/gotw-voting-handlers.js");
      await handleGotwvInteraction(interaction as any);
      return true;
    },
  },
  {
    prefixes: ["gotyv_"],
    handler: async (interaction) => {
      const { handleGotyvInteraction } = await import("../handlers/goty-voting-handlers.js");
      await handleGotyvInteraction(interaction as any);
      return true;
    },
  },
  {
    prefixes: ["hlnom_", "poty_"],
    handler: async (interaction) => {
      const { handleHighlightNominationInteraction, renderPotyVote } = await import("../media/play-of-the-year.js");
      if (interaction.isStringSelectMenu() && actionOf(interaction.customId) === "poty_category") {
        await renderPotyVote(interaction, interaction.values[0], 0);
        return true;
      }
      await handleHighlightNominationInteraction(interaction as any);
      return true;
    },
  },
  {
    prefixes: ["ac_"],
    handler: async (interaction) => {
      const { routeMemberAction } = await import("../menu/actions/actions-router.js");
      return routeMemberAction(interaction);
    },
  },
];

export async function routeInteraction(interaction: Interaction): Promise<boolean> {
  const customId = customIdOf(interaction);
  if (!customId) return false;
  const action = actionOf(customId);

  for (const route of routes) {
    if (!route.prefixes.some((prefix) => action.startsWith(prefix))) continue;
    try {
      const handled = await route.handler(interaction as RoutedInteraction);
      return handled !== false;
    } catch (err) {
      console.error(`[interaction-router] ${customId}:`, err);
      await safeReply(interaction as RoutedInteraction, "❌ Something went wrong while handling that action. Please try again.");
      return true;
    }
  }

  return false;
}
