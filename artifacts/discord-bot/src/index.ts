import { Client, Collection, GatewayIntentBits } from "discord.js";
import { createServer } from "http";
import { getOrCreateActiveSeason, normalizeDefensivePositions } from "./lib/db-helpers.js";

// ── Unified admin + view commands ────────────────────────────────────────────
import * as admin         from "./commands/admin.js";
import * as view          from "./commands/view.js";
import * as adminEosTestrun from "./commands/admin-eos-testrun.js";
import * as adminStatReimport from "./commands/admin-stat-reimport.js";
import * as adminEaConnect from "./commands/admin-ea-connect.js";
import * as adminEaExport   from "./commands/admin-ea-export.js";
import * as draftPresence   from "./commands/draft-presence.js";

// ── Split admin slash commands ────────────────────────────────────────────────
import * as slashAdminSeason    from "./commands/slash-admin-season.js";
import * as slashAdminFranchise from "./commands/slash-admin-franchise.js";
import * as slashAdminUpgrade   from "./commands/slash-admin-upgrade.js";
import * as slashAdminPlayoffs  from "./commands/slash-admin-playoffs.js";
import * as slashAdminRules     from "./commands/slash-admin-rules.js";
import * as slashAdminLegend    from "./commands/slash-admin-legend.js";
import * as slashAdminInventory from "./commands/slash-admin-inventory.js";
import * as slashAdminFix       from "./commands/slash-admin-fix.js";

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
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged — must be enabled in Dev Portal
    ],
  }) as Client & { commands: Collection<string, any> };

  client.commands = new Collection();

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

    // Admin tools
    adminEosTestrun,
    adminStatReimport,
    adminEaConnect,
    adminEaExport,
    draftPresence,

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
    await getOrCreateActiveSeason();
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
