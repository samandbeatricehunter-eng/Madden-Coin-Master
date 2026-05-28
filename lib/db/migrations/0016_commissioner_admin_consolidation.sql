-- Phase 15: commissioner/admin operations consolidation
-- Adds safe operational audit indexes and preserves existing admin flows while routing them through services.

CREATE INDEX IF NOT EXISTS idx_guild_operational_events_commissioner_admin
  ON guild_operational_events (guild_id, event_type, created_at DESC)
  WHERE event_type IN (
    'commissioner_action_routed',
    'admin_payout_adjusted',
    'admin_balance_adjusted',
    'force_win_review_opened',
    'force_win_review_resolved',
    'open_team_changed',
    'autopilot_status_changed',
    'admin_override_applied'
  );

CREATE INDEX IF NOT EXISTS idx_gameday_commissioner_requests_review_queue
  ON gameday_commissioner_requests (guild_id, status, request_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_economy_users_guild_admin_lookup
  ON economy_users (guild_id, is_admin, discord_id);

CREATE INDEX IF NOT EXISTS idx_game_schedules_guild_status_updated
  ON game_schedules (guild_id, status, updated_at DESC);
