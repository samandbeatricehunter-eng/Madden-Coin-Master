-- Phase 13: roster/cap action boundary + accepted-time reschedule approval workflow
-- Safe/idempotent additions only. Existing accepted scheduled times remain active until a new time is approved.

-- Roster/free-agent/cap-manager lookup support.
create index if not exists idx_franchise_rosters_guild_discord_team
  on franchise_rosters (discord_id, season_id, team_id);

create index if not exists idx_franchise_rosters_season_team_position_ovr
  on franchise_rosters (season_id, team_id, position, overall desc);

create index if not exists idx_franchise_rosters_free_agent_lookup
  on franchise_rosters (season_id, position, overall desc)
  where team_id is null or team_name is null or lower(team_name) in ('free agent','free agents','fa');

create index if not exists idx_franchise_mca_teams_guild_discord_team
  on franchise_mca_teams (discord_id, season_id, team_id);

-- Accepted scheduled time reschedule workflow.
alter table gameday_schedule_offers
  add column if not exists offer_kind text not null default 'schedule',
  add column if not exists game_schedule_id integer,
  add column if not exists replaces_scheduled_at timestamptz,
  add column if not exists replaces_scheduled_tz text,
  add column if not exists requires_approval boolean not null default true,
  add column if not exists approved_by_discord_id text;

alter table game_schedules
  add column if not exists reschedule_pending_offer_id integer,
  add column if not exists reschedule_requested_at timestamptz,
  add column if not exists reschedule_requested_by text,
  add column if not exists reschedule_approved_at timestamptz;

create index if not exists idx_gameday_schedule_offers_reschedule_pending
  on gameday_schedule_offers (guild_id, game_schedule_id, status, created_at desc)
  where offer_kind = 'reschedule';

create index if not exists idx_game_schedules_reschedule_pending
  on game_schedules (guild_id, reschedule_pending_offer_id)
  where reschedule_pending_offer_id is not null;

-- Optional FK-style consistency is intentionally not enforced here because older
-- data may contain channel-only or imported rows. Application code guards the workflow.
