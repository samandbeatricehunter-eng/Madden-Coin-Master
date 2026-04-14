import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonStatTierConfigsTable, seasonsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { STAT_CATEGORIES, STAT_CATEGORY_CHOICES } from "../lib/stat-categories.js";

export const data = new SlashCommandBuilder()
  .setName("admin-set-stat-tier")
  .setDescription("Set a single tier threshold/payout for an end-of-season stat bonus category")
  .addStringOption(o => o
    .setName("category")
    .setDescription("Stat category to configure")
    .setRequired(true)
    .addChoices(...STAT_CATEGORY_CHOICES))
  .addIntegerOption(o => o
    .setName("tier")
    .setDescription("Tier number (1 = lowest, 4 = best payout)")
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(4))
  .addIntegerOption(o => o
    .setName("threshold")
    .setDescription("Qualifying value (min for higher-is-better, max for lower-is-better)")
    .setRequired(true)
    .setMinValue(0))
  .addIntegerOption(o => o
    .setName("payout")
    .setDescription("Coin payout for reaching this tier")
    .setRequired(true)
    .setMinValue(1))
  .addIntegerOption(o => o
    .setName("season_id")
    .setDescription("Season ID (defaults to active season)")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const categoryKey = interaction.options.getString("category", true);
  const tier        = interaction.options.getInteger("tier", true);
  const threshold   = interaction.options.getInteger("threshold", true);
  const payout      = interaction.options.getInteger("payout", true);
  const seasonIdOpt = interaction.options.getInteger("season_id", false);

  const catDef = STAT_CATEGORIES.find(c => c.key === categoryKey);
  if (!catDef) {
    await interaction.editReply({ content: `❌ Unknown category key: \`${categoryKey}\`` });
    return;
  }

  // Resolve season
  let seasonId: number;
  if (seasonIdOpt != null) {
    const rows = await db.select({ id: seasonsTable.id })
      .from(seasonsTable).where(eq(seasonsTable.id, seasonIdOpt)).limit(1);
    if (!rows[0]) {
      await interaction.editReply({ content: `❌ Season ID ${seasonIdOpt} not found.` });
      return;
    }
    seasonId = rows[0].id;
  } else {
    const season = await getOrCreateActiveSeason(interaction.guildId!);
    seasonId = season.id;
  }

  // Upsert the tier config
  await db.insert(seasonStatTierConfigsTable)
    .values({ seasonId, statCategory: categoryKey, tier, threshold, payout, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        seasonStatTierConfigsTable.seasonId,
        seasonStatTierConfigsTable.statCategory,
        seasonStatTierConfigsTable.tier,
      ],
      set: { threshold, payout, updatedAt: new Date() },
    });

  // Fetch all tiers for this category/season to display
  const allTiers = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(and(
      eq(seasonStatTierConfigsTable.seasonId, seasonId),
      eq(seasonStatTierConfigsTable.statCategory, categoryKey),
    ));

  allTiers.sort((a, b) => a.tier - b.tier);

  const dirLabel = catDef.direction === "higher" ? "higher = better (min to qualify)" : "lower = better (max to qualify)";

  const tierDisplay = allTiers.map(t => {
    const op = catDef.direction === "higher" ? "≥" : "≤";
    return `Tier ${t.tier}: ${op} **${t.threshold} ${catDef.unit}** → +**${t.payout} coins**`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`✅ Stat Tier Saved — ${catDef.label}`)
    .setColor(Colors.Green)
    .addFields(
      { name: "Season",    value: `Season ${seasonId}`,   inline: true },
      { name: "Direction", value: dirLabel,                inline: false },
      { name: "All Tiers (Season " + seasonId + ")", value: tierDisplay.length
          ? tierDisplay.join("\n")
          : "*No tiers configured yet*" },
    );

  await interaction.editReply({ embeds: [embed] });
}
