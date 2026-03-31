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
│   ├── api-server/         # Express API server (unused for bot but part of template)
│   ├── mockup-sandbox/     # UI prototyping sandbox
│   └── discord-bot/        # Discord economy bot (main artifact)
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
- `seasons` — Season tracking; supports per-season overrides for all costs, caps, and core attribute list (`coreAttributesOverride` is JSON text)
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
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit)

## Development

- Run bot: `pnpm --filter @workspace/discord-bot run dev`
- Deploy commands: `pnpm --filter @workspace/discord-bot run deploy-commands`
- Push DB schema: `pnpm --filter @workspace/db run push`
