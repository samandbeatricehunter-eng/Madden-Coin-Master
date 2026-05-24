import { REST, Routes } from "discord.js";
import { buildCommandJSON } from "../menu/command-list.js";
import { getServerSettings } from "../db/server-settings.js";

/**
 * Re-registers slash commands for a single guild, filtered by that guild's
 * current server settings. Call this after any feature toggle so the command
 * list in Discord updates immediately.
 */
export async function registerCommandsForGuild(guildId: string): Promise<void> {
  const token    = process.env["DISCORD_TOKEN"];
  const clientId = process.env["DISCORD_CLIENT_ID"];
  if (!token || !clientId) {
    console.warn("[register-commands] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID — skipping");
    return;
  }

  try {
    const settings = await getServerSettings(guildId);
    const commands = buildCommandJSON(settings);
    const rest     = new REST().setToken(token);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`✅ [register-commands] ${commands.length} commands registered for guild ${guildId}`);
  } catch (err) {
    console.error(`❌ [register-commands] Failed to register commands for guild ${guildId}:`, err);
  }
}
