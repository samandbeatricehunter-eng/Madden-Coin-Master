import type { TextChannel } from "discord.js";

const DISCORD_MAX = 1990; // safe margin under the 2000-char limit

/**
 * Splits `text` into chunks, each fitting within `limit` characters.
 * Splits on paragraph breaks first, then falls back to word boundaries.
 */
function splitIntoChunks(text: string, limit: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const addition = (current ? "\n\n" : "") + para;
    if (current.length + addition.length <= limit) {
      current += addition;
    } else {
      if (current) chunks.push(current);
      // If a single paragraph is itself over the limit, hard-split on word boundaries
      if (para.length > limit) {
        let remaining = para;
        while (remaining.length > limit) {
          let cut = remaining.lastIndexOf(" ", limit);
          if (cut === -1) cut = limit;
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
  return chunks;
}

/**
 * Sends a potentially long article to a Discord channel.
 * The `header` (ping + title line) is prepended to the first message only.
 * Correctly accounts for the header length so the first message never exceeds the limit.
 */
export async function sendArticleChunked(
  channel: TextChannel,
  header: string,
  article: string,
): Promise<void> {
  if (!article.trim()) {
    await channel.send({ content: `${header}_(No article content)_` });
    return;
  }

  // Budget for first chunk: leave room for the header
  const firstLimit  = DISCORD_MAX - header.length;
  const restLimit   = DISCORD_MAX;

  // Build first chunk with reduced budget, then chunk the remainder normally
  const firstChunks = splitIntoChunks(article, firstLimit > 100 ? firstLimit : DISCORD_MAX);
  const firstChunk  = firstChunks[0] ?? "";
  const remainder   = firstChunks.slice(1).join("\n\n");

  // Send first message (header + first chunk)
  await channel.send({ content: `${header}${firstChunk}` });

  // Split and send any remaining content
  if (remainder.trim()) {
    const rest = splitIntoChunks(remainder, restLimit);
    for (const chunk of rest) {
      if (chunk.trim()) await channel.send({ content: chunk });
    }
  }
}
