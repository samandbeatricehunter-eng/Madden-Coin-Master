-- 0006_guild_routing_and_operational_consolidation.sql
-- Non-destructive consolidation layer for guild-scoped routing, feature config,
-- matchup reconciliation, and audit logging.
-- This intentionally does NOT create physical per-guild stat tables. All data
-- remains shared and partitioned by guild_id / season_id / week_index.

BEGIN;

-- Central place to store guild-specific Discord routing information.
-- Examples: commissioner office channel, game category, announcements channel,
-- GOTW channel, role IDs, dashboard message IDs, etc.
CREATE TABLE IF NOT EXISTS guild_discord_routes (
  id serial PRIMARY KEY,
  guild_id text NOT NULL,
  route_key text NOT NULL,
  channel_id text,
  category_id text,
  role_id text,
  message_id text,
  label text,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_discord_routes_unique UNIQUE (guild_id, route_key)
);

CREATE INDEX IF NOT EXISTS guild_discord_routes_lookup_idx
  ON guild_discord_routes(guild_id, route_key, enabled);

-- Generic guild feature state/config table. This lets future work gradually move
-- scattered booleans and feature-specific settings out of wide tables without
-- breaking existing server_settings reads.
CREATE TABLE IF NOT EXISTS guild_feature_config (
  id serial PRIMARY KEY,
  guild_id text NOT NULL,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'consolidated-rebuild',
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_feature_config_unique UNIQUE (guild_id, feature_key)
);

CREATE INDEX IF NOT EXISTS guild_feature_config_enabled_idx
  ON guild_feature_config(guild_id, enabled, feature_key);

-- Bridge table between imported MCA schedule rows and Discord gameday rows.
-- This avoids stuffing reconciliation-specific state into either source table.
CREATE TABLE IF NOT EXISTS guild_franchise_game_links (
  id serial PRIMARY KEY,
  guild_id text NOT NULL,
  season_id integer NOT NULL,
  week_index integer NOT NULL,
  matchup_key text NOT NULL,
  franchise_schedule_id bigint,
  game_schedule_id integer,
  away_team_id integer,
  home_team_id integer,
  away_discord_id text,
  home_discord_id text,
  source text NOT NULL DEFAULT 'sync',
  sync_status text NOT NULL DEFAULT 'pending',
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_franchise_game_links_unique UNIQUE (guild_id, season_id, week_index, matchup_key)
);

CREATE INDEX IF NOT EXISTS guild_franchise_game_links_game_schedule_idx
  ON guild_franchise_game_links(game_schedule_id)
  WHERE game_schedule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS guild_franchise_game_links_franchise_schedule_idx
  ON guild_franchise_game_links(franchise_schedule_id)
  WHERE franchise_schedule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS guild_franchise_game_links_active_idx
  ON guild_franchise_game_links(guild_id, season_id, week_index, sync_status);

-- Shared audit/event log for commissioner decisions, economy changes, imports,
-- game lifecycle changes, scheduling escalations, and automated reconciliation.
CREATE TABLE IF NOT EXISTS guild_operational_events (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  event_type text NOT NULL,
  actor_discord_id text,
  target_discord_id text,
  season_id integer,
  week_index integer,
  entity_type text,
  entity_id text,
  correlation_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guild_operational_events_recent_idx
  ON guild_operational_events(guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS guild_operational_events_entity_idx
  ON guild_operational_events(guild_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS guild_operational_events_type_idx
  ON guild_operational_events(guild_id, event_type, created_at DESC);

-- Backfill feature rows from the existing wide server_settings table.
INSERT INTO guild_feature_config (guild_id, feature_key, enabled, config, source, updated_at)
SELECT guild_id, 'coin_economy', coin_economy, '{}'::jsonb, 'server_settings-backfill', now()
FROM server_settings
WHERE guild_id IS NOT NULL
ON CONFLICT (guild_id, feature_key) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO guild_feature_config (guild_id, feature_key, enabled, config, source, updated_at)
SELECT guild_id, 'legends', legends_enabled, '{}'::jsonb, 'server_settings-backfill', now()
FROM server_settings
WHERE guild_id IS NOT NULL
ON CONFLICT (guild_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, source = EXCLUDED.source, updated_at = now();

INSERT INTO guild_feature_config (guild_id, feature_key, enabled, config, source, updated_at)
SELECT guild_id, 'custom_players', custom_superstars_enabled, '{}'::jsonb, 'server_settings-backfill', now()
FROM server_settings
WHERE guild_id IS NOT NULL
ON CONFLICT (guild_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, source = EXCLUDED.source, updated_at = now();

INSERT INTO guild_feature_config (guild_id, feature_key, enabled, config, source, updated_at)
SELECT guild_id, 'mca_import', mca_import_enabled, '{}'::jsonb, 'server_settings-backfill', now()
FROM server_settings
WHERE guild_id IS NOT NULL
ON CONFLICT (guild_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, source = EXCLUDED.source, updated_at = now();

INSERT INTO guild_feature_config (guild_id, feature_key, enabled, config, source, updated_at)
SELECT guild_id, 'wager', wager_enabled, '{}'::jsonb, 'server_settings-backfill', now()
FROM server_settings
WHERE guild_id IS NOT NULL
ON CONFLICT (guild_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, source = EXCLUDED.source, updated_at = now();

-- Read views used by the routing/services layer.
CREATE OR REPLACE VIEW v_guild_feature_state AS
SELECT
  gfc.guild_id,
  gfc.feature_key,
  gfc.enabled,
  gfc.config,
  gfc.updated_at
FROM guild_feature_config gfc;

CREATE OR REPLACE VIEW v_guild_game_context AS
SELECT
  l.guild_id,
  l.season_id,
  l.week_index,
  l.matchup_key,
  l.game_schedule_id,
  gs.channel_id,
  gs.status AS discord_status,
  gs.scheduled_at,
  gs.started_at,
  gs.finished_at,
  gs.winner_discord_id,
  gs.imported_winner_discord_id,
  l.franchise_schedule_id,
  fs.status AS imported_status,
  fs.away_score AS imported_away_score,
  fs.home_score AS imported_home_score,
  l.away_team_id,
  l.home_team_id,
  COALESCE(l.away_discord_id, gs.away_discord_id) AS away_discord_id,
  COALESCE(l.home_discord_id, gs.home_discord_id) AS home_discord_id,
  COALESCE(gs.away_team_name, fs.away_team_name) AS away_team_name,
  COALESCE(gs.home_team_name, fs.home_team_name) AS home_team_name,
  l.sync_status,
  l.last_synced_at,
  l.updated_at
FROM guild_franchise_game_links l
LEFT JOIN game_schedules gs ON gs.id = l.game_schedule_id
LEFT JOIN franchise_schedule fs ON fs.id = l.franchise_schedule_id;

COMMIT;
