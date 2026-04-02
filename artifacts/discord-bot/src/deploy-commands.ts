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
import { seasonPRData, allTimePRData } from "./commands/records.js";
import * as recentH2H from "./commands/recentH2H.js";
import * as rules from "./commands/rules.js";
import * as adminRules from "./commands/admin-rules.js";
import * as adminSetAdmin from "./commands/admin-setadmin.js";
import * as adminInventory from "./commands/admin-inventory.js";
import * as interviewrequest from "./commands/interviewrequest.js";
import * as advanceweek from "./commands/advanceweek.js";
import * as adminPlayoffs from "./commands/admin-playoffs.js";
import * as adminGotw from "./commands/admin-gotw.js";
import * as adminPotw from "./commands/admin-potw.js";
import * as adminListUserTeams from "./commands/admin-listuserteams.js";
import * as adminUserStats from "./commands/admin-userstats.js";
import * as adminLegendVault from "./commands/admin-legendvault.js";
import * as userStats from "./commands/userstats.js";
import * as wager from "./commands/wager.js";
import * as teamlist from "./commands/teamlist.js";
import * as openteams from "./commands/openteams.js";
import * as adminClearteam from "./commands/admin-clearteam.js";
import * as adminResetWeek from "./commands/admin-resetweek.js";
import * as franchiseUpdate from "./commands/franchise-update.js";
import * as seasonschedule from "./commands/seasonschedule.js";
import * as nextopp from "./commands/nextopp.js";
import * as adminRollbackFranchise from "./commands/admin-rollback-franchise.js";
import * as adminSetStatTier from "./commands/admin-set-stat-tiers.js";
import * as endofseasonpayout from "./commands/endofseasonpayout.js";
import * as myRoster from "./commands/my-roster.js";
import * as weeklyMatchups from "./commands/weekly-matchups.js";
import * as adminCorrectPayout from "./commands/admin-correctpayout.js";
import * as statLeaders from "./commands/statleaders.js";
import * as tradeBlock from "./commands/tradeblock.js";
import * as postFullSeasonSchedule from "./commands/admin-postfullseasonschedule.js";
import * as webhookurl from "./commands/webhookurl.js";
import * as adminCatchup from "./commands/admin-catchup.js";
import * as adminFixPlayerNames from "./commands/admin-fixplayernames.js";
import * as adminSyncMilestones from "./commands/admin-syncmilestones.js";
import * as adminSetPayouts from "./commands/admin-setpayouts.js";
import * as adminResendArticle from "./commands/admin-resendarticle.js";
import * as adminLinkTeam from "./commands/admin-linkteam.js";
import * as adminFullSync from "./commands/admin-fullsync.js";
import * as setweek from "./commands/setweek.js";
import * as standings from "./commands/standings.js";
import * as viewroster from "./commands/viewroster.js";
import * as viewplayerdetails from "./commands/viewplayerdetails.js";

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
  adminRules, adminSetAdmin, adminInventory, interviewrequest, advanceweek,
  adminPlayoffs, adminGotw, adminPotw, adminListUserTeams, adminUserStats, adminLegendVault, userStats, wager,
  teamlist, openteams, adminClearteam, adminResetWeek, franchiseUpdate,
  seasonschedule, nextopp,
  adminRollbackFranchise, adminSetStatTier, endofseasonpayout,
  myRoster,
  weeklyMatchups,
  adminCorrectPayout,
  statLeaders,
  tradeBlock,
  postFullSeasonSchedule,
  webhookurl,
  adminCatchup,
  adminFixPlayerNames,
  adminSyncMilestones,
  adminSetPayouts,
  adminResendArticle,
  adminLinkTeam,
  adminFullSync,
  setweek,
  standings,
  viewroster,
  viewplayerdetails,
].map(c => c.data.toJSON());

commands.push(
  addNewUserData.toJSON(),
  deleteMemberData.toJSON(),
  seasonPRData.toJSON(),
  allTimePRData.toJSON(),
);

const rest = new REST().setToken(token);

console.log(`Registering ${commands.length} slash commands to guild ${guildId}...`);

rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  .then(() => console.log("✅ Slash commands registered successfully!"))
  .catch(console.error);
