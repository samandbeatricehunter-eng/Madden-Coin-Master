-- Phase 3 consolidated rebuild: gameday imported-result reconciliation.
-- Safe to run more than once. Adds indexes/constraints used by the scheduler,
-- reconciler, force-win review workflow, and stale-state cleanup.

alter table if exists game_schedules
  add column if not exists escalation_eligible_at timestamptz,
  add column if not exists response_warning_sent_at timestamptz,
  add column if not exists force_win_requested_at timestamptz;

alter table if exists game_schedules
  add column if not exists imported_result_synced_at timestamptz;

create index if not exists game_schedules_active_matchup_idx
  on game_schedules(guild_id, season_id, week_index, away_discord_id, home_discord_id)
  where coalesce(status, '') not in ('cancelled', 'deleted');

create index if not exists game_schedules_reconciliation_idx
  on game_schedules(season_id, week_index, away_team_name, home_team_name)
  where coalesce(status, '') not in ('cancelled', 'deleted');

create index if not exists game_schedules_unfinished_idx
  on game_schedules(guild_id, season_id, week_index, status)
  where winner_discord_id is null and imported_winner_discord_id is null;

create index if not exists game_schedules_force_review_idx
  on game_schedules(guild_id, status, force_win_requested_at)
  where status = 'force_win_review';

create index if not exists franchise_schedule_completed_lookup_idx
  on franchise_schedule(season_id, week_index, away_team_id, home_team_id)
  where home_score is not null and away_score is not null;

create index if not exists franchise_schedule_processed_game_id_idx
  on franchise_schedule(processed_game_id)
  where processed_game_id is not null;

create index if not exists franchise_mca_teams_season_team_idx
  on franchise_mca_teams(season_id, team_id);

create index if not exists gameday_schedule_offers_active_idx
  on gameday_schedule_offers(guild_id, season_id, week_index, matchup_key, status)
  where status in ('pending', 'accepted');

create index if not exists gameday_schedule_offers_expiry_idx
  on gameday_schedule_offers(status, created_at)
  where status = 'pending';

-- Normalize known legacy/freeform statuses into the consolidated lifecycle.
update game_schedules
set status = 'scheduled', updated_at = now()
where status in ('accepted', 'pending_acceptance')
  and winner_discord_id is null
  and imported_winner_discord_id is null;

update game_schedules
set status = 'finished', updated_at = now()
where (winner_discord_id is not null or imported_winner_discord_id is not null)
  and coalesce(status, '') <> 'finished';

-- Ensure the 9+ hour force-win eligibility window is materialized for rows that
-- already had a scheduled time but predate the new escalation fields.
update game_schedules
set escalation_eligible_at = coalesce(scheduled_at, created_at) + interval '9 hours',
    updated_at = now()
where escalation_eligible_at is null
  and coalesce(status, '') in ('scheduled', 'started', 'force_win_review')
  and coalesce(scheduled_at, created_at) is not null;
