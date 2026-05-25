---
name: Discord interaction event redelivery
description: Discord's gateway can deliver the same interactionCreate event multiple times; channel-posting handlers must dedup by interaction.id.
---

Channel-posting interaction handlers (anything that calls `channel.send(...)` from a button click) must guard against gateway redelivery, or one click produces duplicate channel posts plus a stream of `40060 "already acknowledged"` / `10062 "Unknown interaction"` errors on the redelivered runs.

**Why:** discord.js v14 does not retry interactions internally, but the gateway WILL redeliver the same `interactionCreate` event during shard reconnects or transient network blips. The user perceives this as "I clicked once and it ran 3 times." Deferring earlier does not help — by the time the duplicate arrives, the channel post has already gone out. Only per-`interaction.id` dedup prevents the duplicate side effect.

**How to apply:** At the top of any per-prefix dispatcher (e.g. `gs_`, `pc_`, `co_`) that performs channel writes, keep a short-lived in-memory `Set<string>` of recently-seen `interaction.id` values (5-minute TTL is plenty — interactions die at 15 min). Drop and return early on a repeat. Use `setTimeout(...).unref()` for the cleanup so the timer doesn't pin the process alive. Read-only / ephemeral-reply handlers don't strictly need this but it's harmless to apply uniformly.

**Sibling problem — iOS double-tap.** interaction.id dedup does NOT catch iOS / mobile clients that fire two taps for one touch — those arrive as two genuine, separate interactions. For confirm-style buttons that produce a single channel post (Send Proposal, Force Win, Fair Sim, etc.), also do an **atomic synchronous claim** of any per-(user, target) state BEFORE the first `await`: e.g. read the picker/state map, validate, then `Map.delete()` immediately. The second tap then hits a missing state and fails the validation gate cleanly instead of racing through and posting again. Any pattern that defers the state-clear until after an INSERT/SELECT will lose the race.
