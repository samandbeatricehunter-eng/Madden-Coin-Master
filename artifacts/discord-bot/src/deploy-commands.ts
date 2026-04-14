import { REST, Routes } from "discord.js";
import { buildCommandJSON } from "./lib/command-list.js";

const token    = process.env["DISCORD_TOKEN"]!;
const clientId = process.env["DISCORD_CLIENT_ID"]!;
const guildId  = process.env["DISCORD_GUILD_ID"];

if (!token || !clientId) {
  throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set");
}

const commands = buildCommandJSON();
const rest     = new REST().setToken(token);

async function deploy() {
  // Clear global commands so they don't duplicate guild-specific ones.
  // Guild commands are used instead because they register instantly and
  // the ready/guildCreate events handle all servers automatically.
  console.log("Clearing global commands (prevents duplicates with guild commands)...");
  await rest.put(Routes.applicationCommands(clientId), { body: [] });
  console.log("✅ Global commands cleared");

  if (guildId) {
    console.log(`Registering ${commands.length} commands to guild ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`✅ Guild commands registered for ${guildId}`);
  } else {
    console.log("ℹ️  No DISCORD_GUILD_ID set — skipping guild registration.");
    console.log("   The bot's ready event will register commands for all joined guilds on next startup.");
  }
}

deploy().catch(console.error);
