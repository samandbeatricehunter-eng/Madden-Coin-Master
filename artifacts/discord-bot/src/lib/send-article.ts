import type { TextChannel } from "discord.js";

const DISCORD_MAX = 1990; // safe margin under the 2000-char limit

/**
 * Sends a potentially long article to a Discord channel.
 * The `header` (ping + title line) goes with the first chunk.
 * Splits on paragraph breaks so it never cuts mid-sentence.
 */
export async function sendArticleChunked(
  channel: TextChannel,
  header: string,
  article: string,
): Promise<void> {
  const paragraphs = article.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const addition = (current ? "\n\n" : "") + para;
    if (current.length + addition.length <= DISCORD_MAX) {
      current += addition;
    } else {
      if (current) chunks.push(current);
      // If a single paragraph is itself over the limit, hard-split it
      if (para.length > DISCORD_MAX) {
        let remaining = para;
        while (remaining.length > DISCORD_MAX) {
          // Try to break on the last space within the limit
          let cut = remaining.lastIndexOf(" ", DISCORD_MAX);
          if (cut === -1) cut = DISCORD_MAX;
          chunks.push(remaining.slice(0, cut).trim());
          remaining = remaining.slice(cut).trim();
        }
        current = remaining;
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);

  if (chunks.length === 0) chunks.push("_(No article content)_");

  // First message carries the header
  const first = `${header}${chunks[0]}`;
  await channel.send({ content: first });

  for (let i = 1; i < chunks.length; i++) {
    await channel.send({ content: chunks[i]! });
  }
}
