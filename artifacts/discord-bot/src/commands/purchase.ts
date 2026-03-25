import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel,
  AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { legendsTable, purchasesTable, inventoryTable, usersTable, seasonStatsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getSeasonStats,
  getLegendPurchaseHistory, deductBalance, getInventoryCount, logTransaction, getSeasonRules,
} from "../lib/db-helpers.js";
import { successEmbed, errorEmbed, pendingEmbed } from "../lib/embeds.js";
import { COSTS, LIMITS, ATTRIBUTES, CORE_ATTRIBUTES, NFL_POSITIONS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("purchase")
  .setDescription("Purchase an item from the store")

  // ── Legend ──────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("legend")
      .setDescription(`Buy a legend (${COSTS.legend.toLocaleString()} coins) — max 4 all-time`)
      .addStringOption(opt =>
        opt.setName("legend_name")
          .setDescription("Select a legend from the store")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )

  // ── Attribute ───────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("attribute")
      .setDescription("Upgrade an attribute — Core: 25 coins/cap 16 | Non-Core: 10 coins/cap 32")
      .addStringOption(opt =>
        opt.setName("attribute_name")
          .setDescription("Which attribute to upgrade?")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("player_name")
          .setDescription("Name of the player receiving the upgrade")
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("player_position")
          .setDescription("Player's position")
          .setRequired(true)
          .addChoices(...NFL_POSITIONS.map(p => ({ name: p, value: p })))
      )
      .addIntegerOption(opt =>
        opt.setName("quantity")
          .setDescription("How many attribute points to purchase (default: 1)")
          .setRequired(false)
          .setMinValue(1)
      )
  )

  // ── Dev Upgrade ─────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("devup")
      .setDescription(`Dev upgrade a player (${COSTS.dev_up} coins) — 2/season, Star or Superstar only`)
      .addStringOption(opt =>
        opt.setName("dev_type")
          .setDescription("Star or Superstar?")
          .setRequired(true)
          .addChoices(
            { name: "Star", value: "Star" },
            { name: "Superstar", value: "Superstar" },
          )
      )
      .addStringOption(opt =>
        opt.setName("player_name")
          .setDescription("Player's name")
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("player_position")
          .setDescription("Player's position (e.g. QB, WR, CB)")
          .setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName("quantity")
          .setDescription("How many dev upgrades to purchase (default: 1)")
          .setRequired(false)
          .setMinValue(1)
      )
  )

  // ── Age Reset ───────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("agereset")
      .setDescription(`Reset a player's age (${COSTS.age_reset} coins) — 2/season`)
      .addStringOption(opt =>
        opt.setName("player_name")
          .setDescription("Player's name")
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("player_position")
          .setDescription("Player's position (e.g. QB, WR, CB)")
          .setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName("quantity")
          .setDescription("How many age resets to purchase (default: 1)")
          .setRequired(false)
          .setMinValue(1)
      )
  )

  // ── Custom Player ───────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("customplayer")
      .setDescription("Create a custom player — Gold 300 / Silver 200 / Bronze 100 coins")
      .addStringOption(opt =>
        opt.setName("tier")
          .setDescription("Player tier")
          .setRequired(true)
          .addChoices(
            { name: "Gold (300 coins)", value: "custom_player_gold" },
            { name: "Silver (200 coins)", value: "custom_player_silver" },
            { name: "Bronze (100 coins)", value: "custom_player_bronze" },
          )
      )
      .addStringOption(opt =>
        opt.setName("player_name")
          .setDescription("Player's name")
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("player_position")
          .setDescription("Player's position (e.g. QB, WR, CB)")
          .setRequired(true)
      )
  );

// ── Autocomplete ──────────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction) {
  const sub = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused().toLowerCase();

  if (sub === "legend") {
    const available = await db.select().from(legendsTable).where(eq(legendsTable.isAvailable, true));
    const matches = available
      .filter(l => l.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(l => ({ name: `${l.name} — ${l.position} (${l.cost.toLocaleString()} coins)`, value: l.name }));
    await interaction.respond(matches);
    return;
  }

  if (sub === "attribute") {
    const matches = ATTRIBUTES
      .filter(a => a.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(a => ({ name: a, value: a }));
    await interaction.respond(matches);
    return;
  }

  await interaction.respond([]);
}

// ── Execute ───────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();
  const user = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const season = await getOrCreateActiveSeason();
  const stats = await getSeasonStats(interaction.user.id, season.id);
  const rules = await getSeasonRules(season);

  // ── /purchase legend ────────────────────────────────────────────────────────
  if (sub === "legend") {
    const cost = COSTS.legend;
    if (user.balance < cost) return insufficientFunds(interaction, cost, user.balance);

    const legendName = interaction.options.getString("legend_name", true);

    const legendHistory = await getLegendPurchaseHistory(interaction.user.id);
    if (legendHistory.total >= LIMITS.legendsAllTime) {
      return interaction.editReply({
        embeds: [errorEmbed("Purchase Limit Reached", `You have reached the maximum of **${LIMITS.legendsAllTime} legend purchases** in this franchise.`)],
      });
    }

    const legends = await db.select().from(legendsTable).where(eq(legendsTable.isAvailable, true));
    const legend = legends.find(l => l.name.toLowerCase() === legendName.toLowerCase());
    if (!legend) {
      const names = legends.map(l => l.name).join(", ");
      return interaction.editReply({
        embeds: [errorEmbed("Legend Not Found", `**"${legendName}"** is not available.\n\nAvailable: ${names || "None currently — check back soon!"}\n\nUse \`/viewstore\` to browse.`)],
      });
    }

    const invCount = await getInventoryCount(interaction.user.id, season.id);
    if (invCount.legends >= LIMITS.maxLegendsInInventory) {
      return interaction.editReply({ embeds: [errorEmbed("Inventory Full", `You already have **${LIMITS.maxLegendsInInventory} legends** in your inventory.`)] });
    }
    if (invCount.legends + invCount.customs >= LIMITS.maxLegendsPlusCustomPlayers) {
      return interaction.editReply({ embeds: [errorEmbed("Inventory Full", `You already have **${invCount.legends + invCount.customs}** combined legends and custom players (max ${LIMITS.maxLegendsPlusCustomPlayers}).`)] });
    }

    await deductBalance(interaction.user.id, cost);
    await logTransaction(interaction.user.id, -cost, "purchase", `Legend purchase — ${legend.name} (${legend.position})`);
    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "legend",
      status: "pending",
      cost,
      legendId: legend.id,
      playerName: legend.name,
      playerPosition: legend.position,
    }).returning();

    await db.update(usersTable)
      .set({ totalLegendPurchases: sql`${usersTable.totalLegendPurchases} + 1`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, interaction.user.id));

    await sendCommissionerNotification(interaction, "legend", purchase!.id, {
      legendId: legend.id, legendName: legend.name, legendPosition: legend.position,
    });

    return interaction.editReply({
      embeds: [pendingEmbed("Legend Purchase Submitted!", `Your request for **${legend.name}** has been submitted and is pending commissioner approval.\n\nYou'll be notified once the player has been added to the draft pool.\n\n**Cost:** ${cost.toLocaleString()} coins deducted.`)],
    });
  }

  // ── /purchase attribute ─────────────────────────────────────────────────────
  if (sub === "attribute") {
    const attributeName = interaction.options.getString("attribute_name", true);
    const playerName = interaction.options.getString("player_name", true);
    const playerPosition = interaction.options.getString("player_position", true);
    const quantity = interaction.options.getInteger("quantity") ?? 1;

    if (!ATTRIBUTES.includes(attributeName as any)) {
      return interaction.editReply({ embeds: [errorEmbed("Invalid Attribute", `**${attributeName}** is not a valid attribute. Use the autocomplete list when typing.`)] });
    }

    const isCore = CORE_ATTRIBUTES.has(attributeName);
    const costPer = isCore ? rules.coreAttrCost    : rules.nonCoreAttrCost;
    const cap     = isCore ? rules.coreAttrCap     : rules.nonCoreAttrCap;
    const used    = isCore ? stats.coreAttrPurchased : stats.nonCoreAttrPurchased;
    const category = isCore ? "Core" : "Non-Core";
    const remaining = cap - used;
    const totalCost = costPer * quantity;

    if (quantity > remaining) {
      return interaction.editReply({
        embeds: [errorEmbed(
          `Exceeds ${category} Attribute Cap`,
          `You only have **${remaining} ${category.toLowerCase()} upgrade${remaining === 1 ? "" : "s"}** remaining this season (cap: ${cap}), but requested **${quantity}**.\n\n` +
          (isCore
            ? `Non-core upgrades available: **${Math.max(0, rules.nonCoreAttrCap - stats.nonCoreAttrPurchased)}** (${rules.nonCoreAttrCost} coins each).`
            : `Core upgrades available: **${Math.max(0, rules.coreAttrCap - stats.coreAttrPurchased)}** (${rules.coreAttrCost} coins each).`)
        )],
      });
    }

    if (user.balance < totalCost) return insufficientFunds(interaction, totalCost, user.balance);

    await deductBalance(interaction.user.id, totalCost);
    await logTransaction(interaction.user.id, -totalCost, "purchase", `Attribute upgrade (${category}) ×${quantity} — ${attributeName} for ${playerName} (${playerPosition})`);
    await db.update(seasonStatsTable).set({
      coreAttrPurchased: isCore
        ? sql`${seasonStatsTable.coreAttrPurchased} + ${quantity}`
        : seasonStatsTable.coreAttrPurchased,
      nonCoreAttrPurchased: !isCore
        ? sql`${seasonStatsTable.nonCoreAttrPurchased} + ${quantity}`
        : seasonStatsTable.nonCoreAttrPurchased,
    }).where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "attribute",
      status: "pending",
      cost: totalCost,
      attributeName,
      playerName,
      playerPosition,
      notes: quantity > 1 ? `qty:${quantity}` : null,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "attribute",
      attributeName,
      playerName,
      playerPosition,
      notes: quantity > 1 ? `qty:${quantity}` : null,
    });

    await sendCommissionerNotification(interaction, "attribute", purchase!.id, {
      attributeName, playerName, playerPosition, category, quantity: String(quantity), costPer: String(costPer),
    });

    return interaction.editReply({
      embeds: [pendingEmbed(
        "Attribute Upgrade Submitted!",
        `**${attributeName} ×${quantity}** for **${playerName}** (${playerPosition}) submitted!\n\n` +
        `**Category:** ${category} (${costPer} coins/pt)\n` +
        `**Total Cost:** ${totalCost.toLocaleString()} coins deducted.\n` +
        `**${category} upgrades used this season:** ${used + quantity}/${cap}`
      )],
    });
  }

  // ── /purchase devup ─────────────────────────────────────────────────────────
  if (sub === "devup") {
    const playerName = interaction.options.getString("player_name", true);
    const playerPosition = interaction.options.getString("player_position", true);
    const devUpType = interaction.options.getString("dev_type", true);
    const quantity = interaction.options.getInteger("quantity") ?? 1;
    const costPer = COSTS.dev_up;
    const totalCost = costPer * quantity;
    const remaining = rules.devUpsCap - stats.devUpsPurchased;

    if (quantity > remaining) {
      return interaction.editReply({
        embeds: [errorEmbed("Dev Upgrade Limit Exceeded", `You only have **${remaining} dev upgrade${remaining === 1 ? "" : "s"}** remaining this season (cap: ${rules.devUpsCap}), but requested **${quantity}**.`)],
      });
    }

    if (user.balance < totalCost) return insufficientFunds(interaction, totalCost, user.balance);

    await deductBalance(interaction.user.id, totalCost);
    await logTransaction(interaction.user.id, -totalCost, "purchase", `Dev upgrade (${devUpType}) ×${quantity} — ${playerName} (${playerPosition})`);
    await db.update(seasonStatsTable)
      .set({ devUpsPurchased: sql`${seasonStatsTable.devUpsPurchased} + ${quantity}` })
      .where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "dev_up",
      status: "pending",
      cost: totalCost,
      playerName,
      playerPosition,
      notes: `${devUpType}${quantity > 1 ? `;qty:${quantity}` : ""}`,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "dev_up",
      playerName,
      playerPosition,
      notes: `${devUpType}${quantity > 1 ? `;qty:${quantity}` : ""}`,
    });

    await sendCommissionerNotification(interaction, "dev_up", purchase!.id, { playerName, playerPosition, devUpType, quantity: String(quantity), costPer: String(costPer) });

    return interaction.editReply({
      embeds: [pendingEmbed(
        "Dev Upgrade Submitted!",
        `**${devUpType}** dev upgrade ×${quantity} for **${playerName}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n` +
        `**Total Cost:** ${totalCost.toLocaleString()} coins deducted.\n` +
        `**Dev upgrades used:** ${stats.devUpsPurchased + quantity}/${rules.devUpsCap}`
      )],
    });
  }

  // ── /purchase agereset ──────────────────────────────────────────────────────
  if (sub === "agereset") {
    const playerName = interaction.options.getString("player_name", true);
    const playerPosition = interaction.options.getString("player_position", true);
    const quantity = interaction.options.getInteger("quantity") ?? 1;
    const costPer = COSTS.age_reset;
    const totalCost = costPer * quantity;
    const remaining = rules.ageResetsCap - stats.ageResetsPurchased;

    if (quantity > remaining) {
      return interaction.editReply({
        embeds: [errorEmbed("Age Reset Limit Exceeded", `You only have **${remaining} age reset${remaining === 1 ? "" : "s"}** remaining this season (cap: ${rules.ageResetsCap}), but requested **${quantity}**.`)],
      });
    }

    if (user.balance < totalCost) return insufficientFunds(interaction, totalCost, user.balance);

    await deductBalance(interaction.user.id, totalCost);
    await logTransaction(interaction.user.id, -totalCost, "purchase", `Age reset ×${quantity} — ${playerName} (${playerPosition})`);
    await db.update(seasonStatsTable)
      .set({ ageResetsPurchased: sql`${seasonStatsTable.ageResetsPurchased} + ${quantity}` })
      .where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "age_reset",
      status: "pending",
      cost: totalCost,
      playerName,
      playerPosition,
      notes: quantity > 1 ? `qty:${quantity}` : null,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "age_reset",
      playerName,
      playerPosition,
      notes: quantity > 1 ? `qty:${quantity}` : null,
    });

    await sendCommissionerNotification(interaction, "age_reset", purchase!.id, { playerName, playerPosition, quantity: String(quantity), costPer: String(costPer) });

    return interaction.editReply({
      embeds: [pendingEmbed(
        "Age Reset Submitted!",
        `Age reset ×${quantity} for **${playerName}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n` +
        `**Total Cost:** ${totalCost.toLocaleString()} coins deducted.\n` +
        `**Age resets used:** ${stats.ageResetsPurchased + quantity}/${rules.ageResetsCap}`
      )],
    });
  }

  // ── /purchase customplayer ──────────────────────────────────────────────────
  if (sub === "customplayer") {
    const tierValue = interaction.options.getString("tier", true) as "custom_player_gold" | "custom_player_silver" | "custom_player_bronze";
    const playerName = interaction.options.getString("player_name", true);
    const playerPosition = interaction.options.getString("player_position", true);
    const cost = COSTS[tierValue];
    const tier = tierValue.replace("custom_player_", "") as "gold" | "silver" | "bronze";

    if (user.balance < cost) return insufficientFunds(interaction, cost, user.balance);

    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    const invCount = await getInventoryCount(interaction.user.id, season.id);
    if (invCount.legends + invCount.customs >= LIMITS.maxLegendsPlusCustomPlayers) {
      return interaction.editReply({ embeds: [errorEmbed("Inventory Full", `You already have **${invCount.legends + invCount.customs}** combined legends and custom players (max ${LIMITS.maxLegendsPlusCustomPlayers}).`)] });
    }

    await deductBalance(interaction.user.id, cost);
    await logTransaction(interaction.user.id, -cost, "purchase", `Custom player (${tierLabel}) — ${playerName} (${playerPosition})`);

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: tierValue,
      status: "pending",
      cost,
      playerName,
      playerPosition,
      customPlayerTier: tier,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: tierValue,
      playerName,
      playerPosition,
      customPlayerTier: tier,
    });

    const tierName = tier.charAt(0).toUpperCase() + tier.slice(1);
    await sendCommissionerNotification(interaction, tierValue, purchase!.id, { playerName, playerPosition, tier: tierName });

    return interaction.editReply({
      embeds: [pendingEmbed("Custom Player Submitted!", `**${tierName}** custom player **${playerName}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n**Cost:** ${cost} coins deducted.`)],
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function insufficientFunds(interaction: ChatInputCommandInteraction, cost: number, balance: number) {
  return interaction.editReply({
    embeds: [errorEmbed("Insufficient Funds", `You need **${cost.toLocaleString()} coins** but only have **${balance.toLocaleString()} coins**. You're short by **${(cost - balance).toLocaleString()} coins**.`)],
  });
}

async function sendCommissionerNotification(
  interaction: ChatInputCommandInteraction,
  type: string,
  purchaseId: number,
  details: Record<string, string | number | undefined>,
) {
  const channelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  let title = "";
  let description = "";
  let buttonLabel = "✅ Mark as Applied";

  if (type === "legend") {
    title = "🏆 Legend Purchase Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      `**Legend:** ${details["legendName"]} (${details["legendPosition"]})`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Once you've added this player to the draft pool, click the button below to notify the member.",
    ].join("\n");
    buttonLabel = "✅ Added to Draft Pool";
  } else if (type === "attribute") {
    const qty = parseInt(details["quantity"] ?? "1");
    const costPer = details["costPer"];
    title = "⚡ Attribute Upgrade Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      `**Attribute:** ${details["attributeName"]} (${details["category"]})`,
      `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
      `**Quantity:** ${qty} point${qty > 1 ? "s" : ""} × ${costPer} coins = **${qty * parseInt(costPer ?? "0")} coins**`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Click the button below once this has been applied in-game.",
    ].join("\n");
  } else if (type === "dev_up") {
    const qty = parseInt(details["quantity"] ?? "1");
    const costPer = details["costPer"];
    title = "📈 Dev Upgrade Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
      `**Upgrade Type:** ${details["devUpType"]}`,
      `**Quantity:** ${qty} × ${costPer} coins = **${qty * parseInt(costPer ?? "0")} coins**`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Click the button below once this has been applied in-game.",
    ].join("\n");
  } else if (type === "age_reset") {
    const qty = parseInt(details["quantity"] ?? "1");
    const costPer = details["costPer"];
    title = "🔄 Age Reset Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
      `**Quantity:** ${qty} reset${qty > 1 ? "s" : ""} × ${costPer} coins = **${qty * parseInt(costPer ?? "0")} coins**`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Click the button below once this has been applied in-game.",
    ].join("\n");
  } else if (type.startsWith("custom_player")) {
    title = `🎨 Custom Player Request — ${details["tier"]}`;
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
      `**Tier:** ${details["tier"]}`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Click the button below once this has been applied in-game.",
    ].join("\n");
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_purchase:${purchaseId}:${interaction.user.id}:${type}`)
      .setLabel(buttonLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`refund_purchase:${purchaseId}:${interaction.user.id}:${type}`)
      .setLabel("🔄 Refund")
      .setStyle(ButtonStyle.Danger),
  );

  await (channel as TextChannel).send({ embeds: [embed], components: [row] });
}
