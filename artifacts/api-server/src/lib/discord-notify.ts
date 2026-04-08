const DISCORD_API = "https://discord.com/api/v10";

interface EmbedField { name: string; value: string; inline?: boolean; }
interface EmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

export async function sendDiscordEmbed(channelId: string, embed: EmbedPayload): Promise<void> {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    console.warn("[discord-notify] DISCORD_TOKEN not set — skipping embed");
    return;
  }

  const body = JSON.stringify({ embeds: [{ timestamp: new Date().toISOString(), ...embed }] });

  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[discord-notify] Discord API error ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error("[discord-notify] fetch error:", err);
  }
}

export async function sendDiscordMessage(channelId: string, content: string): Promise<void> {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    console.warn("[discord-notify] DISCORD_TOKEN not set — skipping message");
    return;
  }

  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[discord-notify] Discord API error ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error("[discord-notify] fetch error:", err);
  }
}

/**
 * Send an embed with Confirm / Deny buttons to a channel.
 * Returns the posted message ID (needed to store in DB for later edits).
 * The confirmId and denyId are the custom_id values for the buttons.
 */
export async function sendDiscordEmbedWithButtons(
  channelId: string,
  embed: EmbedPayload,
  confirmId: string,
  denyId: string,
  confirmLabel = "✅ Confirm Violation",
  denyLabel    = "❌ Deny",
): Promise<string | null> {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    console.warn("[discord-notify] DISCORD_TOKEN not set — skipping embed with buttons");
    return null;
  }

  const body = JSON.stringify({
    embeds: [{ timestamp: new Date().toISOString(), ...embed }],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: confirmLabel, custom_id: confirmId },
          { type: 2, style: 4, label: denyLabel,    custom_id: denyId },
        ],
      },
    ],
  });

  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[discord-notify] Discord API error ${res.status}: ${text}`);
      return null;
    }
    const data = (await res.json()) as { id?: string };
    return data.id ?? null;
  } catch (err) {
    console.error("[discord-notify] fetch error:", err);
    return null;
  }
}

/**
 * Edit an existing Discord message (e.g., to disable buttons after resolution).
 */
export async function editDiscordMessage(
  channelId: string,
  messageId: string,
  embed: EmbedPayload,
  disabledLabel: string,
  color: number,
): Promise<void> {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) return;

  const body = JSON.stringify({
    embeds: [{ timestamp: new Date().toISOString(), ...embed, color }],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: disabledLabel, custom_id: "noop_done", disabled: true },
        ],
      },
    ],
  });

  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[discord-notify] Edit message error ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error("[discord-notify] edit fetch error:", err);
  }
}
