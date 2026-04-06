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
  seasonPRData, executeSeasonPR,
  allTimePRData, executeAllTimePR,
} from "./commands/records.js";
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

import * as seasonschedule from "./commands/seasonschedule.js";
import * as nextopp from "./commands/nextopp.js";
import * as adminRollbackFranchise from "./commands/admin-rollback-franchise.js";
import * as adminSetStatTier from "./commands/admin-set-stat-tiers.js";
import * as customarticle from "./commands/customarticle.js";
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
import * as adminServer from "./commands/adminserver.js";
import * as adminManualScore from "./commands/admin-manualscore.js";
import * as setweek from "./commands/setweek.js";
import * as standings from "./commands/standings.js";
import * as viewroster from "./commands/viewroster.js";
import * as viewplayerdetails from "./commands/viewplayerdetails.js";
import * as viewfreeagents from "./commands/viewfreeagents.js";
import { startPollChecker } from "./lib/poll-checker.js";

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

// Production deployments run via `pnpm run start`; the dev workflow uses `pnpm run dev`.
// npm_lifecycle_event is set to the script name by npm/pnpm — this is the reliable signal.
const isProduction = process.env["npm_lifecycle_event"] === "start" || !!process.env["REPL_DEPLOYMENT"];
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
    interviewrequest,
    advanceweek,
    adminPlayoffs,
    adminGotw,
    adminPotw,
    adminListUserTeams,
    adminUserStats,
    adminLegendVault,
    userStats,
    wager,
    teamlist,
    openteams,
    adminClearteam,
    adminResetWeek,
    seasonschedule,
    nextopp,
    adminRollbackFranchise,
    adminSetStatTier,
    customarticle,
    endofseasonpayout,
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
    adminServer,
    adminManualScore,
    setweek,
    standings,
    viewroster,
    viewplayerdetails,
    viewfreeagents,
    { data: addNewUserData, execute: executeAddNewUser, autocomplete: autocompleteAddNewUser },
    { data: deleteMemberData, execute: executeDeleteMember, autocomplete: autocompleteDeleteMember },
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

  client.once("ready", () => {
    startPollChecker(client);
  });

  init()
    .then(() => client.login(token))
    .catch((err) => {
      console.error("Failed to initialize:", err);
      process.exit(1);
    });
}
