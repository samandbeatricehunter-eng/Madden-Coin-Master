# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Hosts a Discord economy bot for a Madden League server, backed by Supabase Postgres.

The bot was recently cleaned up to remove all AI/LLM functionality, the Twitter/tweet feature, and most public/admin channel-posting. The slash command surface was collapsed from ~50 commands to a single `/menu` hub that drives everything via buttons and selectors. A new **Commissioner's Office** hub centralizes every pending review (purchases, payouts, interviews, stream/highlight) plus recent history.

### Game Channels & Scheduling (new)

- **No matchup banner / channel post.** Weekly matchups are persisted to DB only; nothing is posted to the matchups channel.
- **Private channels.** Each game channel allows only the 2 players + the Discord role literally named `Commissioner` + every `economy_users.isAdmin=true` user (and the bot). `@everyone` is denied view.
- **Advance Period setting** (admin → Week & Season → ⏱️ Advance Period): 24 / 48 / 72 / 96 / 120 hours. Drives the "Next Advance" deadline shown on every game channel header in all 4 zones (CST/PST/EST/AKST). On `Advance Week` the bot stamps `serverSettings.lastAdvanceAt`.
- **In-channel scheduling state machine** (`lib/handlers/game-scheduling-handlers.ts`, prefix `gs_`):
  - Pinned header in each game channel: status, "Next Advance" countdown in 4 TZs, buttons `Schedule Game` / `Request Fair Sim` / `Request Force Win`.
  - Schedule picker: date / 30-min slot / TZ dropdowns; can't land within 1h of the next advance deadline.
  - Opponent reply: Accept / Counter / Decline+FairSim. Counter re-opens the picker for the other player.
  - Fair Sim / Force Win: opponent approves, then Commissioner is tagged + bot-admins DMed.
- **Reminder scheduler** (`lib/scheduling/game-reminders.ts`, 60s tick, dedup via `game_reminder_log`): T-30 / T0 / T+20 / T+60 / T+120. T0 posts "Confirm Game Begun" buttons. T+120 tags Commissioner and flips status to `auto_fair_sim`.
- **Begun / Finished / Winner.** Both players must confirm Begun; both must confirm Finished; both must confirm winner. Winner confirm triggers GOTW settlement immediately.

### GOTW Voting (replaces Discord polls)

- Old `Poll` API removed. `postGotwToChannel` keeps the same signature but no longer creates a poll — it posts a short announcement pointing users at `/menu → 🏆 GOTW Vote`.
- New menu tile `🏆 GOTW Vote` opens an ephemeral card with live tallies. Regular season: one matchup per week. **Playoffs: every H2H game** is its own votable matchup (one `gotw_history` row per game, `matchupIndex` distinguishes them). Users can change their vote any time until the underlying `game_schedules` row flips to `started` (or `scheduledAt` passes).
- On winner confirmation, every voter who picked the winning team is paid `PAYOUT_KEYS.GOTW_REGULAR_BONUS` (default **25 coins**, both regular season and playoffs — playoff bonus key still exists as an additional on top if configured).
- `poll-checker` scheduler removed entirely (file deleted); replaced by `startGameReminderScheduler`.
- Playoff matchups runner (`playoff-matchups-runner.ts`) no longer posts polls or `@everyone` to the GOTW channel — it just upserts `gotw_history` rows so the in-menu vote picks them up.

### GOTY Voting (replaces Discord poll)

- The old wildcard automation that built a historical-records channel and posted a Discord GOTY poll is **gone**. `rebuildHistoricalChannel` / `runOffseasonHistoricalPost` are now no-op stubs that just inform the admin the feature was retired.
- `runWildcardAutomation` (fires on Week 18 → Wildcard advance) does exactly one thing: seed the in-menu GOTY round.
  1. Scrape the last 100 messages from the channel mapped to `CHANNEL_KEYS.GOTY`.
  2. Filter bots / empty / dupes (case-insensitive), truncate each to 200 chars, insert into `goty_candidates`.
  3. Upsert a `goty_rounds` row with `voteEndsAt = now + 24h`, `status = 'open'`.
  4. Post a short announcement in the GOTY channel pointing users at `/menu → 🎮 GOTY Vote`.
- New menu tile **🎮 GOTY Vote** (sibling to GOTW Vote) — only visible while a `goty_rounds` row is `open` for the active season.
- Set up the GOTY channel via the new **📺 Set GOTY Channel** button inside the Commissioner's Office. If it's not set, the embed shows a warning and the wildcard seed is a no-op.

### EOS Auto-Posts Removed

The end-of-season historical channel and all of its auto-posts have been removed:
- ❌ Awards channel post, stat-leader posts, PR-bonus channel post, community polls, GOTY Discord poll.
- ✅ Coin payouts kept: PR bonus payouts still flow into `pending_eos_payouts` via `eos-auto-post.ts` for commissioner approval. End-of-season stat-tier payouts unchanged.
- ✅ Playoff seeding + bracket logic unchanged.

### Menu Notification Badges

Labels surface unaddressed-item counts as `(N)` suffixes — see `lib/menu/notif-counts.ts`:
- **Admin hub**: `🏛️ Commissioner's Office (N)` where N = purchases + payouts + interviews + stream/highlight.
- **Commissioner's Office sub-buttons**: each `(N)` for its own category.
- **🏆 GOTW Vote (N)** — N = playable matchups for the active season the user hasn't voted on yet.
- **🎮 GOTY Vote (1)** — present only while an open round exists and the user hasn't voted.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5 (api-server artifact)
- **Database**: Supabase Postgres + Drizzle ORM (connection string in `SUPABASE_DATABASE_URL`)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Discord**: discord.js v14
- **Build**: esbuild (CJS bundle for api-server)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server — MCA webhooks + app-facing read API
│   │   └── src/
│   │       ├── routes/franchise.ts        # MCA webhook routes (/api/madden/:key/*)
│   │       ├── routes/leagueRead.ts       # Read API: leagues / standings / schedule / roster / stats
│   │       ├── routes/economyRead.ts      # Read API: economy users / transactions / wagers / store
│   │       ├── routes/globalRead.ts       # Read API: leagues / records / users
│   │       ├── middleware/requireApiKey.ts # Bearer token auth (MADDEN_WEBHOOK_KEY)
│   │       └── lib/franchise-processor.ts # Shared game/roster/stats processing logic
│   ├── mockup-sandbox/     # UI prototyping sandbox
│   └── discord-bot/        # Discord economy bot (main artifact)
│       └── src/
│           ├── commands/
│           │   └── actions.ts             # The only slash command: /menu
│           ├── lib/
│           │   ├── constants.ts
│           │   ├── db/                    # db-helpers, user-data, server-settings, repair-records
│           │   ├── menu/                  # menu-hub, menu-router, command-list, help-text
│           │   ├── handlers/              # actions-handlers, admin-*-handlers,
│           │   │                          # pending-inbox-handlers (Commissioner's Office hub),
│           │   │                          # custom-player-*, league-data-handlers, lottery-handler
│           │   │   └── admin-helpers/     # admin-ops-ui, eos-testrun, inventory, server-init
│           │   ├── franchise/             # mca-storage-reader, gcs-*, weekly/playoff matchup runners,
│           │   │                          # eos-auto-post, playoff-seeding, wildcard-automation
│           │   ├── ea/                    # ea-client (EA Direct Connect)
│           │   ├── economy/               # purchase-shared, custom-player-helpers, default-legends,
│           │   │                          # payout-config, dev-trait, stat-categories, roster-legend-assign
│           │   ├── discord/               # embeds, theme, user-stats-embed, matchup-image,
│           │   │                          # draft-presence-manager, register-commands
│           │   ├── league/                # extracted league command helpers
│           │   ├── stats/                 # extracted stats command helpers
│           │   ├── scheduling/            # savings-interest, poll-checker
│           │   └── helpers/               # gotw-helpers, week-helpers
│           ├── events/, scripts/, index.ts, deploy-commands.ts
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Discord Bot

### Setup

1. Invite the bot to the server using the OAuth2 link (bot + applications.commands scope)
2. Run `pnpm --filter @workspace/discord-bot run deploy-commands` to register `/menu`
3. The bot workflow runs automatically: `pnpm --filter @workspace/discord-bot run dev`

### Slash Commands

The bot now exposes a **single slash command** — every former command moved into the hub:

| Command | Description |
|---|---|
| `/menu` | Opens the full bot hub. Everything (user actions + admin tools) lives here. |

### `/menu` — Public Actions

Users get a category selector with:
- **Balance & Coins** — check balance, send coins, savings, wagers
- **Store** — view store, purchase legend / attribute / dev upgrade / age reset / custom player, inventory
- **League** — team list, open teams, season schedule, next opponent, interview request
- **Stats** — userstats, H2H records, global records, season/all-time power rankings
- **Help & Rules** — rules, help

### `/menu` — Admin Categories

Admins / Commissioners also see admin categories:
- **🏛️ Commissioner's Office** — pending purchases (apply / refund), pending payouts (approve / deny / edit amount), pending interviews, pending stream / highlight, and a Recent History view of the last 25 completed transactions
- **📅 Week & Season** — set/advance week, set season number, season status, override costs/caps
- **💰 Payouts** — all payout config (GOTW/POTW, EOS, interview, wagers, etc.) + end-of-season stat tier setup
- **📢 Post Content** — weekly matchups (plain text), GOTW, draft lottery
- **🏈 League Data** — EA Direct Connect, franchise imports, stat exports, end-of-season payout
- **👤 User Data** — view/link/unlink teams, edit user economy/records/all-time stats, set bot-admin
- **🏪 Store Settings** — archetypes, legend templates, prices, per-season/all-time caps
- **⚙️ Server Settings** — initialize server channels, rules, features, waitlist
- **🔧 Troubleshoot** — repair records, resync data

### Commissioner's Office Hub

Centralized review surface for everything that previously hit a designated commissioner / transactions / purchases channel. Built in `lib/handlers/pending-inbox-handlers.ts`:

- **Pending Purchases** (3/page) — Apply or Refund each pending purchase
- **Pending Payouts** (3/page) — Approve, Deny, or Edit amount (modal). Stream/highlight detections from `messageCreate.ts` flow into `pendingChannelPayoutsTable` and are reviewed here instead of being auto-posted to a channel
- **Pending Interviews** (3/page) — Approve / Deny
- **Pending Stream/Highlight** (3/page) — Approve / Deny channel payouts
- **Recent History** (10/page from last 25) — completed `coin_transactions` log

Edit-amount modals reuse a single dispatcher (`co_modal_edit_*`) and re-render the active page after each action.

### Purchase Rules

- **Legends**: 1,000 coins | 4 max all-time per user | Max 4 in inventory | Max 7 combined legends + custom players
- **Attributes**: 40 coins | 20/season | Speed capped at 5 pts/season
- **Dev Upgrades**: 250 coins | 2/season | Star or Superstar type required
- **Age Resets**: 250 coins | 2/season
- **Custom Players**: Gold 300 / Silver 200 / Bronze 100 coins

### Power Ranking Formula (current)

```
PR Score = (Wins × 3) + (Point Differential × 0.1) - (Losses × 1)
```

Defined in `lib/stats/` helpers. Swap `calcPRScore()` when the user provides their formula.

## Database Schema (lib/db/src/schema/discord-economy.ts)

- `economy_users` — Discord users, balances, all-time legend count, team, playoff info
- `seasons` — Season tracking; per-season overrides for costs, caps, and core attribute list
- `legend_templates` — Base attribute templates per legend × model type (realistic_rookie / 88_ovr / 99_ovr)
- `server_settings` — Guild-level feature flags; `allTimeLegendCap` overrides hardcoded default
- `legends` — Permanent legend catalog (`isAvailable` controls store visibility)
- `purchases` — Purchase history with status (pending / approved / refunded)
- `inventory` — Per-season user inventory
- `season_stats` — Per-season upgrade usage counts
- `user_records` — Per-season H2H wins/losses/point differential
- `coin_transactions` — Full transaction history (drives the Recent History view)
- `game_log` — Individual match log (score, winner, loser, etc.)
- `wagers` — Active and resolved coin wagers
- `franchise_processed_games` — Dedup table for franchise ZIP imports
- `franchise_schedule` — Full regular-season schedule persisted from each franchise ZIP import
- `franchise_game_participants` — Players with a processed game this week (interview eligibility)
- `season_stat_tier_configs` — End-of-season stat bonus tier configs (11 categories × 4 tiers × season)
- `franchise_mca_teams` — Team map populated by the MCA `/leagueteams` webhook
- `ea_connections` — EA API tokens + league info (auto-refreshes on each export)
- `player_season_stats` — Per-season stat accumulation per player (passing, rushing, receiving, defense, kicking, punting, returns)
- `roster_transactions` — Detected roster changes (no longer posted to Discord; reviewable via DB / future hub)
- `pending_channel_payouts` — Stream/highlight detections awaiting commissioner review
- `interview_requests` — Pending interview submissions
- `payout_requests` / `pending_eos_payouts` — Manual payout requests + end-of-season queue
- `game_schedules` — One row per private game channel (status, scheduledAt, startedAt, header message id)
- `game_schedule_proposals` — Player-to-player schedule proposals (date/time/TZ + status)
- `game_status_confirmations` — Per-player "Begun"/"Finished"/"Winner" confirmations
- `game_reminder_log` — Dedup table for T-30/T0/T+20/T+60/T+120 reminders
- `gotw_votes` — In-menu GOTW voter ballots (replaces Discord polls)

`server_settings` gained `advancePeriodHours` (default 72) and `lastAdvanceAt` (stamped on every Advance Week).

Legacy tables still defined in schema for historical data but no longer written/read by code: `guild_tweets`, `league_twitter_*`. Safe to drop at the DB level whenever convenient.

## End-of-Season Stat Bonus System

- **11 categories**: off_pass_yds, off_rush_yds, off_pass_tds, off_rush_tds, off_pts_scored, off_redzone_pct, def_rush_yds, def_pass_yds, def_ints, def_redzone_pct, def_pts_allowed
- **4 tiers per category**: Tier 1 (weakest) through Tier 4 (best), no stacking — highest qualifying tier wins
- **Direction**: "higher is better" for offense + def INTs; "lower is better" for def yards/pts/redzone
- **Workflow**: configure all 44 tiers under **Payouts → Stat Tier Setup**, then run **League Data → End-of-Season Payout** with the season-end franchise ZIP

## EA Direct Connect

Replaces manual MCA exports by fetching franchise data directly from EA's Madden 26 Blaze API. Managed under **League Data** in the menu:

- **Auth (one-time per season)**: Start → log in via the EA URL → paste the redirect URL → bot exchanges code, detects platform + persona, stores tokens. If multiple leagues are found, pick one.
- **Weekly export**: pick a regular/preseason week (1-18) or a playoff round (19-23). EA data is POSTed to the same `/api/madden/...` API routes that MCA uses, so franchise-processor needs no special handling. `schedules_only` mode pulls scores only.
- Tokens auto-refresh within 5 minutes of expiry.

## Mobile App — EA Registration Flow

API endpoints for the Expo mobile app's gamertag-verification flow:

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/v2/ea/login-url` | None | Returns `{ url }` — the EA OAuth URL for the WebView |
| `POST /api/v2/ea/connect` | Bearer `recleague001` | Verify gamertag via EA OAuth, create/update `app_users` + `app_ea_connections`, auto-link `mca_leagues` entries |

DB tables: `app_users`, `app_ea_connections`.

## Environment Variables

- `DISCORD_TOKEN` — Bot token (production)
- `DISCORD_TOKEN_DEV` — Bot token (dev). Dev bot is in standby unless `DEV_BOT_ENABLED=true`
- `DISCORD_CLIENT_ID` — Application ID
- `DISCORD_GUILD_ID` — Server ID
- `DISCORD_COMMISSIONER_CHANNEL_ID` — Optional fallback for the private commissioner channel (the hub no longer auto-posts to it for routine reviews)
- `SUPABASE_DATABASE_URL` — Postgres connection string (also exposed as `DATABASE_URL` in code via `lib/db`)
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — Supabase admin credentials
- `MADDEN_WEBHOOK_KEY` — Bearer token for MCA webhooks (`/api/madden/:key/*`)

Removed since the cleanup: `OPENAI_API_KEY`, `DISCORD_TRANSACTIONS_CHANNEL_ID`, and any Twitter / posting-channel envs — no longer used.

## Development

- Run bot: `pnpm --filter @workspace/discord-bot run dev`
- Deploy commands: `pnpm --filter @workspace/discord-bot run deploy-commands`
- Typecheck everything: `pnpm run typecheck`
- Push DB schema (careful — Supabase): `pnpm --filter @workspace/db run push`

## Pushing to GitHub (recbot repo)

This project is connected to the `recbot` repo on GitHub. Push via the Replit **Git** pane (left sidebar):

1. Open the **Git** tab in Replit
2. Review the changed files in the **Changes** list
3. Enter a commit message (e.g. `chore: major cleanup — remove AI/Twitter/channel-posts, collapse to /menu, add Commissioner's Office hub`)
4. Click **Stage & commit**
5. Click **Push** to publish to GitHub

If you'd rather use the shell, the safe path is `git add -A && git commit -m "..."` and then push from the Git pane (the Replit sandbox blocks direct push from the shell).
