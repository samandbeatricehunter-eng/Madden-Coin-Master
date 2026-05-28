import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Colors,
  EmbedBuilder,
} from "discord.js";
import type { RoutedInteraction } from "../../../../interactions/router.js";
import { logGuildEvent } from "../../../../guild/guild-routing-service.js";
import { beginCustomPlayerPurchase } from "./custom-player-purchase-service.js";

function backToHubRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
  );
}

function isCustomPlayerEntryAction(customId: string): boolean {
  return customId === "ac_buy_custom";
}

async function showCustomPlayerWarning(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.guildId) return false;

  const result = await beginCustomPlayerPurchase({
    guildId: interaction.guildId,
    discordId: interaction.user.id,
  });

  if (!result.ok) {
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle(result.title ?? "❌ Custom Player Unavailable")
          .setDescription(result.reason),
      ],
      components: [backToHubRow()],
    });
    return true;
  }

  await logGuildEvent({
    guildId: interaction.guildId,
    eventType: "custom_player_purchase_started",
    actorDiscordId: interaction.user.id,
    entityType: "custom_player_session",
    entityId: result.sessionId,
    payload: {
      seasonId: result.seasonId,
      currentWeek: result.currentWeek,
      customsUsed: result.customsUsed,
      customsCap: result.customsCap,
      consolidationPhase: 9,
    },
  }).catch(() => null);

  const warningEmbed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("⚠️ Before You Start — Draft Pick Required")
    .setDescription(
      "Purchasing a custom player **does not automatically place them on your roster**.\n\n" +
      "You must use **a draft pick** to select your custom player during the annual draft. " +
      "If you do not have a draft pick available, you will not be able to add this player to your team.",
    )
    .addFields(
      {
        name: "What happens after you purchase?",
        value:
          "1. You build your player's position, archetype, attributes, and appearance.\n" +
          "2. A commissioner adds them to the MCA draft class.\n" +
          "3. You use a draft pick to select them in the draft.\n" +
          "4. They join your roster once drafted.",
      },
      {
        name: "Custom player limit",
        value: `You have used **${result.customsUsed}** of **${result.customsCap}** custom player slot this season.`,
      },
    )
    .setFooter({ text: "Make sure you have a draft pick saved before proceeding." });

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ccp_preconfirm:${result.sessionId}`)
      .setLabel("✅ I understand, start building")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ccp_cancel:${result.sessionId}`)
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [warningEmbed], components: [confirmRow] });
  return true;
}

export async function routeCustomPlayerPurchaseAction(interaction: RoutedInteraction): Promise<boolean> {
  if (!interaction.guildId || !isCustomPlayerEntryAction(interaction.customId)) return false;
  if (interaction.isButton() && interaction.customId === "ac_buy_custom") return showCustomPlayerWarning(interaction);
  return false;
}
