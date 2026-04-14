import { Guild } from "discord.js";
import { registerCommandsForGuild } from "../lib/register-commands.js";

export const name = "guildCreate";
export const once = false;

export async function execute(guild: Guild) {
  console.log(`➕ Bot joined new guild: ${guild.name} (${guild.id}) — registering slash commands...`);
  await registerCommandsForGuild(guild.id);
}
