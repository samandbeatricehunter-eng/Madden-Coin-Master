-- Phase 11: wallet/economy action consolidation
-- Purpose:
--   Keep wallet/savings/send-coins behavior stable while moving routing out of
--   the monolithic actions handler and into src/lib/menu/actions/wallet.
--
-- No destructive schema changes are required. These indexes improve the lookup
-- paths used by the new wallet service and preserve the existing global savings
-- model.

CREATE INDEX IF NOT EXISTS economy_users_guild_discord_idx
  ON economy_users (guild_id, discord_id);

CREATE INDEX IF NOT EXISTS economy_users_guild_username_lower_idx
  ON economy_users (guild_id, lower(discord_username));

CREATE INDEX IF NOT EXISTS coin_transactions_guild_discord_created_idx
  ON coin_transactions (guild_id, discord_id, created_at DESC);

CREATE INDEX IF NOT EXISTS coin_transactions_related_user_idx
  ON coin_transactions (guild_id, related_user_id, created_at DESC)
  WHERE related_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_savings_balance_idx
  ON user_savings (discord_id, balance);

CREATE INDEX IF NOT EXISTS wagers_guild_participants_status_idx
  ON wagers (guild_id, challenger_id, opponent_id, status);
