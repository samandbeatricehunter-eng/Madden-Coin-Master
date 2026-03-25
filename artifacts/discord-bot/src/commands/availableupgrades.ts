import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getOrCreateUser, getOrCreateActiveSeason, getSeasonStats, getLegendPurchaseHistory, getSeasonRules } from "../lib/db-helpers.js";
import { LIMITS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("availableupgrades")
  .setDescription("Check how many upgrades you've used this season");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  await getOrCreateUser(interaction.user.id, interaction.user.username);
  const season = await getOrCreateActiveSeason();
  const stats = await getSeasonStats(interaction.user.id, season.id);
  const legendHistory = await getLegendPurchaseHistory(interaction.user.id);
  const rules = await getSeasonRules(season);

  const coreUsed    = stats.coreAttrPurchased;
  const coreLeft    = Math.max(0, rules.coreAttrCap - coreUsed);
  const nonCoreUsed = stats.nonCoreAttrPurchased;
  const nonCoreLeft = Math.max(0, rules.nonCoreAttrCap - nonCoreUsed);
  const devUpsLeft  = Math.max(0, LIMITS.devUpsPerSeason - stats.devUpsPurchased);
  const ageResetsLeft = Math.max(0, LIMITS.ageResetsPerSeason - stats.ageResetsPurchased);
  const legendsLeft = Math.max(0, LIMITS.legendsAllTime - legendHistory.total);

  const hasOverride = season.coreAttrCostOverride !== null || season.coreAttrCapOverride !== null ||
                      season.nonCoreAttrCostOverride !== null || season.nonCoreAttrCapOverride !== null;
  const overrideNote = hasOverride ? "\n⚠️ *This season has custom attribute rules set by the commissioner.*" : "";

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📊 ${interaction.user.username}'s Upgrades — Season ${season.seasonNumber}`)
    .addFields(
      {
        name: "⚡ Core Attribute Upgrades",
        value:
          `Used: **${coreUsed}/${rules.coreAttrCap}** | Remaining: **${coreLeft}**\n` +
          `Cost: **${rules.coreAttrCost} coins/pt**\n` +
          `*(Speed, Acceleration, Agility, COD, Strength, Jumping, Throw Power, Awareness, Stamina)*${overrideNote}`,
        inline: false,
      },
      {
        name: "🎯 Non-Core Attribute Upgrades",
        value:
          `Used: **${nonCoreUsed}/${rules.nonCoreAttrCap}** | Remaining: **${nonCoreLeft}**\n` +
          `Cost: **${rules.nonCoreAttrCost} coins/pt**\n` +
          `*(All other attributes)*`,
        inline: false,
      },
      {
        name: "📈 Dev Upgrades",
        value: `Used: **${stats.devUpsPurchased}/${LIMITS.devUpsPerSeason}** | Remaining: **${devUpsLeft}**`,
        inline: true,
      },
      {
        name: "🔄 Age Resets",
        value: `Used: **${stats.ageResetsPurchased}/${LIMITS.ageResetsPerSeason}** | Remaining: **${ageResetsLeft}**`,
        inline: true,
      },
      {
        name: "🏆 Legend Purchases (All Time)",
        value: `Used: **${legendHistory.total}/${LIMITS.legendsAllTime}** | Remaining: **${legendsLeft}**`,
        inline: false,
      },
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}
