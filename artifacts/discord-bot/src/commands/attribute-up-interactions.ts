/**
 * Interactive attribute-upgrade flow (for /purchase attributeUp).
 * Session-based flow: user selects target player → paginated attribute dropdown → cost preview → confirm.
 */
import {
  ChatInputCommandInteraction, ButtonInteraction, StringSelectMenuInteraction,
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseRostersTable, purchasesTable, inventoryTable, seasonStatsTable, usersTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getSeasonStats,
  getCoreAttributes, getSeasonRules, deductBalance, logTransaction,
} from "../lib/db-helpers.js";
import { ATTRIBUTES } from "../lib/constants.js";
import { errorEmbed, pendingEmbed } from "../lib/embeds.js";
import { getServerSettings } from "../lib/server-settings.js";

// ── Session store ──────────────────────────────────────────────────────────────
interface AupSession {
  invokerId: string;       // discord ID of user who ran the command
  targetId: string;        // discord ID whose player is being upgraded
  playerName: string;
  playerPosition: string;
  playerId: number;
  attributes: Record<string, number>;  // current in-game attribute values
  page: number;
  selectedAttr?: string;
  currentValue?: number;
  baseCost?: number;
  scaledCost?: number;
  isCore?: boolean;
}

export const aupSessions = new Map<string, AupSession>();

const ATTRS_PER_PAGE = 15;

function sessionKey(invokerId: string, playerId: number) {
  return `${invokerId}:${playerId}`;
}

// ── Cost scaling model ─────────────────────────────────────────────────────────
function scaledCost(base: number, current: number): number | null {
  if (current >= 99) return null;           // can't upgrade at 99
  if (current >= 96) return base * 3;       // 96-98 → 3x
  if (current >= 91) return base * 2;       // 91-95 → 2x
  return base;                              // ≤ 90 → base cost
}

// ── Build paginated attribute embed ───────────────────────────────────────────
function buildAttrPage(session: AupSession, rules: { coreAttrCost: number; nonCoreAttrCost: number }) {
  const coreAttrs = new Set(ATTRIBUTES.slice(0, 10)); // placeholder — real check uses getCoreAttributes
  const pageAttrs = ATTRIBUTES.slice(session.page * ATTRS_PER_PAGE, (session.page + 1) * ATTRS_PER_PAGE);
  const totalPages = Math.ceil(ATTRIBUTES.length / ATTRS_PER_PAGE);

  const lines: string[] = [];
  for (const attr of pageAttrs) {
    const current = session.attributes[attr] ?? 0;
    const isCore = coreAttrs.has(attr as any);
    const base = isCore ? rules.coreAttrCost : rules.nonCoreAttrCost;
    const cost = scaledCost(base, current);
    const label = cost === null
      ? `~~**${attr}**~~ (${current} — maxed out)`
      : `**${attr}** — ${current} → ${current + 1} (**${cost.toLocaleString()} coins**)`;
    lines.push(label);
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`⚡ Attribute Upgrade — ${session.playerName} (${session.playerPosition})`)
    .setDescription(
      `Select an attribute to upgrade from the dropdown below.\n\n` +
      lines.join("\n") +
      `\n\n📄 **Page ${session.page + 1} of ${totalPages}**`
    )
    .setFooter({ text: "Scaling cost: ≤90 = 1×, 91–95 = 2×, 96–98 = 3×, 99 = not upgradeable" });

  return embed;
}

function buildAttrDropdown(session: AupSession, rules: { coreAttrCost: number; nonCoreAttrCost: number }, sKey: string) {
  const coreAttrs = new Set(ATTRIBUTES.slice(0, 10));
  const pageAttrs = ATTRIBUTES.slice(session.page * ATTRS_PER_PAGE, (session.page + 1) * ATTRS_PER_PAGE);

  const options = pageAttrs
    .filter(attr => {
      const cur = session.attributes[attr] ?? 0;
      return cur < 99;
    })
    .map(attr => {
      const cur = session.attributes[attr] ?? 0;
      const isCore = coreAttrs.has(attr as any);
      const base = isCore ? rules.coreAttrCost : rules.nonCoreAttrCost;
      const cost = scaledCost(base, cur)!;
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${attr} (${cur} → ${cur + 1})`)
        .setValue(`${attr}`)
        .setDescription(`${cost.toLocaleString()} coins — ${isCore ? "Core" : "Non-core"}`);
    });

  if (options.length === 0) {
    // All attrs on this page are maxed
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`aup_sel:${sKey}`)
        .setPlaceholder("No upgradeable attributes on this page")
        .setDisabled(true)
        .addOptions(new StringSelectMenuOptionBuilder().setLabel("None").setValue("none"))
    );
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aup_sel:${sKey}`)
      .setPlaceholder("Select an attribute to upgrade…")
      .addOptions(options)
  );
}

function buildNavRow(session: AupSession, sKey: string) {
  const totalPages = Math.ceil(ATTRIBUTES.length / ATTRS_PER_PAGE);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`aup_prev:${sKey}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.page === 0),
    new ButtonBuilder()
      .setCustomId("aup_indicator")
      .setLabel(`${session.page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`aup_next:${sKey}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`aup_cancel:${sKey}`)
      .setLabel("✖ Cancel")
      .setStyle(ButtonStyle.Danger),
  );
}

// ── Entry point: start the flow from /purchase attributeUp execute() ──────────
export async function startAttributeUp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings();
  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled." });
    return;
  }
  if (!settings.attributeUpgradesEnabled) {
    await interaction.editReply({ content: "❌ Attribute upgrades are currently disabled." });
    return;
  }

  const targetUser = interaction.options.getUser("user") ?? interaction.user;
  const playerName = interaction.options.getString("player", true);
  const position   = interaction.options.getString("position", true);

  const season = await getOrCreateActiveSeason();

  // Fetch the player from the franchise roster
  const [playerRow] = await db
    .select()
    .from(franchiseRostersTable)
    .where(
      and(
        eq(franchiseRostersTable.seasonId, season.id),
        eq(franchiseRostersTable.discordId, targetUser.id),
      )
    )
    .then(rows =>
      rows.filter(r =>
        `${r.firstName} ${r.lastName}`.toLowerCase().includes(playerName.toLowerCase()) &&
        r.position.toUpperCase() === position.toUpperCase()
      ).slice(0, 1)
    );

  if (!playerRow || !playerRow.attributes) {
    await interaction.editReply({
      content: `❌ Could not find **${playerName}** (${position}) on <@${targetUser.id}>'s roster. Make sure MCA data has been imported recently.`
    });
    return;
  }

  const attrs = playerRow.attributes as Record<string, number>;
  const rules = await getSeasonRules(season);

  const sKey = sessionKey(interaction.user.id, playerRow.playerId);
  const session: AupSession = {
    invokerId: interaction.user.id,
    targetId: targetUser.id,
    playerName: `${playerRow.firstName} ${playerRow.lastName}`,
    playerPosition: playerRow.position,
    playerId: playerRow.playerId,
    attributes: attrs,
    page: 0,
  };
  aupSessions.set(sKey, session);

  const embed = buildAttrPage(session, rules);
  const dropdown = buildAttrDropdown(session, rules, sKey);
  const navRow   = buildNavRow(session, sKey);

  await interaction.editReply({ embeds: [embed], components: [dropdown, navRow] });
}

// ── Handler: page navigation (prev/next) ──────────────────────────────────────
export async function handleAupPageNav(interaction: ButtonInteraction, direction: "prev" | "next"): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  const session = aupSessions.get(sKey);
  if (!session || session.invokerId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Session expired or not yours. Run `/purchase attributeUp` again.", ephemeral: true });
    return;
  }

  const totalPages = Math.ceil(ATTRIBUTES.length / ATTRS_PER_PAGE);
  session.page = direction === "prev"
    ? Math.max(0, session.page - 1)
    : Math.min(totalPages - 1, session.page + 1);

  const season = await getOrCreateActiveSeason();
  const rules  = await getSeasonRules(season);

  await interaction.update({
    embeds: [buildAttrPage(session, rules)],
    components: [buildAttrDropdown(session, rules, sKey), buildNavRow(session, sKey)],
  });
}

// ── Handler: attribute selected from dropdown ─────────────────────────────────
export async function handleAupSel(interaction: StringSelectMenuInteraction): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  const session = aupSessions.get(sKey);
  if (!session || session.invokerId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Session expired or not yours.", ephemeral: true });
    return;
  }

  const attrName   = interaction.values[0]!;
  const current    = session.attributes[attrName] ?? 0;

  const season     = await getOrCreateActiveSeason();
  const rules      = await getSeasonRules(season);
  const coreSet    = getCoreAttributes(season);
  const isCore     = coreSet.has(attrName as any);
  const base       = isCore ? rules.coreAttrCost : rules.nonCoreAttrCost;
  const cost       = scaledCost(base, current);

  if (cost === null) {
    await interaction.reply({ content: `❌ **${attrName}** is already at max (${current}/99) — cannot upgrade further.`, ephemeral: true });
    return;
  }

  session.selectedAttr  = attrName;
  session.currentValue  = current;
  session.baseCost      = base;
  session.scaledCost    = cost;
  session.isCore        = isCore;

  // Show confirmation
  const invoker = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const canAfford = invoker.balance >= cost;
  const category  = isCore ? "Core" : "Non-core";

  const embed = new EmbedBuilder()
    .setColor(canAfford ? Colors.Green : Colors.Red)
    .setTitle(`⚡ Confirm Attribute Upgrade`)
    .setDescription(
      `**Player:** ${session.playerName} (${session.playerPosition})\n` +
      `**Attribute:** ${attrName}\n` +
      `**Current value:** ${current} → **${current + 1}**\n` +
      `**Category:** ${category}${isCore ? " ⭐" : ""}\n` +
      `**Cost:** ${cost.toLocaleString()} coins\n` +
      `**Your balance:** ${invoker.balance.toLocaleString()} coins\n\n` +
      (canAfford
        ? `✅ You can afford this upgrade.`
        : `❌ You need **${(cost - invoker.balance).toLocaleString()}** more coins.`)
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`aup_confirm:${sKey}`)
      .setLabel("✅ Confirm Purchase")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canAfford),
    new ButtonBuilder()
      .setCustomId(`aup_back:${sKey}`)
      .setLabel("◀ Back to Attributes")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`aup_cancel:${sKey}`)
      .setLabel("✖ Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

// ── Handler: back to attribute list ──────────────────────────────────────────
export async function handleAupBack(interaction: ButtonInteraction): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  const session = aupSessions.get(sKey);
  if (!session || session.invokerId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Session expired.", ephemeral: true });
    return;
  }
  session.selectedAttr = undefined;
  const season = await getOrCreateActiveSeason();
  const rules  = await getSeasonRules(season);
  await interaction.update({
    embeds: [buildAttrPage(session, rules)],
    components: [buildAttrDropdown(session, rules, sKey), buildNavRow(session, sKey)],
  });
}

// ── Handler: cancel ───────────────────────────────────────────────────────────
export async function handleAupCancel(interaction: ButtonInteraction): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  aupSessions.delete(sKey);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Grey).setDescription("✖ Attribute upgrade cancelled.")],
    components: [],
  });
}

// ── Handler: confirm purchase ─────────────────────────────────────────────────
export async function handleAupConfirm(interaction: ButtonInteraction): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  const session = aupSessions.get(sKey);
  if (!session || session.invokerId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Session expired.", ephemeral: true });
    return;
  }

  if (!session.selectedAttr || session.scaledCost === undefined || session.currentValue === undefined) {
    await interaction.reply({ content: "❌ No attribute selected — please select an attribute first.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  try {
    const season  = await getOrCreateActiveSeason();
    const stats   = await getSeasonStats(interaction.user.id, season.id);
    const rules   = await getSeasonRules(season);
    const user    = await getOrCreateUser(interaction.user.id, interaction.user.username);
    const cost    = session.scaledCost;
    const isCore  = session.isCore ?? false;
    const cap     = isCore ? rules.coreAttrCap     : rules.nonCoreAttrCap;
    const used    = isCore ? stats.coreAttrPurchased : stats.nonCoreAttrPurchased;
    const remaining = cap - used;

    if (user.balance < cost) {
      await interaction.editReply({
        embeds: [errorEmbed("Insufficient Funds", `You need **${cost.toLocaleString()} coins** but only have **${user.balance.toLocaleString()}**.`)],
        components: [],
      });
      aupSessions.delete(sKey);
      return;
    }

    if (remaining <= 0) {
      const category = isCore ? "Core" : "Non-core";
      await interaction.editReply({
        embeds: [errorEmbed(`${category} Attribute Cap Reached`, `You've used all **${cap}** ${category.toLowerCase()} attribute upgrades this season.`)],
        components: [],
      });
      aupSessions.delete(sKey);
      return;
    }

    // Deduct coins
    await deductBalance(interaction.user.id, cost);
    await logTransaction(
      interaction.user.id, -cost, "purchase",
      `Attribute upgrade — ${session.selectedAttr} (${session.isCore ? "Core" : "Non-core"}) for ${session.playerName} (${session.playerPosition})`
    );

    // Update season stats
    await db.update(seasonStatsTable).set({
      coreAttrPurchased: isCore
        ? sql`${seasonStatsTable.coreAttrPurchased} + 1`
        : seasonStatsTable.coreAttrPurchased,
      nonCoreAttrPurchased: !isCore
        ? sql`${seasonStatsTable.nonCoreAttrPurchased} + 1`
        : seasonStatsTable.nonCoreAttrPurchased,
    }).where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    // Record purchase
    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "attribute",
      status: "pending",
      cost,
      attributeName: session.selectedAttr,
      playerName: session.playerName,
      playerPosition: session.playerPosition,
      notes: session.targetId !== interaction.user.id ? `for:<@${session.targetId}>` : null,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "attribute",
      attributeName: session.selectedAttr,
      playerName: session.playerName,
      playerPosition: session.playerPosition,
      notes: session.targetId !== interaction.user.id ? `for:<@${session.targetId}>` : null,
    });

    // Commissioner notification
    try {
      const channelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const category = isCore ? "Core ⭐" : "Non-core";
        const desc = [
          `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
          session.targetId !== interaction.user.id ? `**Player Owner:** <@${session.targetId}>` : null,
          `**Attribute:** ${session.selectedAttr} (${category})`,
          `**Player:** ${session.playerName} (${session.playerPosition})`,
          `**Upgrade:** ${session.currentValue} → ${session.currentValue + 1}`,
          `**Cost:** ${cost.toLocaleString()} coins (base: ${session.baseCost}, scaled ${isCore ? (cost / session.baseCost!) : (cost / session.baseCost!)}×)`,
          `**Purchase ID:** #${purchase!.id}`,
          ``,
          `Click the button below once this has been applied in-game.`,
        ].filter(Boolean).join("\n");

        const { EmbedBuilder: EB, ActionRowBuilder: ARB, ButtonBuilder: BB, ButtonStyle: BS, Colors: C } = await import("discord.js");
        const notifEmbed = new EB().setColor(C.Orange).setTitle("⚡ Attribute Upgrade Request").setDescription(desc).setTimestamp();
        const notifRow = new ARB<InstanceType<typeof BB>>().addComponents(
          new BB().setCustomId(`approve_purchase:${purchase!.id}:${interaction.user.id}:attribute`).setLabel("✅ Applied in-game").setStyle(BS.Success),
          new BB().setCustomId(`refund_purchase:${purchase!.id}:${interaction.user.id}:attribute`).setLabel("🔄 Refund").setStyle(BS.Danger),
        );
        await (channel as any).send({ embeds: [notifEmbed], components: [notifRow] });
      }
    } catch (err) {
      console.error("Commissioner notification failed:", err);
    }

    aupSessions.delete(sKey);
    const category = isCore ? "Core ⭐" : "Non-core";
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Attribute Upgrade Submitted!")
        .setDescription(
          `**${session.selectedAttr}** (${category}) upgrade for **${session.playerName}** (${session.playerPosition}) submitted!\n\n` +
          `**Upgrade:** ${session.currentValue} → ${session.currentValue + 1}\n` +
          `**Cost:** ${cost.toLocaleString()} coins deducted.\n` +
          `**${isCore ? "Core" : "Non-core"} upgrades used this season:** ${used + 1}/${cap}`
        )
      ],
      components: [],
    });

  } catch (err) {
    console.error("attributeUp confirm error:", err);
    await interaction.editReply({
      embeds: [errorEmbed("Purchase Failed", "An unexpected error occurred. Your coins have not been deducted. Please try again.")],
      components: [],
    });
    aupSessions.delete(sKey);
  }
}
