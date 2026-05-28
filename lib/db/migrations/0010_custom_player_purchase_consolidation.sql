-- Phase 9: Custom player purchase consolidation
-- Adds guild-aware routing to custom player submissions so the custom player
-- builder can be resolved through the same identity/guild partition model used
-- by purchases, inventory, and season stats.

ALTER TABLE custom_players
  ADD COLUMN IF NOT EXISTS guild_id text;

UPDATE custom_players cp
SET guild_id = COALESCE(s.guild_id, eu.guild_id, '1476251181524189438')
FROM seasons s
LEFT JOIN economy_users eu
  ON eu.discord_id = cp.discord_id
 AND (eu.guild_id = s.guild_id OR eu.guild_id IS NOT NULL)
WHERE cp.guild_id IS NULL
  AND cp.season_id = s.id;

UPDATE custom_players
SET guild_id = '1476251181524189438'
WHERE guild_id IS NULL;

ALTER TABLE custom_players
  ALTER COLUMN guild_id SET DEFAULT '1476251181524189438',
  ALTER COLUMN guild_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS custom_players_guild_season_user_idx
  ON custom_players (guild_id, season_id, discord_id);

CREATE INDEX IF NOT EXISTS custom_players_guild_status_idx
  ON custom_players (guild_id, status);

CREATE INDEX IF NOT EXISTS custom_players_guild_team_status_idx
  ON custom_players (guild_id, team_name, status);
