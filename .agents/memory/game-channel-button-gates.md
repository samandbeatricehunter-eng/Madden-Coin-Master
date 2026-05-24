---
name: Game channel button gates
description: How `gs_*` buttons in private game channels are authorized, and why proposal-keyed actions need separate handling.
---

**Rule:** every `gs_*` button in a private game channel is strictly the two
players' — no commish/admin bypass anywhere. The opponent (not a commish)
approves Fair Sim / Force Win requests.

**Why:** game channels are 2-player private rooms. The user explicitly does
not want commish/admin to interact with these buttons even though commish
has channel view. A prior version allowed commish bypass in `assertOpponent`
and on Fair Sim approval, which the user surfaced as a bug.

**How to apply:** the dispatcher in `game-scheduling-handlers.ts` resolves
the schedule for every action before routing — but the custom_id encoding
differs:

- Most actions encode `scheduleId` directly (`gs_schedule:<sid>`, `gs_begun:<sid>`, …).
- `gs_accept` / `gs_counter` / `gs_decline` / `gs_req_approve` / `gs_req_reject`
  encode a **proposal id**, not a schedule id. Resolve schedule via the proposal first.
- `gs_pick_*` and `gs_sched_confirm/cancel` act on an ephemeral picker only
  the opener can see, so no gate is needed.

If a new `gs_*` action is added, decide which bucket it belongs to and update
both sets in the dispatcher; never assume "the inner handler will check."

**Side-effects on resolve:** when a proposal is accepted/countered/declined,
delete the original Accept/Counter/Reject embed via `deleteProposalMessage`
(uses the stored `messageId`). Otherwise stale proposal embeds pile up in the
channel as players counter back and forth.

**Atomic claim on Accept:** `handleAccept` uses
`UPDATE…WHERE status='pending' RETURNING` so a double-click can't post two
"Game Scheduled" confirmations. Any handler that posts a public channel
message in response to a state transition should do the same.
