# ChatGPT Setup Prompt — Madden Discord Economy Bot

Copy everything below the divider into ChatGPT (or any other coding assistant) when starting a new conversation about this project. It tells the model what the project is, where to find things, and how to work with the live infrastructure without breaking anything.

---

## You are working on the "Madden Coin Master" Discord economy bot

### What it is
A Discord bot for a Madden NFL franchise league. It tracks coin balances, lets users buy legends / attribute upgrades / dev upgrades / age resets / custom players, runs game-of-the-week and game-of-the-year voting, schedules H2H matchups in private game channels, ingests franchise data via the Madden Companion App (MCA) webhooks and via EA Direct Connect, and pays out coins for game results / streams / highlights / EOS bonuses. Everything users do is driven from a single `/menu` slash command — buttons and selectors only.

### Stack
- **Repo layout:** pnpm workspace monorepo, TypeScript 5.9, Node 24.
- **Bot:** `artifacts/discord-bot/` — discord.js v14, run with `pnpm --filter @workspace/discord-bot run dev`.
- **API server:** `artifacts/api-server/` — Express 5, handles MCA + mobile-app webhooks.
- **Shared DB layer:** `lib/db/` — Drizzle ORM, Postgres.
- **Schemas:** `lib/db/src/schema/discord-economy.ts` is the source of truth for every table the bot uses.

### Hosting & runtime topology
- **Development:** Replit. The Replit workspace has its own SUPABASE_DATABASE_URL secret and runs the dev workflows. The dev bot is in standby unless `DEV_BOT_ENABLED=true` — production is NOT touched from Replit.
- **Production:** Railway, auto-deployed from the GitHub repo `samandbeatricehunter-eng/Madden-Coin-Master`, branch `main`. Railway has its own secrets including `DISCORD_TOKEN` (the live bot token), `SUPABASE_DATABASE_URL` (same Supabase project as dev — there is only one database), and `MADDEN_WEBHOOK_KEY`.
- **Database:** Supabase Postgres. **Dev and prod share the same database.** Treat every write as a production write.
- **Push flow:** Code is pushed from Replit's **Git pane** (the shell is blocked from `git push`). After a push to `main`, Railway redeploys automatically. If a bug is still happening after a push, first verify Railway's deployed commit SHA matches the latest `main` commit — Railway sometimes lags or sticks on the wrong branch.

### How to interact with the systems

**Supabase (the database):**
- Read-only inspection is safe and encouraged — query through `node -e` with the `pg` package from `lib/db/node_modules/pg`, using `process.env.SUPABASE_DATABASE_URL` and `ssl: { rejectUnauthorized: false }`.
- For any write (UPDATE / INSERT / DELETE), ALWAYS wrap in `BEGIN ... COMMIT` and verify with a SELECT in the same script. If anything looks off, ROLLBACK.
- Never run `drizzle-kit push` against production without first programmatic-diffing the schema. The DB has known drift from Drizzle (e.g. `payout_config.payout_config_pkey` is on `(key)` only, not `(guild_id, key)`). Always check the actual constraint with `pg_get_constraintdef` before relying on Drizzle's `onConflictDoUpdate` target.
- Sequences can drift after row copies — if you see rows with `NULL` primary keys, the `bigserial` sequence is desynced from the table. Re-seed with `SELECT setval('<table>_id_seq', (SELECT COALESCE(MAX(id), 0)+1 FROM <table>))`.

**Railway (the runtime):**
- You don't deploy to Railway directly. You push to `main` on GitHub from Replit's Git pane and Railway picks it up.
- To check what's actually running, fetch the Discord message you suspect is from prod and look at the `application_id` — if it matches `DISCORD_CLIENT_ID`, it's the live bot. The deployed commit can be confirmed by reading the recent `git log` on `main` and cross-referencing with Railway's deploy dashboard (or by reading a file that you know was changed in a specific commit).
- The bot uses **cold-start** semantics on Railway. After idle periods, the first interaction may take >3 seconds to process and Discord will return error `10062` (Unknown interaction) when the bot finally tries to `deferReply`. Every interaction handler that does meaningful work must:
  1. Wrap the initial `deferReply` / `deferUpdate` in try/catch.
  2. On `10062`, log a warning and continue the underlying work.
  3. Have a fallback for the success/error reply that posts to the channel directly instead of `editReply`-ing the dead interaction.

**Discord:**
- The bot exposes exactly one slash command: `/menu`. Everything else is buttons and select menus routed through a hub. Do not add new slash commands without a strong reason.
- Custom IDs follow prefix conventions: `menu_*` (router), `ac_*` (action buttons), `ao_*` (admin operations), `co_*` (Commissioner's Office), `gs_*` (game scheduling), `gotw_*` / `goty_*` (voting). Adding a new family means registering it in the interaction dispatcher in `interactionCreate.ts`.
- Channel posts to public channels were removed in the big cleanup — almost all routine review now happens inside the ephemeral Commissioner's Office hub. Don't add new auto-posts to public channels unless explicitly asked.

### Where to find things (the map)

```
artifacts/discord-bot/src/
├── index.ts                           # Bot entrypoint, login, scheduler boot
├── deploy-commands.ts                 # Registers the single /menu slash command
├── commands/actions.ts                # The only slash command handler
├── events/
│   ├── interactionCreate.ts           # Top-level dispatcher — routes button/select/modal IDs to handler modules
│   └── messageCreate.ts               # Detects stream/highlight links, queues them into pending_channel_payouts
├── lib/
│   ├── menu/                          # Hub UI
│   │   ├── menu-hub.ts                # Builds the main /menu embed + category selector
│   │   ├── menu-router.ts             # Routes menu_* IDs to category screens
│   │   ├── notif-counts.ts            # Badge counts (must mirror filters used by the page handlers)
│   │   └── command-list.ts            # The list of every menu tile
│   ├── handlers/
│   │   ├── actions-handlers.ts        # User-facing actions: balance, send coins, savings, store browse
│   │   ├── admin-*-handlers.ts        # Admin tools split by category (week, payouts, posting, league data)
│   │   ├── pending-inbox-handlers.ts  # Commissioner's Office hub (purchases, payouts, interviews, history)
│   │   ├── game-scheduling-handlers.ts# Per-game-channel scheduling state machine (gs_* IDs)
│   │   ├── lottery-handler.ts         # Draft lottery
│   │   └── admin-helpers/             # Shared admin UI/UX (ops-ui, server-init, EOS testrun, inventory)
│   ├── franchise/                     # MCA + EA Direct Connect ingestion, weekly/playoff runners, EOS auto-post
│   ├── ea/ea-client.ts                # EA Blaze API client + token refresh
│   ├── economy/
│   │   ├── payout-config.ts           # PAYOUT_KEYS + DEFAULTS — single source of truth for every payout value
│   │   ├── purchase-shared.ts         # Common purchase math + season_stats counter logic
│   │   └── default-legends.ts         # Built-in legend catalog
│   ├── discord/                       # Embed builders, theme colors, draft presence, register-commands
│   ├── scheduling/
│   │   ├── savings-interest.ts        # Periodic interest on global savings
│   │   └── game-reminders.ts          # T-30 / T0 / T+20 / T+60 / T+120 reminders for scheduled games
│   ├── helpers/gotw-helpers.ts        # GOTW math
│   ├── stats/                         # Stat aggregation + power-ranking calc (calcPRScore lives here)
│   └── db/                            # Bot-local DB helpers wrapping lib/db (user fetch/create, server settings, repair-records)

lib/db/src/
├── index.ts                           # Drizzle client (pg pool, SUPABASE_DATABASE_URL)
└── schema/discord-economy.ts          # EVERY table the bot uses, in one file. Read this before any DB work.

artifacts/api-server/src/
├── routes/franchise.ts                # MCA webhooks: /api/madden/:key/*
├── routes/leagueRead.ts               # Read API for the mobile app: leagues / standings / schedule / roster / stats
├── routes/economyRead.ts              # Read API: users / transactions / wagers / store
├── middleware/requireApiKey.ts        # Bearer auth using MADDEN_WEBHOOK_KEY
└── lib/franchise-processor.ts         # Shared MCA + EA ingestion logic

CHATGPT_SETUP_PROMPT.md                # This file
replit.md                              # Project README — read first for current bug/feature context
.agents/memory/                        # Persistent lessons across sessions; check before assuming behavior
```

### How to make efficient changes

1. **Always read `replit.md` first.** It contains the current cleanup state, removed features (no more AI/Twitter/auto-channel-posts), and the current `/menu` hub structure.
2. **Find before you grep wide.** Use ripgrep with `-t ts` and a precise pattern (`PAYOUT_KEYS.HIGHLIGHT_PAYOUT`, `customId.startsWith("ac_")`, specific table names from the schema file). The schema file is the single best index — read it before guessing column names.
3. **Use the menu router as your map.** Every user-visible action is reachable from `/menu`. Trace from `menu-hub.ts` → category screen → handler module. If a feature isn't reachable from `/menu`, it's either dead code or a scheduler/webhook path.
4. **Change one knob, not three.** Game-result payouts live in `DEFAULTS` in `artifacts/discord-bot/src/lib/economy/payout-config.ts` AND can be overridden per-key in the `payout_config` table. The MCA webhook processor (`artifacts/api-server/src/lib/franchise-processor.ts`) reads the same `payout_config` rows with the same DEFAULTS as fallback, so both sides stay in sync. To raise a payout permanently: update DEFAULTS in `payout-config.ts` AND upsert the matching `payout_config` row so any live DB override doesn't mask the new default. **Caveat:** the playoff-matchups-runner still has separate hardcoded round bonuses (`PLAYOFF_WIN_BONUS_TOP4` / `PLAYOFF_WIN_BONUS_WC`) — those are bonus payouts on top of `playoff_h2h_win`, not the base payout, and the user has not asked to make them dynamic.
5. **Respect the cold-start contract.** Any new handler that does >100ms of work or hits the DB must defer the interaction immediately and have a channel-send fallback path for when `10062` fires.
6. **Restrict buttons by participant when relevant.** Game-channel buttons (schedule / fair sim / force win / begun / finished / winner) are participant-only — admins and Commissioners are explicitly NOT allowed. The exact ephemeral message is: `"🚫 You're not scheduled to play in this game. Do not touch these buttons."` Add new game-channel buttons to the `PARTICIPANT_ONLY` set in `game-scheduling-handlers.ts`.
7. **Type-check before claiming done.** Run `pnpm --filter @workspace/discord-bot run typecheck` after every code change. Do NOT run `pnpm dev` or `pnpm build` at the workspace root — those need workflow-provided env vars. To exercise the bot in dev, set `DEV_BOT_ENABLED=true` in Replit Secrets and restart the workflow.
8. **For DB repairs, transaction or don't bother.** Refunds, balance fixes, and stale-row cleanups always run inside `BEGIN ... COMMIT` with verification SELECTs in the same script. Roll back on any anomaly. Never repair a balance without also (a) logging a `purchase_refund` / `season_adjustment` `coin_transactions` row and (b) decrementing the per-season usage counter in `season_stats` if applicable.

### Things that are intentionally NOT supported anymore
- Public channel auto-posts (transactions, purchases, payouts, polls). Don't reintroduce them.
- AI / LLM features (no OpenAI key, no chat). Do not add LLM calls.
- Twitter / tweet integration. The `guild_tweets` and `league_twitter_*` tables still exist for history but the code path is gone.
- Multi-command slash surface. There is exactly one slash command: `/menu`.

### When you're stuck
- Read `.agents/memory/MEMORY.md` and any topic file it links to — known drift, cold-start workarounds, and DB pitfalls are documented there.
- Read `replit.md` again — the current bug context is usually in the overview.
- If you need to inspect prod data, run a read-only query against Supabase using the snippet pattern at the top of this prompt. If you need to write, ask the user first and always wrap in a transaction.
