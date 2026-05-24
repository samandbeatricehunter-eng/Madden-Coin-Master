---
name: Drizzle vs Postgres drift cleanup
description: Method for diagnosing and fixing systemic drift between a Drizzle TS schema and the actual Postgres columns after a long-lived DB has diverged from drizzle-kit push history.
---

# Diagnosing Drizzle ↔ Postgres drift

`drizzle-kit push` is non-destructive on many type changes — over time the live DB and the TS schema can drift in dozens or hundreds of columns without any single push erroring. After a DB migration or platform move, always diff before trusting either side.

**Why:** A "minor" cleanup turned out to be 180 mismatches — most cosmetic, but ~25 of them would have silently broken bot features (missing columns the schema declared, booleans stored as text, etc.).

**How to apply:**

1. **Diff programmatically**, not by eye. Parse the Drizzle TS file with a regex over `pgTable("name", { ... })` blocks, extract `kind("col")` + `.notNull()`, then compare to `information_schema.columns` from the live DB. Map Drizzle kinds → PG `data_type`: `serial→integer`, `bigserial→bigint`, `timestamp→timestamp without time zone`, `json→json`, etc. Treat `*Enum("col")` as a separate "USER-DEFINED" kind and skip the type compare.

2. **Categorize before altering**. Five buckets in practice:
   - **B1 cosmetic type** (integer↔bigint): pg coerces silently, no app impact.
   - **B2 timestamp TZ**: rarely affects Node/Drizzle code (both materialize as `Date`); mostly DB display semantics.
   - **B3 real type drift** (bool/int/timestamp stored as text, json↔array): will break filters and casts in code.
   - **B4 missing columns**: schema declares them; DB doesn't have them. Bot will throw `column does not exist` the moment that feature runs.
   - **B5 nullability**: usually harmless when inserts populate the col, but worth fixing for new-row safety.

3. **Direction of the fix matters per bucket.** For cosmetic buckets (B1, B2), align the **Drizzle source** to the live DB — no data risk and `drizzle-kit push` won't try to re-alter. For correctness buckets (B3, B4, B5), align the **DB** to Drizzle, since Drizzle represents what the code expects.

4. **Common ALTER patterns** for B3 (always cast with `USING`):
   - text→integer: `USING NULLIF(col,'')::integer` (the `NULLIF` is mandatory or empty strings throw)
   - text→boolean: `USING (col IN ('true','t','1','TRUE'))` — audit first that all distinct text values are canonical
   - text→timestamp: `USING NULLIF(col,'')::timestamp`
   - `text[]`→json: `USING array_to_json(col)`
   - Cols with `DEFAULT` need `DROP DEFAULT` → `ALTER TYPE` → `SET DEFAULT new_val`. Same for cols with sequences (drop default, alter, recreate `nextval()`).

5. **For B4 missing-column re-copies**, the fast path is `UPDATE ... FROM (VALUES (...), ...) AS v(...) WHERE t.id = v.id` in chunks of ~500. Per-row UPDATEs over a 15k-row table took 100+ seconds; the bulk form did it in 2s.

6. **Audit the casts after** with row counts: how many rows would a backfill default actually touch? How many distinct text values are outside your truthy set for a boolean cast? If those are zero or all-canonical, the cleanup is data-safe.

## Anti-patterns
- Running `drizzle-kit push` interactively from a non-TTY shell — it hangs forever on the spinner waiting for input.
- Trusting "the diff I saw an hour ago." Drift changes as you ALTER. Always re-run the diff at the end and aim for "no drift detected" before declaring done.
- Switching `serial` → `bigserial` without adding `bigint` and `bigserial` to the `drizzle-orm/pg-core` imports — TS will fail to compile.
