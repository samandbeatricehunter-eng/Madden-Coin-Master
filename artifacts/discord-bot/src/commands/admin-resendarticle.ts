import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { generateFranchiseArticle, generateWeekPreview } from "../lib/franchise-article.js";
import { sendArticleChunked } from "../lib/send-article.js";

const HEADLINES_CHANNEL_ID = "1477717664804896899";

export const data = new SlashCommandBuilder()
  .setName("admin-resendarticle")
  .setDescription("Admin: regenerate and repost a weekly article for any week")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(o => o
    .setName("week")
    .setDescription("Which week to write about (1–18)")
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(18))
  .addStringOption(o => o
    .setName("mode")
    .setDescription("recap = post-game article | preview = pre-game hype article (default: recap)")
    .setRequired(false)
    .addChoices(
      { name: "recap  — recaps scores & stats after the week is complete", value: "recap" },
      { name: "preview — previews matchups before the week is played",      value: "preview" },
    ))
  .addStringOption(o => o
    .setName("upcoming")
    .setDescription("(Recap only) Label for the next week, e.g. \"Week 11\" or \"Wildcard\" (default: auto)")
    .setRequired(false))
  .addBooleanOption(o => o
    .setName("ping_everyone")
    .setDescription("Ping @everyone when posting? (default: true)")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const week             = interaction.options.getInteger("week", true);
  const mode             = (interaction.options.getString("mode") ?? "recap") as "recap" | "preview";
  const pingEveryone     = interaction.options.getBoolean("ping_everyone") ?? true;
  const upcomingOverride = interaction.options.getString("upcoming")?.trim() ?? null;
  const weekIndex        = week - 1; // 0-based

  // ── Determine "upcoming week" label (recap only) ──────────────────────────
  let upcomingLabel: string;
  if (upcomingOverride) {
    upcomingLabel = upcomingOverride;
  } else if (week >= 18) {
    upcomingLabel = "Wildcard Weekend";
  } else {
    upcomingLabel = `Week ${week + 1}`;
  }

  // ── Fetch active season ───────────────────────────────────────────────────
  const season = await getOrCreateActiveSeason();

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setDescription(
        `⏳ Generating Week ${week} **${mode}** article… this takes a few seconds.`
      )],
  });

  // ── Generate article ──────────────────────────────────────────────────────
  let article: string;
  try {
    if (mode === "preview") {
      article = await generateWeekPreview(season.id, season.seasonNumber, weekIndex);
    } else {
      article = await generateFranchiseArticle(season.id, season.seasonNumber, weekIndex, upcomingLabel);
    }
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

  // ── Post to headlines channel ─────────────────────────────────────────────
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
  const header = mode === "preview"
    ? `${prefix}📋 **REC League — Week ${week} Preview**\n\n`
    : `${prefix}📰 **REC League — Week ${week} Recap**\n\n`;

  try {
    await sendArticleChunked(headlinesChannel as TextChannel, header, article);
  } catch (sendErr) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ Failed to Post Article")
        .setDescription(
          "The article was generated but could not be sent to the headlines channel.\n\n" +
          `**Error:** \`${sendErr instanceof Error ? sendErr.message : String(sendErr)}\``
        )],
    });
    return;
  }

  // ── Confirm to admin ──────────────────────────────────────────────────────
  const confirmFields = mode === "preview"
    ? [
        { name: "Mode",           value: "📋 Preview",                                      inline: true },
        { name: "Posted to",      value: `<#${HEADLINES_CHANNEL_ID}>`,                      inline: true },
        { name: "@everyone",      value: pingEveryone ? "Yes" : "No",                       inline: true },
        { name: "Season",         value: `Season ${season.seasonNumber}`,                   inline: true },
        { name: "Article length", value: `${article.length.toLocaleString()} chars`,        inline: true },
      ]
    : [
        { name: "Mode",           value: "📰 Recap",                                        inline: true },
        { name: "Posted to",      value: `<#${HEADLINES_CHANNEL_ID}>`,                      inline: true },
        { name: "Looking ahead",  value: upcomingLabel,                                     inline: true },
        { name: "@everyone",      value: pingEveryone ? "Yes" : "No",                       inline: true },
        { name: "Season",         value: `Season ${season.seasonNumber}`,                   inline: true },
        { name: "Article length", value: `${article.length.toLocaleString()} chars`,        inline: true },
      ];

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle(`✅ Week ${week} ${mode === "preview" ? "Preview" : "Recap"} Posted`)
      .addFields(...confirmFields)
      .setTimestamp()],
  });
}
