-- Core Data V2 import-writer consolidation support.
-- Adds import job/payload auditing and identity columns for canonical game upserts.

create table if not exists rec_import_jobs (
  id bigserial primary key,
  guild_id text not null,
  ea_league_id bigint,
  import_type text not null,
  week_type text,
  week_number integer,
  status text not null default 'running',
  rows_received integer not null default 0,
  rows_upserted integer not null default 0,
  h2h_rows integer not null default 0,
  payload_hash text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists rec_import_payloads (
  id bigserial primary key,
  import_job_id bigint references rec_import_jobs(id) on delete cascade,
  guild_id text not null,
  payload_type text not null,
  payload_hash text not null,
  raw_json jsonb not null,
  created_at timestamptz not null default now()
);

alter table rec_league_games add column if not exists identity_key text;
alter table rec_league_games add column if not exists source_hash text;
alter table rec_league_games add column if not exists last_import_job_id bigint;

create unique index if not exists rec_league_games_rec_season_identity_key_idx
  on rec_league_games(rec_season_id, identity_key)
  where identity_key is not null;

create index if not exists rec_import_jobs_guild_started_idx
  on rec_import_jobs(guild_id, started_at desc);
