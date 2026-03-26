import { Client, Collection, GatewayIntentBits } from "discord.js";
import { createServer } from "http";
import { getOrCreateActiveSeason, normalizeDefensivePositions } from "./lib/db-helpers.js";

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
import * as adminUserStats from "./commands/admin-userstats.js";
import * as adminLegendVault from "./commands/admin-legendvault.js";
import * as userStats from "./commands/userstats.js";

// Events
import * as interactionCreate from "./events/interactionCreate.js";
import * as ready from "./events/ready.js";

// ── Global crash protection ────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (bot kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (bot kept alive):", err);
});

const token = process.env["DISCORD_TOKEN"];
if (!token) throw new Error("DISCORD_TOKEN is required");

// In development (no REPL_DEPLOYMENT set), the dev bot must be explicitly
// enabled to avoid competing with the production bot on the same token.
// Production deployments always connect (REPL_DEPLOYMENT=1 is set by Replit).
const isProduction = process.env["REPL_DEPLOYMENT"] === "1";
const devBotEnabled = process.env["DEV_BOT_ENABLED"] === "true";
const statusPort = parseInt(process.env["PORT"] ?? "8090");

if (!isProduction && !devBotEnabled) {
  // ── Standby mode: keep HTTP server alive but do NOT connect to Discord ────
  console.log("⚠️  Dev bot is in standby — will not connect to Discord.");
  console.log("    Set DEV_BOT_ENABLED=true to enable (avoid running alongside the production bot).");
  createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "standby", bot: "REC League Econo-Bot (dev disabled)" }));
  }).listen(statusPort, () => console.log(`✅ Status server on :${statusPort} (standby — not connected to Discord)`));
} else {
  // ── Active mode: connect to Discord ───────────────────────────────────────
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
    adminUserStats,
    adminLegendVault,
    userStats,
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

  createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "online", bot: "REC League Econo-Bot" }));
  }).listen(statusPort, () => console.log(`✅ Status server on :${statusPort}`));

  async function init() {
    await getOrCreateActiveSeason();
    await normalizeDefensivePositions();
    console.log("✅ Database initialized");
  }

  init()
    .then(() => client.login(token))
    .catch((err) => {
      console.error("Failed to initialize:", err);
      process.exit(1);
    });
}
