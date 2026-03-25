import { Client, Collection, GatewayIntentBits } from "discord.js";
import { getOrCreateActiveSeason } from "./lib/db-helpers.js";

// Commands
import * as balance from "./commands/balance.js";
import * as sendcoins from "./commands/sendcoins.js";
import * as viewstore from "./commands/viewstore.js";
import * as purchase from "./commands/purchase.js";
import * as inventory from "./commands/inventory.js";
import * as availableupgrades from "./commands/availableupgrades.js";
import * as adminLegend from "./commands/admin-legend.js";
import * as adminSeason from "./commands/admin-season.js";

// Events
import * as interactionCreate from "./events/interactionCreate.js";
import * as ready from "./events/ready.js";

const token = process.env["DISCORD_TOKEN"];
if (!token) throw new Error("DISCORD_TOKEN is required");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
}) as Client & { commands: Collection<string, any> };

client.commands = new Collection();

const commands = [balance, sendcoins, viewstore, purchase, inventory, availableupgrades, adminLegend, adminSeason];
for (const command of commands) {
  client.commands.set(command.data.name, command);
}

// Register events
const events = [interactionCreate, ready];
for (const event of events) {
  if ((event as any).once) {
    client.once(event.name, (...args) => event.execute(...args as [any]));
  } else {
    client.on(event.name, (...args) => event.execute(...args as [any]));
  }
}

// Initialize DB: ensure active season exists on startup
async function init() {
  await getOrCreateActiveSeason();
  console.log("✅ Database initialized");
}

init()
  .then(() => client.login(token))
  .catch((err) => {
    console.error("Failed to initialize:", err);
    process.exit(1);
  });
