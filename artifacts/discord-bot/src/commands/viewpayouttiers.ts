import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonStatTierConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { STAT_CATEGORIES, STAT_TIER_DEFAULTS } from "../lib/stat-categories.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";

export const data = new SlashCommandBuilder()
  .setName("viewpayouttiers")
  .setDescription("View all end-of-season payout tiers, stat thresholds, and coin amounts");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  const allTierRows = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(eq(seasonStatTierConfigsTable.seasonId, season.id));

  const tiersByCategory = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const row of allTierRows) {
    let arr = tiersByCategory.get(row.statCategory);
    if (!arr) { arr = []; tiersByCategory.set(row.statCategory, arr); }
    arr.push({ tier: row.tier, threshold: row.threshold, payout: row.payout });
  }

  const [rbBonus, qbBonus, dbBonus, missedPlayoffsBonus] = await Promise.all([
    getPayoutValue(PAYOUT_KEYS.EOS_RB_YPC_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_QB_YPA_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_DB_INT_BONUS),
    getPayoutValue(PAYOUT_KEYS.EOS_MISSED_PLAYOFFS),
  ]);

  function buildCategoryLine(cat: typeof STAT_CATEGORIES[0]): string {
    const dbTiers = (tiersByCategory.get(cat.key) ?? []).sort((a, b) => a.tier - b.tier);
    const op = cat.direction === "higher" ? "≥" : "≤";
    const isSeeded = dbTiers.length >= 4;
    const tiers = isSeeded ? dbTiers : (STAT_TIER_DEFAULTS[cat.key] ?? []).map((d, i) => ({
      tier: i + 1, threshold: d.threshold, payout: d.payout,
    }));
    const suffix = isSeeded ? "" : " *(defaults — not yet seeded)*";

    const tierParts = tiers.map(t => `T${t.tier}: ${op}${t.threshold.toLocaleString()} → **${t.payout}🪙**`);
    return `**${cat.label}**\n${tierParts.join(" · ")}${suffix}`;
  }

  const offCats   = STAT_CATEGORIES.filter(c => c.key.startsWith("off_"));
  const defCats   = STAT_CATEGORIES.filter(c => c.key.startsWith("def_"));
  const otherCats = STAT_CATEGORIES.filter(c => !c.key.startsWith("off_") && !c.key.startsWith("def_"));

  const offBlock   = offCats.map(buildCategoryLine).join("\n\n");
  const defBlock   = defCats.map(buildCategoryLine).join("\n\n");
  const otherBlock = otherCats.map(buildCategoryLine).join("\n\n");

  const indivBlock = [
    `**RB YPC Bonus** — 7.0+ YPC (100+ carries) → **${rbBonus}🪙**`,
    `**QB YPA Bonus** — 8.5+ YPA (150+ attempts) → **${qbBonus}🪙**`,
    `**DB INT Bonus** — individual player 8+ INTs → **${dbBonus}🪙**`,
    `**Missed Playoffs Consolation** — user-controlled team that didn't qualify → **${missedPlayoffsBonus}🪙**`,
  ].join("\n");

  const seededCount = STAT_CATEGORIES.filter(c => (tiersByCategory.get(c.key)?.length ?? 0) >= 4).length;
  const totalCount  = STAT_CATEGORIES.length;
  const allSeeded   = seededCount === totalCount;

  const embed = new EmbedBuilder()
    .setTitle(`📊 End-of-Season Payout Tiers — Season ${season.seasonNumber ?? season.id}`)
    .setColor(allSeeded ? Colors.Gold : Colors.Yellow)
    .setDescription(
      allSeeded
        ? "These are the stat thresholds and coin payouts for this season. Each team qualifies for the highest tier their stat reaches."
        : `⚠️ Stat tiers have not been fully seeded yet (${seededCount}/${totalCount} configured). Showing defaults for unseeded categories.`
    )
    .addFields(
      { name: "🏈 Offensive Stats",              value: offBlock,   inline: false },
      { name: "🛡️ Defensive Stats",              value: defBlock,   inline: false },
      ...(otherBlock ? [{ name: "🔄 Other Stats", value: otherBlock, inline: false }] : []),
      { name: "💰 Individual & Consolation Bonuses", value: indivBlock, inline: false },
    )
    .setFooter({ text: "Individual bonuses (RB/QB/DB) are manually verified by the commissioner • Stats that fall below Tier 1 receive no payout" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
