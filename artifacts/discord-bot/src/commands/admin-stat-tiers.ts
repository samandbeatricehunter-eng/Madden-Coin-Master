import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonStatTierConfigsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { STAT_CATEGORIES, STAT_TIER_DEFAULTS } from "../lib/stat-categories.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";

export const data = new SlashCommandBuilder()
  .setName("admin-stat-tiers")
  .setDescription("Admin: view all end-of-season stat tier configs and seed defaults for the active season")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  const allRows = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(eq(seasonStatTierConfigsTable.seasonId, season.id));

  const tiersByCategory = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const row of allRows) {
    let arr = tiersByCategory.get(row.statCategory);
    if (!arr) { arr = []; tiersByCategory.set(row.statCategory, arr); }
    arr.push({ tier: row.tier, threshold: row.threshold, payout: row.payout });
  }

  // Individual bonus amounts + configurable thresholds
  const [rbBonus, qbBonus, dbBonus, minQbAtt, minRbAtt, minQbYpa, minRbYpc, minDbInts] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.EOS_RB_YPC_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_QB_YPA_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_DB_INT_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_QB_MIN_ATT),
    getPayoutValue(PAYOUT_KEYS.EOS_RB_MIN_ATT),
    getPayoutValue(PAYOUT_KEYS.EOS_QB_MIN_YPA),
    getPayoutValue(PAYOUT_KEYS.EOS_RB_MIN_YPC),
    getPayoutValue(PAYOUT_KEYS.EOS_DB_MIN_INTS),
  ]);

  const offCats   = STAT_CATEGORIES.filter(c => c.key.startsWith("off_"));
  const defCats   = STAT_CATEGORIES.filter(c => c.key.startsWith("def_"));
  const otherCats = STAT_CATEGORIES.filter(c => !c.key.startsWith("off_") && !c.key.startsWith("def_"));
  // Split defense into two fields to stay within Discord's 1024-char embed field limit
  const defCats1 = defCats.slice(0, 3); // Yards & Points Allowed
  const defCats2 = defCats.slice(3);    // Turnovers & Pressure

  function buildCategoryBlock(cats: typeof STAT_CATEGORIES): string {
    return cats.map(cat => {
      const tiers = (tiersByCategory.get(cat.key) ?? []).sort((a, b) => a.tier - b.tier);
      const op = cat.direction === "higher" ? "≥" : "≤";
      if (tiers.length === 0) {
        const defaults = STAT_TIER_DEFAULTS[cat.key];
        if (defaults) {
          const preview = defaults.map((d, i) =>
            `T${i + 1}: ${op}${d.threshold} ${cat.unit} → ${d.payout}🪙 *(default not seeded)*`
          ).join(" | ");
          return `**${cat.label}**\n${preview}`;
        }
        return `**${cat.label}**\n*No tiers configured*`;
      }
      const tierLines = tiers.map(t =>
        `T${t.tier}: ${op}${t.threshold} ${cat.unit} → ${t.payout}🪙`
      ).join(" | ");
      return `**${cat.label}**\n${tierLines}`;
    }).join("\n\n");
  }

  const offBlock    = buildCategoryBlock(offCats);
  const defBlock1   = buildCategoryBlock(defCats1);
  const defBlock2   = buildCategoryBlock(defCats2);
  const otherBlock  = otherCats.length > 0 ? buildCategoryBlock(otherCats) : "";

  const indivBlock = [
    `**QB YPA Bonus** — QB needs ${minQbAtt}+ attempts AND ${(minQbYpa / 10).toFixed(1)}+ YPA → **${qbBonus}🪙**`,
    `**RB YPC Bonus** — RB needs ${minRbAtt}+ carries AND ${(minRbYpc / 10).toFixed(1)}+ YPC → **${rbBonus}🪙**`,
    `**DB INT Bonus** — any defensive player with ${minDbInts}+ INTs → **${dbBonus}🪙 per qualifying player**`,
    `*(Set coin amounts and thresholds via \`/admin set_payout_amounts\`)*`,
  ].join("\n");

  const configuredCount = STAT_CATEGORIES.filter(c =>
    (tiersByCategory.get(c.key)?.length ?? 0) === 4
  ).length;
  const total = STAT_CATEGORIES.length;
  const allSeeded = configuredCount === total;

  const embed = new EmbedBuilder()
    .setTitle(`📊 End-of-Season Stat Tier Config — Season ${season.id}`)
    .setColor(allSeeded ? Colors.Green : Colors.Yellow)
    .addFields(
      { name: "🏈 Offense",                        value: offBlock,   inline: false },
      { name: "🛡️ Defense — Yards & Points",       value: defBlock1,  inline: false },
      { name: "🛡️ Defense — Turnovers & Pressure", value: defBlock2,  inline: false },
      ...(otherBlock ? [{ name: "🔄 Other Stats", value: otherBlock, inline: false }] : []),
      { name: "💰 Individual Bonuses",              value: indivBlock, inline: false },
    )
    .setFooter({
      text: allSeeded
        ? `✅ All ${total} categories fully configured • Use /admin-set-stat-tier to edit individual tiers`
        : `⚠️ ${configuredCount}/${total} categories have all 4 tiers configured • Click "Seed Defaults" to populate missing tiers`,
    })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`seed_stat_defaults:${season.id}`)
      .setLabel("🌱 Seed Missing Defaults")
      .setStyle(allSeeded ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(allSeeded),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}
