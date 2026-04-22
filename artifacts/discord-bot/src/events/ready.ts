import { Client } from "discord.js";
import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
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

// ── Sync Commissioner Discord role → DB isAdmin ───────────────────────────────
// Runs every startup. For each guild, any member with the "Commissioner" Discord
// role is guaranteed isAdmin=true in the DB, and their nickname is normalized to
// strip the legacy "(Co-Commissioner)" tag and ensure "(Commissioner)" suffix.
// This is the idempotent recovery path for guilds where the role-migration ran
// but DB/nickname updates were missed (e.g., due to member-cache misses).
async function syncCommissionerRoleWithDb(client: Client): Promise<void> {
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await guild.members.fetch().catch(() => null);
      await guild.roles.fetch().catch(() => null);

      const commRole = guild.roles.cache.find(r => r.name === "Commissioner");
      if (!commRole) continue;

      for (const [memberId, member] of commRole.members) {
        await db.update(usersTable)
          .set({ isAdmin: true, updatedAt: new Date() })
          .where(and(eq(usersTable.discordId, memberId), eq(usersTable.guildId, guildId)))
          .catch(() => null);

        const rawNick = member.displayName;
        const stripped = rawNick
          .replace(/\s*\(Co-Commissioner\)\s*/gi, "")
          .replace(/\s*\(Commissioner\)\s*/gi, "")
          .trim();
        const cleanNick = `${stripped} (Commissioner)`.slice(0, 32);
        if (rawNick !== cleanNick) {
          await member.setNickname(cleanNick, "Sync: Commissioner role — nickname normalization").catch(() => null);
          console.log(`[comm-sync] ${guild.name}: ${rawNick} → ${cleanNick}`);
        }
      }
    } catch (err) {
      console.error(`[comm-sync] Failed for guild ${guildId}:`, err);
    }
  }
}

// ── Co-Commissioner → Commissioner migration ───────────────────────────────────
// Runs once per startup. Finds all "Co-Commissioner" role holders in every
// guild, converts up to 3 of them to "Commissioner" (owner is always #1 = 4 max
// total), then deletes the "Co-Commissioner" role from the guild entirely.
// Safe to re-run — guilds without a Co-Commissioner role are skipped.
const COMMISSIONER_CAP = 4;

async function migrateCoCommissioners(client: Client): Promise<void> {
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await guild.members.fetch().catch(() => null);
      await guild.roles.fetch().catch(() => null);

      const coCommRole = guild.roles.cache.find(r => r.name === "Co-Commissioner");
      if (!coCommRole) continue;

      const commRole = guild.roles.cache.find(r => r.name === "Commissioner");
      if (!commRole) {
        console.log(`[co-comm-migration] ${guild.name}: No Commissioner role — skipping (run /admin-initialize first).`);
        continue;
      }

      const ownerId = guild.ownerId;

      // Ensure owner has Commissioner role + isAdmin=true
      const owner = await guild.members.fetch(ownerId).catch(() => null);
      if (owner) {
        if (!owner.roles.cache.has(commRole.id)) {
          await owner.roles.add(commRole, "Migration: owner is primary commissioner").catch(console.error);
        }
        await db.update(usersTable)
          .set({ isAdmin: true, updatedAt: new Date() })
          .where(and(eq(usersTable.discordId, ownerId), eq(usersTable.guildId, guildId)))
          .catch(() => null);
      }

      // Sort non-owner co-comm members alphabetically by display name
      const coCommMembers = [...coCommRole.members.values()]
        .filter(m => m.id !== ownerId)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

      const toMigrate = coCommMembers.slice(0, COMMISSIONER_CAP - 1);

      for (const member of toMigrate) {
        await member.roles.remove(coCommRole, "Migration: Co-Commissioner → Commissioner").catch(console.error);
        await member.roles.add(commRole, "Migration: Co-Commissioner → Commissioner").catch(console.error);

        await db.update(usersTable)
          .set({ isAdmin: true, updatedAt: new Date() })
          .where(and(eq(usersTable.discordId, member.id), eq(usersTable.guildId, guildId)))
          .catch(() => null);

        // Strip any existing (Co-Commissioner) / (Commissioner) tag before appending clean suffix
        const stripped = member.displayName
          .replace(/\s*\(Co-Commissioner\)\s*/gi, "")
          .replace(/\s*\(Commissioner\)\s*/gi, "")
          .trim();
        const newNick = `${stripped} (Commissioner)`.slice(0, 32);
        await member.setNickname(newNick, "Migration: Co-Commissioner → Commissioner").catch(console.error);

        console.log(`[co-comm-migration] ${guild.name}: Migrated ${member.displayName} → Commissioner (nick: ${newNick})`);
      }

      await coCommRole.delete("Migration: Co-Commissioner role eliminated").catch(err =>
        console.error(`[co-comm-migration] ${guild.name}: Could not delete Co-Commissioner role:`, err),
      );

      console.log(`[co-comm-migration] ${guild.name}: Done. ${toMigrate.length} user(s) migrated. Co-Commissioner role deleted.`);
    } catch (err) {
      console.error(`[co-comm-migration] Failed for guild ${guildId}:`, err);
    }
  }
}

export async function execute(client: Client) {
  console.log(`✅ Bot logged in as ${client.user?.tag}`);

  // Run data migrations before serving any interactions
  await backfillPermanentVaultTeams();
  await seedKnownGuildChannels();
  await autoDiscoverChannelsByName(client);
  await migrateCoCommissioners(client);
  await syncCommissionerRoleWithDb(client);

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
