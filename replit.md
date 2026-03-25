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

### User Commands

| Command | Description |
|---|---|
| `/balance` | Check your coin balance |
| `/sendcoins` | Send coins to another player |
| `/viewstore` | See all available items and legends |
| `/purchase` | Buy any item (legend, attribute, dev up, age reset, custom player) |
| `/inventory` | See your current season inventory |
| `/availableupgrades` | See how many upgrades you've used this season |

### Admin Commands (Administrators only)

| Command | Description |
|---|---|
| `/addcoins` | Add coins to a user |
| `/removecoins` | Remove coins from a user |
| `/resetupgrades` | Reset a user's upgrade counts for the season |
| `/legend add/list/edit/remove` | Manage the legend store |
| `/season new/status/addcoins/setbalance` | Season management |
| `/updaterecord` | Record a win or loss with point spread |
| `/seasonpr` | Show current season power rankings |
| `/alltimepr` | Show all-time power rankings |

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

- `economy_users` — Discord users, balances, all-time legend count
- `seasons` — Season tracking (active season)
- `legends` — Available/purchased legends store
- `purchases` — All purchase history with status (pending/approved/refunded)
- `inventory` — Per-season user inventory
- `season_stats` — Per-season upgrade usage counts
- `user_records` — Per-season H2H wins/losses/point differential

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
