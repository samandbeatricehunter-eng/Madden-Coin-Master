---
name: Cross-database row copy pitfalls
description: Gotchas when copying rows between two Postgres databases whose schemas drifted (Drizzle push target vs. actual prod data shape).
---

# Cross-database row copy pitfalls

When migrating rows between two Postgres DBs with the same intended schema but real drift, an INSERT-based bulk copier (read from source, multi-row INSERT into target) needs all of these:

**Why:** Drizzle `push` regenerates a fresh target schema from current TS definitions, which may not match the actual production data shape if the schema evolved looser/stricter over time. Naive copy fails on every drift point.

**How to apply:**

1. **Param-count cap.** Postgres bind protocol limits parameters to int16 (~65535). Batch size MUST be `floor(MAX_PARAMS / colCount)`, not a constant. A wide stats table (80+ cols) at batch=1000 silently exceeds the limit and pg returns a cryptic "bind message has N parameter formats but 0 parameters" error.

2. **Resume mode.** Always check `count(*)` per table on the target before truncating; skip tables that already match source. Migration scripts get re-run many times during debugging; truncating already-copied tables wastes 10+ minutes.

3. **Auto-align target schema, narrowly.** Only ALTER the target when the mismatch would actually fail the copy:
   - `text` in source, non-text in target → ALTER target column to `text` (e.g. `guild_id="system"` won't fit a bigint).
   - `uuid` in target, non-uuid in source → ALTER target to `text` (uuid rejects integers).
   - DROP NOT NULL on target columns where source allows null.
   - Skip bigint↔integer, real↔double, timestamp↔timestamptz, enum→text — pg handles those natively. Trying to ALTER `USER-DEFINED` (enum's information_schema label) by that literal name throws a syntax error.

4. **Float → Int coercion.** When source col is real/double and target is integer, round the value in JS before sending; don't ALTER the target.

5. **JSON columns.** When the target is `json`/`jsonb`, always `JSON.stringify` the value yourself AND add `::json`/`::jsonb` cast to the placeholder. pg-node's auto-stringify path can double-encode in edge cases (object that prod returns as already-stringified, etc).

6. **FK triggers off, sequences reset after.** `SET session_replication_role = replica` during copy; reset all sequences to `max(id)+1` afterward, otherwise next INSERT collides.

7. **Common-column intersection.** When source has extra columns the target lacks (intentional schema simplification), do `cols = intersection(sourceCols, targetCols)` instead of failing. Log dropped columns so the user can confirm.
