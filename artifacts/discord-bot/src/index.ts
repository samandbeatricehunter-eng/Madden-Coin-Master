import { Client, Collection, GatewayIntentBits, Partials } from "discord.js";
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
import { handleReactionPanelAdd, shouldHandleGamedayReaction, startGamedayPanelSyncScheduler } from "./lib/gameday/reaction-panels/service.js";

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
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
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
      client.once(event.name, (...args) => (event as any).execute(...args));
    } else {
      client.on(event.name, (...args) => (event as any).execute(...args));
    }
  }

  client.on("raw", async (packet: any) => {
    if (packet?.t !== "MESSAGE_REACTION_ADD") return;
    const data = packet.d;
    const emojiName = data?.emoji?.name ?? "";
    if (!data?.message_id || !data?.user_id || !shouldHandleGamedayReaction(data.message_id, data.user_id, emojiName)) return;
    if (process.env.DEBUG_GAMEDAY_REACTIONS === "true" || process.env.DEBUG_GAMEDAY_REACTIONS === "1") {
      console.log("[discord-raw] MESSAGE_REACTION_ADD", {
        guildId: data?.guild_id ?? null,
        channelId: data?.channel_id ?? null,
        messageId: data?.message_id ?? null,
        userId: data?.user_id ?? null,
        emoji: emojiName,
      });
    }

    try {
      if (!data?.channel_id || !data?.message_id || !data?.user_id) return;
      const channel = await client.channels.fetch(data.channel_id).catch(() => null);
      if (!channel?.isTextBased?.()) return;
      const message = await (channel as any).messages.fetch(data.message_id).catch(() => null);
      if (!message) return;
      const user = await client.users.fetch(data.user_id).catch(() => null);
      if (!user || user.bot) return;
      const reaction = message.reactions.cache.find((r: any) => (r.emoji?.name ?? "") === emojiName)
        ?? await message.reactions.resolve(emojiName)?.fetch().catch(() => null);
      if (!reaction) {
        if (process.env.DEBUG_GAMEDAY_REACTIONS === "true" || process.env.DEBUG_GAMEDAY_REACTIONS === "1") {
          console.log("[discord-raw] reaction object not found", { messageId: data.message_id, userId: data.user_id, emoji: emojiName });
        }
        return;
      }
      await handleReactionPanelAdd(reaction as any, user as any).catch((err) => console.error("[discord-raw] reaction bridge failed:", err));
    } catch (err: any) {
      console.error("[discord-raw] MESSAGE_REACTION_ADD bridge error:", err?.message ?? err);
    }
  });

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
