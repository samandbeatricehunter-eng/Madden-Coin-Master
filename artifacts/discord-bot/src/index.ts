import { Client, Collection, GatewayIntentBits } from "discord.js";
import { createServer } from "http";
import { getOrCreateActiveSeason, normalizeDefensivePositions, PRIMARY_GUILD_ID } from "./lib/db/db-helpers.js";

// ── Unified admin + view commands ────────────────────────────────────────────
import * as admin         from "./commands/admin/admin.js";

// ── User commands ─────────────────────────────────────────────────────────────
import * as actions          from "./commands/actions.js";
import * as help             from "./commands/stats/help.js";
import * as h2hrecord        from "./commands/stats/h2hrecord.js";
import * as globalrecords    from "./commands/stats/globalrecords.js";

// ── Admin tools ───────────────────────────────────────────────────────────────
import * as adminEosTestrun          from "./commands/admin/admin-eos-testrun.js";
import * as adminCancelResendEos     from "./commands/admin/admin-cancel-resend-eos.js";
import * as adminRebuildHistorical   from "./commands/admin/admin-rebuild-historical.js";
import * as draftPresence            from "./commands/league/draft-presence.js";
import * as adminResendArticle       from "./commands/admin/admin-resendarticle.js";
import * as adminCatchup             from "./commands/admin/admin-catchup.js";
import * as adminRollbackFranchise   from "./commands/admin/admin-rollback-franchise.js";
import * as adminResetSeasonStats    from "./commands/admin/admin-reset-season-stats.js";
import * as endofseasonpayout        from "./commands/admin/endofseasonpayout.js";
import * as adminSetStatTiers        from "./commands/admin/admin-set-stat-tiers.js";
import * as adminStatTiers           from "./commands/admin/admin-stat-tiers.js";
import * as adminLegend              from "./commands/admin/admin-legend.js";
import * as adminLegendVault         from "./commands/admin/admin-legendvault.js";
import * as adminRepairTeamLinks     from "./commands/admin/admin-repair-teamlinks.js";
import * as adminMilestoneAudit      from "./commands/admin/admin-milestone-audit.js";
import * as adminCustomArcetypes     from "./commands/admin/admin-customarchetypes.js";
import * as adminCustomPlayerSettings from "./commands/admin/admin-customplayersettings.js";
import * as adminFixPlayerNames      from "./commands/admin/admin-fixplayernames.js";
import * as adminEosReapprove        from "./commands/admin/admin-eos-reapprove.js";
import * as adminSeason             from "./commands/admin/admin-season.js";
import * as adminLinkTeam           from "./commands/admin/admin-linkteam.js";
import * as adminInventory          from "./commands/admin/admin-inventory.js";
import * as adminInitialize         from "./commands/admin/admin-initialize.js";
import * as adminServer             from "./commands/admin/adminserver.js";
import * as adminTeamLogo          from "./commands/admin/admin-team-logo.js";
import * as adminRepostBanners     from "./commands/admin/admin-repost-banners.js";
import * as adminOperations        from "./commands/admin/admin-operations.js";

// ── Events ────────────────────────────────────────────────────────────────────
import * as interactionCreate from "./events/interactionCreate.js";
import * as ready             from "./events/ready.js";
import * as messageCreate     from "./events/messageCreate.js";
import * as guildCreate       from "./events/guildCreate.js";
import * as guildMemberAdd    from "./events/guildMemberAdd.js";

// ── Helpers ────────────────────────────────────────────────────────────────────
import { startSavingsInterestScheduler } from "./lib/scheduling/savings-interest.js";
import { startPollChecker }              from "./lib/scheduling/poll-checker.js";
import { startLeagueTwitterScheduler }   from "./lib/discord/league-twitter.js";

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
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  }) as Client & { commands: Collection<string, any> };

  client.commands = new Collection();

  const commands = [
    // Unified admin
    admin,

    // User-facing commands
    actions,
    help,
    h2hrecord,
    globalrecords,

    // Admin tools
    adminEosTestrun,
    adminCancelResendEos,
    adminRebuildHistorical,
    draftPresence,
    adminResendArticle,
    adminCatchup,
    adminRollbackFranchise,
    adminResetSeasonStats,
    endofseasonpayout,
    adminSetStatTiers,
    adminStatTiers,
    adminLegend,
    adminLegendVault,
    adminRepairTeamLinks,
    adminMilestoneAudit,
    adminCustomArcetypes,
    adminCustomPlayerSettings,
    adminFixPlayerNames,
    adminEosReapprove,
    adminSeason,
    adminLinkTeam,
    adminInventory,
    adminInitialize,
    adminServer,
    adminTeamLogo,
    adminRepostBanners,
    adminOperations,
  ];

  for (const command of commands) {
    client.commands.set(command.data.name, command);
  }

  const events = [interactionCreate, ready, messageCreate, guildCreate, guildMemberAdd];
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
