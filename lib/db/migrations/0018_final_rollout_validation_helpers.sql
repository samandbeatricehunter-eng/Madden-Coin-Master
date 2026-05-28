-- Phase 17/final: validation helpers and audit indexes.
-- Safe/idempotent. No destructive changes.

CREATE TABLE IF NOT EXISTS consolidated_rebuild_migration_notes (
  id serial PRIMARY KEY,
  migration_key text NOT NULL UNIQUE,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO consolidated_rebuild_migration_notes (migration_key, description)
VALUES
  ('final-cumulative-rollout', 'Final cumulative consolidated rebuild package deployed through Phase 16 plus final validation helpers')
ON CONFLICT (migration_key) DO UPDATE
SET description = excluded.description,
    applied_at = now();

CREATE INDEX IF NOT EXISTS idx_game_schedules_final_review_active
  ON game_schedules (guild_id, status, scheduled_at, updated_at DESC)
  WHERE status IN ('pending','scheduled','started','force_win_review');

CREATE INDEX IF NOT EXISTS idx_gameday_schedule_offers_final_review_active
  ON gameday_schedule_offers (guild_id, status, offer_kind, created_at DESC)
  WHERE status IN ('pending','accepted');

CREATE INDEX IF NOT EXISTS idx_gameday_matchup_status_final_review_fw
  ON gameday_matchup_status (guild_id, checkin_force_win_eligible_at, checkin_force_win_requested_at)
  WHERE checkin_force_win_eligible_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_guild_operational_events_final_audit
  ON guild_operational_events (guild_id, event_type, created_at DESC);
