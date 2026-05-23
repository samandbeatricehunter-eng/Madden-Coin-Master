-- =============================================================================
-- REC League Discord Bot — Full Schema Setup for Supabase
-- Generated from lib/db/src/schema/discord-economy.ts + mca-native.ts
--
-- SAFE TO RUN multiple times (fully idempotent):
--   - Enums:   DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL ...
--   - Tables:  CREATE TABLE IF NOT EXISTS
--   - Indexes: CREATE UNIQUE INDEX IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--
-- HOW TO USE:
--   1. Open your Supabase project → SQL Editor → New Query
--   2. Paste this entire file and click Run
--   3. Check the "Table Editor" tab — all 77 tables should appear
--
-- NOTE: Run with the direct connection (port 5432), not the pooler.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 0: DEDUPLICATION (runs before index creation)
--
-- If you imported data from the old DB before running this script, tables may
-- have duplicate rows that block unique index creation.  This block removes
-- duplicates safely — keeping the row with the lowest id — and is a no-op on
-- tables that do not yet exist.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN

  -- economy_users: unique (discord_id, guild_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='economy_users' AND table_schema='public') THEN
    DELETE FROM economy_users WHERE id NOT IN (
      SELECT MIN(id) FROM economy_users GROUP BY discord_id, guild_id
    );
  END IF;

  -- seasons: unique (guild_id, season_number)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='seasons' AND table_schema='public') THEN
    DELETE FROM seasons WHERE id NOT IN (
      SELECT MIN(id) FROM seasons GROUP BY guild_id, season_number
    );
  END IF;

  -- user_records: unique (discord_id, season_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='user_records' AND table_schema='public') THEN
    DELETE FROM user_records WHERE id NOT IN (
      SELECT MIN(id) FROM user_records GROUP BY discord_id, season_id
    );
  END IF;

  -- h2h_matchup_records: unique (guild_id, discord_id_1, discord_id_2)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='h2h_matchup_records' AND table_schema='public') THEN
    DELETE FROM h2h_matchup_records WHERE id NOT IN (
      SELECT MIN(id) FROM h2h_matchup_records GROUP BY guild_id, discord_id_1, discord_id_2
    );
  END IF;

  -- franchise_game_participants: unique (season_id, week, discord_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='franchise_game_participants' AND table_schema='public') THEN
    DELETE FROM franchise_game_participants WHERE id NOT IN (
      SELECT MIN(id) FROM franchise_game_participants GROUP BY season_id, week, discord_id
    );
  END IF;

  -- franchise_schedule: unique (season_id, week_index, home_team_id, away_team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='franchise_schedule' AND table_schema='public') THEN
    DELETE FROM franchise_schedule WHERE id NOT IN (
      SELECT MIN(id) FROM franchise_schedule GROUP BY season_id, week_index, home_team_id, away_team_id
    );
  END IF;

  -- franchise_rosters: unique (season_id, team_id, player_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='franchise_rosters' AND table_schema='public') THEN
    DELETE FROM franchise_rosters WHERE id NOT IN (
      SELECT MIN(id) FROM franchise_rosters GROUP BY season_id, team_id, player_id
    );
  END IF;

  -- franchise_draft_picks: unique (season_id, team_id, draft_year, round, pick_num)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='franchise_draft_picks' AND table_schema='public') THEN
    DELETE FROM franchise_draft_picks WHERE id NOT IN (
      SELECT MIN(id) FROM franchise_draft_picks GROUP BY season_id, team_id, draft_year, round, pick_num
    );
  END IF;

  -- season_stat_tier_configs: unique (season_id, stat_category, tier)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='season_stat_tier_configs' AND table_schema='public') THEN
    DELETE FROM season_stat_tier_configs WHERE id NOT IN (
      SELECT MIN(id) FROM season_stat_tier_configs GROUP BY season_id, stat_category, tier
    );
  END IF;

  -- team_season_stats: unique (season_id, team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='team_season_stats' AND table_schema='public') THEN
    DELETE FROM team_season_stats WHERE id NOT IN (
      SELECT MIN(id) FROM team_season_stats GROUP BY season_id, team_id
    );
  END IF;

  -- player_season_stats: unique (season_id, player_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='player_season_stats' AND table_schema='public') THEN
    DELETE FROM player_season_stats WHERE id NOT IN (
      SELECT MIN(id) FROM player_season_stats GROUP BY season_id, player_id
    );
  END IF;

  -- player_stat_week_processed: unique (season_id, week_type, week_num, stat_type)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='player_stat_week_processed' AND table_schema='public') THEN
    DELETE FROM player_stat_week_processed WHERE id NOT IN (
      SELECT MIN(id) FROM player_stat_week_processed GROUP BY season_id, week_type, week_num, stat_type
    );
  END IF;

  -- player_week_stats_delta: unique (season_id, week_type, week_num, stat_type, player_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='player_week_stats_delta' AND table_schema='public') THEN
    DELETE FROM player_week_stats_delta WHERE id NOT IN (
      SELECT MIN(id) FROM player_week_stats_delta GROUP BY season_id, week_type, week_num, stat_type, player_id
    );
  END IF;

  -- team_week_stats_delta: unique (season_id, week_type, week_num, team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='team_week_stats_delta' AND table_schema='public') THEN
    DELETE FROM team_week_stats_delta WHERE id NOT IN (
      SELECT MIN(id) FROM team_week_stats_delta GROUP BY season_id, week_type, week_num, team_id
    );
  END IF;

  -- gotw_history: unique (season_id, week_index)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='gotw_history' AND table_schema='public') THEN
    DELETE FROM gotw_history WHERE id NOT IN (
      SELECT MIN(id) FROM gotw_history GROUP BY season_id, week_index
    );
  END IF;

  -- playoff_gotw_polls: unique (season_id, week_index, matchup_index)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='playoff_gotw_polls' AND table_schema='public') THEN
    DELETE FROM playoff_gotw_polls WHERE id NOT IN (
      SELECT MIN(id) FROM playoff_gotw_polls GROUP BY season_id, week_index, matchup_index
    );
  END IF;

  -- draft_presence: unique (session_id, discord_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='draft_presence' AND table_schema='public') THEN
    DELETE FROM draft_presence WHERE id NOT IN (
      SELECT MIN(id) FROM draft_presence GROUP BY session_id, discord_id
    );
  END IF;

  -- franchise_mca_teams: unique (season_id, team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='franchise_mca_teams' AND table_schema='public') THEN
    DELETE FROM franchise_mca_teams WHERE id NOT IN (
      SELECT MIN(id) FROM franchise_mca_teams GROUP BY season_id, team_id
    );
  END IF;

  -- legend_templates: unique (legend_id, model)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='legend_templates' AND table_schema='public') THEN
    DELETE FROM legend_templates WHERE id NOT IN (
      SELECT MIN(id) FROM legend_templates GROUP BY legend_id, model
    );
  END IF;

  -- player_xp_log: unique (season_id, player_id, week_num, week_type)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='player_xp_log' AND table_schema='public') THEN
    DELETE FROM player_xp_log WHERE id NOT IN (
      SELECT MIN(id) FROM player_xp_log GROUP BY season_id, player_id, week_num, week_type
    );
  END IF;

  -- waitlist: unique (guild_id, discord_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='waitlist' AND table_schema='public') THEN
    DELETE FROM waitlist WHERE id NOT IN (
      SELECT MIN(id) FROM waitlist GROUP BY guild_id, discord_id
    );
  END IF;

  -- guild_channels: unique (guild_id, channel_key)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='guild_channels' AND table_schema='public') THEN
    DELETE FROM guild_channels WHERE id NOT IN (
      SELECT MIN(id) FROM guild_channels GROUP BY guild_id, channel_key
    );
  END IF;

  -- player_ea_ids: unique (discord_id, slot)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='player_ea_ids' AND table_schema='public') THEN
    DELETE FROM player_ea_ids WHERE id NOT IN (
      SELECT MIN(id) FROM player_ea_ids GROUP BY discord_id, slot
    );
  END IF;

  -- app_user_league_links: unique (gamertag, ea_league_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='app_user_league_links' AND table_schema='public') THEN
    DELETE FROM app_user_league_links WHERE id NOT IN (
      SELECT MIN(id) FROM app_user_league_links GROUP BY gamertag, ea_league_id
    );
  END IF;

  -- mca_seasons: unique (ea_league_id, season_number)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_seasons' AND table_schema='public') THEN
    DELETE FROM mca_seasons WHERE id NOT IN (
      SELECT MIN(id) FROM mca_seasons GROUP BY ea_league_id, season_number
    );
  END IF;

  -- mca_teams: unique (ea_season_id, team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_teams' AND table_schema='public') THEN
    DELETE FROM mca_teams WHERE id NOT IN (
      SELECT MIN(id) FROM mca_teams GROUP BY ea_season_id, team_id
    );
  END IF;

  -- mca_rosters: unique (ea_season_id, team_id, player_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_rosters' AND table_schema='public') THEN
    DELETE FROM mca_rosters WHERE id NOT IN (
      SELECT MIN(id) FROM mca_rosters GROUP BY ea_season_id, team_id, player_id
    );
  END IF;

  -- mca_team_stats: unique (ea_season_id, team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_team_stats' AND table_schema='public') THEN
    DELETE FROM mca_team_stats WHERE id NOT IN (
      SELECT MIN(id) FROM mca_team_stats GROUP BY ea_season_id, team_id
    );
  END IF;

  -- mca_team_week_stats: unique (ea_season_id, week_type, week_num, team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_team_week_stats' AND table_schema='public') THEN
    DELETE FROM mca_team_week_stats WHERE id NOT IN (
      SELECT MIN(id) FROM mca_team_week_stats GROUP BY ea_season_id, week_type, week_num, team_id
    );
  END IF;

  -- mca_schedules: unique (ea_season_id, week_index, home_team_id, away_team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_schedules' AND table_schema='public') THEN
    DELETE FROM mca_schedules WHERE id NOT IN (
      SELECT MIN(id) FROM mca_schedules GROUP BY ea_season_id, week_index, home_team_id, away_team_id
    );
  END IF;

  -- mca_player_stats: unique (ea_season_id, player_id, team_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_player_stats' AND table_schema='public') THEN
    DELETE FROM mca_player_stats WHERE id NOT IN (
      SELECT MIN(id) FROM mca_player_stats GROUP BY ea_season_id, player_id, team_id
    );
  END IF;

  -- mca_player_week_stats: unique (ea_season_id, week_type, week_num, stat_type, player_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_player_week_stats' AND table_schema='public') THEN
    DELETE FROM mca_player_week_stats WHERE id NOT IN (
      SELECT MIN(id) FROM mca_player_week_stats GROUP BY ea_season_id, week_type, week_num, stat_type, player_id
    );
  END IF;

  -- mca_week_processed: unique (ea_season_id, week_type, week_num, stat_type)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_week_processed' AND table_schema='public') THEN
    DELETE FROM mca_week_processed WHERE id NOT IN (
      SELECT MIN(id) FROM mca_week_processed GROUP BY ea_season_id, week_type, week_num, stat_type
    );
  END IF;

  -- mca_draft_picks: unique (ea_season_id, team_id, draft_year, round, pick_num)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mca_draft_picks' AND table_schema='public') THEN
    DELETE FROM mca_draft_picks WHERE id NOT IN (
      SELECT MIN(id) FROM mca_draft_picks GROUP BY ea_season_id, team_id, draft_year, round, pick_num
    );
  END IF;

END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1: ENUM TYPES
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE purchase_type AS ENUM (
    'legend','attribute','dev_up','age_reset',
    'custom_player_gold','custom_player_silver','custom_player_bronze',
    'contract_extension','salary_reduction','bonus_reduction',
    'training_gold','training_silver','training_bronze'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE purchase_status AS ENUM ('pending','approved','refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE custom_player_tier AS ENUM ('gold','silver','bronze');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE game_type AS ENUM ('regular_season','playoff','superbowl');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tx_type AS ENUM (
    'purchase','purchase_refund','addcoins','removecoins',
    'sendcoins_sent','sendcoins_received','season_adjustment','setbalance',
    'savings_deposit','savings_withdraw','savings_interest'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2: DISCORD ECONOMY TABLES
-- ─────────────────────────────────────────────────────────────────────────────

-- economy_users
CREATE TABLE IF NOT EXISTS economy_users (
  id                        SERIAL PRIMARY KEY,
  discord_id                TEXT NOT NULL,
  guild_id                  TEXT NOT NULL DEFAULT '1476251181524189438',
  discord_username          TEXT NOT NULL,
  team                      TEXT,
  server_nickname           TEXT,
  balance                   INTEGER NOT NULL DEFAULT 0,
  total_legend_purchases    INTEGER NOT NULL DEFAULT 0,
  all_time_superbowl_wins   INTEGER NOT NULL DEFAULT 0,
  all_time_superbowl_losses INTEGER NOT NULL DEFAULT 0,
  all_time_h2h_wins         INTEGER NOT NULL DEFAULT 0,
  all_time_h2h_losses       INTEGER NOT NULL DEFAULT 0,
  milestone_tier_awarded    INTEGER NOT NULL DEFAULT 0,
  playoff_seed              INTEGER,
  playoff_conference        TEXT,
  ea_id                     TEXT,
  is_admin                  BOOLEAN NOT NULL DEFAULT FALSE,
  bot_escalation_level      INTEGER NOT NULL DEFAULT 0,
  created_at                TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS economy_users_discord_guild_idx ON economy_users (discord_id, guild_id);
CREATE UNIQUE INDEX IF NOT EXISTS economy_users_team_guild_idx    ON economy_users (team, guild_id);

-- seasons
CREATE TABLE IF NOT EXISTS seasons (
  id                                   SERIAL PRIMARY KEY,
  guild_id                             TEXT NOT NULL DEFAULT '1476251181524189438',
  season_number                        INTEGER NOT NULL,
  is_active                            BOOLEAN NOT NULL DEFAULT TRUE,
  started_at                           TIMESTAMP NOT NULL DEFAULT NOW(),
  core_attr_cost_override              INTEGER,
  core_attr_cap_override               INTEGER,
  non_core_attr_cost_override          INTEGER,
  non_core_attr_cap_override           INTEGER,
  dev_ups_cap_override                 INTEGER,
  dev_ups_cost_override                INTEGER,
  age_resets_cap_override              INTEGER,
  age_resets_cost_override             INTEGER,
  legend_cost_override                 INTEGER,
  legends_per_season_cap_override      INTEGER,
  custom_gold_cost_override            INTEGER,
  custom_silver_cost_override          INTEGER,
  custom_bronze_cost_override          INTEGER,
  custom_players_per_season_cap_override INTEGER,
  current_week                         TEXT NOT NULL DEFAULT '1',
  core_attributes_override             TEXT,
  catchup_mode                         BOOLEAN NOT NULL DEFAULT FALSE,
  contract_extension_cost_override     INTEGER,
  contract_extension_cap_override      INTEGER,
  salary_reduction_cost_override       INTEGER,
  salary_reduction_cap_override        INTEGER,
  bonus_reduction_cost_override        INTEGER,
  bonus_reduction_cap_override         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS seasons_guild_season_idx ON seasons (guild_id, season_number);

-- legends
CREATE TABLE IF NOT EXISTS legends (
  id           SERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL DEFAULT '1476251181524189438',
  name         TEXT NOT NULL,
  position     TEXT NOT NULL,
  description  TEXT,
  cost         INTEGER NOT NULL DEFAULT 1000,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  added_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- purchases
CREATE TABLE IF NOT EXISTS purchases (
  id                    SERIAL PRIMARY KEY,
  discord_id            TEXT NOT NULL,
  season_id             INTEGER NOT NULL,
  purchase_type         purchase_type NOT NULL,
  status                purchase_status NOT NULL DEFAULT 'pending',
  cost                  INTEGER NOT NULL,
  legend_id             INTEGER,
  player_name           TEXT,
  player_position       TEXT,
  attribute_name        TEXT,
  custom_player_tier    custom_player_tier,
  discord_message_id    TEXT,
  notes                 TEXT,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  approved_at           TIMESTAMP,
  draft_tracker_message_id TEXT,
  team_name             TEXT,
  ea_franchise_id       INTEGER
);

-- inventory
CREATE TABLE IF NOT EXISTS inventory (
  id                 SERIAL PRIMARY KEY,
  discord_id         TEXT NOT NULL,
  season_id          INTEGER NOT NULL,
  purchase_id        INTEGER NOT NULL,
  item_type          purchase_type NOT NULL,
  legend_id          INTEGER,
  legend_name        TEXT,
  player_name        TEXT,
  player_position    TEXT,
  attribute_name     TEXT,
  custom_player_tier custom_player_tier,
  notes              TEXT,
  legend_category    TEXT NOT NULL DEFAULT 'current',
  team               TEXT,
  ea_franchise_id    INTEGER,
  added_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

-- season_stats
CREATE TABLE IF NOT EXISTS season_stats (
  id                           SERIAL PRIMARY KEY,
  discord_id                   TEXT NOT NULL,
  season_id                    INTEGER NOT NULL,
  core_attr_purchased          INTEGER NOT NULL DEFAULT 0,
  non_core_attr_purchased      INTEGER NOT NULL DEFAULT 0,
  dev_ups_purchased            INTEGER NOT NULL DEFAULT 0,
  age_resets_purchased         INTEGER NOT NULL DEFAULT 0,
  legends_purchased_this_season INTEGER NOT NULL DEFAULT 0,
  contract_extensions_purchased INTEGER NOT NULL DEFAULT 0,
  salary_reductions_purchased  INTEGER NOT NULL DEFAULT 0,
  bonus_reductions_purchased   INTEGER NOT NULL DEFAULT 0,
  training_gold_purchased      INTEGER NOT NULL DEFAULT 0,
  training_silver_purchased    INTEGER NOT NULL DEFAULT 0
);

-- user_records
CREATE TABLE IF NOT EXISTS user_records (
  id               SERIAL PRIMARY KEY,
  discord_id       TEXT NOT NULL,
  discord_username TEXT NOT NULL,
  team             TEXT,
  season_id        INTEGER NOT NULL,
  wins             INTEGER NOT NULL DEFAULT 0,
  losses           INTEGER NOT NULL DEFAULT 0,
  ties             INTEGER NOT NULL DEFAULT 0,
  point_differential INTEGER NOT NULL DEFAULT 0,
  playoff_wins     INTEGER NOT NULL DEFAULT 0,
  playoff_losses   INTEGER NOT NULL DEFAULT 0,
  superbowl_wins   INTEGER NOT NULL DEFAULT 0,
  superbowl_losses INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_records_discord_season_idx ON user_records (discord_id, season_id);

-- game_log
CREATE TABLE IF NOT EXISTS game_log (
  id                 SERIAL PRIMARY KEY,
  guild_id           TEXT NOT NULL DEFAULT '1476251181524189438',
  discord_id         TEXT NOT NULL,
  season_id          INTEGER NOT NULL,
  result             TEXT NOT NULL,
  point_spread       INTEGER NOT NULL,
  opponent_label     TEXT,
  opponent_discord_id TEXT,
  game_type          game_type NOT NULL DEFAULT 'regular_season',
  recorded_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- h2h_matchup_records
CREATE TABLE IF NOT EXISTS h2h_matchup_records (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL DEFAULT '1476251181524189438',
  discord_id_1 TEXT NOT NULL,
  discord_id_2 TEXT NOT NULL,
  wins_1      INTEGER NOT NULL DEFAULT 0,
  wins_2      INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS h2h_matchup_guild_pair_idx ON h2h_matchup_records (guild_id, discord_id_1, discord_id_2);

-- rules  (composite PK: guild_id + section)
CREATE TABLE IF NOT EXISTS rules (
  section    TEXT NOT NULL,
  guild_id   TEXT NOT NULL DEFAULT '1476251181524189438',
  rules      JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  PRIMARY KEY (guild_id, section)
);

-- rules_sections  (composite PK: guild_id + key)
CREATE TABLE IF NOT EXISTS rules_sections (
  key        TEXT NOT NULL,
  guild_id   TEXT NOT NULL DEFAULT '1476251181524189438',
  title      TEXT NOT NULL,
  color      INTEGER NOT NULL DEFAULT 3447003,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, key)
);

-- payout_requests
CREATE TABLE IF NOT EXISTS payout_requests (
  id                SERIAL PRIMARY KEY,
  requester_id      TEXT NOT NULL,
  requester_team    TEXT,
  opponent_id       TEXT,
  opponent_team     TEXT,
  requester_score   INTEGER,
  opponent_score    INTEGER,
  game_type         TEXT NOT NULL,
  week              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  interview_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  denial_reason     TEXT,
  discord_message_id TEXT,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMP,
  resolved_by       TEXT
);

-- interview_requests
CREATE TABLE IF NOT EXISTS interview_requests (
  id                SERIAL PRIMARY KEY,
  discord_id        TEXT NOT NULL,
  guild_id          TEXT NOT NULL DEFAULT '1476251181524189438',
  payout_request_id INTEGER,
  week              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  question_1        TEXT,
  question_2        TEXT,
  question_3        TEXT,
  answer_1          TEXT,
  answer_2          TEXT,
  answer_3          TEXT,
  denial_reason     TEXT,
  discord_message_id TEXT,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMP,
  resolved_by       TEXT
);

-- coin_transactions
CREATE TABLE IF NOT EXISTS coin_transactions (
  id              SERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL DEFAULT '1476251181524189438',
  discord_id      TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  type            tx_type NOT NULL,
  description     TEXT NOT NULL,
  related_user_id TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- user_savings  (PK = discord_id — global, no guild scope)
CREATE TABLE IF NOT EXISTS user_savings (
  discord_id TEXT PRIMARY KEY,
  balance    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- global_user_records  (PK = discord_id)
CREATE TABLE IF NOT EXISTS global_user_records (
  discord_id         TEXT PRIMARY KEY,
  wins               INTEGER NOT NULL DEFAULT 0,
  losses             INTEGER NOT NULL DEFAULT 0,
  ties               INTEGER NOT NULL DEFAULT 0,
  point_differential INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

-- wagers
CREATE TABLE IF NOT EXISTS wagers (
  id                     SERIAL PRIMARY KEY,
  guild_id               TEXT NOT NULL DEFAULT '1476251181524189438',
  challenger_id          TEXT NOT NULL,
  challenger_username    TEXT NOT NULL,
  opponent_id            TEXT NOT NULL,
  opponent_username      TEXT NOT NULL,
  amount                 INTEGER NOT NULL,
  pot                    INTEGER NOT NULL,
  team_for               TEXT NOT NULL,
  team_against           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',
  winner_id              TEXT,
  commissioner_message_id TEXT,
  challenge_message_id   TEXT,
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at            TIMESTAMP,
  resolved_by            TEXT,
  spread                 INTEGER,
  challenger_side        TEXT,
  schedule_game_id       INTEGER
);

-- franchise_processed_games  (PK = game_id text)
CREATE TABLE IF NOT EXISTS franchise_processed_games (
  game_id              TEXT PRIMARY KEY,
  guild_id             TEXT NOT NULL DEFAULT '1476251181524189438',
  processed_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  payout_type          TEXT,
  winner_discord_id    TEXT,
  loser_discord_id     TEXT,
  winner_coins         INTEGER,
  loser_coins          INTEGER,
  applied_point_diff   INTEGER,
  milestone_bonus      INTEGER,
  milestone_prev_tier  INTEGER,
  season_id_ref        INTEGER,
  week_index_ref       INTEGER,
  home_team_ref        TEXT,
  away_team_ref        TEXT
);

-- franchise_game_participants
CREATE TABLE IF NOT EXISTS franchise_game_participants (
  id         SERIAL PRIMARY KEY,
  season_id  INTEGER NOT NULL,
  week       TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  game_type  TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS franchise_game_participants_unique_idx
  ON franchise_game_participants (season_id, week, discord_id);

-- franchise_schedule
CREATE TABLE IF NOT EXISTS franchise_schedule (
  id              SERIAL PRIMARY KEY,
  season_id       INTEGER NOT NULL,
  week_index      INTEGER NOT NULL,
  home_team_id    INTEGER NOT NULL,
  away_team_id    INTEGER NOT NULL,
  home_team_name  TEXT NOT NULL,
  away_team_name  TEXT NOT NULL,
  home_score      INTEGER,
  away_score      INTEGER,
  status          INTEGER NOT NULL DEFAULT 0,
  processed_game_id TEXT,
  imported_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS franchise_schedule_unique_game_idx
  ON franchise_schedule (season_id, week_index, home_team_id, away_team_id);

-- franchise_rosters
CREATE TABLE IF NOT EXISTS franchise_rosters (
  id                  SERIAL PRIMARY KEY,
  season_id           INTEGER NOT NULL,
  team_id             INTEGER NOT NULL,
  team_name           TEXT NOT NULL,
  discord_id          TEXT,
  player_id           INTEGER NOT NULL,
  first_name          TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  position            TEXT NOT NULL DEFAULT '',
  overall             INTEGER NOT NULL DEFAULT 0,
  dev_trait           INTEGER NOT NULL DEFAULT 0,
  age                 INTEGER,
  jersey_num          INTEGER,
  contract_years_left INTEGER,
  archetype_abbrev    TEXT,
  xp_total            INTEGER,
  attributes          JSON,
  abilities           JSON,
  portrait_url        TEXT,
  imported_at         TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS franchise_roster_player_season_idx
  ON franchise_rosters (season_id, team_id, player_id);

-- franchise_draft_picks
CREATE TABLE IF NOT EXISTS franchise_draft_picks (
  id                SERIAL PRIMARY KEY,
  season_id         INTEGER NOT NULL,
  team_id           INTEGER NOT NULL,
  team_name         TEXT NOT NULL DEFAULT '',
  discord_id        TEXT,
  draft_year        INTEGER NOT NULL,
  round             INTEGER NOT NULL,
  pick_num          INTEGER NOT NULL DEFAULT 0,
  original_team_id  INTEGER,
  original_team_name TEXT,
  imported_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS franchise_draft_picks_unique_idx
  ON franchise_draft_picks (season_id, team_id, draft_year, round, pick_num);

-- season_stat_tier_configs
CREATE TABLE IF NOT EXISTS season_stat_tier_configs (
  id            SERIAL PRIMARY KEY,
  season_id     INTEGER NOT NULL,
  stat_category TEXT NOT NULL,
  tier          INTEGER NOT NULL,
  threshold     INTEGER NOT NULL,
  payout        INTEGER NOT NULL,
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS season_stat_tier_unique_idx
  ON season_stat_tier_configs (season_id, stat_category, tier);

-- team_season_stats
CREATE TABLE IF NOT EXISTS team_season_stats (
  id                SERIAL PRIMARY KEY,
  season_id         INTEGER NOT NULL,
  team_id           INTEGER NOT NULL,
  discord_id        TEXT,
  team_name         TEXT NOT NULL DEFAULT '',
  off_yds           INTEGER NOT NULL DEFAULT 0,
  off_pass_yds      INTEGER NOT NULL DEFAULT 0,
  off_rush_yds      INTEGER NOT NULL DEFAULT 0,
  off_tds           INTEGER NOT NULL DEFAULT 0,
  off_pts_per_game  REAL NOT NULL DEFAULT 0,
  def_pass_yds      INTEGER NOT NULL DEFAULT 0,
  def_rush_yds      INTEGER NOT NULL DEFAULT 0,
  def_tds           INTEGER NOT NULL DEFAULT 0,
  team_sacks        INTEGER NOT NULL DEFAULT 0,
  team_ints         INTEGER NOT NULL DEFAULT 0,
  off_redzone_pct   REAL NOT NULL DEFAULT 0,
  def_redzone_pct   REAL NOT NULL DEFAULT 0,
  def_fumbles_rec   INTEGER NOT NULL DEFAULT 0,
  turnover_diff     INTEGER NOT NULL DEFAULT 0,
  wins              INTEGER NOT NULL DEFAULT 0,
  losses            INTEGER NOT NULL DEFAULT 0,
  ties              INTEGER NOT NULL DEFAULT 0,
  pts_for           INTEGER NOT NULL DEFAULT 0,
  pts_against       INTEGER NOT NULL DEFAULT 0,
  home_wins         INTEGER NOT NULL DEFAULT 0,
  home_losses       INTEGER NOT NULL DEFAULT 0,
  home_ties         INTEGER NOT NULL DEFAULT 0,
  away_wins         INTEGER NOT NULL DEFAULT 0,
  away_losses       INTEGER NOT NULL DEFAULT 0,
  away_ties         INTEGER NOT NULL DEFAULT 0,
  conf_wins         INTEGER NOT NULL DEFAULT 0,
  conf_losses       INTEGER NOT NULL DEFAULT 0,
  conf_ties         INTEGER NOT NULL DEFAULT 0,
  div_wins          INTEGER NOT NULL DEFAULT 0,
  div_losses        INTEGER NOT NULL DEFAULT 0,
  div_ties          INTEGER NOT NULL DEFAULT 0,
  cap_room          INTEGER NOT NULL DEFAULT 0,
  cap_spent         INTEGER NOT NULL DEFAULT 0,
  cap_available     INTEGER NOT NULL DEFAULT 0,
  seed              INTEGER,
  rank              INTEGER,
  prev_rank         INTEGER,
  playoff_status    TEXT,
  win_pct           REAL NOT NULL DEFAULT 0,
  win_loss_streak   INTEGER NOT NULL DEFAULT 0,
  net_pts           INTEGER NOT NULL DEFAULT 0,
  off_total_yds     INTEGER NOT NULL DEFAULT 0,
  def_total_yds     INTEGER NOT NULL DEFAULT 0,
  off_pass_yds_rank   INTEGER,
  off_rush_yds_rank   INTEGER,
  off_total_yds_rank  INTEGER,
  def_pass_yds_rank   INTEGER,
  def_rush_yds_rank   INTEGER,
  def_total_yds_rank  INTEGER,
  pts_for_rank        INTEGER,
  pts_against_rank    INTEGER,
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_season_stats_unique_idx
  ON team_season_stats (season_id, team_id);

-- player_season_stats
CREATE TABLE IF NOT EXISTS player_season_stats (
  id                    SERIAL PRIMARY KEY,
  season_id             INTEGER NOT NULL,
  player_id             INTEGER NOT NULL,
  team_id               INTEGER NOT NULL DEFAULT -1,
  team_name             TEXT NOT NULL DEFAULT '',
  discord_id            TEXT,
  first_name            TEXT NOT NULL DEFAULT '',
  last_name             TEXT NOT NULL DEFAULT '',
  position              TEXT NOT NULL DEFAULT '',
  -- passing
  pass_yds              INTEGER NOT NULL DEFAULT 0,
  pass_tds              INTEGER NOT NULL DEFAULT 0,
  pass_att              INTEGER NOT NULL DEFAULT 0,
  pass_comp             INTEGER NOT NULL DEFAULT 0,
  pass_ints             INTEGER NOT NULL DEFAULT 0,
  times_sacked          INTEGER NOT NULL DEFAULT 0,
  pass_longest          INTEGER NOT NULL DEFAULT 0,
  pass_pts              REAL NOT NULL DEFAULT 0,
  pass_yds_per_att      REAL NOT NULL DEFAULT 0,
  pass_yds_per_game     REAL NOT NULL DEFAULT 0,
  passer_rating         REAL NOT NULL DEFAULT 0,
  pass_comp_pct         REAL NOT NULL DEFAULT 0,
  -- rushing
  rush_yds              INTEGER NOT NULL DEFAULT 0,
  rush_tds              INTEGER NOT NULL DEFAULT 0,
  rush_att              INTEGER NOT NULL DEFAULT 0,
  fumbles               INTEGER NOT NULL DEFAULT 0,
  rush_20_plus_yds      INTEGER NOT NULL DEFAULT 0,
  rush_broken_tackles   INTEGER NOT NULL DEFAULT 0,
  rush_longest          INTEGER NOT NULL DEFAULT 0,
  rush_pts              REAL NOT NULL DEFAULT 0,
  rush_to_pct           REAL NOT NULL DEFAULT 0,
  rush_yds_after_contact INTEGER NOT NULL DEFAULT 0,
  rush_yds_per_att      REAL NOT NULL DEFAULT 0,
  rush_yds_per_game     REAL NOT NULL DEFAULT 0,
  -- receiving
  rec_yds               INTEGER NOT NULL DEFAULT 0,
  rec_tds               INTEGER NOT NULL DEFAULT 0,
  rec_rec               INTEGER NOT NULL DEFAULT 0,
  rec_drops             INTEGER NOT NULL DEFAULT 0,
  rec_longest           INTEGER NOT NULL DEFAULT 0,
  rec_pts               REAL NOT NULL DEFAULT 0,
  rec_to_pct            REAL NOT NULL DEFAULT 0,
  rec_yac_per_catch     REAL NOT NULL DEFAULT 0,
  rec_yds_after_catch   INTEGER NOT NULL DEFAULT 0,
  rec_yds_per_catch     REAL NOT NULL DEFAULT 0,
  rec_yds_per_game      REAL NOT NULL DEFAULT 0,
  rec_catch_pct         REAL NOT NULL DEFAULT 0,
  -- defense
  sacks                 REAL NOT NULL DEFAULT 0,
  def_ints              INTEGER NOT NULL DEFAULT 0,
  total_tackles         INTEGER NOT NULL DEFAULT 0,
  tackle_solo           INTEGER NOT NULL DEFAULT 0,
  tackle_assist         INTEGER NOT NULL DEFAULT 0,
  def_fumbles_rec       INTEGER NOT NULL DEFAULT 0,
  forced_fumbles        INTEGER NOT NULL DEFAULT 0,
  tackles_for_loss      REAL NOT NULL DEFAULT 0,
  def_tds_scored        INTEGER NOT NULL DEFAULT 0,
  def_catch_allowed     INTEGER NOT NULL DEFAULT 0,
  def_deflections       INTEGER NOT NULL DEFAULT 0,
  def_int_return_yds    INTEGER NOT NULL DEFAULT 0,
  def_pts               REAL NOT NULL DEFAULT 0,
  def_safeties          INTEGER NOT NULL DEFAULT 0,
  -- kicking
  fg_made               INTEGER NOT NULL DEFAULT 0,
  fg_att                INTEGER NOT NULL DEFAULT 0,
  fg_long               INTEGER NOT NULL DEFAULT 0,
  xp_made               INTEGER NOT NULL DEFAULT 0,
  xp_att                INTEGER NOT NULL DEFAULT 0,
  fg_50_plus_att        INTEGER NOT NULL DEFAULT 0,
  fg_50_plus_made       INTEGER NOT NULL DEFAULT 0,
  fg_comp_pct           REAL NOT NULL DEFAULT 0,
  kick_pts              REAL NOT NULL DEFAULT 0,
  kickoff_att           INTEGER NOT NULL DEFAULT 0,
  kickoff_tbs           INTEGER NOT NULL DEFAULT 0,
  xp_comp_pct           REAL NOT NULL DEFAULT 0,
  -- punting
  punt_att              INTEGER NOT NULL DEFAULT 0,
  punt_yds              INTEGER NOT NULL DEFAULT 0,
  punt_long             INTEGER NOT NULL DEFAULT 0,
  punt_in_20            INTEGER NOT NULL DEFAULT 0,
  punt_touchbacks       INTEGER NOT NULL DEFAULT 0,
  punt_net_yds          INTEGER NOT NULL DEFAULT 0,
  punt_net_yds_per_att  REAL NOT NULL DEFAULT 0,
  punts_blocked         INTEGER NOT NULL DEFAULT 0,
  -- returns
  kr_att                INTEGER NOT NULL DEFAULT 0,
  kr_yds                INTEGER NOT NULL DEFAULT 0,
  kr_tds                INTEGER NOT NULL DEFAULT 0,
  pr_att                INTEGER NOT NULL DEFAULT 0,
  pr_yds                INTEGER NOT NULL DEFAULT 0,
  pr_tds                INTEGER NOT NULL DEFAULT 0,
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_season_stats_unique_idx
  ON player_season_stats (season_id, player_id);

-- player_stat_week_processed
CREATE TABLE IF NOT EXISTS player_stat_week_processed (
  id           SERIAL PRIMARY KEY,
  season_id    INTEGER NOT NULL,
  week_type    TEXT NOT NULL,
  week_num     INTEGER NOT NULL,
  stat_type    TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_stat_week_processed_unique_idx
  ON player_stat_week_processed (season_id, week_type, week_num, stat_type);

-- player_week_stats_delta
CREATE TABLE IF NOT EXISTS player_week_stats_delta (
  id              SERIAL PRIMARY KEY,
  season_id       INTEGER NOT NULL,
  week_type       TEXT NOT NULL,
  week_num        INTEGER NOT NULL,
  stat_type       TEXT NOT NULL,
  player_id       INTEGER NOT NULL,
  pass_yds        INTEGER,
  pass_tds        INTEGER,
  pass_att        INTEGER,
  pass_comp       INTEGER,
  pass_ints       INTEGER,
  times_sacked    INTEGER,
  rush_yds        INTEGER,
  rush_tds        INTEGER,
  rush_att        INTEGER,
  fumbles         INTEGER,
  rec_yds         INTEGER,
  rec_tds         INTEGER,
  rec_rec         INTEGER,
  sacks           INTEGER,
  def_ints        INTEGER,
  total_tackles   INTEGER,
  tackle_solo     INTEGER,
  tackle_assist   INTEGER,
  def_fumbles_rec INTEGER,
  forced_fumbles  INTEGER,
  tackles_for_loss INTEGER,
  def_tds         INTEGER,
  fg_made         INTEGER,
  fg_att          INTEGER,
  xp_made         INTEGER,
  xp_att          INTEGER,
  punt_att        INTEGER,
  punt_yds        INTEGER,
  punt_in_20      INTEGER,
  punt_touchbacks INTEGER,
  kr_att          INTEGER,
  kr_yds          INTEGER,
  kr_tds          INTEGER,
  pr_att          INTEGER,
  pr_yds          INTEGER,
  pr_tds          INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS player_week_stats_delta_uniq
  ON player_week_stats_delta (season_id, week_type, week_num, stat_type, player_id);

-- team_week_stats_delta
CREATE TABLE IF NOT EXISTS team_week_stats_delta (
  id             SERIAL PRIMARY KEY,
  season_id      INTEGER NOT NULL,
  week_type      TEXT NOT NULL,
  week_num       INTEGER NOT NULL,
  team_id        INTEGER NOT NULL,
  off_yds        INTEGER,
  off_pass_yds   INTEGER,
  off_rush_yds   INTEGER,
  off_tds        INTEGER,
  def_pass_yds   INTEGER,
  def_rush_yds   INTEGER,
  def_tds        INTEGER,
  def_fumbles_rec INTEGER,
  turnover_diff  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS team_week_stats_delta_uniq
  ON team_week_stats_delta (season_id, week_type, week_num, team_id);

-- gotw_history
CREATE TABLE IF NOT EXISTS gotw_history (
  id                      SERIAL PRIMARY KEY,
  season_id               INTEGER NOT NULL,
  week_index              INTEGER NOT NULL,
  discord_id_1            TEXT NOT NULL,
  discord_id_2            TEXT NOT NULL,
  team_name_1             TEXT NOT NULL,
  team_name_2             TEXT NOT NULL,
  combined_score          INTEGER NOT NULL DEFAULT 0,
  announcement_message_id TEXT,
  poll_message_id         TEXT,
  payout_issued_at        TIMESTAMP,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS gotw_history_week_idx ON gotw_history (season_id, week_index);

-- playoff_gotw_polls
CREATE TABLE IF NOT EXISTS playoff_gotw_polls (
  id              SERIAL PRIMARY KEY,
  season_id       INTEGER NOT NULL,
  week_label      TEXT NOT NULL,
  week_index      INTEGER NOT NULL,
  matchup_index   INTEGER NOT NULL,
  discord_id_1    TEXT NOT NULL,
  discord_id_2    TEXT NOT NULL,
  team_name_1     TEXT NOT NULL,
  team_name_2     TEXT NOT NULL,
  poll_message_id TEXT,
  payout_issued_at TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS playoff_gotw_polls_uniq
  ON playoff_gotw_polls (season_id, week_index, matchup_index);

-- draft_sessions
CREATE TABLE IF NOT EXISTS draft_sessions (
  id               SERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  message_id       TEXT,
  panel_message_id TEXT,
  panel_message_ids TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- draft_presence
CREATE TABLE IF NOT EXISTS draft_presence (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL,
  discord_id TEXT NOT NULL,
  team_name  TEXT,
  is_present BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS draft_presence_uniq ON draft_presence (session_id, discord_id);

-- game_channels
CREATE TABLE IF NOT EXISTS game_channels (
  id             SERIAL PRIMARY KEY,
  season_id      INTEGER NOT NULL,
  week_index     INTEGER NOT NULL,
  channel_id     TEXT NOT NULL,
  away_team_name TEXT NOT NULL DEFAULT '',
  home_team_name TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- trade_block_listings
CREATE TABLE IF NOT EXISTS trade_block_listings (
  id         SERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  team_name  TEXT NOT NULL DEFAULT '',
  season_id  INTEGER NOT NULL,
  items      JSON NOT NULL,
  notes      TEXT,
  message_id TEXT,
  channel_id TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- trade_block_iso
CREATE TABLE IF NOT EXISTS trade_block_iso (
  id               SERIAL PRIMARY KEY,
  discord_id       TEXT NOT NULL,
  team_name        TEXT NOT NULL DEFAULT '',
  season_id        INTEGER NOT NULL,
  seeking_type     TEXT NOT NULL,
  seeking_details  JSON NOT NULL,
  offering         JSON NOT NULL,
  message_id       TEXT,
  channel_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- completed_trades
CREATE TABLE IF NOT EXISTS completed_trades (
  id                  SERIAL PRIMARY KEY,
  season_id           INTEGER NOT NULL,
  listing_id          INTEGER,
  listing_type        TEXT NOT NULL DEFAULT 'listing',
  team1_discord_id    TEXT NOT NULL,
  team1_name          TEXT NOT NULL,
  team2_name          TEXT NOT NULL,
  what_team1_sent     TEXT NOT NULL,
  what_team1_received TEXT NOT NULL,
  announced_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  articled_at         TIMESTAMP
);

-- franchise_mca_teams
CREATE TABLE IF NOT EXISTS franchise_mca_teams (
  id              SERIAL PRIMARY KEY,
  season_id       INTEGER NOT NULL,
  team_id         INTEGER NOT NULL,
  full_name       TEXT NOT NULL,
  nick_name       TEXT NOT NULL,
  conference      TEXT,
  user_name       TEXT NOT NULL,
  is_human        BOOLEAN NOT NULL DEFAULT FALSE,
  discord_id      TEXT,
  logo_url        TEXT,
  abbr_name       TEXT,
  div_name        TEXT,
  off_scheme      TEXT,
  def_scheme      TEXT,
  ovr_rating      INTEGER,
  primary_color   INTEGER,
  secondary_color INTEGER,
  logo_id         INTEGER,
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS franchise_mca_teams_unique_idx
  ON franchise_mca_teams (season_id, team_id);

-- default_team_logos  (PK = team_id integer)
CREATE TABLE IF NOT EXISTS default_team_logos (
  team_id    INTEGER PRIMARY KEY,
  full_name  TEXT NOT NULL,
  nick_name  TEXT NOT NULL,
  logo_url   TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- payout_config  (PK = key text; unique index on guild_id+key)
CREATE TABLE IF NOT EXISTS payout_config (
  key         TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL DEFAULT '1476251181524189438',
  value       INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS payout_config_guild_key_uniq ON payout_config (guild_id, key);

-- pending_polls
CREATE TABLE IF NOT EXISTS pending_polls (
  id                    SERIAL PRIMARY KEY,
  message_id            TEXT NOT NULL,
  channel_id            TEXT NOT NULL,
  poll_type             TEXT NOT NULL,
  season_id             INTEGER NOT NULL,
  expires_at            TIMESTAMP NOT NULL,
  processed             BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at          TIMESTAMP,
  historical_channel_id TEXT,
  metadata              TEXT,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

-- season_historical_channels  (PK = season_id)
CREATE TABLE IF NOT EXISTS season_historical_channels (
  season_id  INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- server_settings
CREATE TABLE IF NOT EXISTS server_settings (
  id                          SERIAL PRIMARY KEY,
  guild_id                    TEXT NOT NULL UNIQUE DEFAULT 'global',
  coin_economy                BOOLEAN NOT NULL DEFAULT TRUE,
  legends_enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  custom_superstars_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  attribute_upgrades_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  dev_upgrades_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  age_resets_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  all_time_legend_cap         INTEGER,
  wager_enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  trade_block_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  mca_import_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  legacy_core_attr_mode       BOOLEAN NOT NULL DEFAULT FALSE,
  max_seasons                 INTEGER NOT NULL DEFAULT 10,
  contract_extensions_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  salary_reductions_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  bonus_reductions_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  salary_reduction_career_cap INTEGER,
  bonus_reduction_career_cap  INTEGER,
  updated_at                  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- pending_eos_payouts
CREATE TABLE IF NOT EXISTS pending_eos_payouts (
  id                      SERIAL PRIMARY KEY,
  discord_id              TEXT NOT NULL,
  team_name               TEXT,
  season_id               INTEGER NOT NULL,
  stat_breakdown          JSON NOT NULL,
  total_coins             INTEGER NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending',
  commissioner_message_id TEXT,
  approved_by             TEXT,
  approved_at             TIMESTAMP,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

-- pending_channel_payouts
CREATE TABLE IF NOT EXISTS pending_channel_payouts (
  id                 SERIAL PRIMARY KEY,
  type               TEXT NOT NULL,
  discord_id         TEXT NOT NULL,
  amount             INTEGER NOT NULL,
  opponent_discord_id TEXT,
  opponent_amount    INTEGER,
  opponent_team      TEXT,
  channel_id         TEXT NOT NULL,
  message_id         TEXT NOT NULL,
  guild_id           TEXT NOT NULL,
  season_id          INTEGER NOT NULL,
  week               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  comm_message_id    TEXT,
  resolved_at        TIMESTAMP,
  resolved_by        TEXT,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

-- stat_padding_violations
CREATE TABLE IF NOT EXISTS stat_padding_violations (
  id             SERIAL PRIMARY KEY,
  season_id      INTEGER NOT NULL,
  week           TEXT NOT NULL,
  type           TEXT NOT NULL,
  discord_id     TEXT,
  player_name    TEXT,
  team_name      TEXT NOT NULL,
  description    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  comm_message_id TEXT,
  resolved_at    TIMESTAMP,
  resolved_by    TEXT,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- custom_archetypes
CREATE TABLE IF NOT EXISTS custom_archetypes (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT NOT NULL DEFAULT '1476251181524189438',
  position   TEXT NOT NULL,
  name       TEXT NOT NULL,
  attributes JSON NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- legend_templates
CREATE TABLE IF NOT EXISTS legend_templates (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL DEFAULT '1476251181524189438',
  legend_id   INTEGER NOT NULL,
  legend_name TEXT NOT NULL,
  position    TEXT NOT NULL,
  model       TEXT NOT NULL,
  attributes  JSON NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS legend_templates_legend_model_idx
  ON legend_templates (legend_id, model);

-- custom_player_settings
CREATE TABLE IF NOT EXISTS custom_player_settings (
  id             SERIAL PRIMARY KEY,
  guild_id       TEXT NOT NULL DEFAULT '1476251181524189438',
  bronze_points  INTEGER NOT NULL DEFAULT 35,
  silver_points  INTEGER NOT NULL DEFAULT 70,
  gold_points    INTEGER NOT NULL DEFAULT 100,
  bronze_cost    INTEGER NOT NULL DEFAULT 0,
  silver_cost    INTEGER NOT NULL DEFAULT 0,
  gold_cost      INTEGER NOT NULL DEFAULT 0,
  kp_points      INTEGER NOT NULL DEFAULT 50,
  kp_cost        INTEGER NOT NULL DEFAULT 150,
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- custom_players
CREATE TABLE IF NOT EXISTS custom_players (
  id                       SERIAL PRIMARY KEY,
  discord_id               TEXT NOT NULL,
  season_id                INTEGER,
  position                 TEXT NOT NULL,
  archetype_name           TEXT NOT NULL,
  dev_trait                TEXT NOT NULL DEFAULT 'normal',
  package_tier             TEXT NOT NULL,
  creation_points          INTEGER NOT NULL DEFAULT 0,
  first_name               TEXT NOT NULL,
  last_name                TEXT NOT NULL,
  jersey_number            INTEGER NOT NULL,
  college                  TEXT NOT NULL,
  dominant_hand            TEXT NOT NULL DEFAULT 'right',
  height_ft                INTEGER NOT NULL,
  height_in                INTEGER NOT NULL,
  weight_lbs               INTEGER NOT NULL,
  attributes               JSON NOT NULL,
  throwing_motion_style    TEXT,
  throwing_motion_number   INTEGER,
  appearance_head          TEXT,
  total_cost               INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'pending',
  team_name                TEXT,
  commissioner_message_id  TEXT,
  commissioner_channel_id  TEXT,
  applied_at               TIMESTAMP,
  refunded_at              TIMESTAMP,
  refund_reason            TEXT,
  created_at               TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ea_connections
CREATE TABLE IF NOT EXISTS ea_connections (
  id            SERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL DEFAULT '1476251181524189438',
  ea_league_id  INTEGER NOT NULL UNIQUE,
  league_name   TEXT NOT NULL DEFAULT '',
  blaze_id      TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expiry        TIMESTAMP NOT NULL,
  platform      TEXT NOT NULL DEFAULT 'pc',
  connected_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  connected_by  TEXT NOT NULL
);

-- league_twitter_trade_events
CREATE TABLE IF NOT EXISTS league_twitter_trade_events (
  id         SERIAL PRIMARY KEY,
  season_id  INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  summary    TEXT NOT NULL,
  team_a     TEXT,
  team_b     TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- league_twitter_matchup_cache
CREATE TABLE IF NOT EXISTS league_twitter_matchup_cache (
  id            SERIAL PRIMARY KEY,
  season_id     INTEGER NOT NULL,
  week_label    TEXT NOT NULL,
  matchups_text TEXT NOT NULL,
  posted_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- league_news
CREATE TABLE IF NOT EXISTS league_news (
  id         SERIAL PRIMARY KEY,
  season_id  INTEGER NOT NULL,
  ea_news_id TEXT,
  headline   TEXT NOT NULL,
  body       TEXT,
  category   TEXT,
  week_index INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- roster_transactions
CREATE TABLE IF NOT EXISTS roster_transactions (
  id                SERIAL PRIMARY KEY,
  season_id         INTEGER NOT NULL,
  detected_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  week_num          INTEGER,
  transaction_type  TEXT NOT NULL,
  player_id         INTEGER NOT NULL,
  player_name       TEXT NOT NULL,
  position          TEXT,
  from_team         TEXT,
  to_team           TEXT,
  from_value        TEXT,
  to_value          TEXT,
  posted_to_channel BOOLEAN NOT NULL DEFAULT FALSE
);

-- player_xp_log
CREATE TABLE IF NOT EXISTS player_xp_log (
  id         SERIAL PRIMARY KEY,
  season_id  INTEGER NOT NULL,
  guild_id   TEXT,
  week_num   INTEGER,
  week_type  TEXT,
  player_id  INTEGER NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name  TEXT NOT NULL DEFAULT '',
  position   TEXT NOT NULL DEFAULT '',
  team_id    INTEGER NOT NULL,
  team_name  TEXT NOT NULL DEFAULT '',
  discord_id TEXT,
  xp_earned  INTEGER NOT NULL,
  xp_total   INTEGER NOT NULL,
  logged_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_xp_log_player_week_idx
  ON player_xp_log (season_id, player_id, week_num, week_type);

-- waitlist
CREATE TABLE IF NOT EXISTS waitlist (
  id           SERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  discord_id   TEXT NOT NULL,
  added_by     TEXT NOT NULL,
  team         TEXT,
  added_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  notified_at  TIMESTAMP,
  status       TEXT NOT NULL DEFAULT 'waiting'
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_guild_user_idx ON waitlist (guild_id, discord_id);

-- guild_channels
CREATE TABLE IF NOT EXISTS guild_channels (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS guild_channels_guild_key_idx ON guild_channels (guild_id, channel_key);

-- player_ea_ids
CREATE TABLE IF NOT EXISTS player_ea_ids (
  id         SERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  ea_id      TEXT NOT NULL,
  console    TEXT NOT NULL,
  slot       INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_ea_ids_discord_slot_idx ON player_ea_ids (discord_id, slot);

-- league_twitter_tweets
CREATE TABLE IF NOT EXISTS league_twitter_tweets (
  id               SERIAL PRIMARY KEY,
  season_id        INTEGER NOT NULL,
  message_id       TEXT NOT NULL,
  reporter_name    TEXT NOT NULL,
  reporter_handle  TEXT NOT NULL,
  content          TEXT NOT NULL,
  posted_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- guild_tweets
CREATE TABLE IF NOT EXISTS guild_tweets (
  id                SERIAL PRIMARY KEY,
  guild_id          TEXT NOT NULL,
  discord_id        TEXT NOT NULL,
  season_id         INTEGER NOT NULL,
  week_number       TEXT NOT NULL,
  tweet_text        TEXT NOT NULL,
  coins_awarded     INTEGER NOT NULL DEFAULT 0,
  channel_message_id TEXT,
  posted_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

-- autopilot_requests
CREATE TABLE IF NOT EXISTS autopilot_requests (
  id               SERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  discord_id       TEXT NOT NULL,
  team_name        TEXT,
  weeks_requested  INTEGER NOT NULL,
  reason           TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMP,
  comm_message_id  TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- rule_violations
CREATE TABLE IF NOT EXISTS rule_violations (
  id             SERIAL PRIMARY KEY,
  guild_id       TEXT NOT NULL,
  reporter_id    TEXT NOT NULL,
  reporter_team  TEXT,
  opponent_id    TEXT,
  opponent_team  TEXT,
  week_number    TEXT NOT NULL,
  season_id      INTEGER NOT NULL,
  description    TEXT NOT NULL,
  media_urls     JSON DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'pending',
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMP,
  comm_message_id TEXT,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- playoff_seeding_config
CREATE TABLE IF NOT EXISTS playoff_seeding_config (
  id         SERIAL PRIMARY KEY,
  rules_json JSON NOT NULL,
  source_url TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3: MCA NATIVE TABLES (mobile app / direct EA API)
-- ─────────────────────────────────────────────────────────────────────────────

-- app_users  (PK = uuid)
CREATE TABLE IF NOT EXISTS app_users (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  gamertag     TEXT NOT NULL UNIQUE,
  email        TEXT UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- app_user_league_links  (FK → app_users.gamertag)
CREATE TABLE IF NOT EXISTS app_user_league_links (
  id           SERIAL PRIMARY KEY,
  gamertag     TEXT NOT NULL REFERENCES app_users(gamertag),
  ea_league_id INTEGER NOT NULL,
  team_id      INTEGER,
  team_name    TEXT,
  linked_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_user_league_links_idx
  ON app_user_league_links (gamertag, ea_league_id);

-- mca_leagues  (PK = ea_league_id integer)
CREATE TABLE IF NOT EXISTS mca_leagues (
  ea_league_id INTEGER PRIMARY KEY,
  league_name  TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT 'pc',
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- mca_seasons
CREATE TABLE IF NOT EXISTS mca_seasons (
  id            SERIAL PRIMARY KEY,
  ea_league_id  INTEGER NOT NULL,
  season_number INTEGER NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  current_week  TEXT NOT NULL DEFAULT '1',
  started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_seasons_league_season_idx
  ON mca_seasons (ea_league_id, season_number);

-- mca_teams
CREATE TABLE IF NOT EXISTS mca_teams (
  id              SERIAL PRIMARY KEY,
  ea_season_id    INTEGER NOT NULL,
  ea_league_id    INTEGER NOT NULL,
  team_id         INTEGER NOT NULL,
  full_name       TEXT NOT NULL DEFAULT '',
  nick_name       TEXT NOT NULL DEFAULT '',
  abbr_name       TEXT,
  conference      TEXT,
  div_name        TEXT,
  user_name       TEXT NOT NULL DEFAULT 'CPU',
  is_human        BOOLEAN NOT NULL DEFAULT FALSE,
  off_scheme      TEXT,
  def_scheme      TEXT,
  ovr_rating      INTEGER,
  primary_color   INTEGER,
  secondary_color INTEGER,
  logo_id         INTEGER,
  raw_json        JSON,
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_teams_season_team_idx ON mca_teams (ea_season_id, team_id);

-- mca_rosters
CREATE TABLE IF NOT EXISTS mca_rosters (
  id                  SERIAL PRIMARY KEY,
  ea_season_id        INTEGER NOT NULL,
  ea_league_id        INTEGER NOT NULL,
  team_id             INTEGER NOT NULL,
  team_name           TEXT NOT NULL DEFAULT '',
  player_id           INTEGER NOT NULL,
  first_name          TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  position            TEXT NOT NULL DEFAULT '',
  overall             INTEGER NOT NULL DEFAULT 0,
  dev_trait           INTEGER NOT NULL DEFAULT 0,
  age                 INTEGER,
  jersey_num          INTEGER,
  contract_years_left INTEGER,
  archetype_abbrev    TEXT,
  xp_total            INTEGER,
  attributes          JSON,
  abilities           JSON,
  portrait_url        TEXT,
  raw_json            JSON,
  imported_at         TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_rosters_player_season_idx
  ON mca_rosters (ea_season_id, team_id, player_id);

-- mca_team_stats
CREATE TABLE IF NOT EXISTS mca_team_stats (
  id              SERIAL PRIMARY KEY,
  ea_season_id    INTEGER NOT NULL,
  ea_league_id    INTEGER NOT NULL,
  team_id         INTEGER NOT NULL,
  team_name       TEXT NOT NULL DEFAULT '',
  wins            INTEGER NOT NULL DEFAULT 0,
  losses          INTEGER NOT NULL DEFAULT 0,
  ties            INTEGER NOT NULL DEFAULT 0,
  pts_for         INTEGER NOT NULL DEFAULT 0,
  pts_against     INTEGER NOT NULL DEFAULT 0,
  off_yds         INTEGER NOT NULL DEFAULT 0,
  off_pass_yds    INTEGER NOT NULL DEFAULT 0,
  off_rush_yds    INTEGER NOT NULL DEFAULT 0,
  off_tds         INTEGER NOT NULL DEFAULT 0,
  off_pts_per_game REAL NOT NULL DEFAULT 0,
  def_pass_yds    INTEGER NOT NULL DEFAULT 0,
  def_rush_yds    INTEGER NOT NULL DEFAULT 0,
  def_tds         INTEGER NOT NULL DEFAULT 0,
  team_sacks      INTEGER NOT NULL DEFAULT 0,
  team_ints       INTEGER NOT NULL DEFAULT 0,
  def_fumbles_rec INTEGER NOT NULL DEFAULT 0,
  off_redzone_pct REAL NOT NULL DEFAULT 0,
  def_redzone_pct REAL NOT NULL DEFAULT 0,
  to_takeaways    INTEGER NOT NULL DEFAULT 0,
  to_giveaways    INTEGER NOT NULL DEFAULT 0,
  turnover_diff   INTEGER NOT NULL DEFAULT 0,
  home_wins       INTEGER NOT NULL DEFAULT 0,
  home_losses     INTEGER NOT NULL DEFAULT 0,
  away_wins       INTEGER NOT NULL DEFAULT 0,
  away_losses     INTEGER NOT NULL DEFAULT 0,
  conf_wins       INTEGER NOT NULL DEFAULT 0,
  conf_losses     INTEGER NOT NULL DEFAULT 0,
  div_wins        INTEGER NOT NULL DEFAULT 0,
  div_losses      INTEGER NOT NULL DEFAULT 0,
  seed            INTEGER,
  rank            INTEGER,
  playoff_status  TEXT,
  win_pct         REAL NOT NULL DEFAULT 0,
  net_pts         INTEGER NOT NULL DEFAULT 0,
  raw_json        JSON,
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_team_stats_season_team_idx ON mca_team_stats (ea_season_id, team_id);

-- mca_team_week_stats
CREATE TABLE IF NOT EXISTS mca_team_week_stats (
  id             SERIAL PRIMARY KEY,
  ea_season_id   INTEGER NOT NULL,
  ea_league_id   INTEGER NOT NULL,
  week_type      TEXT NOT NULL,
  week_num       INTEGER NOT NULL,
  team_id        INTEGER NOT NULL,
  team_name      TEXT NOT NULL DEFAULT '',
  off_pass_yds   INTEGER NOT NULL DEFAULT 0,
  off_rush_yds   INTEGER NOT NULL DEFAULT 0,
  off_yds        INTEGER NOT NULL DEFAULT 0,
  off_tds        INTEGER NOT NULL DEFAULT 0,
  def_pass_yds   INTEGER NOT NULL DEFAULT 0,
  def_rush_yds   INTEGER NOT NULL DEFAULT 0,
  def_tds        INTEGER NOT NULL DEFAULT 0,
  team_sacks     INTEGER NOT NULL DEFAULT 0,
  team_ints      INTEGER NOT NULL DEFAULT 0,
  def_fumbles_rec INTEGER NOT NULL DEFAULT 0,
  turnover_diff  INTEGER NOT NULL DEFAULT 0,
  to_takeaways   INTEGER NOT NULL DEFAULT 0,
  to_giveaways   INTEGER NOT NULL DEFAULT 0,
  raw_json       JSON,
  processed_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_team_week_stats_idx
  ON mca_team_week_stats (ea_season_id, week_type, week_num, team_id);

-- mca_schedules
CREATE TABLE IF NOT EXISTS mca_schedules (
  id             SERIAL PRIMARY KEY,
  ea_season_id   INTEGER NOT NULL,
  ea_league_id   INTEGER NOT NULL,
  week_index     INTEGER NOT NULL,
  week_type      TEXT NOT NULL DEFAULT 'reg',
  home_team_id   INTEGER NOT NULL,
  away_team_id   INTEGER NOT NULL,
  home_team_name TEXT NOT NULL DEFAULT '',
  away_team_name TEXT NOT NULL DEFAULT '',
  home_score     INTEGER,
  away_score     INTEGER,
  status         INTEGER NOT NULL DEFAULT 0,
  raw_json       JSON
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_schedules_idx
  ON mca_schedules (ea_season_id, week_index, home_team_id, away_team_id);

-- mca_player_stats
CREATE TABLE IF NOT EXISTS mca_player_stats (
  id                    SERIAL PRIMARY KEY,
  ea_season_id          INTEGER NOT NULL,
  ea_league_id          INTEGER NOT NULL,
  player_id             INTEGER NOT NULL,
  team_id               INTEGER NOT NULL,
  team_name             TEXT NOT NULL DEFAULT '',
  first_name            TEXT NOT NULL DEFAULT '',
  last_name             TEXT NOT NULL DEFAULT '',
  position              TEXT NOT NULL DEFAULT '',
  -- passing
  pass_yds              INTEGER NOT NULL DEFAULT 0,
  pass_tds              INTEGER NOT NULL DEFAULT 0,
  pass_att              INTEGER NOT NULL DEFAULT 0,
  pass_comp             INTEGER NOT NULL DEFAULT 0,
  pass_ints             INTEGER NOT NULL DEFAULT 0,
  times_sacked          INTEGER NOT NULL DEFAULT 0,
  pass_longest          INTEGER NOT NULL DEFAULT 0,
  pass_pts              REAL NOT NULL DEFAULT 0,
  passer_rating         REAL NOT NULL DEFAULT 0,
  pass_comp_pct         REAL NOT NULL DEFAULT 0,
  pass_yds_per_att      REAL NOT NULL DEFAULT 0,
  pass_yds_per_game     REAL NOT NULL DEFAULT 0,
  -- rushing
  rush_yds              INTEGER NOT NULL DEFAULT 0,
  rush_tds              INTEGER NOT NULL DEFAULT 0,
  rush_att              INTEGER NOT NULL DEFAULT 0,
  rush_longest          INTEGER NOT NULL DEFAULT 0,
  fumbles               INTEGER NOT NULL DEFAULT 0,
  rush_20plus_yds       INTEGER NOT NULL DEFAULT 0,
  rush_broken_tackles   INTEGER NOT NULL DEFAULT 0,
  rush_yds_after_contact INTEGER NOT NULL DEFAULT 0,
  rush_pts              REAL NOT NULL DEFAULT 0,
  rush_to_pct           REAL NOT NULL DEFAULT 0,
  rush_yds_per_att      REAL NOT NULL DEFAULT 0,
  rush_yds_per_game     REAL NOT NULL DEFAULT 0,
  -- receiving
  rec_yds               INTEGER NOT NULL DEFAULT 0,
  rec_tds               INTEGER NOT NULL DEFAULT 0,
  rec_rec               INTEGER NOT NULL DEFAULT 0,
  rec_drops             INTEGER NOT NULL DEFAULT 0,
  rec_longest           INTEGER NOT NULL DEFAULT 0,
  rec_pts               REAL NOT NULL DEFAULT 0,
  rec_yds_after_catch   INTEGER NOT NULL DEFAULT 0,
  rec_catch_pct         REAL NOT NULL DEFAULT 0,
  rec_to_pct            REAL NOT NULL DEFAULT 0,
  rec_yac_per_catch     REAL NOT NULL DEFAULT 0,
  rec_yds_per_catch     REAL NOT NULL DEFAULT 0,
  rec_yds_per_game      REAL NOT NULL DEFAULT 0,
  -- defense
  sacks                 REAL NOT NULL DEFAULT 0,
  def_ints              INTEGER NOT NULL DEFAULT 0,
  total_tackles         INTEGER NOT NULL DEFAULT 0,
  tackle_solo           INTEGER NOT NULL DEFAULT 0,
  tackle_assist         INTEGER NOT NULL DEFAULT 0,
  def_fumbles_rec       INTEGER NOT NULL DEFAULT 0,
  forced_fumbles        INTEGER NOT NULL DEFAULT 0,
  tackles_for_loss      INTEGER NOT NULL DEFAULT 0,
  def_tds               INTEGER NOT NULL DEFAULT 0,
  def_catch_allowed     INTEGER NOT NULL DEFAULT 0,
  def_deflections       INTEGER NOT NULL DEFAULT 0,
  def_int_return_yds    INTEGER NOT NULL DEFAULT 0,
  def_pts               REAL NOT NULL DEFAULT 0,
  def_safeties          INTEGER NOT NULL DEFAULT 0,
  -- kicking
  fg_made               INTEGER NOT NULL DEFAULT 0,
  fg_att                INTEGER NOT NULL DEFAULT 0,
  fg_long               INTEGER NOT NULL DEFAULT 0,
  xp_made               INTEGER NOT NULL DEFAULT 0,
  xp_att                INTEGER NOT NULL DEFAULT 0,
  fg_50plus_att         INTEGER NOT NULL DEFAULT 0,
  fg_50plus_made        INTEGER NOT NULL DEFAULT 0,
  kick_pts              REAL NOT NULL DEFAULT 0,
  kickoff_att           INTEGER NOT NULL DEFAULT 0,
  kickoff_tbs           INTEGER NOT NULL DEFAULT 0,
  fg_comp_pct           REAL NOT NULL DEFAULT 0,
  xp_comp_pct           REAL NOT NULL DEFAULT 0,
  -- punting
  punt_att              INTEGER NOT NULL DEFAULT 0,
  punt_yds              INTEGER NOT NULL DEFAULT 0,
  punt_long             INTEGER NOT NULL DEFAULT 0,
  punt_in_20            INTEGER NOT NULL DEFAULT 0,
  punt_touchbacks       INTEGER NOT NULL DEFAULT 0,
  punt_net_yds          INTEGER NOT NULL DEFAULT 0,
  punts_blocked         INTEGER NOT NULL DEFAULT 0,
  punt_net_yds_per_att  REAL NOT NULL DEFAULT 0,
  -- returns
  kr_att                INTEGER NOT NULL DEFAULT 0,
  kr_yds                INTEGER NOT NULL DEFAULT 0,
  kr_tds                INTEGER NOT NULL DEFAULT 0,
  pr_att                INTEGER NOT NULL DEFAULT 0,
  pr_yds                INTEGER NOT NULL DEFAULT 0,
  pr_tds                INTEGER NOT NULL DEFAULT 0,
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_player_stats_idx
  ON mca_player_stats (ea_season_id, player_id, team_id);

-- mca_player_week_stats
CREATE TABLE IF NOT EXISTS mca_player_week_stats (
  id             SERIAL PRIMARY KEY,
  ea_season_id   INTEGER NOT NULL,
  ea_league_id   INTEGER NOT NULL,
  week_type      TEXT NOT NULL,
  week_num       INTEGER NOT NULL,
  stat_type      TEXT NOT NULL,
  player_id      INTEGER NOT NULL,
  team_id        INTEGER NOT NULL,
  team_name      TEXT NOT NULL DEFAULT '',
  first_name     TEXT NOT NULL DEFAULT '',
  last_name      TEXT NOT NULL DEFAULT '',
  position       TEXT NOT NULL DEFAULT '',
  pass_yds       INTEGER NOT NULL DEFAULT 0,
  pass_tds       INTEGER NOT NULL DEFAULT 0,
  pass_att       INTEGER NOT NULL DEFAULT 0,
  pass_comp      INTEGER NOT NULL DEFAULT 0,
  pass_ints      INTEGER NOT NULL DEFAULT 0,
  times_sacked   INTEGER NOT NULL DEFAULT 0,
  passer_rating  REAL NOT NULL DEFAULT 0,
  rush_yds       INTEGER NOT NULL DEFAULT 0,
  rush_tds       INTEGER NOT NULL DEFAULT 0,
  rush_att       INTEGER NOT NULL DEFAULT 0,
  fumbles        INTEGER NOT NULL DEFAULT 0,
  rec_yds        INTEGER NOT NULL DEFAULT 0,
  rec_tds        INTEGER NOT NULL DEFAULT 0,
  rec_rec        INTEGER NOT NULL DEFAULT 0,
  rec_drops      INTEGER NOT NULL DEFAULT 0,
  sacks          REAL NOT NULL DEFAULT 0,
  def_ints       INTEGER NOT NULL DEFAULT 0,
  total_tackles  INTEGER NOT NULL DEFAULT 0,
  forced_fumbles INTEGER NOT NULL DEFAULT 0,
  def_tds        INTEGER NOT NULL DEFAULT 0,
  fg_made        INTEGER NOT NULL DEFAULT 0,
  fg_att         INTEGER NOT NULL DEFAULT 0,
  xp_made        INTEGER NOT NULL DEFAULT 0,
  xp_att         INTEGER NOT NULL DEFAULT 0,
  punt_att       INTEGER NOT NULL DEFAULT 0,
  punt_yds       INTEGER NOT NULL DEFAULT 0,
  kr_yds         INTEGER NOT NULL DEFAULT 0,
  kr_tds         INTEGER NOT NULL DEFAULT 0,
  pr_yds         INTEGER NOT NULL DEFAULT 0,
  pr_tds         INTEGER NOT NULL DEFAULT 0,
  raw_json       JSON,
  processed_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_player_week_stats_idx
  ON mca_player_week_stats (ea_season_id, week_type, week_num, stat_type, player_id);

-- mca_week_processed
CREATE TABLE IF NOT EXISTS mca_week_processed (
  id           SERIAL PRIMARY KEY,
  ea_season_id INTEGER NOT NULL,
  week_type    TEXT NOT NULL,
  week_num     INTEGER NOT NULL,
  stat_type    TEXT NOT NULL,
  processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_week_processed_idx
  ON mca_week_processed (ea_season_id, week_type, week_num, stat_type);

-- app_ea_connections  (PK = gamertag; FK → app_users.gamertag)
CREATE TABLE IF NOT EXISTS app_ea_connections (
  gamertag       TEXT PRIMARY KEY REFERENCES app_users(gamertag),
  ea_persona_name TEXT NOT NULL,
  platform       TEXT NOT NULL,
  blaze_id       TEXT NOT NULL,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL DEFAULT '',
  expiry         TIMESTAMP NOT NULL,
  connected_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- mca_draft_picks
CREATE TABLE IF NOT EXISTS mca_draft_picks (
  id                SERIAL PRIMARY KEY,
  ea_season_id      INTEGER NOT NULL,
  ea_league_id      INTEGER NOT NULL,
  team_id           INTEGER NOT NULL,
  team_name         TEXT NOT NULL DEFAULT '',
  draft_year        INTEGER NOT NULL,
  round             INTEGER NOT NULL,
  pick_num          INTEGER NOT NULL DEFAULT 0,
  original_team_id  INTEGER,
  original_team_name TEXT,
  raw_json          JSON,
  imported_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_draft_picks_idx
  ON mca_draft_picks (ea_season_id, team_id, draft_year, round, pick_num);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4: VERIFICATION QUERY
-- Run this after the script to confirm all 77 tables were created.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  table_name,
  (SELECT COUNT(*) FROM information_schema.columns c
   WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
