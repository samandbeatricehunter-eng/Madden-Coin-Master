---
name: Top-N stamping idempotency
description: When pre-stamping the top-N rows in a pending queue for later withholding, reruns must be safe.
---

Any "stamp the top-N rows now, deduct at approval time" pattern (e.g. withhold 5% from the top-4 EOS payouts; flag biggest invoices for review) MUST be idempotent across reruns of the stamper.

**Why:** Stampers are usually wired to a season/week advance, which can fire more than once (commissioner re-clicks, redeliveries, manual reruns from a troubleshoot menu). If the stamper only adds flags, a second run can leave >N rows flagged for the same season — over-funding the downstream pool, double-billing some users at approval, or skewing audit counts.

**How to apply:**
- Wrap the stamping pass in a single `db.transaction`.
- Step 1 in the tx: clear any prior stamps for this season (`UPDATE ... SET flagged=false, amount=0 WHERE seasonId=? AND flagged=true`).
- Step 2: SELECT only rows still **claimable** (e.g. `status='pending'`). Already-approved rows have had their withholding executed and the pool credited — re-stamping them would double-bill.
- Step 3: rank + tie-break + stamp exactly N rows inside the same tx.
- The full ranking is computed *off the currently-pending set only*, so previously-approved rows correctly stay out.
