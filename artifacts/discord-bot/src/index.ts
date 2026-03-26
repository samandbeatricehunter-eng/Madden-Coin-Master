import { Client, Collection, GatewayIntentBits } from "discord.js";
import { createServer } from "http";
import { getOrCreateActiveSeason } from "./lib/db-helpers.js";

// User commands
import * as help from "./commands/help.js";
import * as balance from "./commands/balance.js";
import * as sendcoins from "./commands/sendcoins.js";
import * as viewstore from "./commands/viewstore.js";
import * as purchase from "./commands/purchase.js";
import * as inventory from "./commands/inventory.js";
import * as availableupgrades from "./commands/availableupgrades.js";

// Admin commands
import * as adminLegend from "./commands/admin-legend.js";
import * as adminSeason from "./commands/admin-season.js";
import * as adminAddCoins from "./commands/admin-addcoins.js";
import * as adminRemoveCoins from "./commands/admin-removecoins.js";
import * as adminResetUpgrades from "./commands/admin-resetupgrades.js";
import * as adminSetUser from "./commands/admin-setuser.js";
import * as adminTransactions from "./commands/admin-transactions.js";
import {
  addNewUserData, executeAddNewUser, autocompleteAddNewUser,
  deleteMemberData, executeDeleteMember, autocompleteDeleteMember,
} from "./commands/admin-team.js";

// Records / rankings
import {
  updateRecordData, executeUpdateRecord, autocompleteUpdateRecord,
  seasonPRData, executeSeasonPR,
  allTimePRData, executeAllTimePR,
} from "./commands/records.js";
import * as recentH2H from "./commands/recentH2H.js";
import * as rules from "./commands/rules.js";
import * as adminRules from "./commands/admin-rules.js";
import * as adminSetAdmin from "./commands/admin-setadmin.js";
import * as adminInventory from "./commands/admin-inventory.js";
import * as reportscore from "./commands/reportscore.js";
import * as interviewrequest from "./commands/interviewrequest.js";
import * as advanceweek from "./commands/advanceweek.js";
import * as adminPlayoffs from "./commands/admin-playoffs.js";
import * as adminGotw from "./commands/admin-gotw.js";
import * as adminPotw from "./commands/admin-potw.js";
import * as adminListUserTeams from "./commands/admin-listuserteams.js";

// Events
import * as interactionCreate from "./events/interactionCreate.js";
import * as ready from "./events/ready.js";

const token = process.env["DISCORD_TOKEN"];
if (!token) throw new Error("DISCORD_TOKEN is required");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
}) as Client & { commands: Collection<string, any> };

client.commands = new Collection();

const commands = [
  help,
  balance,
  sendcoins,
  viewstore,
  purchase,
  inventory,
  availableupgrades,
  adminLegend,
  adminSeason,
  adminAddCoins,
  adminRemoveCoins,
  adminResetUpgrades,
  adminSetUser,
  adminTransactions,
  recentH2H,
  rules,
  adminRules,
  adminSetAdmin,
  adminInventory,
  reportscore,
  interviewrequest,
  advanceweek,
  adminPlayoffs,
  adminGotw,
  adminPotw,
  adminListUserTeams,
  { data: addNewUserData, execute: executeAddNewUser, autocomplete: autocompleteAddNewUser },
  { data: deleteMemberData, execute: executeDeleteMember, autocomplete: autocompleteDeleteMember },
  { data: updateRecordData, execute: executeUpdateRecord, autocomplete: autocompleteUpdateRecord },
  { data: seasonPRData, execute: executeSeasonPR },
  { data: allTimePRData, execute: executeAllTimePR },
];

for (const command of commands) {
  client.commands.set(command.data.name, command);
}

const events = [interactionCreate, ready];
for (const event of events) {
  if ((event as any).once) {
    client.once(event.name, (...args) => event.execute(...args as [any]));
  } else {
    client.on(event.name, (...args) => event.execute(...args as [any]));
  }
}

// ── Status HTTP server (required for Replit service registration) ─────────────
const statusPort = parseInt(process.env["PORT"] ?? "8090");
createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "online", bot: "REC League Econo-Bot" }));
}).listen(statusPort, () => console.log(`✅ Status server on :${statusPort}`));

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
