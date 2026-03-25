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
  getLegendPurchaseHistory, deductBalance, getInventoryCount, logTransaction,
} from "../lib/db-helpers.js";
import { successEmbed, errorEmbed, pendingEmbed } from "../lib/embeds.js";
import { COSTS, LIMITS, ATTRIBUTES } from "../lib/constants.js";

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
      .setDescription(`Upgrade an attribute (${COSTS.attribute} coins) — 20/season, Speed capped at 5`)
      .addStringOption(opt =>
        opt.setName("attribute_name")
          .setDescription("Which attribute to upgrade?")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("player_name")
          .setDescription("Optional: which player is receiving the upgrade?")
          .setRequired(false)
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
    const cost = COSTS.attribute;
    if (user.balance < cost) return insufficientFunds(interaction, cost, user.balance);

    const attributeName = interaction.options.getString("attribute_name", true);
    const playerName = interaction.options.getString("player_name");

    if (!ATTRIBUTES.includes(attributeName as any)) {
      return interaction.editReply({ embeds: [errorEmbed("Invalid Attribute", `**${attributeName}** is not a valid attribute. Use the autocomplete list when typing.`)] });
    }

    if (stats.attributesPurchased >= LIMITS.attributesPerSeason) {
      return interaction.editReply({ embeds: [errorEmbed("Limit Reached", `You've used all **${LIMITS.attributesPerSeason} attribute upgrades** for this season.`)] });
    }

    if (attributeName === "Speed" && stats.speedPointsPurchased >= LIMITS.speedPointsPerSeason) {
      return interaction.editReply({ embeds: [errorEmbed("Speed Cap Reached", `You've already used **${LIMITS.speedPointsPerSeason} speed points** this season.`)] });
    }

    await deductBalance(interaction.user.id, cost);
    await logTransaction(interaction.user.id, -cost, "purchase", `Attribute upgrade — ${attributeName}${playerName ? ` for ${playerName}` : ""}`);
    await db.update(seasonStatsTable).set({
      attributesPurchased: sql`${seasonStatsTable.attributesPurchased} + 1`,
      speedPointsPurchased: attributeName === "Speed"
        ? sql`${seasonStatsTable.speedPointsPurchased} + 1`
        : seasonStatsTable.speedPointsPurchased,
    }).where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "attribute",
      status: "pending",
      cost,
      attributeName,
      playerName: playerName ?? null,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "attribute",
      attributeName,
      playerName: playerName ?? null,
    });

    await sendCommissionerNotification(interaction, "attribute", purchase!.id, {
      attributeName, playerName: playerName ?? "Not specified",
    });

    return interaction.editReply({
      embeds: [pendingEmbed("Attribute Upgrade Submitted!", `**${attributeName}** upgrade${playerName ? ` for **${playerName}**` : ""} submitted!\n\nA commissioner will apply it in-game.\n\n**Cost:** ${cost} coins deducted.\n**Upgrades used this season:** ${stats.attributesPurchased + 1}/${LIMITS.attributesPerSeason}`)],
    });
  }

  // ── /purchase devup ─────────────────────────────────────────────────────────
  if (sub === "devup") {
    const cost = COSTS.dev_up;
    if (user.balance < cost) return insufficientFunds(interaction, cost, user.balance);

    const playerName = interaction.options.getString("player_name", true);
    const playerPosition = interaction.options.getString("player_position", true);
    const devUpType = interaction.options.getString("dev_type", true);

    if (stats.devUpsPurchased >= LIMITS.devUpsPerSeason) {
      return interaction.editReply({ embeds: [errorEmbed("Limit Reached", `You've used all **${LIMITS.devUpsPerSeason} dev upgrades** for this season.`)] });
    }

    await deductBalance(interaction.user.id, cost);
    await logTransaction(interaction.user.id, -cost, "purchase", `Dev upgrade (${devUpType}) — ${playerName} (${playerPosition})`);
    await db.update(seasonStatsTable)
      .set({ devUpsPurchased: sql`${seasonStatsTable.devUpsPurchased} + 1` })
      .where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "dev_up",
      status: "pending",
      cost,
      playerName,
      playerPosition,
      notes: devUpType,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "dev_up",
      playerName,
      playerPosition,
      notes: devUpType,
    });

    await sendCommissionerNotification(interaction, "dev_up", purchase!.id, { playerName, playerPosition, devUpType });

    return interaction.editReply({
      embeds: [pendingEmbed("Dev Upgrade Submitted!", `**${devUpType}** dev upgrade for **${playerName}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n**Cost:** ${cost} coins deducted.\n**Dev upgrades used:** ${stats.devUpsPurchased + 1}/${LIMITS.devUpsPerSeason}`)],
    });
  }

  // ── /purchase agereset ──────────────────────────────────────────────────────
  if (sub === "agereset") {
    const cost = COSTS.age_reset;
    if (user.balance < cost) return insufficientFunds(interaction, cost, user.balance);

    const playerName = interaction.options.getString("player_name", true);
    const playerPosition = interaction.options.getString("player_position", true);

    if (stats.ageResetsPurchased >= LIMITS.ageResetsPerSeason) {
      return interaction.editReply({ embeds: [errorEmbed("Limit Reached", `You've used all **${LIMITS.ageResetsPerSeason} age resets** for this season.`)] });
    }

    await deductBalance(interaction.user.id, cost);
    await logTransaction(interaction.user.id, -cost, "purchase", `Age reset — ${playerName} (${playerPosition})`);
    await db.update(seasonStatsTable)
      .set({ ageResetsPurchased: sql`${seasonStatsTable.ageResetsPurchased} + 1` })
      .where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "age_reset",
      status: "pending",
      cost,
      playerName,
      playerPosition,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "age_reset",
      playerName,
      playerPosition,
    });

    await sendCommissionerNotification(interaction, "age_reset", purchase!.id, { playerName, playerPosition });

    return interaction.editReply({
      embeds: [pendingEmbed("Age Reset Submitted!", `Age reset for **${playerName}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n**Cost:** ${cost} coins deducted.\n**Age resets used:** ${stats.ageResetsPurchased + 1}/${LIMITS.ageResetsPerSeason}`)],
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
    title = "⚡ Attribute Upgrade Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      `**Attribute:** ${details["attributeName"]}`,
      `**Player:** ${details["playerName"] ?? "Not specified"}`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Click the button below once this has been applied in-game.",
    ].join("\n");
  } else if (type === "dev_up") {
    title = "📈 Dev Upgrade Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
      `**Upgrade Type:** ${details["devUpType"]}`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Click the button below once this has been applied in-game.",
    ].join("\n");
  } else if (type === "age_reset") {
    title = "🔄 Age Reset Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
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
