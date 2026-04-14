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
  if (guildId) {
    console.log(`Registering ${commands.length} commands to guild ${guildId} (instant)...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`✅ Guild commands registered for ${guildId}`);
  }

  console.log(`Registering ${commands.length} commands globally (propagates to all servers within ~1 hour)...`);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("✅ Global commands registered");
}

deploy().catch(console.error);
