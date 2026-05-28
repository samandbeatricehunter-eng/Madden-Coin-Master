-- 0007_menu_action_routing_preservation.sql
-- Non-destructive support for the Phase 6 preservation audit.
-- Purpose: make member-menu feature ownership visible in the database while the
-- large legacy ac_* handler is decomposed safely.
--
-- This does not remove or rewrite existing economy/purchase/menu tables.

BEGIN;

CREATE TABLE IF NOT EXISTS guild_menu_action_routes (
  id serial PRIMARY KEY,
  guild_id text,
  custom_id_prefix text NOT NULL,
  feature_key text NOT NULL,
  owner_module text NOT NULL,
  preservation_status text NOT NULL DEFAULT 'legacy_adapter',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guild_menu_action_routes_unique UNIQUE (guild_id, custom_id_prefix)
);

CREATE INDEX IF NOT EXISTS guild_menu_action_routes_feature_idx
  ON guild_menu_action_routes(guild_id, feature_key, preservation_status);

-- Global/default route map. Guild-specific overrides may be added later by using
-- a non-null guild_id with the same custom_id_prefix.
INSERT INTO guild_menu_action_routes (guild_id, custom_id_prefix, feature_key, owner_module, preservation_status, notes)
VALUES
  (NULL, 'ac_hub', 'menu_core', 'menu/actions/actions-router', 'legacy_adapter', 'Hub restore and top-level menu navigation.'),
  (NULL, 'ac_close', 'menu_core', 'menu/actions/actions-router', 'legacy_adapter', 'Hub close action.'),
  (NULL, 'ac_profile', 'profile', 'menu/actions/actions-router', 'legacy_adapter', 'Profile page navigation.'),
  (NULL, 'ac_myprofile', 'profile', 'menu/actions/actions-router', 'legacy_adapter', 'Current user profile entrypoint.'),
  (NULL, 'ac_purchase', 'store_purchases', 'menu/actions/actions-router', 'legacy_adapter', 'Store entrypoint.'),
  (NULL, 'ac_buy_', 'store_purchases', 'menu/actions/actions-router', 'legacy_adapter', 'Purchase subflows: legends, custom players, upgrades, training, contract modifiers.'),
  (NULL, 'ac_ht_', 'store_purchases', 'menu/actions/actions-router', 'legacy_adapter', 'Hire trainer subflow.'),
  (NULL, 'ac_coins', 'wallet_wagers', 'menu/actions/actions-router', 'legacy_adapter', 'Wallet display.'),
  (NULL, 'ac_send_coins', 'wallet_wagers', 'menu/actions/actions-router', 'legacy_adapter', 'Send coins.'),
  (NULL, 'ac_transfer', 'wallet_wagers', 'menu/actions/actions-router', 'legacy_adapter', 'Bank/savings transfer flow.'),
  (NULL, 'ac_wager', 'wallet_wagers', 'menu/actions/actions-router', 'legacy_adapter', 'Wager flow.'),
  (NULL, 'ac_myroster', 'rosters_cap', 'menu/actions/actions-router', 'legacy_adapter', 'Own roster.'),
  (NULL, 'ac_anyroster', 'rosters_cap', 'menu/actions/actions-router', 'legacy_adapter', 'Any roster viewer.'),
  (NULL, 'ac_allplayers', 'rosters_cap', 'menu/actions/actions-router', 'legacy_adapter', 'All players viewer.'),
  (NULL, 'ac_freeagents', 'rosters_cap', 'menu/actions/actions-router', 'legacy_adapter', 'Free-agent viewer.'),
  (NULL, 'ac_fa_', 'rosters_cap', 'menu/actions/actions-router', 'legacy_adapter', 'Free-agent filters/cards.'),
  (NULL, 'ac_ap_', 'rosters_cap', 'menu/actions/actions-router', 'legacy_adapter', 'All-player filters/cards.'),
  (NULL, 'ac_rc_', 'rosters_cap', 'menu/actions/actions-router', 'legacy_adapter', 'Roster-card filters/cards.'),
  (NULL, 'ac_cap_', 'rosters_cap', 'menu/actions/actions-router', 'legacy_adapter', 'Cap manager and potential free agent flows.'),
  (NULL, 'ac_schedule', 'league_info', 'menu/actions/actions-router', 'legacy_adapter', 'League schedule entrypoint.'),
  (NULL, 'ac_standings', 'league_info', 'menu/actions/actions-router', 'legacy_adapter', 'Standings entrypoint.'),
  (NULL, 'ac_rules', 'league_info', 'menu/actions/actions-router', 'legacy_adapter', 'Rules entrypoint and pages.'),
  (NULL, 'ac_req_', 'requests_rules_social', 'menu/actions/actions-router', 'legacy_adapter', 'Open-team/waitlist request flows.'),
  (NULL, 'ac_globalpr', 'rankings_awards', 'menu/actions/actions-router', 'legacy_adapter', 'Global power rankings.'),
  (NULL, 'ac_seasonpr', 'rankings_awards', 'menu/actions/actions-router', 'legacy_adapter', 'Season power rankings.'),
  (NULL, 'ac_alltimepr', 'rankings_awards', 'menu/actions/actions-router', 'legacy_adapter', 'All-time power rankings.'),
  (NULL, 'ac_gotw', 'rankings_awards', 'menu/actions/actions-router', 'legacy_adapter', 'GOTW voting entrypoint.'),
  (NULL, 'ac_goty', 'rankings_awards', 'menu/actions/actions-router', 'legacy_adapter', 'GOTY voting entrypoint.'),
  (NULL, 'ac_press', 'requests_rules_social', 'menu/actions/actions-router', 'legacy_adapter', 'Press/interview entrypoint.'),
  (NULL, 'ac_interview', 'requests_rules_social', 'menu/actions/actions-router', 'legacy_adapter', 'Legacy press/interview entrypoint.'),
  (NULL, 'ac_rivalries', 'requests_rules_social', 'menu/actions/actions-router', 'legacy_adapter', 'Rivalries entrypoint.'),
  (NULL, 'ac_violation', 'requests_rules_social', 'menu/actions/actions-router', 'legacy_adapter', 'Violation report flow.')
ON CONFLICT (guild_id, custom_id_prefix) DO UPDATE SET
  feature_key = EXCLUDED.feature_key,
  owner_module = EXCLUDED.owner_module,
  preservation_status = EXCLUDED.preservation_status,
  notes = EXCLUDED.notes,
  updated_at = now();

CREATE OR REPLACE VIEW v_guild_menu_action_route_map AS
SELECT
  COALESCE(guild_id, 'GLOBAL') AS route_scope,
  custom_id_prefix,
  feature_key,
  owner_module,
  preservation_status,
  notes,
  updated_at
FROM guild_menu_action_routes;

COMMIT;
