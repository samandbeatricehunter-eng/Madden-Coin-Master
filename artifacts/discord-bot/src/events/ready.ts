import { Client } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { registerCommandsForGuild } from "../lib/register-commands.js";
import { setGuildChannel, getGuildChannel, KNOWN_GUILD_CHANNELS, CHANNEL_KEYS } from "../lib/db-helpers.js";

export const name = "clientReady";
export const once = true;

// ── One-time startup migration ────────────────────────────────────────────────
// Backfills the `team` column on permanent-vault inventory rows that predate
// the team-stamping feature. Safe to run every startup — it's a no-op once all
// rows are stamped. Matches discord_id → economy_users.team via a single UPDATE.
async function backfillPermanentVaultTeams(): Promise<void> {
  try {
    // Join through seasons so team comes from the same guild the inventory item belongs to.
    // This prevents cross-guild contamination in multi-server setups.
    const result = await db.execute(sql`
      UPDATE inventory
      SET    team = u.team
      FROM   economy_users u
      JOIN   seasons s ON s.id = inventory.season_id AND s.guild_id = u.guild_id
      WHERE  inventory.discord_id      = u.discord_id
        AND  inventory.team            IS NULL
        AND  inventory.legend_category = 'permanent'
        AND  u.team                    IS NOT NULL
        AND  u.team                    != ''
    `);
    const count = (result as { rowCount?: number }).rowCount ?? 0;
    if (count > 0) {
      console.log(`[startup-migration] Stamped team on ${count} permanent-vault item(s).`);
    }
  } catch (err) {
    console.error("[startup-migration] Failed to backfill permanent vault teams:", err);
  }
}

// ── Seed known guild channels ─────────────────────────────────────────────────
// Ensures channel IDs that predate /initialize-server (or were provisioned
// manually) are always present in guild_channels. Runs on every startup but
// is a no-op once the rows exist (upsert with same values).
async function seedKnownGuildChannels(): Promise<void> {
  try {
    for (const [guildId, channels] of Object.entries(KNOWN_GUILD_CHANNELS)) {
      for (const [key, channelId] of Object.entries(channels)) {
        if (channelId) await setGuildChannel(guildId, key, channelId);
      }
    }
    console.log("[startup-migration] Known guild channels seeded.");
  } catch (err) {
    console.error("[startup-migration] Failed to seed known guild channels:", err);
  }
}

// ── Auto-discover channels by name ────────────────────────────────────────────
// For guilds that ran /initialize-server before a channel key was added to the
// CHANNEL_KEY_MAP, scan the guild's channel list and register any that match.
// Only registers keys that aren't already in the DB.
const CHANNEL_NAME_AUTODISCOVER: Array<{ channelName: string; key: string; label: string }> = [
  { channelName: "commissioners-log", key: CHANNEL_KEYS.COMMISSIONER_LOG, label: "commissioners-log" },
  { channelName: "streams",           key: CHANNEL_KEYS.STREAM,           label: "streams"           },
  { channelName: "highlights",        key: CHANNEL_KEYS.HIGHLIGHTS,       label: "highlights"        },
];

async function autoDiscoverChannelsByName(client: Client): Promise<void> {
  try {
    for (const [guildId, guild] of client.guilds.cache) {
      // Fetch full channel list once per guild
      const channels = guild.channels.cache.size > 0
        ? guild.channels.cache
        : await guild.channels.fetch().catch(() => null);
      if (!channels) continue;

      for (const { channelName, key, label } of CHANNEL_NAME_AUTODISCOVER) {
        const existing = await getGuildChannel(guildId, key);
        if (existing) continue; // already registered

        const found = [...channels.values()].find(
          (c): c is NonNullable<typeof c> =>
            c !== null && c.name === channelName && c.isTextBased(),
        );
        if (found) {
          await setGuildChannel(guildId, key, found.id);
          console.log(`[startup-migration] Registered ${label} for guild ${guildId}: ${found.id}`);
        }
      }
    }
  } catch (err) {
    console.error("[startup-migration] Failed to auto-discover channels by name:", err);
  }
}

export async function execute(client: Client) {
  console.log(`✅ Bot logged in as ${client.user?.tag}`);

  // Run data migrations before serving any interactions
  await backfillPermanentVaultTeams();
  await seedKnownGuildChannels();
  await autoDiscoverChannelsByName(client);

  const guilds = client.guilds.cache;
  if (guilds.size === 0) return;

  console.log(`🔄 Registering slash commands for ${guilds.size} guild(s) on startup...`);

  for (const [guildId, guild] of guilds) {
    try {
      await registerCommandsForGuild(guildId);
      console.log(`✅ Commands registered: ${guild.name} (${guildId})`);
    } catch (err) {
      console.error(`❌ Failed to register commands for guild ${guildId}:`, err);
    }
  }
}
