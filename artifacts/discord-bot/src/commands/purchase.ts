import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel,
  AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  legendsTable, purchasesTable, inventoryTable, usersTable, seasonStatsTable,
  franchiseRostersTable, franchiseMcaTeamsTable,
} from "@workspace/db";
import { eq, and, sql, asc, ilike, or } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getSeasonStats,
  getLegendPurchaseHistory, deductBalance, getInventoryCount, logTransaction, getSeasonRules,
  getCoreAttributes, getRosterSeasonId, getGuildChannel, CHANNEL_KEYS,
} from "../lib/db-helpers.js";
import { successEmbed, errorEmbed, pendingEmbed } from "../lib/embeds.js";
import { COSTS, LIMITS, ATTRIBUTES, NFL_POSITIONS } from "../lib/constants.js";
import { getServerSettings } from "../lib/server-settings.js";
import * as purchaseCustomPlayer from "./purchasecustomplayer.js";
import { startAttributeUp } from "./attribute-up-interactions.js";

const DEV_LABEL: Record<number, string> = { 0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor" };

export const data = new SlashCommandBuilder()
  .setName("purchase")
  .setDescription("Purchase an item from the store")

  // ── Custom Player ────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("custom_player")
      .setDescription("Build and buy a custom player — see /view store for package prices and current availability")
  )

  // ── Legend ──────────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("legend")
      .setDescription("Buy a legend — see /view store for current price (max 4 all-time)")
      .addStringOption(opt =>
        opt.setName("legend_name")
          .setDescription("Select a legend from the store")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("position")
          .setDescription("Filter legends by position (optional)")
          .setRequired(false)
          .setAutocomplete(true)
      )
  )

  // ── Dev Upgrade ─────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("dev_upgrade")
      .setDescription("Upgrade a player's dev trait — Normal→Star, Star→Superstar, Superstar→X-Factor")
      .addStringOption(opt =>
        opt.setName("position")
          .setDescription("Player's position on the roster")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("player")
          .setDescription("Player to upgrade (from autocomplete — excludes Superstar and X-Factor)")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("dev_type")
          .setDescription("Target development tier")
          .setRequired(true)
          .addChoices(
            { name: "Star (from Normal)",          value: "Star"      },
            { name: "Superstar (from Star)",       value: "Superstar" },
            { name: "X-Factor (from Superstar)",   value: "X-Factor"  },
          )
      )
      .addUserOption(opt =>
        opt.setName("user")
          .setDescription("Team owner (defaults to yourself)")
          .setRequired(false)
      )
  )

  // ── Age Reset ───────────────────────────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("age_reset")
      .setDescription("Reset a player's age — see /view store for current price and cap")
      .addStringOption(opt =>
        opt.setName("position")
          .setDescription("Player's position on the roster")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("player")
          .setDescription("Player whose age to reset (from autocomplete)")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addUserOption(opt =>
        opt.setName("user")
          .setDescription("Team owner (defaults to yourself)")
          .setRequired(false)
      )
  )

  // ── Attribute Upgrade (interactive) ─────────────────────────────────────────
  .addSubcommand(sub =>
    sub.setName("attribute_upgrade")
      .setDescription("Upgrade a player attribute — pick attribute/quantity here or use the interactive UI")
      .addStringOption(opt =>
        opt.setName("position")
          .setDescription("Player's position on the roster")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("player")
          .setDescription("Player to upgrade attributes for (from autocomplete)")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName("attribute")
          .setDescription("Attribute to upgrade (optional — omit to browse all attributes interactively)")
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addIntegerOption(opt =>
        opt.setName("quantity")
          .setDescription("How many points to upgrade (default 1, max 10)")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(10)
      )
      .addUserOption(opt =>
        opt.setName("user")
          .setDescription("Team owner (defaults to yourself)")
          .setRequired(false)
      )
  );

// ── Autocomplete ───────────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction) {
  try {
    const sub     = interaction.options.getSubcommand();
    const focused = interaction.options.getFocused(true);

    if (sub === "legend") {
      if (focused.name === "position") {
        // Return unique positions from available legends
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
            const matchesPos = !posFilter || l.position?.toLowerCase() === posFilter.toLowerCase();
            const matchesName = l.name.toLowerCase().includes(q);
            return matchesPos && matchesName;
          })
          .slice(0, 25)
          .map(l => ({ name: `${l.name} — ${l.position} (${l.cost.toLocaleString()} coins)`, value: l.name }));
        await interaction.respond(matches);
        return;
      }
    }

    if (sub === "attribute_upgrade" && focused.name === "attribute") {
      // Autocomplete attribute names from the master ATTRIBUTES list
      const q = focused.value.toLowerCase();
      const choices = ATTRIBUTES
        .filter(a => a.toLowerCase().includes(q))
        .slice(0, 25)
        .map(a => ({ name: a, value: a }));
      await interaction.respond(choices);
      return;
    }

    if (sub === "dev_upgrade" || sub === "age_reset" || sub === "attribute_upgrade") {
      // getUser is not available in autocomplete context; always use the invoking user for roster lookup
      const targetUser = interaction.user;

      // ── Resolve roster rows for this user ────────────────────────────────────
      // Primary: by discordId stored on roster rows (fast path).
      // Fallback: by the team name registered in the user's profile, matched
      //           against franchise_mca_teams, then queried by teamId.
      async function getRosterRows(season: { id: number }, fields: Record<string, any>) {
        const baseWhere = and(eq(franchiseRostersTable.seasonId, season.id), eq(franchiseRostersTable.discordId, targetUser.id));
        const rows = await (db.select(fields).from(franchiseRostersTable).where(baseWhere) as any);
        if (rows.length > 0) return rows;

        // Fallback: look up via economy_users.team → franchise_mca_teams teamId
        const [userRow] = await db
          .select({ team: usersTable.team })
          .from(usersTable)
          .where(and(eq(usersTable.discordId, targetUser.id), eq(usersTable.guildId, interaction.guildId!)))
          .limit(1);
        if (!userRow?.team) return [];

        const teamSearch = userRow.team.trim();
        const teamEntries = await db
          .select({ teamId: franchiseMcaTeamsTable.teamId })
          .from(franchiseMcaTeamsTable)
          .where(and(
            eq(franchiseMcaTeamsTable.seasonId, season.id),
            or(
              ilike(franchiseMcaTeamsTable.fullName, `%${teamSearch}%`),
              ilike(franchiseMcaTeamsTable.nickName, `%${teamSearch}%`),
            ),
          ));
        if (teamEntries.length === 0) return [];

        const teamIds = teamEntries.map(t => t.teamId);
        const fallbackRows = await (db.select(fields).from(franchiseRostersTable).where(and(
          eq(franchiseRostersTable.seasonId, season.id),
          teamIds.length === 1
            ? eq(franchiseRostersTable.teamId, teamIds[0]!)
            : sql`${franchiseRostersTable.teamId} = ANY(ARRAY[${sql.join(teamIds.map(id => sql`${id}`), sql`, `)}])`,
        )) as any);
        return fallbackRows;
      }

      if (focused.name === "position") {
        const rosterSeasonId = await getRosterSeasonId(interaction.guildId!);
        const rows = await getRosterRows({ id: rosterSeasonId }, { position: franchiseRostersTable.position });
        const positions = [...new Set((rows as { position: string }[]).map(r => r.position).filter(Boolean))].sort();
        const q = focused.value.toLowerCase();
        const choices = positions
          .filter((p: string) => p.toLowerCase().startsWith(q))
          .slice(0, 25)
          .map((p: string) => ({ name: p, value: p }));
        await interaction.respond(choices);
        return;
      }

      if (focused.name === "player") {
        const positionFilter = interaction.options.getString("position");
        const rosterSeasonId = await getRosterSeasonId(interaction.guildId!);
        const season = { id: rosterSeasonId };
        const rows: { firstName: string; lastName: string; devTrait: number; overall: number; position: string }[] =
          await getRosterRows(season, {
            firstName: franchiseRostersTable.firstName,
            lastName:  franchiseRostersTable.lastName,
            devTrait:  franchiseRostersTable.devTrait,
            overall:   franchiseRostersTable.overall,
            position:  franchiseRostersTable.position,
          });
        const q = focused.value.toLowerCase();

        const eligible = rows.filter(r => {
          if (sub === "dev_upgrade" && r.devTrait >= 3) return false;
          // Filter by the position the user already selected
          if (positionFilter && r.position.toUpperCase() !== positionFilter.toUpperCase()) return false;
          return true;
        });

        const choices = eligible
          .filter(r => `${r.firstName} ${r.lastName}`.toLowerCase().includes(q))
          .slice(0, 25)
          .map(r => ({
            name: `${r.firstName} ${r.lastName} (${r.overall} OVR • ${DEV_LABEL[r.devTrait] ?? "?"})`,
            value: `${r.firstName} ${r.lastName}`,
          }));

        await interaction.respond(choices);
        return;
      }
    }

    await interaction.respond([]);
  } catch (err) {
    console.error("purchase autocomplete error:", err);
    await interaction.respond([]).catch(() => {});
  }
}

// ── Execute ────────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  // ── /purchase customPlayer ──────────────────────────────────────────────────
  if (sub === "custom_player") {
    return purchaseCustomPlayer.execute(interaction);
  }

  // ── /purchase attributeUp (interactive flow) ───────────────────────────────
  if (sub === "attribute_upgrade") {
    return startAttributeUp(interaction);
  }

  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings(interaction.guildId!);
  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled by the commissioners." });
    return;
  }
  if (sub === "legend" && !settings.legendsEnabled) {
    await interaction.editReply({ content: "❌ Legend purchases are currently disabled." });
    return;
  }
  if (sub === "dev_upgrade" && !settings.devUpgradesEnabled) {
    await interaction.editReply({ content: "❌ Development upgrades are currently disabled." });
    return;
  }
  if (sub === "age_reset" && !settings.ageResetsEnabled) {
    await interaction.editReply({ content: "❌ Age resets are currently disabled." });
    return;
  }

  // ── /purchase legend ─────────────────────────────────────────────────────────
  if (sub === "legend") {
    const user   = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
    const season = await getOrCreateActiveSeason(interaction.guildId!);
    const rules  = await getSeasonRules(season);
    const cost   = rules.legendCost;

    if (user.balance < cost) return insufficientFunds(interaction, cost, user.balance);

    const legendName = interaction.options.getString("legend_name", true);

    const legendHistory = await getLegendPurchaseHistory(interaction.user.id);
    if (legendHistory.total >= LIMITS.legendsAllTime) {
      return interaction.editReply({
        embeds: [errorEmbed("Purchase Limit Reached", `You have reached the maximum of **${LIMITS.legendsAllTime} legend purchases** in this franchise.`)],
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

  // ── /purchase devUp ──────────────────────────────────────────────────────────
  if (sub === "dev_upgrade") {
    const targetUser   = interaction.options.getUser("user") ?? interaction.user;
    const playerInput  = interaction.options.getString("player", true);
    const devUpType    = interaction.options.getString("dev_type", true);
    const season       = await getOrCreateActiveSeason(interaction.guildId!);
    const stats        = await getSeasonStats(interaction.user.id, season.id);
    const rules        = await getSeasonRules(season);
    const user         = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
    const costPer      = rules.devUpsCost;
    const totalCost    = costPer;
    const remaining    = rules.devUpsCap - stats.devUpsPurchased;

    if (remaining <= 0) {
      return interaction.editReply({
        embeds: [errorEmbed("Dev Upgrade Limit Exceeded", `You have no dev upgrades remaining this season (cap: ${rules.devUpsCap}).`)],
      });
    }

    if (user.balance < totalCost) return insufficientFunds(interaction, totalCost, user.balance);

    // Find the player on the roster (for their position + current dev trait) — use roster season in case new season not yet imported
    const rosterSeasonId = await getRosterSeasonId(interaction.guildId!);
    const rosterRows = await db
      .select({ firstName: franchiseRostersTable.firstName, lastName: franchiseRostersTable.lastName, position: franchiseRostersTable.position, devTrait: franchiseRostersTable.devTrait })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, rosterSeasonId),
        eq(franchiseRostersTable.discordId, targetUser.id),
      ));
    const match = rosterRows.find(r => `${r.firstName} ${r.lastName}`.toLowerCase() === playerInput.toLowerCase());
    const playerPosition = match?.position ?? interaction.options.getString("position", true);
    const currentDevLabel = DEV_LABEL[match?.devTrait ?? 0] ?? "Normal";

    await deductBalance(interaction.user.id, totalCost, interaction.guildId!);
    await logTransaction(interaction.user.id, -totalCost, "purchase", `Dev upgrade (${devUpType}) — ${playerInput} (${playerPosition})`, interaction.guildId!);
    await db.update(seasonStatsTable)
      .set({ devUpsPurchased: sql`${seasonStatsTable.devUpsPurchased} + 1` })
      .where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "dev_up",
      status: "pending",
      cost: totalCost,
      playerName: playerInput,
      playerPosition,
      notes: `${devUpType}${targetUser.id !== interaction.user.id ? `;owner:<@${targetUser.id}>` : ""}`,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "dev_up",
      playerName: playerInput,
      playerPosition,
      notes: `${devUpType}`,
    });

    await sendCommissionerNotification(interaction, "dev_upgrade", purchase!.id, {
      playerName: playerInput, playerPosition, devUpType, quantity: "1", costPer: String(costPer),
      currentDevLabel,
      ownerNote: targetUser.id !== interaction.user.id ? `Owner: <@${targetUser.id}>` : undefined,
    });

    return interaction.editReply({
      embeds: [pendingEmbed(
        "Dev Upgrade Submitted!",
        `**${devUpType}** dev upgrade for **${playerInput}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n` +
        `**Cost:** ${totalCost.toLocaleString()} coins deducted.\n` +
        `**Dev upgrades used:** ${stats.devUpsPurchased + 1}/${rules.devUpsCap}`
      )],
    });
  }

  // ── /purchase ageReset ───────────────────────────────────────────────────────
  if (sub === "age_reset") {
    const targetUser   = interaction.options.getUser("user") ?? interaction.user;
    const playerInput  = interaction.options.getString("player", true);
    const season       = await getOrCreateActiveSeason(interaction.guildId!);
    const stats        = await getSeasonStats(interaction.user.id, season.id);
    const rules        = await getSeasonRules(season);
    const user         = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
    const costPer      = rules.ageResetCost;
    const remaining    = rules.ageResetsCap - stats.ageResetsPurchased;

    if (remaining <= 0) {
      return interaction.editReply({
        embeds: [errorEmbed("Age Reset Limit Exceeded", `You have no age resets remaining this season (cap: ${rules.ageResetsCap}).`)],
      });
    }

    if (user.balance < costPer) return insufficientFunds(interaction, costPer, user.balance);

    // Find position + current age from roster — use roster season in case new season not yet imported
    const rosterSeasonIdForAge = await getRosterSeasonId(interaction.guildId!);
    const rosterRows = await db
      .select({ firstName: franchiseRostersTable.firstName, lastName: franchiseRostersTable.lastName, position: franchiseRostersTable.position, age: franchiseRostersTable.age })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, rosterSeasonIdForAge),
        eq(franchiseRostersTable.discordId, targetUser.id),
      ));
    const match = rosterRows.find(r => `${r.firstName} ${r.lastName}`.toLowerCase() === playerInput.toLowerCase());
    const playerPosition = match?.position ?? interaction.options.getString("position", true);
    const currentAge = match?.age ?? null;

    await deductBalance(interaction.user.id, costPer, interaction.guildId!);
    await logTransaction(interaction.user.id, -costPer, "purchase", `Age reset — ${playerInput} (${playerPosition})`, interaction.guildId!);
    await db.update(seasonStatsTable)
      .set({ ageResetsPurchased: sql`${seasonStatsTable.ageResetsPurchased} + 1` })
      .where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "age_reset",
      status: "pending",
      cost: costPer,
      playerName: playerInput,
      playerPosition,
      notes: targetUser.id !== interaction.user.id ? `owner:<@${targetUser.id}>` : null,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "age_reset",
      playerName: playerInput,
      playerPosition,
      notes: targetUser.id !== interaction.user.id ? `owner:<@${targetUser.id}>` : null,
    });

    await sendCommissionerNotification(interaction, "age_reset", purchase!.id, {
      playerName: playerInput, playerPosition, quantity: "1", costPer: String(costPer),
      currentAge: currentAge !== null ? String(currentAge) : undefined,
      ownerNote: targetUser.id !== interaction.user.id ? `Owner: <@${targetUser.id}>` : undefined,
    });

    return interaction.editReply({
      embeds: [pendingEmbed(
        "Age Reset Submitted!",
        `Age reset for **${playerInput}** (${playerPosition}) submitted!\n\nA commissioner will apply it in-game.\n\n` +
        `**Cost:** ${costPer.toLocaleString()} coins deducted.\n` +
        `**Age resets used:** ${stats.ageResetsPurchased + 1}/${rules.ageResetsCap}`
      )],
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
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
  try {
    const channelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER) ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
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
  } else if (type === "dev_upgrade") {
    const costPer = details["costPer"];
    const fromDev  = details["currentDevLabel"] ?? "?";
    const toDev    = details["devUpType"] ?? "?";
    title = "📈 Dev Upgrade Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      details["ownerNote"] ? `**${details["ownerNote"]}**` : null,
      `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
      `**Dev Level:** ${fromDev} → ${toDev}`,
      `**Cost:** ${costPer} coins`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Click the button below once this has been applied in-game.",
    ].filter(Boolean).join("\n");
  } else if (type === "age_reset") {
    const costPer    = details["costPer"];
    const ageBefore  = details["currentAge"] ? `${details["currentAge"]} → 23` : "→ 23";
    title = "🔄 Age Reset Request";
    description = [
      `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
      details["ownerNote"] ? `**${details["ownerNote"]}**` : null,
      `**Player:** ${details["playerName"]} (${details["playerPosition"]})`,
      `**Age:** ${ageBefore}`,
      `**Cost:** ${costPer} coins`,
      `**Purchase ID:** #${purchaseId}`,
      "",
      "Click the button below once this has been applied in-game.",
    ].filter(Boolean).join("\n");
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
  } catch (err) {
    console.error("Commissioner notification failed (purchase still completed):", err);
  }
}
