# recbot — Full Codebase Structure Review

## Quick Stats

| Metric | Count |
|---|---|
| Total `.ts` files in `src/` | ~110 |
| Total lines of code | ~55,840 |
| Dead command files (not wired up) | **15 files, ~3,390 lines** |
| Files too large to maintain (>1,000 lines) | **7 files, ~22,000 lines** |

---

## Part 1 — Dead Files (safe to archive/delete)

These command files exist in `src/commands/` but are **never imported by `index.ts`** and have **no live code references** anywhere else in the codebase. Their functionality was absorbed into the actions hub or admin-menu.

Run `node cleanup-dead-files.cjs` from the project root to move them into `src/_archive/`.

| File | Lines | Reason |
|---|---|---|
| `commands/purchase.ts` | 878 | Replaced by actions hub `/purchase` flow |
| `commands/userstats.ts` | 404 | Replaced by actions hub `/profile` flow |
| `commands/viewroster.ts` | 397 | Replaced by actions hub roster card |
| `commands/buy-devup.ts` | 183 | Replaced by actions hub |
| `commands/buy-agereset.ts` | 173 | Replaced by actions hub |
| `commands/buy-legend.ts` | 163 | Replaced by actions hub |
| `commands/admin-deleteuser.ts` | 247 | Replaced by `/admin-user-data` hub |
| `commands/admin-clearteam.ts` | 101 | Replaced by `/admin-user-data` hub |
| `commands/admin-transactions.ts` | 129 | No references anywhere |
| `commands/admin-gotw.ts` | 104 | Replaced by `/admin-menu` |
| `commands/adminserver.ts` | 140 | Re-exports from `server-settings.ts`, zero callers |
| `commands/admin-seed-emojis.ts` | 113 | One-time utility, no callers |
| `commands/rules.ts` | 150 | Replaced by actions hub |
| `commands/purchasecustomplayer.ts` | 95 | Only referenced by other dead files |
| `commands/buy-customplayer.ts` | 12 | Empty stub |

**Note — files that look dead but are NOT:**
- `commands/waitlist.ts` — exports `checkAndNotifyWaitlist`, `notifyTeamWaitlist`, `WAITLIST_ACCEPT_PREFIX`, `WAITLIST_DENY_PREFIX` used by `lib/admin-operations-handlers.ts`, `lib/admin-user-handlers.ts`, and `events/interactionCreate.ts`. **Keep it.**
- `commands/interviewrequest.ts` — exports interview constants/types used by `lib/actions-handlers.ts`. **Keep it.**
- `commands/admin-initialize.ts` — imported by `lib/admin-operations-handlers.ts`. **Keep it.**
- `commands/viewcustomarchetypes.ts` — exports `handleVcaNav`, `handleVcaAttrPageNav`, `handleViewArchetypeSelect` needed by the routing fix. **Keep it.**
- `commands/viewplayerstats.ts` — exports `handleTeamSelect`, `handlePositionSelect`, `handlePlayerSelect` needed by the routing fix. **Keep it.**
- `commands/admin-setadmin.ts` — imported by `commands/admin.ts`. **Keep it.**

---

## Part 2 — Oversized Files That Need Splitting

### 1. `lib/actions-handlers.ts` — 7,114 lines 🚨

This is the most critical file to split. It contains 8 completely separate domains that have nothing to do with each other except they all live under the `ac_` custom ID prefix.

**Proposed split:**

| New File | Lines (approx) | What goes in it |
|---|---|---|
| `lib/actions-handlers.ts` *(keep)* | ~1,600 | Types, `ActionsSession`, session store helpers, shared UI builders, roster card page builder, PR helpers, main dispatch `handleActionsInteraction`, coins handlers, interview handlers, tweet handlers |
| `lib/purchase-flow-handlers.ts` | ~1,480 | Age reset (line 967), dev trait upgrade (1435), buy custom player info (1614), buy legend (1680), training package (1915) — all the "confirm purchase" button/select flows |
| `lib/wager-handlers.ts` | ~485 | Wager section types + helpers (2448), wager step 1 game select (2533), step 2 team pick (2604), step 3 spread (2650), step 4 opponent select (2742) |
| `lib/player-browser-handlers.ts` | ~1,500 | View player cards flow (3568), free agents (4087), all players browse (4261), free agent filter/sort (4633), all players filter/sort (4441) |
| `lib/team-stats-handlers.ts` | ~1,150 | Team stats embed builder (567 — shared with actions), full team stats interaction section (4838) |
| `lib/rule-violation-handlers.ts` | ~570 | Rule violation flow (5990–6558) |
| `lib/team-request-handlers.ts` | ~555 | Request open team (6559–6700), waitlist flow (6770–7114) |

**Contract rule:** The `ActionsSession` interface and session store (`sessions` Map, `getSession`, `touchSession`) MUST stay in `actions-handlers.ts` and be imported by all the split files. Do NOT duplicate the session.

---

### 2. `lib/admin-operations-handlers.ts` — 4,216 lines 🚨

Contains 4 separate admin domains. The advance-week core logic alone is ~700 lines.

**Proposed split:**

| New File | Lines (approx) | What goes in it |
|---|---|---|
| `lib/admin-operations-handlers.ts` *(keep)* | ~2,100 | Init new server (2050), set franchise length (2159), manual channel link (2210), troubleshoot hub (2376), report bug (2385), set season number (3715) |
| `lib/admin-week-handlers.ts` | ~1,160 | Set week (2449), advance week interactive flow (2520), advance week core logic (2589–3714) |
| `lib/admin-rules-handlers.ts` | ~365 | Rules hub embed (3851), rules modal handlers (4088–4216) — also export `buildRulesPages` which is currently called from `actions-handlers.ts` |

---

### 3. `events/messageCreate.ts` — 1,748 lines

Contains two completely unrelated systems: the AI league manager chatbot and the stream/highlight post monitors.

**Proposed split:**

| New File | Lines (approx) | What goes in it |
|---|---|---|
| `lib/ai-chat.ts` | ~1,180 | All AI logic: escalation tracker, chitchat limiter, conversation history, league context fetchers, EOS context, economy context, user stats fetcher, system prompt builder, `buildPricingBlock`, `buildSystemPrompt` |
| `lib/stream-monitor.ts` | ~265 | `handleStreamPost`, `handleHighlightPost` |
| `events/messageCreate.ts` *(keep, thinned)* | ~130 | Just `execute()`, commissioner role helpers, calls out to `ai-chat.ts` and `stream-monitor.ts` |

---

### 4. `lib/admin-payout-handlers.ts` — 2,210 lines

Manageable compared to the above but has 5 logical sections that could be separate files if needed. **Lower priority** — fix the top 3 first.

| Section | Lines | Possible file |
|---|---|---|
| GOTW / POTW voting | ~245 | `lib/admin-gotw-potw-handlers.ts` |
| Add/Remove/Transfer coins | ~215 | `lib/admin-coins-handlers.ts` |
| Game payout + correct payout | ~620 | `lib/admin-game-payout-handlers.ts` |
| Set pay configs (reg/playoff/channel) | ~235 | stays in existing |
| EOS / milestone / tweet / interview / referral | ~895 | `lib/admin-eos-bonus-handlers.ts` |

---

## Part 3 — Architectural Issues to Fix

### Issue A: Interaction handlers living in `commands/`

Three `commands/` files export interaction handler functions that `events/interactionCreate.ts` must import:
- `commands/viewcustomarchetypes.ts` → `handleVcaNav`, `handleVcaAttrPageNav`, `handleViewArchetypeSelect`
- `commands/viewplayerstats.ts` → `handleTeamSelect`, `handlePositionSelect`, `handlePlayerSelect`
- `commands/admin-inventory.ts` → `handleAcpPositionSelect`, `handleAcpPlayerSelect`

**Rule:** `commands/` files should only define slash command `data` + `execute` / `autocomplete`. Interaction handlers belong in `lib/`.

**Fix:** Move the exported handler functions out of those command files into matching `lib/` files:
- `lib/vca-handlers.ts` ← move `handleVcaNav`, `handleVcaAttrPageNav`, `handleViewArchetypeSelect` from `commands/viewcustomarchetypes.ts`
- `lib/vps-handlers.ts` ← move `handleTeamSelect`, `handlePositionSelect`, `handlePlayerSelect` from `commands/viewplayerstats.ts`
- `lib/acp-handlers.ts` ← move `handleAcpPositionSelect`, `handleAcpPlayerSelect` from `commands/admin-inventory.ts`

Then update `interactionCreate.ts` imports to point at the new `lib/` paths.

### Issue B: `commands/interviewrequest.ts` exports shared constants to `lib/`

`lib/actions-handlers.ts` imports `INTERVIEW_QUESTIONS`, `pickThreeIndices`, `getQuestionPool`, `interviewTypeLabel`, `InterviewType` from `commands/interviewrequest.ts`. This is a `lib/ → commands/` dependency which is backwards.

**Fix:** Move those constants/types/helpers into `lib/interview-helpers.ts` and update both `commands/interviewrequest.ts` and `lib/actions-handlers.ts` to import from the new lib file.

### Issue C: `commands/actions.ts` exports embed builders to `lib/`

`lib/actions-handlers.ts` imports `buildActionsHubEmbed`, `buildActionsHubRows`, `buildUnlinkedHubEmbed`, `buildUnlinkedHubRows` from `commands/actions.ts`.

**Fix:** Move those four builder functions into `lib/actions-hub-embeds.ts`. Update the imports in `actions.ts`, `actions-handlers.ts`, and `lib/league-operations-menu.ts`.

---

## Summary: Recommended Order of Work

1. **Run `cleanup-dead-files.cjs`** — removes 3,390 lines of dead code instantly, zero risk
2. **Fix `actions-handlers.ts`** — split into 6 files (biggest win; 5,500 lines extracted)
3. **Fix `messageCreate.ts`** — split AI chat into `lib/ai-chat.ts` (clean separation of concerns)
4. **Fix `admin-operations-handlers.ts`** — extract week handlers + rules handlers
5. **Fix architectural issues A, B, C** — move handlers to `lib/`, fix the backwards imports
6. **Fix `admin-payout-handlers.ts`** — optional, lower priority
