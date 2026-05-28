-- Phase 2 consolidated gameday rebuild support.
-- Safe to run multiple times in Supabase SQL editor.

create table if not exists gameday_offer_reminders (
  id serial primary key,
  offer_id integer not null,
  stage text not null,
  sent_at timestamp with time zone not null default now(),
  unique(offer_id, stage)
);

alter table game_schedules
  add column if not exists response_warning_sent_at timestamp with time zone,
  add column if not exists escalation_eligible_at timestamp with time zone,
  add column if not exists force_win_requested_at timestamp with time zone;

create index if not exists gameday_offer_reminders_offer_stage_idx
  on gameday_offer_reminders(offer_id, stage);

create index if not exists gameday_schedule_offers_pending_age_idx
  on gameday_schedule_offers(status, created_at)
  where status = 'pending';

create index if not exists game_schedules_active_lookup_idx
  on game_schedules(guild_id, season_id, week_index, status);

create index if not exists game_schedules_matchup_users_idx
  on game_schedules(guild_id, away_discord_id, home_discord_id, season_id, week_index);
