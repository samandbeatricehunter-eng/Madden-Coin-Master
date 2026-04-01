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
