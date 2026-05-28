-- 0005_identity_and_guild_franchise_consolidation.sql
-- Non-destructive identity normalization layer.
-- Purpose: one global Discord identity table, one guild membership table, and
-- one logical guild/franchise/team ownership table keyed by guild_id + season_id.
-- Do NOT create physical per-guild stat tables; keep guild_id/season_id indexed
-- columns so every guild is logically partitioned while the schema stays maintainable.

BEGIN;

CREATE TABLE IF NOT EXISTS discord_users (
  discord_id text PRIMARY KEY,
  username text,
  global_name text,
  avatar_url text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_memberships (
  id serial PRIMARY KEY,
  guild_id text NOT NULL,
  discord_id text NOT NULL REFERENCES discord_users(discord_id) ON DELETE CASCADE,
  display_name text,
  server_nickname text,
  is_admin boolean NOT NULL DEFAULT false,
  is_commissioner boolean NOT NULL DEFAULT false,
  joined_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_memberships_guild_discord_unique UNIQUE (guild_id, discord_id)
);

CREATE INDEX IF NOT EXISTS guild_memberships_discord_idx
  ON guild_memberships(discord_id);

CREATE TABLE IF NOT EXISTS guild_franchises (
  id serial PRIMARY KEY,
  guild_id text NOT NULL,
  season_id integer NOT NULL,
  ea_league_id integer,
  league_name text,
  current_week text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_franchises_guild_season_unique UNIQUE (guild_id, season_id)
);

CREATE INDEX IF NOT EXISTS guild_franchises_active_idx
  ON guild_franchises(guild_id, is_active, season_id DESC);

CREATE TABLE IF NOT EXISTS guild_franchise_user_teams (
  id serial PRIMARY KEY,
  guild_id text NOT NULL,
  season_id integer NOT NULL,
  team_id integer,
  team_name text NOT NULL,
  discord_id text REFERENCES discord_users(discord_id) ON DELETE SET NULL,
  ea_user_name text,
  is_human boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'sync',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_franchise_user_teams_team_unique UNIQUE (guild_id, season_id, team_name)
);

CREATE INDEX IF NOT EXISTS guild_franchise_user_teams_discord_idx
  ON guild_franchise_user_teams(guild_id, season_id, discord_id)
  WHERE discord_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS guild_franchise_user_teams_team_id_idx
  ON guild_franchise_user_teams(guild_id, season_id, team_id)
  WHERE team_id IS NOT NULL;

-- Keep current tables fast while the code is gradually moved onto the identity layer.
CREATE INDEX IF NOT EXISTS economy_users_guild_discord_lookup_idx
  ON economy_users(guild_id, discord_id);

CREATE INDEX IF NOT EXISTS economy_users_guild_team_lookup_idx
  ON economy_users(guild_id, lower(team))
  WHERE team IS NOT NULL;

CREATE INDEX IF NOT EXISTS franchise_mca_teams_season_discord_idx
  ON franchise_mca_teams(season_id, discord_id)
  WHERE discord_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS franchise_mca_teams_season_team_idx
  ON franchise_mca_teams(season_id, team_id);

CREATE INDEX IF NOT EXISTS franchise_schedule_season_week_status_idx
  ON franchise_schedule(season_id, week_index, status);

CREATE INDEX IF NOT EXISTS game_schedules_guild_season_week_idx
  ON game_schedules(guild_id, season_id, week_index, status);

-- Phase 2/3 escalation fields are repeated defensively so this script can be run
-- after the original repo or after any earlier consolidation ZIP.
ALTER TABLE game_schedules
  ADD COLUMN IF NOT EXISTS escalation_eligible_at timestamptz,
  ADD COLUMN IF NOT EXISTS response_warning_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS force_win_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS imported_result_synced_at timestamptz;

-- Backfill global Discord users from the legacy per-guild economy table.
INSERT INTO discord_users (discord_id, username, first_seen_at, last_seen_at, updated_at)
SELECT discord_id, max(discord_username), now(), now(), now()
FROM economy_users
WHERE discord_id IS NOT NULL AND discord_id <> ''
GROUP BY discord_id
ON CONFLICT (discord_id) DO UPDATE SET
  username = COALESCE(discord_users.username, EXCLUDED.username),
  last_seen_at = now(),
  updated_at = now();

-- Backfill guild memberships from economy users.
INSERT INTO guild_memberships (guild_id, discord_id, display_name, server_nickname, is_admin, first_seen_at, last_seen_at, updated_at)
SELECT
  guild_id,
  discord_id,
  max(discord_username),
  max(server_nickname),
  bool_or(COALESCE(is_admin, false)),
  now(), now(), now()
FROM economy_users
WHERE guild_id IS NOT NULL AND guild_id <> ''
  AND discord_id IS NOT NULL AND discord_id <> ''
GROUP BY guild_id, discord_id
ON CONFLICT (guild_id, discord_id) DO UPDATE SET
  display_name = COALESCE(guild_memberships.display_name, EXCLUDED.display_name),
  server_nickname = COALESCE(guild_memberships.server_nickname, EXCLUDED.server_nickname),
  is_admin = guild_memberships.is_admin OR EXCLUDED.is_admin,
  last_seen_at = now(),
  updated_at = now();

-- Backfill known guild franchises from seasons.
INSERT INTO guild_franchises (guild_id, season_id, current_week, is_active, created_at, updated_at)
SELECT guild_id, id::int, current_week, is_active, now(), now()
FROM seasons
WHERE guild_id IS NOT NULL AND guild_id <> ''
ON CONFLICT (guild_id, season_id) DO UPDATE SET
  current_week = COALESCE(EXCLUDED.current_week, guild_franchises.current_week),
  is_active = EXCLUDED.is_active,
  updated_at = now();

-- Backfill team ownership from franchise_mca_teams where Discord IDs are present.
INSERT INTO guild_franchise_user_teams (
  guild_id, season_id, team_id, team_name, discord_id, ea_user_name, is_human, source,
  first_seen_at, last_seen_at, updated_at
)
SELECT
  COALESCE(eu.guild_id, s.guild_id, '1476251181524189438') AS guild_id,
  fmt.season_id::int AS season_id,
  fmt.team_id::int AS team_id,
  fmt.full_name AS team_name,
  NULLIF(COALESCE(fmt.discord_id, eu.discord_id), '') AS discord_id,
  fmt.user_name AS ea_user_name,
  COALESCE(fmt.is_human, false) AS is_human,
  'legacy-backfill' AS source,
  now(), now(), now()
FROM franchise_mca_teams fmt
LEFT JOIN economy_users eu
  ON lower(eu.team) = lower(fmt.full_name)
LEFT JOIN seasons s
  ON s.id = fmt.season_id
WHERE fmt.full_name IS NOT NULL AND fmt.full_name <> ''
ON CONFLICT (guild_id, season_id, team_name) DO UPDATE SET
  team_id = COALESCE(EXCLUDED.team_id, guild_franchise_user_teams.team_id),
  discord_id = COALESCE(EXCLUDED.discord_id, guild_franchise_user_teams.discord_id),
  ea_user_name = COALESCE(EXCLUDED.ea_user_name, guild_franchise_user_teams.ea_user_name),
  is_human = EXCLUDED.is_human,
  source = EXCLUDED.source,
  last_seen_at = now(),
  updated_at = now();

-- Compatibility views for read-side migration.
CREATE OR REPLACE VIEW v_guild_user_identity AS
SELECT
  gm.guild_id,
  du.discord_id,
  COALESCE(gm.display_name, gm.server_nickname, du.global_name, du.username) AS display_name,
  gm.server_nickname,
  du.username,
  du.global_name,
  gm.is_admin,
  gm.is_commissioner,
  eu.balance,
  eu.team,
  eu.ea_id,
  eu.all_time_h2h_wins,
  eu.all_time_h2h_losses,
  eu.all_time_superbowl_wins,
  eu.all_time_superbowl_losses
FROM guild_memberships gm
JOIN discord_users du ON du.discord_id = gm.discord_id
LEFT JOIN economy_users eu
  ON eu.guild_id = gm.guild_id
 AND eu.discord_id = gm.discord_id;

CREATE OR REPLACE VIEW v_guild_franchise_owners AS
SELECT
  gfut.guild_id,
  gfut.season_id,
  gfut.team_id,
  gfut.team_name,
  gfut.discord_id,
  COALESCE(gm.display_name, gm.server_nickname, du.global_name, du.username, gfut.ea_user_name) AS owner_display_name,
  gfut.ea_user_name,
  gfut.is_human,
  gfut.source,
  gfut.updated_at
FROM guild_franchise_user_teams gfut
LEFT JOIN discord_users du ON du.discord_id = gfut.discord_id
LEFT JOIN guild_memberships gm
  ON gm.guild_id = gfut.guild_id
 AND gm.discord_id = gfut.discord_id;

COMMIT;
