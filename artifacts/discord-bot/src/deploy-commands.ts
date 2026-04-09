import { REST, Routes } from "discord.js";
import * as admin              from "./commands/admin.js";
import * as view               from "./commands/view.js";
import * as slashAdminSeason   from "./commands/slash-admin-season.js";
import * as slashAdminFranchise from "./commands/slash-admin-franchise.js";
import * as slashAdminUpgrade  from "./commands/slash-admin-upgrade.js";
import * as slashAdminPlayoffs from "./commands/slash-admin-playoffs.js";
import * as slashAdminRules    from "./commands/slash-admin-rules.js";
import * as slashAdminLegend   from "./commands/slash-admin-legend.js";
import * as slashAdminInventory from "./commands/slash-admin-inventory.js";
import * as slashAdminFix      from "./commands/slash-admin-fix.js";
import * as help               from "./commands/help.js";
import * as balance            from "./commands/balance.js";
import * as sendcoins          from "./commands/sendcoins.js";
import * as purchase           from "./commands/purchase.js";
import * as inventory          from "./commands/inventory.js";
import * as recentH2H          from "./commands/recentH2H.js";
import * as wager              from "./commands/wager.js";
import * as teamlist           from "./commands/teamlist.js";
import * as openteams          from "./commands/openteams.js";
import * as seasonschedule     from "./commands/seasonschedule.js";
import * as nextopp            from "./commands/nextopp.js";
import * as myRoster           from "./commands/my-roster.js";
import * as savings            from "./commands/savings.js";
import * as weeklyMatchups     from "./commands/weekly-matchups.js";
import * as standings          from "./commands/standings.js";
import * as tradeBlock         from "./commands/tradeblock.js";
import * as h2hrecord          from "./commands/h2hrecord.js";
import * as customarticle      from "./commands/customarticle.js";
import * as webhookurl         from "./commands/webhookurl.js";
import * as viewPayoutTiers    from "./commands/viewpayouttiers.js";
import * as interviewrequest   from "./commands/interviewrequest.js";
import { seasonPRData, allTimePRData } from "./commands/records.js";

const token    = process.env["DISCORD_TOKEN"]!;
const clientId = process.env["DISCORD_CLIENT_ID"]!;
const guildId  = process.env["DISCORD_GUILD_ID"]!;

if (!token || !clientId || !guildId) {
  throw new Error("DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID must be set");
}

const commands = [
  // Unified admin & view
  admin,
  view,

  // Split admin slash commands
  slashAdminSeason,
  slashAdminFranchise,
  slashAdminUpgrade,
  slashAdminPlayoffs,
  slashAdminRules,
  slashAdminLegend,
  slashAdminInventory,
  slashAdminFix,

  // User-facing commands
  help, balance, sendcoins, purchase, inventory,
  recentH2H, wager, teamlist, openteams,
  seasonschedule, nextopp, myRoster, savings, weeklyMatchups,
  standings, tradeBlock, h2hrecord, customarticle, webhookurl,
  viewPayoutTiers, interviewrequest,
].map(c => c.data.toJSON());

commands.push(
  seasonPRData.toJSON(),
  allTimePRData.toJSON(),
);

const rest = new REST().setToken(token);

console.log(`Registering ${commands.length} slash commands to guild ${guildId}...`);

rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  .then(() => console.log("✅ Slash commands registered successfully!"))
  .catch(console.error);
