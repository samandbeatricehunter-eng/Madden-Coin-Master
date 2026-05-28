-- Phase 12: Wager routing extraction + commissioner scheduled-times review support
-- Safe/idempotent additions only. Existing data is preserved.

-- Speed up active wager lookups by guild/user/status.
create index if not exists idx_wagers_guild_status_created
  on wagers (guild_id, status, created_at desc);

create index if not exists idx_wagers_guild_challenger_status
  on wagers (guild_id, challenger_id, status);

create index if not exists idx_wagers_guild_opponent_status
  on wagers (guild_id, opponent_id, status);

create index if not exists idx_wagers_schedule_game
  on wagers (schedule_game_id)
  where schedule_game_id is not null;

-- Commissioner Gameday Review now surfaces accepted/scheduled game times directly from game_schedules.
create index if not exists idx_game_schedules_commissioner_scheduled_times
  on game_schedules (guild_id, scheduled_at asc, status)
  where scheduled_at is not null;

-- Normalize older accepted rows into the scheduled lifecycle when a scheduled_at time exists.
-- This keeps old accepted offer language from leaking into game lifecycle routing.
update game_schedules
set status = 'scheduled',
    updated_at = now()
where scheduled_at is not null
  and status = 'accepted';
