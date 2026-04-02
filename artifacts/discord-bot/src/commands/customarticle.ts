import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  PermissionFlagsBits,
} from "discord.js";
import OpenAI from "openai";
import { isAdminUser } from "../lib/db-helpers.js";
import { sendArticleChunked } from "../lib/send-article.js";

const HEADLINES_CHANNEL_ID = "1477717664804896899";

const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey:  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "dummy",
});

export const data = new SlashCommandBuilder()
  .setName("customarticle")
  .setDescription("(Admin) Generate a custom article and post it to the headlines channel")
  .addStringOption(opt =>
    opt
      .setName("prompt")
      .setDescription("What should the article be about? Be as specific as you want.")
      .setRequired(true)
      .setMaxLength(1500),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // ── Admin gate ──────────────────────────────────────────────────────────────
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    return interaction.reply({
      content: "❌ This command is restricted to admins.",
      ephemeral: true,
    });
  }

  const prompt = interaction.options.getString("prompt", true).trim();

  await interaction.deferReply({ ephemeral: true });

  try {
    // ── Call GPT ──────────────────────────────────────────────────────────────
    // Ask the model to return a headline on the first line (prefixed HEADLINE:)
    // followed by the article body, so we can parse them apart cleanly.
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: [
            "You are an award-winning sports journalist covering The R.E.C. League — a competitive Madden NFL franchise simulation league.",
            "Write in a bold, energetic, ESPN-style voice.",
            "Use vivid prose paragraphs. Do NOT use markdown headers (##, ###) or bullet points — just flowing, punchy paragraphs.",
            "Keep the article between 400–600 words unless the prompt implies a shorter piece.",
            "IMPORTANT: Always start your response with a single line in exactly this format:",
            "HEADLINE: <your headline here>",
            "Then leave one blank line, then write the article body.",
          ].join(" "),
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.85,
      max_tokens:  1200,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";

    if (!raw) {
      return interaction.editReply({ content: "❌ The AI returned an empty response. Try again." });
    }

    // ── Parse headline + body ─────────────────────────────────────────────────
    const lines = raw.split("\n");
    const headlineLine = lines[0] ?? "";
    const headline = headlineLine.startsWith("HEADLINE:")
      ? headlineLine.replace(/^HEADLINE:\s*/i, "").trim()
      : null;
    const article = headline
      ? lines.slice(1).join("\n").trimStart()
      : raw;

    // ── Post to headlines channel ─────────────────────────────────────────────
    const headlinesChannel = interaction.client.channels.cache.get(HEADLINES_CHANNEL_ID)
      ?? await interaction.client.channels.fetch(HEADLINES_CHANNEL_ID).catch(() => null);

    if (!headlinesChannel || !headlinesChannel.isTextBased()) {
      return interaction.editReply({
        content: "❌ Could not reach the headlines channel. Check the channel ID.",
      });
    }

    const tc = headlinesChannel as TextChannel;
    // Header: @everyone ping + bold headline on its own line
    const header = headline
      ? `@everyone\n**${headline}**\n\n`
      : `@everyone\n\n`;
    await sendArticleChunked(tc, header, article);

    return interaction.editReply({
      content: `✅ Article posted to <#${HEADLINES_CHANNEL_ID}>.`,
    });
  } catch (err) {
    console.error("[/customarticle] Error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return interaction.editReply({ content: `❌ Failed to generate article: ${msg}` });
  }
}
