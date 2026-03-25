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
  getLegendPurchaseHistory, deductBalance, getInventoryCount,
} from "../lib/db-helpers.js";
import { successEmbed, errorEmbed, pendingEmbed } from "../lib/embeds.js";
import { COSTS, LIMITS, ATTRIBUTES, CUSTOM_PLAYER_TIERS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("purchase")
  .setDescription("Purchase an item from the store")
  .addStringOption(opt =>
    opt.setName("type")
      .setDescription("What would you like to purchase?")
      .setRequired(true)
      .addChoices(
        { name: "Legend (1,000 coins)", value: "legend" },
        { name: "Attribute Upgrade (40 coins)", value: "attribute" },
        { name: "Development Upgrade (250 coins)", value: "dev_up" },
        { name: "Age Reset (250 coins)", value: "age_reset" },
        { name: "Custom Player - Gold (300 coins)", value: "custom_player_gold" },
        { name: "Custom Player - Silver (200 coins)", value: "custom_player_silver" },
        { name: "Custom Player - Bronze (100 coins)", value: "custom_player_bronze" },
      )
  )
  .addStringOption(opt =>
    opt.setName("legend_name")
      .setDescription("For Legends: the exact legend name (use /viewstore to see available legends)")
      .setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("attribute")
      .setDescription("For Attributes: which attribute? (start typing to search)")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addStringOption(opt =>
    opt.setName("player_name")
      .setDescription("For Dev Up / Age Reset / Custom Player: player name")
      .setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("player_position")
      .setDescription("For Dev Up / Age Reset / Custom Player: player position")
      .setRequired(false)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = ATTRIBUTES.filter(a => a.toLowerCase().includes(focused)).slice(0, 25);
  await interaction.respond(matches.map(a => ({ name: a, value: a })));
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const type = interaction.options.getString("type", true) as keyof typeof COSTS;
  const user = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const season = await getOrCreateActiveSeason();
  const stats = await getSeasonStats(interaction.user.id, season.id);
  const cost = COSTS[type];

  // Balance check
  if (user.balance < cost) {
    return interaction.editReply({
      embeds: [errorEmbed("Insufficient Funds", `You need **${cost.toLocaleString()} coins** but only have **${user.balance.toLocaleString()} coins**. You're short by **${(cost - user.balance).toLocaleString()} coins**.`)],
    });
  }

  // --- LEGEND ---
  if (type === "legend") {
    const legendName = interaction.options.getString("legend_name");
    if (!legendName) {
      return interaction.editReply({ embeds: [errorEmbed("Missing Info", "Please specify the **legend_name** you want to purchase. Use `/viewstore` to see available legends.")] });
    }

    // Check all-time limit
    const legendHistory = await getLegendPurchaseHistory(interaction.user.id);
    if (legendHistory.total >= LIMITS.legendsAllTime) {
      return interaction.editReply({
        embeds: [errorEmbed("Purchase Limit Reached", `You have reached the maximum of **${LIMITS.legendsAllTime} legend purchases** in this franchise.`)],
      });
    }

    // Find legend in store
    const legends = await db.select().from(legendsTable).where(eq(legendsTable.isAvailable, true));
    const legend = legends.find(l => l.name.toLowerCase() === legendName.toLowerCase());
    if (!legend) {
      const availableNames = legends.map(l => l.name).join(", ");
      return interaction.editReply({
        embeds: [errorEmbed("Legend Not Found", `**"${legendName}"** is not available in the store.\n\nAvailable legends: ${availableNames || "None currently"}\n\nUse \`/viewstore\` to see the full list.`)],
      });
    }

    // Check inventory cap
    const invCount = await getInventoryCount(interaction.user.id, season.id);
    if (invCount.legends >= LIMITS.maxLegendsInInventory) {
      return interaction.editReply({
        embeds: [errorEmbed("Inventory Full", `You already have **${LIMITS.maxLegendsInInventory} legends** in your inventory. You cannot hold more.`)],
      });
    }
    if (invCount.legends + invCount.customs >= LIMITS.maxLegendsPlusCustomPlayers) {
      return interaction.editReply({
        embeds: [errorEmbed("Inventory Full", `You already have **${invCount.legends + invCount.customs}** combined legends and custom players (max ${LIMITS.maxLegendsPlusCustomPlayers}) for this season.`)],
      });
    }

    // Deduct and create purchase
    await deductBalance(interaction.user.id, cost);
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

    // Update all-time legend count
    await db.update(usersTable)
      .set({ totalLegendPurchases: sql`${usersTable.totalLegendPurchases} + 1`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, interaction.user.id));

    // Send commissioner notification
    await sendCommissionerNotification(interaction, "legend", purchase!.id, {
      legendId: legend.id,
      legendName: legend.name,
      legendPosition: legend.position,
    });

    return interaction.editReply({
      embeds: [pendingEmbed("Legend Purchase Submitted!", `Your request for **${legend.name}** has been submitted and is pending commissioner approval.\n\nYou'll be notified once the player has been added to the draft pool.\n\n**Cost:** ${cost.toLocaleString()} coins deducted.`)],
    });
  }

  // --- ATTRIBUTE ---
  if (type === "attribute") {
    const attributeName = interaction.options.getString("attribute");
    const playerName = interaction.options.getString("player_name");
    if (!attributeName) {
      return interaction.editReply({ embeds: [errorEmbed("Missing Info", "Please select an **attribute** to upgrade by typing in the attribute field.")] });
    }

    if (!ATTRIBUTES.includes(attributeName as any)) {
      return interaction.editReply({ embeds: [errorEmbed("Invalid Attribute", `**${attributeName}** is not a valid attribute. Start typing in the attribute field to see options.`)] });
    }

    // Season limit
    if (stats.attributesPurchased >= LIMITS.attributesPerSeason) {
      return interaction.editReply({
        embeds: [errorEmbed("Limit Reached", `You've used all **${LIMITS.attributesPerSeason} attribute upgrades** for this season.`)],
      });
    }

    // Speed cap
    if (attributeName === "Speed" && stats.speedPointsPurchased >= LIMITS.speedPointsPerSeason) {
      return interaction.editReply({
        embeds: [errorEmbed("Speed Cap Reached", `You've already used **${LIMITS.speedPointsPerSeason} speed points** this season.`)],
      });
    }

    await deductBalance(interaction.user.id, cost);

    // Update season stats
    await db.update(seasonStatsTable)
      .set({
        attributesPurchased: sql`${seasonStatsTable.attributesPurchased} + 1`,
        speedPointsPurchased: attributeName === "Speed"
          ? sql`${seasonStatsTable.speedPointsPurchased} + 1`
          : seasonStatsTable.speedPointsPurchased,
      })
      .where(and(
        eq(seasonStatsTable.discordId, interaction.user.id),
        eq(seasonStatsTable.seasonId, season.id),
      ));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "attribute",
      status: "pending",
      cost,
      attributeName,
      playerName: playerName ?? null,
    }).returning();

    // Add to inventory
    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "attribute",
      attributeName,
      playerName: playerName ?? null,
    });

    await sendCommissionerNotification(interaction, "attribute", purchase!.id, {
      attributeName,
      playerName: playerName ?? "Not specified",
    });

    return interaction.editReply({
      embeds: [pendingEmbed("Attribute Upgrade Submitted!", `Your **${attributeName}** upgrade${playerName ? ` for **${playerName}**` : ""} has been submitted.\n\nA commissioner will apply it in-game.\n\n**Cost:** ${cost.toLocaleString()} coins deducted.\n**Upgrades used this season:** ${stats.attributesPurchased + 1}/${LIMITS.attributesPerSeason}`)],
    });
  }

  // --- DEV UP ---
  if (type === "dev_up") {
    const playerName = interaction.options.getString("player_name");
    const playerPosition = interaction.options.getString("player_position");
    if (!playerName || !playerPosition) {
      return interaction.editReply({ embeds: [errorEmbed("Missing Info", "Please specify both **player_name** and **player_position** for a Dev Upgrade.")] });
    }

    if (stats.devUpsPurchased >= LIMITS.devUpsPerSeason) {
      return interaction.editReply({
        embeds: [errorEmbed("Limit Reached", `You've used all **${LIMITS.devUpsPerSeason} dev upgrades** for this season.`)],
      });
    }

    await deductBalance(interaction.user.id, cost);
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
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "dev_up",
      playerName,
      playerPosition,
    });

    await sendCommissionerNotification(interaction, "dev_up", purchase!.id, { playerName, playerPosition });

    return interaction.editReply({
      embeds: [pendingEmbed("Dev Upgrade Submitted!", `Dev upgrade for **${playerName}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n**Cost:** ${cost.toLocaleString()} coins deducted.\n**Dev upgrades used:** ${stats.devUpsPurchased + 1}/${LIMITS.devUpsPerSeason}`)],
    });
  }

  // --- AGE RESET ---
  if (type === "age_reset") {
    const playerName = interaction.options.getString("player_name");
    const playerPosition = interaction.options.getString("player_position");
    if (!playerName || !playerPosition) {
      return interaction.editReply({ embeds: [errorEmbed("Missing Info", "Please specify both **player_name** and **player_position** for an Age Reset.")] });
    }

    if (stats.ageResetsPurchased >= LIMITS.ageResetsPerSeason) {
      return interaction.editReply({
        embeds: [errorEmbed("Limit Reached", `You've used all **${LIMITS.ageResetsPerSeason} age resets** for this season.`)],
      });
    }

    await deductBalance(interaction.user.id, cost);
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
      embeds: [pendingEmbed("Age Reset Submitted!", `Age reset for **${playerName}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n**Cost:** ${cost.toLocaleString()} coins deducted.\n**Age resets used:** ${stats.ageResetsPurchased + 1}/${LIMITS.ageResetsPerSeason}`)],
    });
  }

  // --- CUSTOM PLAYER ---
  if (type === "custom_player_gold" || type === "custom_player_silver" || type === "custom_player_bronze") {
    const playerName = interaction.options.getString("player_name");
    const playerPosition = interaction.options.getString("player_position");
    const tier = type.replace("custom_player_", "") as "gold" | "silver" | "bronze";

    if (!playerName || !playerPosition) {
      return interaction.editReply({ embeds: [errorEmbed("Missing Info", "Please specify both **player_name** and **player_position** for a Custom Player.")] });
    }

    // Combined inventory cap
    const invCount = await getInventoryCount(interaction.user.id, season.id);
    if (invCount.legends + invCount.customs >= LIMITS.maxLegendsPlusCustomPlayers) {
      return interaction.editReply({
        embeds: [errorEmbed("Inventory Full", `You already have **${invCount.legends + invCount.customs}** combined legends and custom players (max ${LIMITS.maxLegendsPlusCustomPlayers}) for this season.`)],
      });
    }

    await deductBalance(interaction.user.id, cost);

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: type,
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
      itemType: type,
      playerName,
      playerPosition,
      customPlayerTier: tier,
    });

    const tierName = tier.charAt(0).toUpperCase() + tier.slice(1);
    await sendCommissionerNotification(interaction, type, purchase!.id, { playerName, playerPosition, tier: tierName });

    return interaction.editReply({
      embeds: [pendingEmbed("Custom Player Submitted!", `**${tierName}** custom player **${playerName}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n**Cost:** ${cost.toLocaleString()} coins deducted.`)],
    });
  }
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
