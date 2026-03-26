import { REST, Routes } from "discord.js";
import * as help from "./commands/help.js";
import * as balance from "./commands/balance.js";
import * as sendcoins from "./commands/sendcoins.js";
import * as viewstore from "./commands/viewstore.js";
import * as purchase from "./commands/purchase.js";
import * as inventory from "./commands/inventory.js";
import * as availableupgrades from "./commands/availableupgrades.js";
import * as adminLegend from "./commands/admin-legend.js";
import * as adminSeason from "./commands/admin-season.js";
import * as adminAddCoins from "./commands/admin-addcoins.js";
import * as adminRemoveCoins from "./commands/admin-removecoins.js";
import * as adminResetUpgrades from "./commands/admin-resetupgrades.js";
import * as adminSetUser from "./commands/admin-setuser.js";
import * as adminTransactions from "./commands/admin-transactions.js";
import { addNewUserData, deleteMemberData } from "./commands/admin-team.js";
import { updateRecordData, seasonPRData, allTimePRData } from "./commands/records.js";
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

const token = process.env["DISCORD_TOKEN"]!;
const clientId = process.env["DISCORD_CLIENT_ID"]!;
const guildId = process.env["DISCORD_GUILD_ID"]!;

if (!token || !clientId || !guildId) {
  throw new Error("DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID must be set");
}

const commands = [
  help, balance, sendcoins, viewstore, purchase, inventory, availableupgrades,
  adminLegend, adminSeason, adminAddCoins, adminRemoveCoins, adminResetUpgrades,
  adminSetUser, adminTransactions, recentH2H, rules,
  adminRules, adminSetAdmin, adminInventory, reportscore, interviewrequest, advanceweek,
  adminPlayoffs, adminGotw, adminPotw, adminListUserTeams, adminUserStats, adminLegendVault, userStats,
].map(c => c.data.toJSON());

commands.push(
  addNewUserData.toJSON(),
  deleteMemberData.toJSON(),
  updateRecordData.toJSON(),
  seasonPRData.toJSON(),
  allTimePRData.toJSON(),
);

const rest = new REST().setToken(token);

console.log(`Registering ${commands.length} slash commands to guild ${guildId}...`);

rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  .then(() => console.log("✅ Slash commands registered successfully!"))
  .catch(console.error);
