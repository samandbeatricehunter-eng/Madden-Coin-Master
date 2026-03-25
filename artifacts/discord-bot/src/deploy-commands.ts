import { REST, Routes } from "discord.js";
import * as balance from "./commands/balance.js";
import * as sendcoins from "./commands/sendcoins.js";
import * as viewstore from "./commands/viewstore.js";
import * as purchase from "./commands/purchase.js";
import * as inventory from "./commands/inventory.js";
import * as availableupgrades from "./commands/availableupgrades.js";
import * as adminLegend from "./commands/admin-legend.js";
import * as adminSeason from "./commands/admin-season.js";

const token = process.env["DISCORD_TOKEN"]!;
const clientId = process.env["DISCORD_CLIENT_ID"]!;
const guildId = process.env["DISCORD_GUILD_ID"]!;

if (!token || !clientId || !guildId) {
  throw new Error("DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID must be set");
}

const commands = [
  balance, sendcoins, viewstore, purchase, inventory, availableupgrades, adminLegend, adminSeason,
].map(c => c.data.toJSON());

const rest = new REST().setToken(token);

console.log(`Registering ${commands.length} slash commands to guild ${guildId}...`);

rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  .then(() => console.log("✅ Slash commands registered successfully!"))
  .catch(console.error);
