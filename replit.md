# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Hosts a Discord economy bot for a Madden League server.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5 (api-server artifact)
- **Database**: PostgreSQL + Drizzle ORM
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
│   │       ├── routes/leagueRead.ts       # Read API: /api/v1/leagues/:guildId/{teams,standings,schedule,roster/:teamId,player-stats,draft-picks,news}
│   │       ├── routes/economyRead.ts      # Read API: /api/v1/leagues/:guildId/{users,users/:discordId,users/:discordId/transactions,wagers,store}
│   │       ├── routes/globalRead.ts       # Read API: /api/v1/{leagues,records,users/:discordId}
│   │       ├── middleware/requireApiKey.ts # Bearer token auth (MADDEN_WEBHOOK_KEY)
│   │       ├── lib/franchise-processor.ts # Shared game/roster/stats processing logic
│   │       └── lib/discord-notify.ts      # Discord REST API notifier (no discord.js)
│   ├── mockup-sandbox/     # UI prototyping sandbox
│   └── discord-bot/        # Discord economy bot (main artifact)
│       └── src/
│           ├── commands/
│           │   ├── actions.ts     # /menu hub entry point
│           │   ├── admin/         # all admin-*, admin.ts, adminserver, endofseasonpayout, lottery
│           │   ├── economy/       # buy-*, purchase*
│           │   ├── stats/         # h2hrecord, globalrecords, userstats, view*, help, rules
│           │   └── league/        # interviewrequest, waitlist, draft-presence
│           ├── lib/
│           │   ├── constants.ts
│           │   ├── db/            # db-helpers, user-data, server-settings, repair-records
│           │   ├── menu/          # menu-hub, menu-router, command-list
│           │   ├── handlers/      # actions-handlers, admin-*-handlers, custom-player-*, pending-*, league-data-handlers
│           │   ├── franchise/     # franchise-article, full-sync-engine, gcs-*, mca-storage-reader, season-recap, send-article, eos-auto-post, playoff-*, weekly-matchups-runner, wildcard-automation
│           │   ├── ea/            # ea-client
│           │   ├── economy/       # purchase-shared, custom-player-helpers, default-legends, payout-config, dev-trait, stat-categories, roster-legend-assign
│           │   ├── discord/       # embeds, theme, user-stats-embed, matchup-*, draft-presence-manager, league-twitter, register-commands
│           │   ├── scheduling/    # savings-interest, poll-checker
│           │   └── helpers/       # gotw-helpers, week-helpers
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
2. Run `pnpm --filter @workspace/discord-bot run deploy-commands` to register slash commands
3. The bot workflow runs automatically: `pnpm --filter @workspace/discord-bot run dev`

### Public Commands

| Command | Description |
|---|---|
| `/balance` | Check your coin balance |
| `/sendcoins` | Send coins to another player |
| `/viewstore` | See all available items and legends |
| `/purchase` | Buy any item (legend, attribute, dev up, age reset, custom player) |
| `/inventory` | See your current season inventory |
| `/availableupgrades` | See how many upgrades you've used this season |
| `/teamlist` | Show all league members and their NFL team assignments |
| `/openteams` | Show which NFL teams are not yet claimed |
| `/interviewrequest` | Submit a post-game interview for coin reward (after game is processed via franchise update) |
| `/seasonschedule` | View the full current-season schedule |
| `/nextopp` | View your next opponent |
| `/wager` | Challenge another user to a coin wager |
| `/userstats` | See your season and all-time stats |
| `/rules` | View league rules |
| `/help` | Get help with bot commands |

### Admin Commands (Discord Administrators only)

All admin-facing commands now have Discord-level permission restrictions — they are invisible to non-admins.

| Command | Description |
|---|---|
| `/addcoins` | Add coins to up to 32 users at once |
| `/removecoins` | Remove coins from a user |
| `/resetupgrades` | Reset a user's upgrade counts for the season |
| `/legend add/list/edit/remove` | Manage the legend store |
| `/season new/status/addcoins/setbalance/override/core-attrs` | Season management incl. per-season override of all costs, caps, and core attribute list |
| `/franchiseupdate` | Import the franchise ZIP to process results and award payouts (weeks 1-8 log-only, week 9+ live payouts) |
| `/admin-set-stat-tier` | Set a single tier threshold+payout for an end-of-season stat bonus category (11 categories × 4 tiers) |
| `/endofseasonpayout` | Distribute end-of-season stat bonuses from franchise ZIP (requires all 44 tier configs set first) |
| `/admin-correctpayout` | Retroactively fix a game's payout type (h2h/cpu/none) — reverses prior coins/records and applies correct ones |
| `/statleaders` | Season stat leaders from a franchise ZIP (player top-10 per category or top-3 for all; + team formula categories). Admin can post publicly. |
| `/tradeblock add` | Post players/picks/coins to the trade block channel with Interested! + Close Negotiations buttons |
| `/tradeblock remove` | Remove an active trade block listing |
| `/tradeblock update` | Update and repost a trade block listing |
| `/tradeblock iso` | Post an ISO (seeking player by position / draft picks by round / coins). Make An Offer button opens a DM offer flow. |
| `/seasonpr` | Show current season power rankings |
| `/alltimepr` | Show all-time power rankings |
| `/setuser` | Link a Discord user to an NFL team |
| `/clearteam` | Unlink a user from their team and clear their season W/L records |
| `/adminrules` | Edit league rules by section |
| `/admininventory` | View/remove/transfer any user's inventory items |
| `/setadmin` | Grant/revoke bot-admin status |
| `/advanceweek` | Set the current league week |
| `/admin-gotw` / `/admin-potw` | Set GOTW/POTW bonuses |
| `/admin-playoffs` | Manage playoff seeding |
| `/webhookurl` | Show the Madden Companion App export URL (static HTTPS URL to enter in the app before each export) |
| `/admin_ea_connect start` | Begin EA Direct Connect setup — shows the EA login URL |
| `/admin_ea_connect code` | Step 2 of EA connect — paste the redirect URL to complete auth and link the franchise |
| `/admin_ea_connect status` | Show current EA connection status (league name, platform, token expiry) |
| `/admin_ea_connect disconnect` | Remove the EA connection (reverts to MCA manual imports) |
| `/admin_ea_export week` | Export stats for a specific regular/preseason week directly from EA |
| `/admin_ea_export playoffs` | Export stats for a specific playoff round directly from EA |
| `/admin-user-data` | Commissioner hub: view/link/unlink teams, view+edit user economy/records/all-time stats, delete user data |
| `/admin-store-settings` | Commissioner hub: browse+edit custom player archetypes (all positions), set legend attribute templates (per legend × model type), set prices and per-season/all-time purchase caps |

### Purchase Rules

- **Legends**: 1,000 coins | 4 max all-time per user | Max 4 in inventory | Max 7 combined legends+custom players
- **Attributes**: 40 coins | 20/season | Speed capped at 5 pts/season
- **Dev Upgrades**: 250 coins | 2/season | Star or Superstar type required
- **Age Resets**: 250 coins | 2/season
- **Custom Players**: Gold 300 / Silver 200 / Bronze 100 coins

### Power Ranking Formula (current)

```
PR Score = (Wins × 3) + (Point Differential × 0.1) - (Losses × 1)
```

Swap `calcPRScore()` in `artifacts/discord-bot/src/commands/records.ts` when the user provides their formula.

## Database Schema (lib/db/src/schema/discord-economy.ts)

- `economy_users` — Discord users, balances, all-time legend count, team, playoff info
- `seasons` — Season tracking; supports per-season overrides for all costs, caps, and core attribute list (`coreAttributesOverride` is JSON text); new columns: `legendsPerSeasonCapOverride`, `customPlayersPerSeasonCapOverride`
- `legend_templates` — Base attribute templates per legend × model type (realistic_rookie / 88_ovr / 99_ovr); one row per legendId+model unique combo
- `server_settings` — Guild-level feature flags; new column: `allTimeLegendCap` (overrides the hardcoded LIMITS.legendsAllTime default)
- `legends` — Available/purchased legends store (permanent catalog, `isAvailable` controls store)
- `purchases` — All purchase history with status (pending/approved/refunded)
- `inventory` — Per-season user inventory
- `season_stats` — Per-season upgrade usage counts
- `user_records` — Per-season H2H wins/losses/point differential
- `coin_transactions` — Full transaction history
- `game_log` — Individual match log (score, winner, loser, etc.)
- `wagers` — Active and resolved coin wagers between users
- `franchise_processed_games` — Dedup table for franchise ZIP imports (prevents double-processing)
- `franchise_schedule` — Full regular-season schedule persisted from each franchise ZIP import
- `franchise_game_participants` — Players who had a game processed this week (interview eligibility)
- `season_stat_tier_configs` — End-of-season stat bonus tier config (11 categories × 4 tiers × season); direction (higher/lower) is encoded in the stat category definition in code, not the DB
- `franchise_mca_teams` — Team map populated by the MCA `/leagueteams` webhook; gives teamId → fullName, nickName, userName, isHuman, discordId per season; queried by the scores processor
- `ea_connections` — Stores EA API tokens and league info for direct Madden franchise data imports (replaces MCA when active); one row per league; token auto-refreshes on each export
- `player_season_stats` — Per-season stat accumulation per player: passing, rushing, receiving, defense, **kicking** (FG/XP), **punting**, **kick/punt returns**; new columns fgMade/fgAtt/fgLong/xpMade/xpAtt/puntAtt/puntYds/puntLong/puntIn20/puntTouchbacks/krAtt/krYds/krTDs/prAtt/prYds/prTDs
- `roster_transactions` — Detected roster changes (team moves, OVR upgrades/downgrades, dev trait changes) written during each MCA roster import; posted to the DISCORD_TRANSACTIONS_CHANNEL_ID channel

## Mobile App — EA Registration Flow

New API endpoints for the Expo mobile app user registration + EA account verification.

**Auth approach**: Firebase Auth (handled by the mobile app). API calls use `Authorization: Bearer recleague001` for now; Firebase ID token verification to be added as middleware.

**User registration flow:**
1. User enters their gamertag (PSN ID / Xbox GT / Origin username) in the app
2. App calls `GET /api/v2/ea/login-url` → gets the EA OAuth URL
3. App opens the URL in an in-app WebView
4. User logs into EA — WebView intercepts the redirect to `http://127.0.0.1/success?code=...`
5. App extracts the code and calls `POST /api/v2/ea/connect` with `{ gamertag, code }`
6. Server verifies the EA persona name matches the supplied gamertag (rejects mismatch)
7. Server auto-links the user to any `mca_leagues` entries their EA account belongs to
8. Returns `{ verified, eaPersonaName, platform, userId, linkedLeagues, allEaLeagues }`

**New endpoints:**

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/v2/ea/login-url` | None | Returns `{ url }` — the EA OAuth URL for the WebView |
| `POST /api/v2/ea/connect` | Bearer | Verify gamertag via EA OAuth, create/update `app_users` + `app_ea_connections`, auto-link leagues |

**New DB table:** `app_ea_connections` — stores EA OAuth tokens per gamertag (one row per app user). FK to `app_users.gamertag`. Tokens refreshable on demand.

**New files:**
- `artifacts/api-server/src/lib/ea-client.ts` — EA HTTP client (OAuth + Blaze), API server edition. Same logic as discord-bot's ea-client but stateless and also returns `personaName` from `detectPersonas`.
- `artifacts/api-server/src/routes/v2Auth.ts` — EA auth routes

## EA Direct Connect (Direct Madden API Integration)

Replaces manual MCA exports by fetching franchise data directly from EA's Madden 26 Blaze API.

**Auth flow (one-time setup per season):**
1. Commissioner runs `/admin_ea_connect start` → bot sends the EA login URL
2. Commissioner logs in via browser, copies the redirect URL (`http://127.0.0.1/success?code=...`)
3. Commissioner runs `/admin_ea_connect code redirect_url:<url>` → bot exchanges code, auto-detects platform + persona, fetches leagues, and stores connection
4. If multiple leagues found → bot shows list and asks for `/admin_ea_connect connect league_id:<id>`

**Export flow (weekly):**
- `/admin_ea_export week number:<1-18>` — pulls passing, rushing, receiving, defense, team stats, and schedules for that week and POSTs them to the API server's existing MCA endpoints
- `/admin_ea_export playoffs round:<round>` — same but for playoff rounds (weeks 19–23)
- `schedules_only:true` option exports only scores (useful for score corrections)

**Implementation:**
- `artifacts/discord-bot/src/lib/ea-client.ts` — EA API client (OAuth, Blaze session, data fetch, DB ops)
- `artifacts/discord-bot/src/commands/admin-ea-connect.ts` — auth setup command
- `artifacts/discord-bot/src/commands/admin-ea-export.ts` — weekly export command
- EA data is fetched and POSTed to the existing `/api/madden/:key/:platform/:leagueId/week/...` API routes (same format as MCA, so no changes to franchise-processor needed)
- Tokens are auto-refreshed before each export if within 5 minutes of expiry

## End-of-Season Stat Bonus System

- **11 categories**: off_pass_yds, off_rush_yds, off_pass_tds, off_rush_tds, off_pts_scored, off_redzone_pct, def_rush_yds, def_pass_yds, def_ints, def_redzone_pct, def_pts_allowed
- **4 tiers per category**: Tier 1 (weakest) through Tier 4 (best), no stacking — highest qualifying tier wins
- **Direction**: "higher is better" for offense + def INTs (threshold = minimum to qualify); "lower is better" for def yards/pts/redzone (threshold = maximum to qualify)
- **Workflow**: Run `/admin-set-stat-tier` for each of the 44 (11×4) slots, then run `/endofseasonpayout` with the season-end franchise ZIP

## Environment Variables Required

- `DISCORD_TOKEN` — Bot token
- `DISCORD_CLIENT_ID` — Application ID
- `DISCORD_GUILD_ID` — Server ID
- `DISCORD_COMMISSIONER_CHANNEL_ID` — Commissioner-only notification channel
- `DISCORD_TRANSACTIONS_CHANNEL_ID` — Channel where roster moves/upgrades are posted (optional; set to a #transactions channel ID)
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit)

## Development

- Run bot: `pnpm --filter @workspace/discord-bot run dev`
- Deploy commands: `pnpm --filter @workspace/discord-bot run deploy-commands`
- Push DB schema: `pnpm --filter @workspace/db run push`
