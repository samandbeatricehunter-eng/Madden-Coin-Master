-- Consolidated gameday/scheduling rebuild support.
-- Safe to run multiple times. Keeps existing data and moves runtime table creation into SQL.

create table if not exists gameday_schedule_offers (
  id serial primary key,
  guild_id text not null,
  season_id integer not null,
  week_index integer not null,
  matchup_key text not null,
  proposer_discord_id text not null,
  recipient_discord_id text not null,
  away_discord_id text not null,
  home_discord_id text not null,
  away_team_name text not null,
  home_team_name text not null,
  proposed_for text not null,
  proposed_tz text,
  notes text,
  status text not null default 'pending',
  accepted_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists gameday_matchup_status (
  id serial primary key,
  guild_id text not null,
  season_id integer not null,
  week_index integer not null,
  matchup_key text not null,
  away_discord_id text not null,
  home_discord_id text not null,
  away_team_name text not null,
  home_team_name text not null,
  away_checked_in boolean not null default false,
  home_checked_in boolean not null default false,
  search_advised_by text,
  invite_requested_by text,
  begun_by text,
  begun_at timestamp with time zone,
  stream_url text,
  stream_paid_to text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique(guild_id, season_id, week_index, matchup_key)
);

create table if not exists gameday_score_submissions (
  id serial primary key,
  guild_id text not null,
  season_id integer not null,
  week_index integer not null,
  matchup_key text not null,
  away_discord_id text not null,
  home_discord_id text not null,
  away_team_name text not null,
  home_team_name text not null,
  submitted_by text not null,
  opponent_discord_id text not null,
  away_score integer not null,
  home_score integer not null,
  winner_discord_id text,
  status text not null default 'pending',
  dispute_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists gameday_cpu_actions (
  id serial primary key,
  guild_id text not null,
  season_id integer not null,
  week_index integer not null,
  user_discord_id text not null,
  user_team_name text,
  cpu_team_name text,
  schedule_id integer,
  cpu_stream_link text,
  cpu_stream_paid boolean not null default false,
  cpu_stream_paid_amount integer not null default 0,
  cpu_stream_payment_reversed boolean not null default false,
  fw_requested boolean not null default false,
  fw_status text,
  fw_retracted_for_stream boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique(guild_id, season_id, week_index, user_discord_id)
);

create table if not exists gameday_advance_overrides (
  id serial primary key,
  guild_id text not null,
  season_id integer not null,
  week_index integer not null,
  requested_by text,
  approved_by text,
  advance_at_utc timestamp with time zone not null,
  tz text not null,
  reason text,
  status text not null default 'active',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists gameday_commissioner_requests (
  id serial primary key,
  guild_id text not null,
  season_id integer not null,
  week_index integer not null,
  matchup_key text not null,
  request_type text not null,
  requested_by text not null,
  opponent_discord_id text,
  reason text,
  status text not null default 'pending',
  message_id text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists gameday_schedule_offers_lookup_idx on gameday_schedule_offers(guild_id, season_id, week_index, matchup_key, status);
create index if not exists gameday_schedule_offers_recipient_idx on gameday_schedule_offers(guild_id, recipient_discord_id, status);
create index if not exists gameday_schedule_offers_proposer_idx on gameday_schedule_offers(guild_id, proposer_discord_id, status);
create index if not exists gameday_score_submissions_lookup_idx on gameday_score_submissions(guild_id, season_id, week_index, matchup_key, status);
create index if not exists gameday_score_submissions_opp_idx on gameday_score_submissions(guild_id, opponent_discord_id, status);
create index if not exists gameday_cpu_actions_lookup_idx on gameday_cpu_actions(guild_id, season_id, week_index, user_discord_id);
create index if not exists game_schedules_matchup_idx on game_schedules(guild_id, season_id, week_index, away_discord_id, home_discord_id);
create index if not exists game_schedules_status_idx on game_schedules(guild_id, season_id, week_index, status);
create index if not exists game_schedules_winner_idx on game_schedules(guild_id, season_id, week_index, winner_discord_id);
create index if not exists franchise_schedule_week_idx on franchise_schedule(season_id, week_index);
create index if not exists franchise_schedule_processed_game_idx on franchise_schedule(processed_game_id) where processed_game_id is not null;
create index if not exists franchise_mca_teams_season_team_idx on franchise_mca_teams(season_id, team_id);

-- Guardrails for statuses used by the consolidated dashboard.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gameday_schedule_offers_status_chk') then
    alter table gameday_schedule_offers
      add constraint gameday_schedule_offers_status_chk
      check (status in ('pending','accepted','superseded','cancelled','rejected','countered'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gameday_score_submissions_status_chk') then
    alter table gameday_score_submissions
      add constraint gameday_score_submissions_status_chk
      check (status in ('pending','approved','disputed','superseded','expired_on_advance'));
  end if;
end $$;

create unique index if not exists gameday_cpu_actions_unique_idx on gameday_cpu_actions(guild_id, season_id, week_index, user_discord_id);
create unique index if not exists gameday_matchup_status_unique_idx on gameday_matchup_status(guild_id, season_id, week_index, matchup_key);
