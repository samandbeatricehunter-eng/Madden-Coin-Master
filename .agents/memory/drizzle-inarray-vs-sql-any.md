---
name: Drizzle inArray vs sql ANY
description: Never write `sql\`${col} = ANY(${jsArr})\`` in Drizzle — it serializes the array as one string param. Use `inArray()`.
---

When matching a column against a JS array in Drizzle, always use `inArray(col, jsArr)` from `drizzle-orm`. Never write `sql\`${col} = ANY(${jsArr})\``.

**Why:** Drizzle's `sql` template binds each interpolation as a single positional parameter. A JS array gets passed to node-postgres as the parameter value, and node-postgres serializes it to the wire format as a comma-joined string (e.g. `'1037...,2048...'` or just `'1037...'` for a 1-element array). Postgres then sees `ANY('1037...')` and rejects it with `22P02: malformed array literal: "1037..."` ("Array value must start with `{` or dimension information"). Symptom in production: a handler that builds a name lookup for N opponents crashes the entire menu flow with that error.

**How to apply:** Anywhere you need `col IN (arr)` semantics, import `inArray` from `drizzle-orm` and write `.where(inArray(col, jsArr))`. Drizzle emits a proper parameterized `col IN ($1, $2, ...)` clause. Reserve raw `sql\`... ANY(...)\`` for cases where the array is itself a Postgres expression (e.g. a subquery), not a JS value.
