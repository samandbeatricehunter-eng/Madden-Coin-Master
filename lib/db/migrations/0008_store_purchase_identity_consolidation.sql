-- Phase 7: Store / purchase identity consolidation
-- Purpose:
--   Preserve existing purchase, inventory, and season-stat behavior while making guild routing explicit.
--   Before this migration, these tables were usually scoped by season_id indirectly. That works, but it
--   makes multi-server routing harder and forces repeated joins against seasons. This migration adds
--   guild_id directly as a denormalized routing key and backfills it from seasons.

BEGIN;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS guild_id text;

UPDATE purchases p
SET guild_id = s.guild_id
FROM seasons s
WHERE p.season_id = s.id
  AND (p.guild_id IS NULL OR p.guild_id = '');

UPDATE purchases
SET guild_id = '1476251181524189438'
WHERE guild_id IS NULL OR guild_id = '';

ALTER TABLE purchases
  ALTER COLUMN guild_id SET DEFAULT '1476251181524189438',
  ALTER COLUMN guild_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS purchases_guild_season_status_idx
  ON purchases (guild_id, season_id, status);

CREATE INDEX IF NOT EXISTS purchases_guild_user_season_idx
  ON purchases (guild_id, discord_id, season_id);

CREATE INDEX IF NOT EXISTS purchases_guild_type_status_idx
  ON purchases (guild_id, purchase_type, status);


ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS guild_id text;

UPDATE inventory i
SET guild_id = s.guild_id
FROM seasons s
WHERE i.season_id = s.id
  AND (i.guild_id IS NULL OR i.guild_id = '');

UPDATE inventory
SET guild_id = '1476251181524189438'
WHERE guild_id IS NULL OR guild_id = '';

ALTER TABLE inventory
  ALTER COLUMN guild_id SET DEFAULT '1476251181524189438',
  ALTER COLUMN guild_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_guild_user_season_idx
  ON inventory (guild_id, discord_id, season_id);

CREATE INDEX IF NOT EXISTS inventory_guild_team_season_idx
  ON inventory (guild_id, team, season_id);

CREATE INDEX IF NOT EXISTS inventory_guild_purchase_idx
  ON inventory (guild_id, purchase_id);


ALTER TABLE season_stats
  ADD COLUMN IF NOT EXISTS guild_id text;

UPDATE season_stats ss
SET guild_id = s.guild_id
FROM seasons s
WHERE ss.season_id = s.id
  AND (ss.guild_id IS NULL OR ss.guild_id = '');

UPDATE season_stats
SET guild_id = '1476251181524189438'
WHERE guild_id IS NULL OR guild_id = '';

ALTER TABLE season_stats
  ALTER COLUMN guild_id SET DEFAULT '1476251181524189438',
  ALTER COLUMN guild_id SET NOT NULL;

-- Remove duplicate season-stat records before enabling the new unique index. This keeps the newest row.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY guild_id, discord_id, season_id
           ORDER BY id DESC
         ) AS rn
  FROM season_stats
)
DELETE FROM season_stats ss
USING ranked r
WHERE ss.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS season_stats_guild_user_season_idx
  ON season_stats (guild_id, discord_id, season_id);

COMMIT;
