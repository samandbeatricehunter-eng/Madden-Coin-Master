import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { generateFranchiseArticle } from "../lib/franchise-article.js";

const HEADLINES_CHANNEL_ID = "1477717664804896899";

export const data = new SlashCommandBuilder()
  .setName("admin-resendarticle")
  .setDescription("Admin: regenerate and repost the weekly recap article for any week")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(o => o
    .setName("week")
    .setDescription("Which completed week to recap (1–18)")
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(18))
  .addStringOption(o => o
    .setName("upcoming")
    .setDescription("Label for the next week (default: auto-calculated, e.g. \"Week 11\" or \"Wildcard\")")
    .setRequired(false))
  .addBooleanOption(o => o
    .setName("ping_everyone")
    .setDescription("Ping @everyone when posting? (default: true)")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const week         = interaction.options.getInteger("week", true);
  const pingEveryone = interaction.options.getBoolean("ping_everyone") ?? true;
  const upcomingOverride = interaction.options.getString("upcoming")?.trim() ?? null;

  // ── Determine the "upcoming week" label ──────────────────────────────────────
  let upcomingLabel: string;
  if (upcomingOverride) {
    upcomingLabel = upcomingOverride;
  } else if (week >= 18) {
    upcomingLabel = "Wildcard Weekend";
  } else {
    upcomingLabel = `Week ${week + 1}`;
  }

  // ── Fetch season ─────────────────────────────────────────────────────────────
  const season = await getOrCreateActiveSeason();
  const completedWeekIndex = week - 1; // 0-based

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setDescription(`⏳ Generating Week ${week} recap article… this takes a few seconds.`)],
  });

  // ── Generate article ─────────────────────────────────────────────────────────
  let article: string;
  try {
    article = await generateFranchiseArticle(
      season.id,
      season.seasonNumber,
      completedWeekIndex,
      upcomingLabel,
    );
  } catch (err) {
    console.error("[admin-resendarticle] Article generation failed:", err);
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ Article Generation Failed")
        .setDescription(
          "The AI could not generate the article. This is usually a temporary issue with the AI service.\n\n" +
          `**Error:** \`${err instanceof Error ? err.message : String(err)}\``
        )],
    });
    return;
  }

  // ── Post to headlines channel ─────────────────────────────────────────────────
  const headlinesChannel = interaction.client.channels.cache.get(HEADLINES_CHANNEL_ID)
    ?? await interaction.client.channels.fetch(HEADLINES_CHANNEL_ID).catch(() => null);

  if (!headlinesChannel?.isTextBased()) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setDescription("❌ Could not find the headlines channel. Check the channel ID.")],
    });
    return;
  }

  const prefix = pingEveryone ? "@everyone\n" : "";
  await (headlinesChannel as TextChannel).send({
    content: `${prefix}📰 **REC League — Week ${week} Recap**\n\n${article}`,
  });

  // ── Confirm to admin ─────────────────────────────────────────────────────────
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle(`✅ Week ${week} Recap Posted`)
      .addFields(
        { name: "Posted to",    value: `<#${HEADLINES_CHANNEL_ID}>`,                  inline: true },
        { name: "Looking ahead", value: upcomingLabel,                                inline: true },
        { name: "@everyone",    value: pingEveryone ? "Yes" : "No",                  inline: true },
        { name: "Season",       value: `Season ${season.seasonNumber}`,               inline: true },
        { name: "Article length", value: `${article.length.toLocaleString()} chars`, inline: true },
      )
      .setTimestamp()],
  });
}
