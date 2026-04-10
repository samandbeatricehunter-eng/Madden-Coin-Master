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
import * as nextschedule       from "./commands/nextschedule.js";
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
import * as adminEosTestrun         from "./commands/admin-eos-testrun.js";
import * as adminStatReimport       from "./commands/admin-stat-reimport.js";
import * as adminEaConnect          from "./commands/admin-ea-connect.js";
import * as adminEaExport           from "./commands/admin-ea-export.js";
import * as adminCancelResendEos    from "./commands/admin-cancel-resend-eos.js";
import * as adminRebuildHistorical  from "./commands/admin-rebuild-historical.js";
import * as draftPresence           from "./commands/draft-presence.js";
// Admin coin / user management
import * as adminAddCoins           from "./commands/admin-addcoins.js";
import * as adminRemoveCoins        from "./commands/admin-removecoins.js";
import * as adminSetUser            from "./commands/admin-setuser.js";
import * as adminSetAdmin           from "./commands/admin-setadmin.js";
import * as adminLinkTeam           from "./commands/admin-linkteam.js";
import * as adminClearTeam          from "./commands/admin-clearteam.js";
import * as adminListUserTeams      from "./commands/admin-listuserteams.js";
import * as adminUserStats          from "./commands/admin-userstats.js";
import * as adminTransactions       from "./commands/admin-transactions.js";
import * as adminReverseTransaction from "./commands/admin-reverse-transaction.js";
import * as adminCorrectPayout      from "./commands/admin-correctpayout.js";
import * as adminResendPayouts      from "./commands/admin-resend-payouts.js";
// Admin season / week
import * as adminSeason             from "./commands/admin-season.js";
import * as adminResetWeek          from "./commands/admin-resetweek.js";
import * as adminCatchup            from "./commands/admin-catchup.js";
import * as adminFullSync           from "./commands/admin-fullsync.js";
import * as adminManualScore        from "./commands/admin-manualscore.js";
import * as adminPostFullSeasonSchedule from "./commands/admin-postfullseasonschedule.js";
import * as adminRollbackFranchise  from "./commands/admin-rollback-franchise.js";
import * as adminFixPlayerNames     from "./commands/admin-fixplayernames.js";
// Admin payouts / tiers
import * as adminSetPayouts         from "./commands/admin-setpayouts.js";
import * as adminSetStatTiers       from "./commands/admin-set-stat-tiers.js";
import * as adminStatTiers          from "./commands/admin-stat-tiers.js";
import * as adminSetMilestoneTier   from "./commands/admin-setmilestonetier.js";
import * as adminSyncMilestones     from "./commands/admin-syncmilestones.js";
import * as adminResetUpgrades      from "./commands/admin-resetupgrades.js";
// Admin store / inventory / legend
import * as adminInventory          from "./commands/admin-inventory.js";
import * as adminLegend             from "./commands/admin-legend.js";
import * as adminLegendVault        from "./commands/admin-legendvault.js";
import * as adminCustomArcetypes    from "./commands/admin-customarchetypes.js";
import * as adminCustomPlayerSettings from "./commands/admin-customplayersettings.js";
// Admin events / announcements
import * as adminGotw               from "./commands/admin-gotw.js";
import * as adminPotw               from "./commands/admin-potw.js";
import * as adminResendArticle      from "./commands/admin-resendarticle.js";
import * as adminRules              from "./commands/admin-rules.js";
import * as adminServer             from "./commands/adminserver.js";
// Admin playoffs
import * as adminPlayoffs           from "./commands/admin-playoffs.js";
// User-facing franchise / schedule
import * as advanceweek             from "./commands/advanceweek.js";
import * as setweek                 from "./commands/setweek.js";
import * as statleaders             from "./commands/statleaders.js";
import * as userstats               from "./commands/userstats.js";
import * as availableupgrades       from "./commands/availableupgrades.js";
import * as purchasecustomplayer    from "./commands/purchasecustomplayer.js";
import * as endofseasonpayout       from "./commands/endofseasonpayout.js";
import * as rules                   from "./commands/rules.js";
// User-facing view commands
import * as viewRoster              from "./commands/viewroster.js";
import * as viewStore               from "./commands/viewstore.js";
import * as viewTradeBlock          from "./commands/viewtradeblock.js";
import * as viewFreeAgents          from "./commands/viewfreeagents.js";
import * as viewPlayerDetails       from "./commands/viewplayerdetails.js";
import * as viewPlayerStats         from "./commands/viewplayerstats.js";
import * as viewCustomArcetypes     from "./commands/viewcustomarchetypes.js";
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
  seasonschedule, nextschedule, nextopp, myRoster, savings, weeklyMatchups,
  standings, tradeBlock, h2hrecord, customarticle, webhookurl,
  viewPayoutTiers, interviewrequest,
  adminEosTestrun,
  adminStatReimport,
  adminEaConnect,
  adminEaExport,
  adminCancelResendEos,
  adminRebuildHistorical,
  draftPresence,

  // Admin coin / user management
  adminAddCoins, adminRemoveCoins, adminSetUser, adminSetAdmin,
  adminLinkTeam, adminClearTeam, adminListUserTeams, adminUserStats,
  adminTransactions, adminReverseTransaction, adminCorrectPayout, adminResendPayouts,

  // Admin season / week
  adminSeason, adminResetWeek, adminCatchup, adminFullSync,
  adminManualScore, adminPostFullSeasonSchedule, adminRollbackFranchise, adminFixPlayerNames,

  // Admin payouts / tiers
  adminSetPayouts, adminSetStatTiers, adminStatTiers,
  adminSetMilestoneTier, adminSyncMilestones, adminResetUpgrades,

  // Admin store / inventory / legend
  adminInventory, adminLegend, adminLegendVault,
  adminCustomArcetypes, adminCustomPlayerSettings,

  // Admin events / announcements
  adminGotw, adminPotw, adminResendArticle, adminRules, adminServer,

  // Admin playoffs
  adminPlayoffs,

  // User-facing franchise / schedule
  advanceweek, setweek, statleaders, userstats, availableupgrades,
  purchasecustomplayer, endofseasonpayout, rules,

  // User-facing view commands
  viewRoster, viewStore, viewTradeBlock, viewFreeAgents,
  viewPlayerDetails, viewPlayerStats, viewCustomArcetypes,
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
