-- Phase 8: Legend purchase flow consolidation
-- Purpose: harden the extracted Legend purchase path around guild/season routing,
-- duplicate protection, and commissioner review lookups.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS guild_id text;

UPDATE purchases
SET guild_id = COALESCE(guild_id, '1476251181524189438')
WHERE guild_id IS NULL;

ALTER TABLE purchases
  ALTER COLUMN guild_id SET DEFAULT '1476251181524189438';

-- Prevent the same user from opening duplicate pending requests for the same
-- Legend in the same guild/season. Approved historical rows remain untouched.
CREATE UNIQUE INDEX IF NOT EXISTS purchases_one_pending_legend_per_user_idx
ON purchases (guild_id, season_id, discord_id, legend_id)
WHERE purchase_type = 'legend' AND status = 'pending' AND legend_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS legends_guild_position_available_idx
ON legends (guild_id, position, is_available);

CREATE INDEX IF NOT EXISTS purchases_guild_legend_status_idx
ON purchases (guild_id, legend_id, status)
WHERE purchase_type = 'legend';

COMMENT ON INDEX purchases_one_pending_legend_per_user_idx IS
  'Phase 8 consolidation: protects extracted Legend purchase flow from duplicate pending requests.';
