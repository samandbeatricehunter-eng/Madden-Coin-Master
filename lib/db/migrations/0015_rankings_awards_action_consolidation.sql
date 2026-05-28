-- Phase 14: rankings / standings / awards action consolidation
-- Purpose: support fast read paths for power rankings, standings, payout summaries,
-- award voting surfaces, and commissioner review screens without creating per-guild tables.

CREATE INDEX IF NOT EXISTS idx_season_stats_guild_season_rank
  ON season_stats (guild_id, season_id, rank);

CREATE INDEX IF NOT EXISTS idx_season_stats_guild_season_seed
  ON season_stats (guild_id, season_id, seed);

CREATE INDEX IF NOT EXISTS idx_season_stats_guild_season_win_pct
  ON season_stats (guild_id, season_id, win_pct DESC);

CREATE INDEX IF NOT EXISTS idx_franchise_schedule_guild_season_week_status
  ON franchise_schedule (season_id, week_index, status);

CREATE INDEX IF NOT EXISTS idx_economy_users_guild_h2h_record
  ON economy_users (guild_id, all_time_h2h_wins DESC, all_time_h2h_losses ASC);

CREATE INDEX IF NOT EXISTS idx_guild_operational_events_rankings_awards
  ON guild_operational_events (guild_id, event_type, created_at DESC)
  WHERE event_type IN (
    'rankings_awards_action_routed',
    'power_rankings_generated',
    'weekly_payouts_generated',
    'season_awards_generated',
    'award_vote_cast'
  );
