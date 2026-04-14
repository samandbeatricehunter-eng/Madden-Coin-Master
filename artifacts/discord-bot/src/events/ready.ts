import { Client, REST, Routes } from "discord.js";
import { buildCommandJSON } from "../lib/command-list.js";

export const name = "clientReady";
export const once = true;

export async function execute(client: Client) {
  console.log(`✅ Bot logged in as ${client.user?.tag}`);

  const clientId = process.env["DISCORD_CLIENT_ID"];
  const token    = process.env["DISCORD_TOKEN"];
  if (!clientId || !token) return;

  const guilds = client.guilds.cache;
  if (guilds.size === 0) return;

  console.log(`🔄 Registering slash commands for ${guilds.size} guild(s) on startup...`);

  const rest     = new REST().setToken(token);
  const commands = buildCommandJSON();

  for (const [guildId, guild] of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`✅ Commands registered: ${guild.name} (${guildId})`);
    } catch (err) {
      console.error(`❌ Failed to register commands for guild ${guildId}:`, err);
    }
  }
}
