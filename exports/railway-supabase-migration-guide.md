# Railway + Supabase Migration Guide
## REC League Discord Bot — ChatGPT Reference Document

Use this document as a system prompt or reference file when working with ChatGPT on the migration from Replit to Railway + Supabase.

---

## 1. What This Project Is

A **Discord economy bot** for a Madden CFM (Connected Franchise Mode) league server, plus a companion **Express API server** that receives webhook data from the Madden Companion App (MCA) or EA's direct API.

- The **Discord bot** handles all user-facing commands (coin economy, purchases, wagers, standings, schedules, admin tools, etc.)
- The **API server** receives franchise data exports (rosters, schedules, stats, scores) from EA/MCA and processes them into the database

Both services share a single PostgreSQL database via Drizzle ORM.

---

## 2. Monorepo Structure

This is a **pnpm workspace monorepo**. Node.js v24, TypeScript 5.9, ESM throughout (`"type": "module"` in all packages).

```
root/
├── artifacts/
│   ├── discord-bot/        ← SERVICE 1: Discord.js v14 bot
│   └── api-server/         ← SERVICE 2: Express 5 HTTP server
├── lib/
│   ├── db/                 ← Shared: Drizzle ORM schema + DB connection
│   ├── api-spec/           ← OpenAPI spec
│   ├── api-client-react/   ← Generated React Query hooks (not used by bot/api)
│   └── api-zod/            ← Generated Zod schemas
├── scripts/                ← Utility scripts
├── pnpm-workspace.yaml
├── package.json            ← Root (dev tooling only, no dev script)
└── tsconfig.base.json
```

**Key rule:** `artifacts/*` packages are leaf nodes — they depend on `lib/*` but never on each other. The `lib/db` package is imported by both services.

---

## 3. Service 1: Discord Bot

**Location:** `artifacts/discord-bot/`
**Package name:** `@workspace/discord-bot`
**Runtime:** `tsx` (TypeScript execute, no compile step needed for dev/prod)

### Scripts
```json
"dev":              "tsx watch src/index.ts",
"start":            "tsx src/deploy-commands.ts && tsx src/index.ts",
"deploy-commands":  "tsx src/deploy-commands.ts"
```

### Railway Config
- **Build command:** `pnpm install --frozen-lockfile`
- **Start command:** `pnpm --filter @workspace/discord-bot run start`
- **Root directory:** `/` (monorepo root, NOT the artifact folder)
- **No port needed** — Discord bot uses WebSocket outbound only, does not listen on a port

### Key Dependencies
```
discord.js ^14.21.0
drizzle-orm ^0.45.2
@google-cloud/storage ^7.19.0   ← for team logos (GCS bucket)
sharp ^0.34.5                    ← image processing for matchup banners
adm-zip ^0.5.16                  ← reading MCA franchise ZIP exports
openai ^6.33.0                   ← AI features
axios ^1.15.0
tsx ^4.21.0                      ← TypeScript runner (no tsc compile needed)
```

### Entry Point
`artifacts/discord-bot/src/index.ts` — creates Discord client, registers event handlers, logs in.

### Deploy Commands (one-time setup per guild)
Before the bot works, slash commands must be registered:
```bash
pnpm --filter @workspace/discord-bot run deploy-commands
```
This calls the Discord REST API to register all slash commands. Only needs to run once, or when commands change.

---

## 4. Service 2: API Server

**Location:** `artifacts/api-server/`
**Package name:** `@workspace/api-server`
**Runtime:** esbuild-bundled ESM (compiled to `dist/index.mjs`)

### Scripts
```json
"build":  "node ./build.mjs",
"start":  "node --enable-source-maps ./dist/index.mjs",
"dev":    "export NODE_ENV=development && pnpm run build && pnpm run start"
```

### Railway Config
- **Build command:** `pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build`
- **Start command:** `pnpm --filter @workspace/api-server run start`
- **Root directory:** `/` (monorepo root)
- **Port:** Reads from `process.env.PORT` — Railway sets this automatically

### Build System
Uses **esbuild** to bundle everything into a single `dist/index.mjs` file. The `build.mjs` script at `artifacts/api-server/build.mjs` handles this. It externalizes native modules (sharp, pg-native, @google-cloud/*, etc.) and adds a CJS-compatibility banner so CommonJS packages work inside the ESM bundle.

**Important:** `@google-cloud/*` is externalized in the esbuild config — it must be available at runtime, not bundled. Install it as a regular dependency.

### Key Dependencies
```
express ^5
pino ^9 + pino-http ^10    ← structured logging (use req.log in handlers)
drizzle-orm ^0.45.2
cors ^2
axios ^1.15.0
@google-cloud/storage ^7.19.0
```

### Routes
| Path | Description |
|------|-------------|
| `POST /api/madden/:key/:platform/:leagueId/week/:weekType/:weekNum/*` | MCA webhook — franchise data (stats, rosters, schedules, scores) |
| `GET  /api/v1/leagues/:guildId/teams` | Read API — team list |
| `GET  /api/v1/leagues/:guildId/standings` | Read API — standings |
| `GET  /api/v1/leagues/:guildId/schedule` | Read API — schedule |
| `GET  /api/v1/leagues/:guildId/roster/:teamId` | Read API — roster |
| `GET  /api/v1/leagues/:guildId/player-stats` | Read API — player stats |
| `GET  /api/v1/leagues/:guildId/users` | Read API — economy users |
| `GET  /api/v2/ea/login-url` | EA OAuth URL for mobile app |
| `POST /api/v2/ea/connect` | EA OAuth token exchange |

### Webhook Auth
`MADDEN_WEBHOOK_KEY` env var — Bearer token checked on all MCA webhook routes.

---

## 5. Database

### Technology
- **PostgreSQL** via `pg` (node-postgres) connection pool
- **Drizzle ORM** for schema definition and queries
- **drizzle-kit** for schema migrations (`push` command)

### Connection (lib/db/src/index.ts)
```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export * from "./schema";
```

### Supabase Connection String
Use the **Transaction Pooler** connection string from Supabase (port 6543), NOT the direct connection (port 5432), for Railway-hosted services. The direct connection has a limit of ~100 connections; the pooler handles high concurrency.

**Supabase → Project Settings → Database → Connection Pooling → Transaction mode**

```
DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

If you see `prepared statement` errors with the pooler, add `?pgbouncer=true` to the connection string OR disable prepared statements in Drizzle:
```typescript
export const db = drizzle(pool, { schema, logger: false });
// pool config:
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
```

### Schema Migration to Supabase
Run this once to push the full schema to Supabase:
```bash
DATABASE_URL=<supabase-connection-string> pnpm --filter @workspace/db run push
```

This uses `drizzle-kit push` which diffs the TypeScript schema against the live DB and applies changes. **Do not run migrations from Railway's build step** — run it manually once, then only re-run when the schema changes.

### Schema Files
- `lib/db/src/schema/discord-economy.ts` — all economy tables
- `lib/db/src/schema/mca-native.ts` — MCA/franchise tables
- `lib/db/src/schema/index.ts` — barrel export

### Key Tables
| Table | Description |
|-------|-------------|
| `seasons` | Active season per guild, per-season overrides |
| `economy_users` | Discord users, coin balances, team assignments |
| `franchise_rosters` | Full player rosters per season (from MCA/EA exports) |
| `franchise_schedule` | Full schedule per season |
| `player_season_stats` | Passing/rushing/receiving/defense/kicking stats per player |
| `team_season_stats` | Team-level stats per season |
| `coin_transactions` | Full transaction log |
| `game_log` | Individual match results |
| `purchases` | Purchase history (legends, attributes, dev ups, etc.) |
| `inventory` | Per-season user inventory |
| `wagers` | Active and resolved coin wagers |
| `ea_connections` | EA API OAuth tokens per guild (direct Madden API) |
| `roster_transactions` | Detected roster changes (trades, OVR changes, dev trait changes) |
| `franchise_mca_teams` | Team map from MCA exports (teamId → name, discordId) |
| `game_channels` | Discord channel IDs created per matchup per week |
| `user_records` | Per-season H2H win/loss/point differential |
| `payout_requests` | Pending coin payouts awaiting approval |
| `wagers` | Active/resolved wagers between users |

---

## 6. Environment Variables

### Discord Bot (Railway Service 1)
| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application/Client ID |
| `DISCORD_GUILD_ID` | The Discord server ID |
| `DISCORD_COMMISSIONER_CHANNEL_ID` | Channel for admin-only bot notifications |
| `DISCORD_TRANSACTIONS_CHANNEL_ID` | Channel where roster moves are posted (optional) |
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | GCS service account JSON (for team logos/banners) |

### API Server (Railway Service 2)
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Same Supabase connection string |
| `MADDEN_WEBHOOK_KEY` | Secret bearer token for MCA webhook auth |
| `PORT` | Set automatically by Railway — do NOT hardcode |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | GCS service account JSON |
| `NODE_ENV` | Set to `production` |

### Google Cloud Storage (GCS)
The app uses GCS to store/serve team logo images for matchup banners. The credentials are a full service account JSON stored as a single env var. The code reads it like:
```typescript
const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON!);
const storage = new Storage({ credentials });
```
If you want to skip GCS initially, the matchup banners will just not render — the bot degrades gracefully.

---

## 7. Code Changes Required for Railway

### 7a. Remove Replit-specific imports
Search for any imports from `@replit/*` packages — these won't work outside Replit. There are none in the main bot/api code, but double-check.

### 7b. Port binding (API server)
The API server must bind to `process.env.PORT`. Verify `artifacts/api-server/src/index.ts` does:
```typescript
const PORT = parseInt(process.env.PORT ?? "8080", 10);
app.listen(PORT, "0.0.0.0", () => { ... });
```

### 7c. GCS credentials from env var
Replace any file-path-based GCS credential loading with the JSON env var approach shown above.

### 7d. pnpm on Railway
Railway supports pnpm natively. Set the package manager in `package.json`:
```json
"packageManager": "pnpm@9.x.x"
```
Or add a `.npmrc`:
```
engine-strict=true
```
And ensure `pnpm-lock.yaml` is committed to git.

### 7e. Sharp native binary
`sharp` uses native binaries. Railway (Linux x64) is fine, but you may need to force a rebuild:
```bash
pnpm --filter @workspace/discord-bot rebuild sharp
```
Or add to Railway build command:
```bash
pnpm install --frozen-lockfile && pnpm rebuild sharp
```

### 7f. tsx for discord-bot (no build step needed)
The discord-bot uses `tsx` to run TypeScript directly — **no compile step required**. Railway just needs to install dependencies and run `tsx src/index.ts`. This is intentional and simpler than building.

---

## 8. Railway Service Configuration

### Two Services from One Repo
In Railway, create two services from the same GitHub repo:

**Service 1 — Discord Bot**
- Source: your repo
- Root dir: `/` (monorepo root)
- Build: `pnpm install --frozen-lockfile`
- Start: `pnpm --filter @workspace/discord-bot run start`
- No public networking needed (bot is outbound-only)

**Service 2 — API Server**
- Source: same repo
- Root dir: `/`
- Build: `pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build`
- Start: `pnpm --filter @workspace/api-server run start`
- Expose port: Railway auto-assigns — ensure `PORT` env var is used

### Webhook URL
The MCA webhook URL format used by the Madden Companion App is:
```
https://<railway-api-domain>/api/madden/<MADDEN_WEBHOOK_KEY>/<platform>/<leagueId>/...
```
This is generated dynamically by the bot's `/webhookurl` command and shown to commissioners.

---

## 9. Key Architecture Decisions (Do Not Change)

- **ESM only** — all packages use `"type": "module"`. No `require()` calls. Use dynamic `import()` for conditional loads.
- **Drizzle ORM** — all DB queries go through Drizzle. No raw SQL strings in application code except inside `sql\`...\`` tagged template literals.
- **Single DB connection pool** — `lib/db` exports one pool and one `db` instance, imported by all code that needs DB access. Do not create multiple pools.
- **No discord.js in api-server** — the API server uses plain HTTP calls to Discord's REST API for notifications (via `lib/discord-notify.ts`), not discord.js.
- **Logging** — api-server uses `pino`/`pino-http`. In route handlers use `req.log.info(...)`, not `console.log`. Discord bot uses `console.log`/`console.error`.
- **Coin payouts** — H2H win: 75 coins, H2H loss: 30 coins, CPU win: 25 coins. H2H is defined as both teams having a Discord user assigned.

---

## 10. Common Gotchas

| Issue | Fix |
|-------|-----|
| `prepared statement already exists` | Use Supabase transaction pooler (port 6543), not direct connection |
| `Cannot find module '@workspace/db'` | Run `pnpm install` from monorepo root, not from within the artifact folder |
| `sharp` fails to load | Run `pnpm rebuild sharp` in build step; ensure Railway is Linux x64 |
| Discord commands not showing | Run `pnpm --filter @workspace/discord-bot run deploy-commands` once after deploy |
| `PORT already in use` | Never hardcode a port in the API server; always use `process.env.PORT` |
| esbuild bundles `@google-cloud/*` and crashes | It's already in the `external` list in `build.mjs` — do not remove it |
| `DATABASE_URL` not set | Both services need this env var; set it in each Railway service's Variables tab |
| `DISCORD_GUILD_ID` — multiple servers | The bot is multi-guild capable via `guildId` scoping, but `DISCORD_GUILD_ID` is used only for slash command registration. Commands are registered globally in production |

---

## 11. Supabase Schema Push Checklist

1. Get the **direct connection string** (port 5432) from Supabase for the push step (pooler doesn't support all DDL operations)
2. Run: `DATABASE_URL=<direct-url> pnpm --filter @workspace/db run push`
3. Confirm all tables exist in Supabase Dashboard → Table Editor
4. Switch to the **transaction pooler string** (port 6543) for the app's `DATABASE_URL` env var
5. Test with a simple query before deploying the full app

---

## 12. File Reference for ChatGPT

When making changes, the most important files are:

| File | Purpose |
|------|---------|
| `artifacts/discord-bot/src/index.ts` | Bot entry point, client setup |
| `artifacts/discord-bot/src/deploy-commands.ts` | Slash command registration |
| `artifacts/discord-bot/src/commands/*.ts` | Individual slash commands |
| `artifacts/discord-bot/src/lib/admin-operations-handlers.ts` | Admin menu button handlers |
| `artifacts/discord-bot/src/lib/actions-handlers.ts` | User menu button handlers |
| `artifacts/discord-bot/src/lib/db-helpers.ts` | Common DB query helpers |
| `artifacts/discord-bot/src/lib/franchise-processor.ts` | (Not here — see api-server) |
| `artifacts/api-server/src/index.ts` | API server entry point |
| `artifacts/api-server/src/lib/franchise-processor.ts` | MCA/EA data processing + payouts |
| `artifacts/api-server/build.mjs` | esbuild config — do not modify externals list |
| `lib/db/src/schema/discord-economy.ts` | All database table definitions |
| `lib/db/src/index.ts` | DB connection pool export |
| `lib/db/drizzle.config.ts` | drizzle-kit config for schema push |
