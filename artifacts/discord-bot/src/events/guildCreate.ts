import { Guild, REST, Routes } from "discord.js";
import { buildCommandJSON } from "../lib/command-list.js";

export const name = "guildCreate";
export const once = false;

export async function execute(guild: Guild) {
  const clientId = process.env["DISCORD_CLIENT_ID"];
  const token    = process.env["DISCORD_TOKEN"];
  if (!clientId || !token) return;

  console.log(`➕ Bot joined new guild: ${guild.name} (${guild.id}) — registering slash commands...`);

  try {
    const rest     = new REST().setToken(token);
    const commands = buildCommandJSON();
    await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: commands });
    console.log(`✅ Slash commands registered for guild: ${guild.name} (${guild.id})`);
  } catch (err) {
    console.error(`❌ Failed to register commands for guild ${guild.id}:`, err);
  }
}
