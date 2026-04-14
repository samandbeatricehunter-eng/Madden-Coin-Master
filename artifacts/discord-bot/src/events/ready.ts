import { Client } from "discord.js";
import { registerCommandsForGuild } from "../lib/register-commands.js";

export const name = "clientReady";
export const once = true;

export async function execute(client: Client) {
  console.log(`✅ Bot logged in as ${client.user?.tag}`);

  const guilds = client.guilds.cache;
  if (guilds.size === 0) return;

  console.log(`🔄 Registering slash commands for ${guilds.size} guild(s) on startup...`);

  for (const [guildId, guild] of guilds) {
    try {
      await registerCommandsForGuild(guildId);
      console.log(`✅ Commands registered: ${guild.name} (${guildId})`);
    } catch (err) {
      console.error(`❌ Failed to register commands for guild ${guildId}:`, err);
    }
  }
}
