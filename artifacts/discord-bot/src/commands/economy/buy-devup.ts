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
} from "../../lib/db/db-helpers.js";
import { pendingEmbed, errorEmbed } from "../../lib/discord/embeds.js";
import { getServerSettings } from "../../lib/db/server-settings.js";
import {
  insufficientFunds, sendCommissionerNotification,
  DEV_LABEL, getRosterRows,
} from "../../lib/economy/purchase-shared.js";

export const data = new SlashCommandBuilder()
  .setName("buy-devup")
  .setDescription("Upgrade a player's dev trait — Normal→Star, Star→Superstar")
  .addStringOption(opt =>
    opt.setName("player")
      .setDescription("Player to upgrade (Normal and Star only)")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption(opt =>
    opt.setName("dev_type")
      .setDescription("Target tier — auto-populated based on selected player")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Team owner (defaults to yourself)")
      .setRequired(false),
  );

// ── Autocomplete ───────────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction) {
  try {
    const focused        = interaction.options.getFocused(true);
    const rosterSeasonId = await getRosterSeasonId(interaction.guildId!);

    // Load all eligible players once (Normal = 0, Star = 1 only — Superstar/XF not upgradeable)
    const allRows = await getRosterRows(interaction, rosterSeasonId, {
      firstName: franchiseRostersTable.firstName,
      lastName:  franchiseRostersTable.lastName,
      devTrait:  franchiseRostersTable.devTrait,
      overall:   franchiseRostersTable.overall,
      position:  franchiseRostersTable.position,
    });
    const eligible = (allRows as any[]).filter(r => r.devTrait <= 1);

    if (focused.name === "player") {
      const q = focused.value.toLowerCase();
      await interaction.respond(
        eligible
          .filter(r => `${r.firstName} ${r.lastName}`.toLowerCase().includes(q))
          .slice(0, 25)
          .map(r => ({
            name:  `${r.firstName} ${r.lastName} (${r.overall} OVR • ${r.position} • ${DEV_LABEL[r.devTrait] ?? "?"})`,
            value: `${r.firstName} ${r.lastName}`,
          })),
      );
      return;
    }

    if (focused.name === "dev_type") {
      const playerInput = interaction.options.getString("player") ?? "";
      const match = (allRows as any[]).find(
        r => `${r.firstName} ${r.lastName}`.toLowerCase() === playerInput.toLowerCase(),
      );
      // If player is known, offer only the one valid next tier; otherwise offer both
      if (match !== undefined) {
        if (match.devTrait === 0) {
          await interaction.respond([{ name: "Star (upgrade from Normal)", value: "Star" }]);
        } else if (match.devTrait === 1) {
          await interaction.respond([{ name: "Superstar (upgrade from Star)", value: "Superstar" }]);
        } else {
          await interaction.respond([]); // already Superstar or X-Factor, not upgradeable
        }
      } else {
        await interaction.respond([
          { name: "Star (from Normal)",    value: "Star"      },
          { name: "Superstar (from Star)", value: "Superstar" },
        ]);
      }
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

  const match           = rosterRows.find(r => `${r.firstName} ${r.lastName}`.toLowerCase() === playerInput.toLowerCase());
  const playerPosition  = match?.position ?? "Unknown";
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
