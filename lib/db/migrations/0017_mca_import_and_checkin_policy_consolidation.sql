-- Phase 16: MCA import cleanup + accepted-time check-in policy
-- Official check-in opens one hour before the accepted scheduled time.
-- A user more than one hour early is logged as early availability, not official check-in.
-- If one user is checked in by the agreed start time and the other is not, the late user has one hour to check in before FW review becomes available.

ALTER TABLE gameday_matchup_status
  ADD COLUMN IF NOT EXISTS away_checked_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS home_checked_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS away_early_available_at timestamptz,
  ADD COLUMN IF NOT EXISTS home_early_available_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkin_force_win_eligible_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkin_force_win_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkin_force_win_eligible_for text,
  ADD COLUMN IF NOT EXISTS checkin_force_win_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkin_force_win_requested_by text,
  ADD COLUMN IF NOT EXISTS checkin_force_win_declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkin_force_win_declined_by text;

CREATE INDEX IF NOT EXISTS idx_gameday_matchup_status_checkin_eligibility
  ON gameday_matchup_status (guild_id, season_id, week_index, checkin_force_win_eligible_at)
  WHERE checkin_force_win_eligible_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gameday_matchup_status_accepted_checkins
  ON gameday_matchup_status (guild_id, season_id, week_index, away_checked_in, home_checked_in, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_schedules_checkin_scan
  ON game_schedules (guild_id, season_id, week_index, scheduled_at, status)
  WHERE scheduled_at IS NOT NULL AND status IN ('scheduled','accepted','started');

CREATE INDEX IF NOT EXISTS idx_commissioner_requests_checkin_fw
  ON gameday_commissioner_requests (guild_id, season_id, week_index, matchup_key, status)
  WHERE request_type = 'checkin_force_win';

CREATE INDEX IF NOT EXISTS idx_franchise_schedule_processed_game_dedupe
  ON franchise_schedule (processed_game_id)
  WHERE processed_game_id IS NOT NULL;
