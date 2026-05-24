---
name: NULL-PK rows from serial drift
description: When purchases (and matching coin_transactions) end up with NULL primary keys, what causes it and how to clean it up.
---

# NULL-PK orphan rows in `purchases` (and matching `coin_transactions`)

Symptom:
- Discord users have negative balances they can't explain.
- Pending Purchases page in the Commissioner's Office shows fewer items than the badge.
- Refund/Approve buttons throw "interaction failed" on certain rows.
- `SELECT * FROM purchases WHERE id IS NULL` returns rows that look real (cost, item, status='pending') but have NULL id and NULL created_at.
- The matching debit in `coin_transactions` ALSO has NULL `created_at` (because the same broken insert path skipped defaults).

**Why:** The `purchases.id` column is `bigserial`, but the underlying sequence got desynced from the table (most commonly after a cross-DB row copy that inserted rows with explicit ids but never bumped `setval`). Subsequent INSERTs that relied on the default failed silently to populate the id, leaving rows with NULL PK. Drizzle/JS code then ran the debit transaction anyway, so the user's wallet was charged but the purchase row is unreferenceable from any UI (custom_id needs an id).

**How to apply:**
- Any UI that lists or counts pending purchases MUST filter `isNotNull(purchases.id)` so badges match pages and Refund buttons can resolve a row.
- When repairing affected users:
  1. Identify the orphan rows: `SELECT * FROM purchases WHERE id IS NULL AND discord_id = ...`
  2. Refund 1× cost back to `economy_users.balance` for each row that was a duplicate (or full cost if the user got nothing for it).
  3. Insert a `coin_transactions` row with type `purchase_refund` describing the refund.
  4. `DELETE FROM purchases WHERE id IS NULL AND ...` to clear the orphan.
  5. If `season_stats.bonus_reductions_purchased` (or similar usage counter) was incremented by the broken insert, decrement it by the same count: `GREATEST(0, counter - N)`.
- Wrap all four steps in a single `BEGIN`/`COMMIT` transaction.
- Long-term: re-seed the `purchases_id_seq` to `MAX(id)+1` and audit other `bigserial` PKs in the schema for the same drift — see `cross-db-copy-pitfalls.md`.
