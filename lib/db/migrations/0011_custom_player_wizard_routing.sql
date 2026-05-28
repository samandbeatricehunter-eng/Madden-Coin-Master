-- Phase 10: Custom Player wizard routing + optional durable session state.
-- The bot continues to preserve the existing in-memory ccp_* wizard behavior, but this
-- table gives the consolidated architecture a central location to persist/recover
-- wizard state in a later worker-safe phase.

CREATE TABLE IF NOT EXISTS custom_player_wizard_sessions (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  session_id text NOT NULL,
  discord_id text NOT NULL,
  season_id bigint,
  status text NOT NULL DEFAULT 'active',
  step integer NOT NULL DEFAULT 0,
  selected_position text,
  selected_archetype_id bigint,
  selected_archetype_name text,
  package_tier text,
  dev_trait text,
  state json NOT NULL DEFAULT '{}'::json,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  submitted_custom_player_id bigint REFERENCES custom_players(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_player_wizard_sessions_session_idx
  ON custom_player_wizard_sessions (guild_id, session_id);

CREATE INDEX IF NOT EXISTS custom_player_wizard_sessions_user_active_idx
  ON custom_player_wizard_sessions (guild_id, discord_id, status, expires_at);

CREATE INDEX IF NOT EXISTS custom_player_wizard_sessions_cleanup_idx
  ON custom_player_wizard_sessions (status, expires_at);
