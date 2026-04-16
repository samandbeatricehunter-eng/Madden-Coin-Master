import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  purchasesTable, inventoryTable, seasonStatsTable, franchiseRostersTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getSeasonStats,
  deductBalance, logTransaction, getSeasonRules, getRosterSeasonId,
} from "../lib/db-helpers.js";
import { pendingEmbed, errorEmbed } from "../lib/embeds.js";
import { getServerSettings } from "../lib/server-settings.js";
import {
  insufficientFunds, sendCommissionerNotification,
  DEV_LABEL, getRosterRows,
} from "../lib/purchase-shared.js";

export const data = new SlashCommandBuilder()
  .setName("buy-devup")
  .setDescription("Upgrade a player's dev trait — Normal→Star, Star→Superstar, Superstar→X-Factor")
  .addStringOption(opt =>
    opt.setName("position")
      .setDescription("Player's position on the roster")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption(opt =>
    opt.setName("player")
      .setDescription("Player to upgrade (autocomplete — excludes Superstar and X-Factor)")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption(opt =>
    opt.setName("dev_type")
      .setDescription("Target development tier")
      .setRequired(true)
      .addChoices(
        { name: "Star (from Normal)",          value: "Star"      },
        { name: "Superstar (from Star)",       value: "Superstar" },
        { name: "X-Factor (from Superstar)",   value: "X-Factor"  },
      ),
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Team owner (defaults to yourself)")
      .setRequired(false),
  );

// ── Autocomplete ───────────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction) {
  try {
    const focused       = interaction.options.getFocused(true);
    const rosterSeasonId = await getRosterSeasonId(interaction.guildId!);

    if (focused.name === "position") {
      const rows = await getRosterRows(interaction, rosterSeasonId, { position: franchiseRostersTable.position });
      const positions = [...new Set(rows.map((r: any) => r.position as string).filter(Boolean))].sort();
      const q = focused.value.toLowerCase();
      const choices = positions
        .filter(p => p.toLowerCase().startsWith(q))
        .slice(0, 25)
        .map(p => ({ name: p, value: p }));
      await interaction.respond(choices);
      return;
    }

    if (focused.name === "player") {
      const positionFilter = interaction.options.getString("position");
      const rows = await getRosterRows(interaction, rosterSeasonId, {
        firstName: franchiseRostersTable.firstName,
        lastName:  franchiseRostersTable.lastName,
        devTrait:  franchiseRostersTable.devTrait,
        overall:   franchiseRostersTable.overall,
        position:  franchiseRostersTable.position,
      });
      const q = focused.value.toLowerCase();
      const eligible = rows
        .filter((r: any) => {
          if (r.devTrait >= 3) return false;
          if (positionFilter && r.position.toUpperCase() !== positionFilter.toUpperCase()) return false;
          return true;
        });
      const choices = eligible
        .filter((r: any) => `${r.firstName} ${r.lastName}`.toLowerCase().includes(q))
        .slice(0, 25)
        .map((r: any) => ({
          name:  `${r.firstName} ${r.lastName} (${r.overall} OVR • ${DEV_LABEL[r.devTrait] ?? "?"})`,
          value: `${r.firstName} ${r.lastName}`,
        }));
      await interaction.respond(choices);
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
  if (!settings.devUpgradesEnabled) {
    await interaction.editReply({ content: "❌ Development upgrades are currently disabled." });
    return;
  }

  const targetUser  = interaction.options.getUser("user") ?? interaction.user;
  const playerInput = interaction.options.getString("player", true);
  const devUpType   = interaction.options.getString("dev_type", true);
  const season      = await getOrCreateActiveSeason(interaction.guildId!);
  const stats       = await getSeasonStats(interaction.user.id, season.id);
  const rules       = await getSeasonRules(season);
  const user        = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
  const costPer     = rules.devUpsCost;
  const remaining   = rules.devUpsCap - stats.devUpsPurchased;

  if (remaining <= 0) {
    return interaction.editReply({
      embeds: [errorEmbed("Dev Upgrade Limit Exceeded", `You have no dev upgrades remaining this season (cap: ${rules.devUpsCap}).`)],
    });
  }
  if (user.balance < costPer) return insufficientFunds(interaction, costPer, user.balance);

  const rosterSeasonId = await getRosterSeasonId(interaction.guildId!);
  const rosterRows = await db
    .select({ firstName: franchiseRostersTable.firstName, lastName: franchiseRostersTable.lastName, position: franchiseRostersTable.position, devTrait: franchiseRostersTable.devTrait })
    .from(franchiseRostersTable)
    .where(and(eq(franchiseRostersTable.seasonId, rosterSeasonId), eq(franchiseRostersTable.discordId, targetUser.id)));

  const match          = rosterRows.find(r => `${r.firstName} ${r.lastName}`.toLowerCase() === playerInput.toLowerCase());
  const playerPosition = match?.position ?? interaction.options.getString("position", true);
  const currentDevLabel = DEV_LABEL[match?.devTrait ?? 0] ?? "Normal";

  await deductBalance(interaction.user.id, costPer, interaction.guildId!);
  await logTransaction(interaction.user.id, -costPer, "purchase", `Dev upgrade (${devUpType}) — ${playerInput} (${playerPosition})`, interaction.guildId!);
  await db.update(seasonStatsTable)
    .set({ devUpsPurchased: sql`${seasonStatsTable.devUpsPurchased} + 1` })
    .where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

  const [purchase] = await db.insert(purchasesTable).values({
    discordId:      interaction.user.id,
    seasonId:       season.id,
    purchaseType:   "dev_up",
    status:         "pending",
    cost:           costPer,
    playerName:     playerInput,
    playerPosition,
    notes: `${devUpType}${targetUser.id !== interaction.user.id ? `;owner:<@${targetUser.id}>` : ""}`,
  }).returning();

  await db.insert(inventoryTable).values({
    discordId: interaction.user.id,
    seasonId:  season.id,
    purchaseId: purchase!.id,
    itemType:   "dev_up",
    playerName: playerInput,
    playerPosition,
    notes:      `${devUpType}`,
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
      `**Cost:** ${costPer.toLocaleString()} coins deducted.\n` +
      `**Dev upgrades used:** ${stats.devUpsPurchased + 1}/${rules.devUpsCap}`,
    )],
  });
}
