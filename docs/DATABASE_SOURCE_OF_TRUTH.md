# Database Source of Truth

## Current decision

`rec_league_games` is the canonical game schedule and results table for the bot.

Feature code should not independently decide whether to read from `game_schedules`, `franchise_schedule`, `mca_schedules`, `matchups`, `game_log`, or `h2h_matchup_records`. Those tables are legacy, raw, or compatibility layers unless an import adapter is actively transforming their data into canonical records.

## Canonical game path

```text
raw EA/MCA payload
  -> import endpoint / import job
  -> canonical game writer
  -> rec_league_games
  -> canonical services/views
  -> feature UI/cache/menu
```

## Important namespaces

`seasons.id` is the bot/app season row id.

`seasons.season_number` is the user-facing Madden/franchise season number.

`rec_league_games.rec_season_id` is the canonical imported season id used by the REC canonical game layer.

These values are not the same namespace. Never compare `seasons.id` directly to `rec_league_games.rec_season_id`.

Use `rec_season_mappings`:

```text
seasons.id -> rec_season_mappings.season_id
rec_season_mappings.rec_season_id -> rec_league_games.rec_season_id
```

## Operational gameday tables

These tables store Discord workflow state and should link to canonical games with `rec_game_id` whenever possible:

```text
gameday_matchup_panels
gameday_schedule_offers
gameday_commissioner_requests
gameday_score_submissions
gameday_completion_confirmations
```

`game_schedules` remains a legacy compatibility table. It may be updated temporarily by older flows, but new feature reads should prefer canonical services.

## Current service layer

Use these modules before adding new direct table queries:

```text
artifacts/discord-bot/src/lib/canonical/season-mapping-service.ts
artifacts/discord-bot/src/lib/canonical/canonical-game-service.ts
artifacts/discord-bot/src/lib/competitive/competitive-ratings.ts
```

## Current audited mappings

```text
REC League:      seasons.id 7  / season_number 2 -> rec_season_id 5
REC Fantasy:     seasons.id 15 / season_number 2 -> rec_season_id 7
Original League: seasons.id 3  / season_number 3 -> rec_season_id 3
```

## Feature routing rules

- Strength of Schedule: `rec_league_games` + `rec_season_mappings`.
- Competitive Rating: completed H2H from `rec_league_games` or `v_canonical_h2h_results`.
- Gameday panel recovery: `gameday_matchup_panels.rec_game_id -> rec_league_games.id`, fallback to mapped lookup.
- Scheduling offers: should reference `rec_game_id` plus `matchup_key`; `game_schedule_id` is compatibility only.
- Imports: all schedule/result endpoints must call the canonical writer.
