# Import Pipeline V2

## Goal

All imported league data should flow through a small number of canonical writer functions. The bot should never have to guess whether a matchup is in `game_schedules`, `franchise_schedule`, `mca_schedules`, or `rec_league_games`.

## Target flow

```text
EA/MCA export
  -> API route receives payload
  -> raw payload saved for audit
  -> canonical writer normalizes rows
  -> rec_league_games / canonical player tables upserted
  -> cache refresh jobs run
  -> Discord reports import status
```

## Current canonical game writer

```text
artifacts/api-server/src/lib/canonical-games.ts
```

Endpoints that receive schedule/game payloads should call:

```text
syncCanonicalGamesFromSchedulePayload()
backfillCanonicalGamesFromLegacy()
```

## Required identity strategy

Game identity should prefer:

1. EA schedule id if available.
2. Processed/franchise schedule id if available.
3. `guild_id + rec_season_id + week_index + away_team_id + home_team_id`.
4. `guild_id + rec_season_id + week_index + normalized away/home team names`.

Avoid creating new rows for the same game from multiple imports. Use stable identity keys and upserts.

## Legacy table policy

Legacy/raw tables can remain for compatibility and debugging:

```text
game_schedules
franchise_schedule
mca_schedules
matchups
game_log
h2h_matchup_records
```

New feature code should not read these directly. If data is useful, write an adapter that upserts it into `rec_league_games` or another canonical table first.

## Cache refresh targets

After game imports, refresh or invalidate:

```text
rec_competitive_ratings_cache
rec_standings_cache (future)
rec_strength_of_schedule_cache (future)
gameday_matchup_panels state if active
```

## Phase 3 import-writer consolidation

Schedule/result endpoints now write an import audit record before canonical game upserts:

```text
rec_import_jobs
rec_import_payloads
```

Canonical game writes now carry:

```text
identity_key
source_hash
last_import_job_id
```

The identity strategy is:

```text
EA schedule id -> identity_key = ea:<id>
otherwise -> identity_key = wk:<week>:<normalized team/user pair>
```

All schedule/result imports should continue to call `syncCanonicalGamesFromSchedulePayload()` so imports converge into `rec_league_games`. Legacy tables may still be written for compatibility, but feature reads should use canonical services only.

## 2026-05-30 Import V2 Hardening

Every Discord-triggered weekly import now creates `rec_import_jobs` before any EA fetch. The job is updated through visible stages:

- `started`
- `blaze_session`
- `stats_fetching`
- `stats_done`
- `rosters_fetching`
- `rosters_done` / `rosters_failed`
- `stats_writing`
- `schedule_fetching`
- `schedule_done` / `schedule_failed`
- `completed` / `partial` / `failed`

Payloads returned to the bot are recorded in `rec_import_payloads` with `bot_<payloadType>` labels. API schedule writes also record raw schedule payloads and stamp `rec_league_games.last_import_job_id` when the Discord bot sends the `x-rec-import-job-id` header.

EA endpoint errors no longer abort the entire weekly import. Required stat exports that fail become visible failed stages/results, while the rest of the import continues where safe. This is intended to make EA authentication/502 failures diagnosable without leaving the Discord import menu stuck.

Roster sync is wrapped with a timeout and is tracked in the same import job. Schedule/result imports remain routed through `syncCanonicalGamesFromSchedulePayload()` into `rec_league_games` as the canonical game source.
