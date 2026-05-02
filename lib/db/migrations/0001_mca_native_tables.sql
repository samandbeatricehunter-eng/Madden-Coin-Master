-- Migration: Madden-native data layer (task #25)
-- All tables scoped purely by ea_league_id; no Discord guild IDs.
-- Run once against any environment that does not yet have these tables.
-- Uses IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS app_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  gamertag      TEXT        NOT NULL UNIQUE,
  email         TEXT        UNIQUE,
  display_name  TEXT        NOT NULL DEFAULT '',
  platform      TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_user_league_links (
  id            SERIAL      PRIMARY KEY,
  gamertag      TEXT        NOT NULL REFERENCES app_users(gamertag),
  ea_league_id  INTEGER     NOT NULL,
  team_id       INTEGER,
  team_name     TEXT,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_user_league_links_idx
  ON app_user_league_links (gamertag, ea_league_id);

CREATE TABLE IF NOT EXISTS mca_leagues (
  ea_league_id  INTEGER     PRIMARY KEY,
  league_name   TEXT        NOT NULL DEFAULT '',
  platform      TEXT        NOT NULL DEFAULT 'pc',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mca_seasons (
  id             SERIAL      PRIMARY KEY,
  ea_league_id   INTEGER     NOT NULL,
  season_number  INTEGER     NOT NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  current_week   TEXT        NOT NULL DEFAULT '1',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_seasons_league_season_idx
  ON mca_seasons (ea_league_id, season_number);

CREATE TABLE IF NOT EXISTS mca_teams (
  id              SERIAL      PRIMARY KEY,
  ea_season_id    INTEGER     NOT NULL,
  ea_league_id    INTEGER     NOT NULL,
  team_id         INTEGER     NOT NULL,
  full_name       TEXT        NOT NULL DEFAULT '',
  nick_name       TEXT        NOT NULL DEFAULT '',
  abbr_name       TEXT,
  conference      TEXT,
  div_name        TEXT,
  user_name       TEXT        NOT NULL DEFAULT 'CPU',
  is_human        BOOLEAN     NOT NULL DEFAULT FALSE,
  off_scheme      TEXT,
  def_scheme      TEXT,
  ovr_rating      INTEGER,
  primary_color   INTEGER,
  secondary_color INTEGER,
  logo_id         INTEGER,
  raw_json        JSON,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_teams_season_team_idx
  ON mca_teams (ea_season_id, team_id);

CREATE TABLE IF NOT EXISTS mca_rosters (
  id                    SERIAL      PRIMARY KEY,
  ea_season_id          INTEGER     NOT NULL,
  ea_league_id          INTEGER     NOT NULL,
  team_id               INTEGER     NOT NULL,
  team_name             TEXT        NOT NULL DEFAULT '',
  player_id             INTEGER     NOT NULL,
  first_name            TEXT        NOT NULL DEFAULT '',
  last_name             TEXT        NOT NULL DEFAULT '',
  position              TEXT        NOT NULL DEFAULT '',
  overall               INTEGER     NOT NULL DEFAULT 0,
  dev_trait             INTEGER     NOT NULL DEFAULT 0,
  age                   INTEGER,
  jersey_num            INTEGER,
  contract_years_left   INTEGER,
  archetype_abbrev      TEXT,
  xp_total              INTEGER,
  attributes            JSON,
  abilities             JSON,
  portrait_url          TEXT,
  raw_json              JSON,
  imported_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_rosters_player_season_idx
  ON mca_rosters (ea_season_id, team_id, player_id);

CREATE TABLE IF NOT EXISTS mca_team_stats (
  id              SERIAL      PRIMARY KEY,
  ea_season_id    INTEGER     NOT NULL,
  ea_league_id    INTEGER     NOT NULL,
  team_id         INTEGER     NOT NULL,
  team_name       TEXT        NOT NULL DEFAULT '',
  wins            INTEGER     NOT NULL DEFAULT 0,
  losses          INTEGER     NOT NULL DEFAULT 0,
  ties            INTEGER     NOT NULL DEFAULT 0,
  pts_for         INTEGER     NOT NULL DEFAULT 0,
  pts_against     INTEGER     NOT NULL DEFAULT 0,
  off_yds         INTEGER     NOT NULL DEFAULT 0,
  off_pass_yds    INTEGER     NOT NULL DEFAULT 0,
  off_rush_yds    INTEGER     NOT NULL DEFAULT 0,
  off_tds         INTEGER     NOT NULL DEFAULT 0,
  off_pts_per_game REAL       NOT NULL DEFAULT 0,
  def_pass_yds    INTEGER     NOT NULL DEFAULT 0,
  def_rush_yds    INTEGER     NOT NULL DEFAULT 0,
  def_tds         INTEGER     NOT NULL DEFAULT 0,
  team_sacks      INTEGER     NOT NULL DEFAULT 0,
  team_ints       INTEGER     NOT NULL DEFAULT 0,
  def_fumbles_rec INTEGER     NOT NULL DEFAULT 0,
  off_redzone_pct REAL        NOT NULL DEFAULT 0,
  def_redzone_pct REAL        NOT NULL DEFAULT 0,
  to_takeaways    INTEGER     NOT NULL DEFAULT 0,
  to_giveaways    INTEGER     NOT NULL DEFAULT 0,
  turnover_diff   INTEGER     NOT NULL DEFAULT 0,
  home_wins       INTEGER     NOT NULL DEFAULT 0,
  home_losses     INTEGER     NOT NULL DEFAULT 0,
  away_wins       INTEGER     NOT NULL DEFAULT 0,
  away_losses     INTEGER     NOT NULL DEFAULT 0,
  conf_wins       INTEGER     NOT NULL DEFAULT 0,
  conf_losses     INTEGER     NOT NULL DEFAULT 0,
  div_wins        INTEGER     NOT NULL DEFAULT 0,
  div_losses      INTEGER     NOT NULL DEFAULT 0,
  seed            INTEGER,
  rank            INTEGER,
  playoff_status  TEXT,
  win_pct         REAL        NOT NULL DEFAULT 0,
  net_pts         INTEGER     NOT NULL DEFAULT 0,
  raw_json        JSON,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_team_stats_season_team_idx
  ON mca_team_stats (ea_season_id, team_id);

CREATE TABLE IF NOT EXISTS mca_team_week_stats (
  id              SERIAL      PRIMARY KEY,
  ea_season_id    INTEGER     NOT NULL,
  ea_league_id    INTEGER     NOT NULL,
  week_type       TEXT        NOT NULL,
  week_num        INTEGER     NOT NULL,
  team_id         INTEGER     NOT NULL,
  team_name       TEXT        NOT NULL DEFAULT '',
  off_pass_yds    INTEGER     NOT NULL DEFAULT 0,
  off_rush_yds    INTEGER     NOT NULL DEFAULT 0,
  off_yds         INTEGER     NOT NULL DEFAULT 0,
  off_tds         INTEGER     NOT NULL DEFAULT 0,
  def_pass_yds    INTEGER     NOT NULL DEFAULT 0,
  def_rush_yds    INTEGER     NOT NULL DEFAULT 0,
  def_tds         INTEGER     NOT NULL DEFAULT 0,
  team_sacks      INTEGER     NOT NULL DEFAULT 0,
  team_ints       INTEGER     NOT NULL DEFAULT 0,
  def_fumbles_rec INTEGER     NOT NULL DEFAULT 0,
  turnover_diff   INTEGER     NOT NULL DEFAULT 0,
  to_takeaways    INTEGER     NOT NULL DEFAULT 0,
  to_giveaways    INTEGER     NOT NULL DEFAULT 0,
  raw_json        JSON,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_team_week_stats_idx
  ON mca_team_week_stats (ea_season_id, week_type, week_num, team_id);

CREATE TABLE IF NOT EXISTS mca_schedules (
  id              SERIAL      PRIMARY KEY,
  ea_season_id    INTEGER     NOT NULL,
  ea_league_id    INTEGER     NOT NULL,
  week_index      INTEGER     NOT NULL,
  week_type       TEXT        NOT NULL DEFAULT 'reg',
  home_team_id    INTEGER     NOT NULL,
  away_team_id    INTEGER     NOT NULL,
  home_team_name  TEXT        NOT NULL DEFAULT '',
  away_team_name  TEXT        NOT NULL DEFAULT '',
  home_score      INTEGER,
  away_score      INTEGER,
  status          INTEGER     NOT NULL DEFAULT 0,
  raw_json        JSON
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_schedules_idx
  ON mca_schedules (ea_season_id, week_index, home_team_id, away_team_id);

CREATE TABLE IF NOT EXISTS mca_player_stats (
  id                      SERIAL      PRIMARY KEY,
  ea_season_id            INTEGER     NOT NULL,
  ea_league_id            INTEGER     NOT NULL,
  player_id               INTEGER     NOT NULL,
  team_id                 INTEGER     NOT NULL,
  team_name               TEXT        NOT NULL DEFAULT '',
  first_name              TEXT        NOT NULL DEFAULT '',
  last_name               TEXT        NOT NULL DEFAULT '',
  position                TEXT        NOT NULL DEFAULT '',
  pass_yds                INTEGER     NOT NULL DEFAULT 0,
  pass_tds                INTEGER     NOT NULL DEFAULT 0,
  pass_att                INTEGER     NOT NULL DEFAULT 0,
  pass_comp               INTEGER     NOT NULL DEFAULT 0,
  pass_ints               INTEGER     NOT NULL DEFAULT 0,
  times_sacked            INTEGER     NOT NULL DEFAULT 0,
  pass_longest            INTEGER     NOT NULL DEFAULT 0,
  pass_pts                REAL        NOT NULL DEFAULT 0,
  passer_rating           REAL        NOT NULL DEFAULT 0,
  pass_comp_pct           REAL        NOT NULL DEFAULT 0,
  pass_yds_per_att        REAL        NOT NULL DEFAULT 0,
  pass_yds_per_game       REAL        NOT NULL DEFAULT 0,
  rush_yds                INTEGER     NOT NULL DEFAULT 0,
  rush_tds                INTEGER     NOT NULL DEFAULT 0,
  rush_att                INTEGER     NOT NULL DEFAULT 0,
  rush_longest            INTEGER     NOT NULL DEFAULT 0,
  fumbles                 INTEGER     NOT NULL DEFAULT 0,
  rush_20plus_yds         INTEGER     NOT NULL DEFAULT 0,
  rush_broken_tackles     INTEGER     NOT NULL DEFAULT 0,
  rush_yds_after_contact  INTEGER     NOT NULL DEFAULT 0,
  rush_pts                REAL        NOT NULL DEFAULT 0,
  rush_to_pct             REAL        NOT NULL DEFAULT 0,
  rush_yds_per_att        REAL        NOT NULL DEFAULT 0,
  rush_yds_per_game       REAL        NOT NULL DEFAULT 0,
  rec_yds                 INTEGER     NOT NULL DEFAULT 0,
  rec_tds                 INTEGER     NOT NULL DEFAULT 0,
  rec_rec                 INTEGER     NOT NULL DEFAULT 0,
  rec_drops               INTEGER     NOT NULL DEFAULT 0,
  rec_longest             INTEGER     NOT NULL DEFAULT 0,
  rec_pts                 REAL        NOT NULL DEFAULT 0,
  rec_yds_after_catch     INTEGER     NOT NULL DEFAULT 0,
  rec_catch_pct           REAL        NOT NULL DEFAULT 0,
  rec_to_pct              REAL        NOT NULL DEFAULT 0,
  rec_yac_per_catch       REAL        NOT NULL DEFAULT 0,
  rec_yds_per_catch       REAL        NOT NULL DEFAULT 0,
  rec_yds_per_game        REAL        NOT NULL DEFAULT 0,
  sacks                   REAL        NOT NULL DEFAULT 0,
  def_ints                INTEGER     NOT NULL DEFAULT 0,
  total_tackles           INTEGER     NOT NULL DEFAULT 0,
  tackle_solo             INTEGER     NOT NULL DEFAULT 0,
  tackle_assist           INTEGER     NOT NULL DEFAULT 0,
  def_fumbles_rec         INTEGER     NOT NULL DEFAULT 0,
  forced_fumbles          INTEGER     NOT NULL DEFAULT 0,
  tackles_for_loss        INTEGER     NOT NULL DEFAULT 0,
  def_tds                 INTEGER     NOT NULL DEFAULT 0,
  def_catch_allowed       INTEGER     NOT NULL DEFAULT 0,
  def_deflections         INTEGER     NOT NULL DEFAULT 0,
  def_int_return_yds      INTEGER     NOT NULL DEFAULT 0,
  def_pts                 REAL        NOT NULL DEFAULT 0,
  def_safeties            INTEGER     NOT NULL DEFAULT 0,
  fg_made                 INTEGER     NOT NULL DEFAULT 0,
  fg_att                  INTEGER     NOT NULL DEFAULT 0,
  fg_long                 INTEGER     NOT NULL DEFAULT 0,
  xp_made                 INTEGER     NOT NULL DEFAULT 0,
  xp_att                  INTEGER     NOT NULL DEFAULT 0,
  fg_50plus_att           INTEGER     NOT NULL DEFAULT 0,
  fg_50plus_made          INTEGER     NOT NULL DEFAULT 0,
  kick_pts                REAL        NOT NULL DEFAULT 0,
  kickoff_att             INTEGER     NOT NULL DEFAULT 0,
  kickoff_tbs             INTEGER     NOT NULL DEFAULT 0,
  fg_comp_pct             REAL        NOT NULL DEFAULT 0,
  xp_comp_pct             REAL        NOT NULL DEFAULT 0,
  punt_att                INTEGER     NOT NULL DEFAULT 0,
  punt_yds                INTEGER     NOT NULL DEFAULT 0,
  punt_long               INTEGER     NOT NULL DEFAULT 0,
  punt_in_20              INTEGER     NOT NULL DEFAULT 0,
  punt_touchbacks         INTEGER     NOT NULL DEFAULT 0,
  punt_net_yds            INTEGER     NOT NULL DEFAULT 0,
  punts_blocked           INTEGER     NOT NULL DEFAULT 0,
  punt_net_yds_per_att    REAL        NOT NULL DEFAULT 0,
  kr_att                  INTEGER     NOT NULL DEFAULT 0,
  kr_yds                  INTEGER     NOT NULL DEFAULT 0,
  kr_tds                  INTEGER     NOT NULL DEFAULT 0,
  pr_att                  INTEGER     NOT NULL DEFAULT 0,
  pr_yds                  INTEGER     NOT NULL DEFAULT 0,
  pr_tds                  INTEGER     NOT NULL DEFAULT 0,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_player_stats_idx
  ON mca_player_stats (ea_season_id, player_id, team_id);

CREATE TABLE IF NOT EXISTS mca_player_week_stats (
  id            SERIAL      PRIMARY KEY,
  ea_season_id  INTEGER     NOT NULL,
  ea_league_id  INTEGER     NOT NULL,
  week_type     TEXT        NOT NULL,
  week_num      INTEGER     NOT NULL,
  stat_type     TEXT        NOT NULL,
  player_id     INTEGER     NOT NULL,
  team_id       INTEGER     NOT NULL,
  team_name     TEXT        NOT NULL DEFAULT '',
  first_name    TEXT        NOT NULL DEFAULT '',
  last_name     TEXT        NOT NULL DEFAULT '',
  position      TEXT        NOT NULL DEFAULT '',
  pass_yds      INTEGER     NOT NULL DEFAULT 0,
  pass_tds      INTEGER     NOT NULL DEFAULT 0,
  pass_att      INTEGER     NOT NULL DEFAULT 0,
  pass_comp     INTEGER     NOT NULL DEFAULT 0,
  pass_ints     INTEGER     NOT NULL DEFAULT 0,
  times_sacked  INTEGER     NOT NULL DEFAULT 0,
  passer_rating REAL        NOT NULL DEFAULT 0,
  rush_yds      INTEGER     NOT NULL DEFAULT 0,
  rush_tds      INTEGER     NOT NULL DEFAULT 0,
  rush_att      INTEGER     NOT NULL DEFAULT 0,
  fumbles       INTEGER     NOT NULL DEFAULT 0,
  rec_yds       INTEGER     NOT NULL DEFAULT 0,
  rec_tds       INTEGER     NOT NULL DEFAULT 0,
  rec_rec       INTEGER     NOT NULL DEFAULT 0,
  rec_drops     INTEGER     NOT NULL DEFAULT 0,
  sacks         REAL        NOT NULL DEFAULT 0,
  def_ints      INTEGER     NOT NULL DEFAULT 0,
  total_tackles INTEGER     NOT NULL DEFAULT 0,
  forced_fumbles INTEGER    NOT NULL DEFAULT 0,
  def_tds       INTEGER     NOT NULL DEFAULT 0,
  fg_made       INTEGER     NOT NULL DEFAULT 0,
  fg_att        INTEGER     NOT NULL DEFAULT 0,
  xp_made       INTEGER     NOT NULL DEFAULT 0,
  xp_att        INTEGER     NOT NULL DEFAULT 0,
  punt_att      INTEGER     NOT NULL DEFAULT 0,
  punt_yds      INTEGER     NOT NULL DEFAULT 0,
  kr_yds        INTEGER     NOT NULL DEFAULT 0,
  kr_tds        INTEGER     NOT NULL DEFAULT 0,
  pr_yds        INTEGER     NOT NULL DEFAULT 0,
  pr_tds        INTEGER     NOT NULL DEFAULT 0,
  raw_json      JSON,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_player_week_stats_idx
  ON mca_player_week_stats (ea_season_id, week_type, week_num, stat_type, player_id);

CREATE TABLE IF NOT EXISTS mca_week_processed (
  id            SERIAL      PRIMARY KEY,
  ea_season_id  INTEGER     NOT NULL,
  week_type     TEXT        NOT NULL,
  week_num      INTEGER     NOT NULL,
  stat_type     TEXT        NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_week_processed_idx
  ON mca_week_processed (ea_season_id, week_type, week_num, stat_type);

CREATE TABLE IF NOT EXISTS mca_draft_picks (
  id                  SERIAL      PRIMARY KEY,
  ea_season_id        INTEGER     NOT NULL,
  ea_league_id        INTEGER     NOT NULL,
  team_id             INTEGER     NOT NULL,
  team_name           TEXT        NOT NULL DEFAULT '',
  draft_year          INTEGER     NOT NULL,
  round               INTEGER     NOT NULL,
  pick_num            INTEGER     NOT NULL DEFAULT 0,
  original_team_id    INTEGER,
  original_team_name  TEXT,
  raw_json            JSON,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mca_draft_picks_idx
  ON mca_draft_picks (ea_season_id, team_id, draft_year, round, pick_num);
