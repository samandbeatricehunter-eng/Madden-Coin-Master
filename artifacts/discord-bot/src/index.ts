import { Client, Collection, GatewayIntentBits } from "discord.js";
import { createServer } from "http";
import { getOrCreateActiveSeason, normalizeDefensivePositions, PRIMARY_GUILD_ID } from "./lib/db/db-helpers.js";

// ── Slash commands registered by the bot — everything else is accessed
//    through menu hub buttons/selects routed via events/interactionCreate.ts ─
import * as actions from "./commands/actions.js";

// ── Events ────────────────────────────────────────────────────────────────────
import * as interactionCreate from "./events/interactionCreate.js";
import * as ready             from "./events/ready.js";
import * as messageCreate     from "./events/messageCreate.js";
import * as guildCreate       from "./events/guildCreate.js";
import * as guildMemberAdd    from "./events/guildMemberAdd.js";
import * as messageReactionAdd from "./events/messageReactionAdd.js";

// ── Helpers ────────────────────────────────────────────────────────────────────
import { startSavingsInterestScheduler } from "./lib/scheduling/savings-interest.js";
import { startGameReminderScheduler }    from "./lib/scheduling/game-reminders.js";
import { processGamedayReminderTick } from "./lib/gameday/gameday-reminders.js";
import { startGamedayReconciliationScheduler } from "./lib/gameday/reconcile-imported-results.js";

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
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
  }) as Client & { commands: Collection<string, any> };

  client.commands = new Collection();

  const commands = [actions];

  for (const command of commands) {
    client.commands.set(command.data.name, command);
  }

  const events = [interactionCreate, ready, messageCreate, guildCreate, guildMemberAdd, messageReactionAdd];
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
    startGameReminderScheduler(client);
    startSavingsInterestScheduler();
    startGamedayReconciliationScheduler(client);

    setInterval(() => {
      processGamedayReminderTick(client).catch((err) =>
        console.error("[gameday-reminders] tick failed:", err),
      );
    }, 10 * 60 * 1000);

    processGamedayReminderTick(client).catch((err) =>
      console.error("[gameday-reminders] initial tick failed:", err),
    );
  });

  init()
    .then(() => client.login(token))
    .catch((err) => {
      console.error("Failed to initialize:", err);
      process.exit(1);
    });
}
