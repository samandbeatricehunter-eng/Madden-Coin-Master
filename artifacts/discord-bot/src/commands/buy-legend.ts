import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  legendsTable, purchasesTable, usersTable,
} from "@workspace/db";
import { eq, asc, sql } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason,
  deductBalance, getInventoryCount, logTransaction, getSeasonRules, getTeamLegendCount,
} from "../lib/db-helpers.js";
import { errorEmbed, pendingEmbed } from "../lib/embeds.js";
import { LIMITS, LEGEND_CUSTOM_PURCHASE_WEEKS } from "../lib/constants.js";
import { getServerSettings } from "../lib/server-settings.js";
import { insufficientFunds, sendCommissionerNotification } from "../lib/purchase-shared.js";

export const data = new SlashCommandBuilder()
  .setName("buy-legend")
  .setDescription("Buy a legend — available Week 9 only (max 2 per team)")
  .addStringOption(opt =>
    opt.setName("legend_name")
      .setDescription("Select a legend from the store")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption(opt =>
    opt.setName("position")
      .setDescription("Filter legends by position (optional)")
      .setRequired(false)
      .setAutocomplete(true),
  );

// ── Autocomplete ───────────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction) {
  try {
    const focused = interaction.options.getFocused(true);

    if (focused.name === "position") {
      const available = await db.select({ position: legendsTable.position })
        .from(legendsTable)
        .where(eq(legendsTable.isAvailable, true));
      const positions = [...new Set(available.map(l => l.position).filter(Boolean))].sort();
      const q = focused.value.toLowerCase();
      const choices = positions
        .filter(p => p!.toLowerCase().startsWith(q))
        .slice(0, 25)
        .map(p => ({ name: p!, value: p! }));
      await interaction.respond(choices);
      return;
    }

    if (focused.name === "legend_name") {
      const posFilter = interaction.options.getString("position");
      const available = await db.select().from(legendsTable)
        .where(eq(legendsTable.isAvailable, true))
        .orderBy(asc(legendsTable.position), asc(legendsTable.name));
      const q = focused.value.toLowerCase();
      const matches = available
        .filter(l => {
          const matchesPos  = !posFilter || l.position?.toLowerCase() === posFilter.toLowerCase();
          const matchesName = l.name.toLowerCase().includes(q);
          return matchesPos && matchesName;
        })
        .slice(0, 25)
        .map(l => ({ name: `${l.name} — ${l.position} (${l.cost.toLocaleString()} coins)`, value: l.name }));
      await interaction.respond(matches);
      return;
    }

    await interaction.respond([]);
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}

// ── Execute ────────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings(interaction.guildId!);
  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled by the commissioners." });
    return;
  }
  if (!settings.legendsEnabled) {
    await interaction.editReply({ content: "❌ Legend purchases are currently disabled." });
    return;
  }

  const user   = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const rules  = await getSeasonRules(season);
  const cost   = rules.legendCost;

  // Week availability window: legends can only be purchased during week 9
  if (!LEGEND_CUSTOM_PURCHASE_WEEKS.has(season.currentWeek ?? "")) {
    return interaction.editReply({
      embeds: [errorEmbed("Purchase Window Closed", `Legend purchases are only available during **Week 9**. Current week: **Week ${season.currentWeek ?? "?"}**.`)],
    });
  }

  if (user.balance < cost) return insufficientFunds(interaction, cost, user.balance);

  const legendName = interaction.options.getString("legend_name", true);

  // Team-based cap: max legendsPerTeam legends per team
  const teamCount = await getTeamLegendCount(user.team, interaction.user.id, season.id);
  if (teamCount.legends >= LIMITS.legendsPerTeam) {
    return interaction.editReply({
      embeds: [errorEmbed("Team Limit Reached", `Your team has reached the maximum of **${LIMITS.legendsPerTeam} legends** allowed.`)],
    });
  }

  const legends = await db.select().from(legendsTable).where(eq(legendsTable.isAvailable, true));
  const legend  = legends.find(l => l.name.toLowerCase() === legendName.toLowerCase());
  if (!legend) {
    const names = legends.map(l => l.name).join(", ");
    return interaction.editReply({
      embeds: [errorEmbed("Legend Not Found", `**"${legendName}"** is not available.\n\nAvailable: ${names || "None currently — check back soon!"}\n\nUse \`/view store\` to browse.`)],
    });
  }

  const invCount = await getInventoryCount(interaction.user.id, season.id);
  if (invCount.legends >= LIMITS.maxLegendsInInventory) {
    return interaction.editReply({ embeds: [errorEmbed("Inventory Full", `You already have **${LIMITS.maxLegendsInInventory} legends** in your inventory.`)] });
  }
  if (invCount.legends + invCount.customs >= LIMITS.maxLegendsPlusCustomPlayers) {
    return interaction.editReply({ embeds: [errorEmbed("Inventory Full", `You already have **${invCount.legends + invCount.customs}** combined legends and custom players (max ${LIMITS.maxLegendsPlusCustomPlayers}).`)] });
  }

  await deductBalance(interaction.user.id, cost, interaction.guildId!);
  await logTransaction(interaction.user.id, -cost, "purchase", `Legend purchase — ${legend.name} (${legend.position})`, interaction.guildId!);
  const [purchase] = await db.insert(purchasesTable).values({
    discordId:      interaction.user.id,
    seasonId:       season.id,
    purchaseType:   "legend",
    status:         "pending",
    cost,
    legendId:       legend.id,
    playerName:     legend.name,
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
