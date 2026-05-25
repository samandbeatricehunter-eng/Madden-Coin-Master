---
name: Economy mutation atomicity
description: Multi-row economy mutations (wallet/savings/ledger/idempotency-stamp) must commit in one Drizzle transaction.
---

Any bot feature that mutates `economy_users.balance` **and/or** `user_savings.balance` across multiple users, writes `coin_transactions` ledger rows, **and** stamps an idempotency marker (e.g. `server_settings.luxuryTaxLastSeasonId`) must do all of that inside a single `db.transaction(async (tx) => { ... })`.

**Why:** without the wrap, a crash, deploy, or unhandled throw mid-loop leaves the world in three broken states at once: (a) some users charged, others not; (b) ledger rows mismatched against actual balances; (c) the idempotency stamp either lands (blocking a clean retry — users stay double-charged on next run) or doesn't (so a retry double-charges the users who already paid). All three are silent and very hard to reconcile after the fact, especially on a shared-Supabase Railway prod where rollback isn't trivial.

**How to apply:**
- Pass `tx` (not `db`) into every helper that mutates balances or inserts ledger rows.
- Keep `logTransaction` (which uses module-level `db`) **out** of the tx body — inline `tx.insert(coinTransactionsTable).values(...)` instead. Or add an optional executor parameter.
- Put the idempotency stamp update **inside** the same tx as the last mutation, so a rollback drops both and the next tick retries cleanly.
- Selection logic that reads pre-tx state (e.g. "bottom 50% by combined wealth") can live outside the tx — but compute it before `db.transaction(...)` so the closure body is purely writes.
- DMs / Discord side-effects stay **outside** the tx (best-effort, awaited after commit) — never block the tx on network I/O to Discord.

**Related UX guardrail:** any admin "Run Now" button for an idempotent economy job must default to **respecting** the season/period gate (no `force: true`). Forcing a re-run should require an explicit DB edit, not a Discord click — one misclick on a tax/payout button is a refund headache.
