import { Client, Collection, GatewayIntentBits } from "discord.js";
import { createServer } from "http";
import { getOrCreateActiveSeason, normalizeDefensivePositions, PRIMARY_GUILD_ID } from "./lib/db-helpers.js";

// ── Unified admin + view commands ────────────────────────────────────────────
import * as admin         from "./commands/admin.js";
import * as view          from "./commands/view.js";


// ── User commands ─────────────────────────────────────────────────────────────
import * as help             from "./commands/help.js";
import * as balance          from "./commands/balance.js";
import * as sendcoins        from "./commands/sendcoins.js";
import * as purchase         from "./commands/purchase.js";
import * as inventory        from "./commands/inventory.js";
import * as recentH2H        from "./commands/recentH2H.js";
import * as wager            from "./commands/wager.js";
import * as teamlist         from "./commands/teamlist.js";
import * as openteams        from "./commands/openteams.js";
import * as seasonschedule   from "./commands/seasonschedule.js";
import * as nextschedule     from "./commands/nextschedule.js";
import * as nextopp          from "./commands/nextopp.js";
import * as myRoster         from "./commands/my-roster.js";
import * as savings          from "./commands/savings.js";
import * as weeklyMatchups   from "./commands/weekly-matchups.js";
import * as standings        from "./commands/standings.js";
import * as tradeBlock       from "./commands/tradeblock.js";
import * as h2hrecord        from "./commands/h2hrecord.js";
import * as customarticle    from "./commands/customarticle.js";
import * as webhookurl       from "./commands/webhookurl.js";
import * as viewpayouttiers  from "./commands/viewpayouttiers.js";
import * as interviewrequest from "./commands/interviewrequest.js";
import * as advanceweek      from "./commands/advanceweek.js";
import * as statleaders      from "./commands/statleaders.js";
import * as availableupgrades from "./commands/availableupgrades.js";
import * as viewFreeAgents   from "./commands/viewfreeagents.js";
import * as viewXp            from "./commands/viewxp.js";

// ── Admin tools ───────────────────────────────────────────────────────────────
import * as adminEosTestrun          from "./commands/admin-eos-testrun.js";
import * as adminStatReimport        from "./commands/admin-stat-reimport.js";
import * as adminEaConnect           from "./commands/admin-ea-connect.js";
import * as adminEaExport            from "./commands/admin-ea-export.js";
import * as adminCancelResendEos     from "./commands/admin-cancel-resend-eos.js";
import * as adminRebuildHistorical   from "./commands/admin-rebuild-historical.js";
import * as draftPresence            from "./commands/draft-presence.js";
import * as adminPlayoffs            from "./commands/admin-playoffs.js";
import * as adminResendArticle       from "./commands/admin-resendarticle.js";
import * as adminCatchup             from "./commands/admin-catchup.js";
import * as adminManualScore         from "./commands/admin-manualscore.js";
import * as adminReverseGame         from "./commands/admin-reverse-game.js";
import * as adminPostFullSeasonSchedule from "./commands/admin-postfullseasonschedule.js";
import * as adminRollbackFranchise   from "./commands/admin-rollback-franchise.js";
import * as endofseasonpayout        from "./commands/endofseasonpayout.js";
import * as adminSetPayouts          from "./commands/admin-setpayouts.js";
import * as adminSetStatTiers        from "./commands/admin-set-stat-tiers.js";
import * as adminStatTiers           from "./commands/admin-stat-tiers.js";
import * as adminSetMilestoneTier    from "./commands/admin-setmilestonetier.js";
import * as adminLegendVault         from "./commands/admin-legendvault.js";
import * as adminCustomArcetypes     from "./commands/admin-customarchetypes.js";
import * as adminCustomPlayerSettings from "./commands/admin-customplayersettings.js";
import * as adminFixPlayerNames      from "./commands/admin-fixplayernames.js";
import * as adminEosReapprove        from "./commands/admin-eos-reapprove.js";
import * as adminSeason             from "./commands/admin-season.js";
import * as adminLinkTeam           from "./commands/admin-linkteam.js";
import * as adminInventory          from "./commands/admin-inventory.js";

// ── Records / rankings (standalone) ──────────────────────────────────────────
import {
  seasonPRData, executeSeasonPR,
  allTimePRData, executeAllTimePR,
} from "./commands/records.js";

// ── Events ────────────────────────────────────────────────────────────────────
import * as interactionCreate from "./events/interactionCreate.js";
import * as ready             from "./events/ready.js";
import * as messageCreate     from "./events/messageCreate.js";

// ── Helpers ────────────────────────────────────────────────────────────────────
import { startSavingsInterestScheduler } from "./lib/savings-interest.js";
import { startPollChecker }              from "./lib/poll-checker.js";
import { startLeagueTwitterScheduler }   from "./lib/league-twitter.js";

// ── Global crash protection ────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (bot kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (bot kept alive):", err);
});

const token = process.env["DISCORD_TOKEN"];
if (!token) throw new Error("DISCORD_TOKEN is required");

const isProduction = process.env["npm_lifecycle_event"] === "start" || !!process.env["REPL_DEPLOYMENT"];
const devBotEnabled = process.env["DEV_BOT_ENABLED"] === "true";
const statusPort = parseInt(process.env["PORT"] ?? "8090");

if (!isProduction && !devBotEnabled) {
  console.log("⚠️  Dev bot is in standby — will not connect to Discord.");
  console.log("    Set DEV_BOT_ENABLED=true to enable (avoid running alongside the production bot).");
  createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "standby", bot: "REC League Econo-Bot (dev disabled)" }));
  }).listen(statusPort, () => console.log(`✅ Status server on :${statusPort} (standby — not connected to Discord)`));
} else {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  }) as Client & { commands: Collection<string, any> };

  client.commands = new Collection();

  const commands = [
    // Unified admin & view
    admin,
    view,

    // User-facing commands
    help,
    balance,
    sendcoins,
    purchase,
    inventory,
    recentH2H,
    wager,
    teamlist,
    openteams,
    seasonschedule,
    nextschedule,
    nextopp,
    myRoster,
    savings,
    weeklyMatchups,
    standings,
    tradeBlock,
    h2hrecord,
    customarticle,
    webhookurl,
    viewpayouttiers,
    interviewrequest,
    advanceweek,
    statleaders,
    availableupgrades,
    viewFreeAgents,
    viewXp,

    // Admin tools
    adminEosTestrun,
    adminStatReimport,
    adminEaConnect,
    adminEaExport,
    adminCancelResendEos,
    adminRebuildHistorical,
    draftPresence,
    adminPlayoffs,
    adminResendArticle,
    adminCatchup,
    adminManualScore,
    adminReverseGame,
    adminPostFullSeasonSchedule,
    adminRollbackFranchise,
    endofseasonpayout,
    adminSetPayouts,
    adminSetStatTiers,
    adminStatTiers,
    adminSetMilestoneTier,
    adminLegendVault,
    adminCustomArcetypes,
    adminCustomPlayerSettings,
    adminFixPlayerNames,
    adminEosReapprove,
    adminSeason,
    adminLinkTeam,
    adminInventory,

    // Records (named exports)
    { data: seasonPRData, execute: executeSeasonPR },
    { data: allTimePRData, execute: executeAllTimePR },
  ];

  for (const command of commands) {
    client.commands.set(command.data.name, command);
  }

  const events = [interactionCreate, ready, messageCreate];
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
    await getOrCreateActiveSeason(PRIMARY_GUILD_ID);
    await normalizeDefensivePositions();
    console.log("✅ Database initialized");
  }

  client.once("ready", () => {
    startPollChecker(client);
    startSavingsInterestScheduler();
    startLeagueTwitterScheduler(client);
  });

  init()
    .then(() => client.login(token))
    .catch((err) => {
      console.error("Failed to initialize:", err);
      process.exit(1);
    });
}
