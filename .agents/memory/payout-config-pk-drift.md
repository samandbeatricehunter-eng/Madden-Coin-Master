---
name: payout_config PK drift
description: payout_config table PK is on `key` alone, not (guild_id, key), so values are effectively shared across guilds despite Drizzle code suggesting per-guild scoping.
---

# `payout_config.payout_config_pkey` is `PRIMARY KEY (key)` only

**Why this matters:** `setPayoutValue()` in `payout-config.ts` writes with `onConflictDoUpdate({ target: [guildId, key], ... })`, implying per-guild values. The live Supabase table has PK on `key` only, so any insert/upsert for the same key from a different guild collides on `payout_config_pkey`. In practice the table holds ONE row per key, shared across all guilds, no matter what the code says.

**How to apply:**
- When writing scripts that hit `payout_config`, use `ON CONFLICT (key)` not `(guild_id, key)`.
- When changing DEFAULTS in `payout-config.ts`, also upsert the matching `payout_config` rows in the DB so any existing override row gets refreshed — otherwise the stale DB row will mask the new default for every guild.
- If true per-guild payout values are ever needed, the fix is to drop the existing PK and add `PRIMARY KEY (guild_id, key)`, then re-seed; do not just trust the Drizzle code to handle it.
