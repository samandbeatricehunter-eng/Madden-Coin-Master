


## Phase 2.2 SOS Rewrite

Strength of Schedule now builds a direct SQL-side distinct opponent set from `rec_league_games`.

Rules:
- Use `rec_season_mappings` to resolve the current app season to imported REC season ids.
- Pull H2H games from `rec_league_games`.
- Build both directions for every game:
  - away user -> home user
  - home user -> away user
- Use `distinct` opponent ids per user.
- CPU/unlinked games are excluded.
- SOS = average current competitive rating of distinct H2H opponents.

This intentionally avoids JS-side row grouping/deduping that previously caused users such as Eagles and Cowboys to display no H2H opponents despite having rec_league_games rows.

## Core Data V2 Progress

Completed in the current package:
- Added `season-mapping-service.ts` for `seasons.id -> rec_season_id` resolution.
- Added `canonical-game-service.ts` for current-season H2H opponent lookup, completed H2H results, and panel game lookup.
- Competitive Rating now routes completed H2H reads through canonical service.
- Strength of Schedule now routes current-season H2H opponent reads through canonical service.
- Gameday panel recovery now attempts `rec_game_id` lookup through canonical service before legacy `game_schedules` fallback.
- Added `DATABASE_SOURCE_OF_TRUTH.md` and `IMPORT_PIPELINE_V2.md`.

Still to phase out later:
- Remaining direct `game_schedules` reads in wager board, commissioner gameday review, check-in, GOTW, league roles, and some gameday domain helpers.
- Legacy write compatibility updates to `game_schedules` should remain until all workflows use `rec_game_id`.

## SOS Display Enhancement

Strength of Schedule now stores and displays the toughest remaining H2H opponent per user.

The display replaces the trailing team-name field with:

```text
Toughest Remaining Opponent: <opponent mention> (<competitive rating>)
```

This value is calculated from the user's distinct current-season H2H opponent set sourced from `rec_league_games` through `rec_season_mappings`, then selecting the opponent with the highest current competitive rating.

## Phase 3 import audit and identity columns

`rec_league_games` now has canonical import writer metadata:

```text
identity_key
source_hash
last_import_job_id
```

Raw payloads are audited in:

```text
rec_import_jobs
rec_import_payloads
```

This creates an import trail while keeping `rec_league_games` as the canonical schedule/result source.

## 2026-05-30 Toughest Remaining Opponent Rule

Strength of Schedule uses the full current-season H2H schedule. The displayed `Toughest Remaining Opponent` uses only current-week and future H2H games. It is sourced from `getCurrentSeasonRemainingH2HOpponents()`, which filters `rec_league_games.week_index >= seasons.current_week` after resolving the active REC season through `rec_season_mappings`.
