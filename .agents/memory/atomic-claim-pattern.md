---
name: Atomic claim pattern for status-flip handlers
description: Why precheck-then-update is a double-pay race in approval/distribution handlers, and the guarded UPDATE...RETURNING fix.
---

# Atomic claim pattern

Any handler shaped like "read row, check status === 'pending', do side-effects, set status='approved'" is a race. Two near-simultaneous button clicks both pass the precheck and both run the side-effects before either flips status. This has bitten this codebase on **EOS approval double-pay** and **EOS rebalance double-distribution** (both flagged High by architect in the same review).

**Rule:** the status flip IS the lock. Do it first, inside the transaction, with a guarded UPDATE:

```ts
const claimed = await tx.update(table)
  .set({ status: "approved", approvedBy, approvedAt: new Date() })
  .where(and(eq(table.id, id), eq(table.status, "pending")))
  .returning();
if (claimed.length === 0) return; // someone else won — bail silently
const row = claimed[0]!;
// ...now safely do side-effects using `row`
```

For idempotency-by-key (e.g. "run once per season"), use the same pattern against a stamp column:

```ts
const claimed = await tx.update(serverSettings)
  .set({ lastSeasonId: seasonId, lastRunAt: new Date() })
  .where(and(eq(guildId, gid),
    or(isNull(lastSeasonId), ne(lastSeasonId, seasonId))))
  .returning();
if (claimed.length === 0) return; // already ran
```

**Why:** Postgres default isolation is READ COMMITTED. SELECT-then-UPDATE never blocks the other tx; only the UPDATE's row lock does. Reading the row to "check" before updating gives you zero protection.

**Related anti-pattern in same review:** read-then-write counter accumulation (`old + tax`) loses updates under concurrency. Fix with one atomic UPDATE using `sql\`... + ${delta}\`` or a CASE expression for conditional reset:

```ts
poolAmount: sql`CASE WHEN ${poolSeasonId} = ${seasonId}
  THEN COALESCE(${poolAmount}, 0) + ${tax} ELSE ${tax} END`
```

**How to apply:** any new handler that approves/denies/claims/distributes something — write the guarded UPDATE before any side-effect. Any new counter accumulation — write a single SQL increment, never a JS-side `+`.
