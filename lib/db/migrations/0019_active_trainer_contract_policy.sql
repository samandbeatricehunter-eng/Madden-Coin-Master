-- 0019_active_trainer_contract_policy.sql
-- Purpose:
--   Fix positional trainer contract eligibility so a player may only have ONE ACTIVE
--   trainer at a time, rather than one trainer for the entire season.
--
-- Behavior after this migration:
--   - Active trainer on a player blocks hiring another trainer for that player.
--   - Expired trainers do not block a new trainer contract for that same player.
--   - Manage Trainers views should only show active trainers.
--   - Historical expired trainer rows remain available for audit/roll-log history.

BEGIN;

-- Normalize any completed trainer rows that still have active status but no weeks remaining.
UPDATE positional_trainers
SET status = 'expired',
    expired_at = COALESCE(expired_at, NOW())
WHERE status = 'active'
  AND COALESCE(weeks_remaining, 0) <= 0;

-- Previous index name from the legacy Drizzle schema allowed one row per
-- guild/user/season/player/status and could unintentionally enforce season-level
-- trainer behavior in app code. Replace it with a partial unique index that only
-- guards active contracts.
DROP INDEX IF EXISTS trainer_owner_season_player_active_idx;
DROP INDEX IF EXISTS positional_trainers_one_active_player_contract_idx;

CREATE UNIQUE INDEX positional_trainers_one_active_player_contract_idx
  ON positional_trainers (guild_id, owner_discord_id, season_id, lower(player_name))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS positional_trainers_owner_active_manage_idx
  ON positional_trainers (guild_id, season_id, owner_discord_id, hired_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS positional_trainers_expired_history_idx
  ON positional_trainers (guild_id, season_id, owner_discord_id, expired_at DESC)
  WHERE status <> 'active';

COMMIT;
