import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { RoutedInteraction } from "../../../../interactions/router.js";
import { logGuildEvent } from "../../../../guild/guild-routing-service.js";
import { sendCommissionerNotification } from "../../../../economy/purchase-shared.js";
import {
  getLegendCatalogItem,
  LEGEND_POSITION_LABELS,
  listAvailableLegendPositions,
  listAvailableLegendsByPosition,
  submitLegendPurchase,
  validateLegendPurchase,
} from "./legend-purchase-service.js";

type LegendSession = {
  guildId: string;
  userId: string;
  legendId?: number;
  legendName?: string;
  legendCost?: number;
  expiresAt: number;
};

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, LegendSession>();

function sessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}:legend`;
}

function getSession(guildId: string, userId: string): LegendSession {
  const key = sessionKey(guildId, userId);
  const existing = sessions.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing;

  const created = { guildId, userId, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(key, created);
  return created;
}

function clearSession(guildId: string, userId: string): void {
  sessions.delete(sessionKey(guildId, userId));
}

function backToHubRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("⬅ Back to Menu").setStyle(ButtonStyle.Secondary),
  );
}

function cancelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );
}

function isLegendAction(customId: string): boolean {
  return customId === "ac_buy_legend"
    || customId === "ac_buy_legend_confirm"
    || customId.startsWith("ac_buy_legendpos:")
    || customId.startsWith("ac_buy_legendsel:");
}

async function showLegendPositions(interaction: ButtonInteraction): Promise<boolean> {
  const guildId = interaction.guildId!;
  getSession(guildId, interaction.user.id);

  const positions = await listAvailableLegendPositions(guildId);
  if (!positions.length) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ No legends are currently available in the store.")],
      components: [backToHubRow()],
    });
    return true;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_legendpos:")
    .setPlaceholder("Select a position…")
    .addOptions(
      positions.slice(0, 25).map((position) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(LEGEND_POSITION_LABELS[position] ?? position)
          .setValue(position),
      ),
    );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🏆 Buy a Legend — Step 1: Choose a Position")
        .setDescription(
          "Select a position to see available legends.\n\n" +
          "Max **2 legends per team** · Purchase window: **Weeks 1–18** (closes at Wildcard week)\n" +
          "Legends stay with the team if ownership changes.",
        ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), cancelRow()],
  });
  return true;
}

async function showLegendsForPosition(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const guildId = interaction.guildId!;
  const position = interaction.values[0]!;
  getSession(guildId, interaction.user.id);

  const rows = await listAvailableLegendsByPosition(guildId, position);
  if (!rows.length) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(`❌ No **${position}** legends are currently available.`)],
      components: [backToHubRow()],
    });
    return true;
  }

  const legendMenu = new StringSelectMenuBuilder()
    .setCustomId("ac_buy_legendsel:")
    .setPlaceholder(`Select a ${position} legend…`)
    .addOptions(rows.slice(0, 25).map((legend) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${legend.name} (${legend.cost.toLocaleString()} coins)`)
        .setValue(String(legend.id)),
    ));

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_buy_legend").setLabel("← Back to Positions").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(`🏆 Buy a Legend — ${LEGEND_POSITION_LABELS[position] ?? position}`)
        .setDescription(`**${rows.length}** legend${rows.length === 1 ? "" : "s"} available at this position. Select one to continue.`),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(legendMenu), backRow],
  });
  return true;
}

async function confirmLegend(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const guildId = interaction.guildId!;
  const legendId = Number(interaction.values[0]);
  const legend = await getLegendCatalogItem(guildId, legendId);
  if (!legend) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Legend not found or no longer available.")],
      components: [backToHubRow()],
    });
    return true;
  }

  const validation = await validateLegendPurchase({
    guildId,
    discordId: interaction.user.id,
    username: interaction.user.username,
    legendId,
  });

  if (!validation.ok) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(validation.reason)],
      components: [backToHubRow()],
    });
    return true;
  }

  const session = getSession(guildId, interaction.user.id);
  session.legendId = legend.id;
  session.legendName = legend.name;
  session.legendCost = legend.cost;
  session.expiresAt = Date.now() + SESSION_TTL_MS;

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏆 Confirm Legend Purchase")
    .setDescription(
      `**${legend.name}** — ${legend.position}\n\n` +
      `Cost: **${legend.cost.toLocaleString()} coins**\n` +
      `Your balance: **${validation.userBalance.toLocaleString()} coins**`,
    );

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_buy_legend_confirm").setLabel("✅ Confirm Purchase").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [btnRow] });
  return true;
}

async function executeLegendPurchase(interaction: ButtonInteraction): Promise<boolean> {
  const guildId = interaction.guildId!;
  const session = getSession(guildId, interaction.user.id);
  if (!session.legendId) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Session expired. Please start the legend purchase again.")],
      components: [backToHubRow()],
    });
    return true;
  }

  const result = await submitLegendPurchase({
    guildId,
    discordId: interaction.user.id,
    username: interaction.user.username,
    legendId: session.legendId,
  });

  if (!result.ok) {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription(result.reason)],
      components: [backToHubRow()],
    });
    return true;
  }

  await Promise.all([
    sendCommissionerNotification(interaction as any, "legend", result.purchaseId, {
      legendName: result.legend.name,
      legendPosition: result.legend.position ?? "",
      costPer: result.cost,
    }),
    logGuildEvent({
      guildId,
      eventType: "legend_purchase_submitted",
      actorDiscordId: interaction.user.id,
      entityType: "purchase",
      entityId: String(result.purchaseId),
      payload: {
        legendId: result.legend.id,
        legendName: result.legend.name,
        cost: result.cost,
        consolidationPhase: 8,
      },
    }).catch(() => null),
  ]);

  clearSession(guildId, interaction.user.id);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("⏳ Legend Submitted")
        .setDescription(`**${result.legend.name}** submitted for commissioner approval. Cost: **${result.cost.toLocaleString()} coins** deducted.`),
    ],
    components: [backToHubRow()],
  });
  return true;
}

export async function routeLegendPurchaseAction(interaction: RoutedInteraction): Promise<boolean> {
  if (!interaction.guildId || !isLegendAction(interaction.customId)) return false;

  if (interaction.isButton() && interaction.customId === "ac_buy_legend") return showLegendPositions(interaction);
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("ac_buy_legendpos:")) return showLegendsForPosition(interaction);
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("ac_buy_legendsel:")) return confirmLegend(interaction);
  if (interaction.isButton() && interaction.customId === "ac_buy_legend_confirm") return executeLegendPurchase(interaction);

  return false;
}
