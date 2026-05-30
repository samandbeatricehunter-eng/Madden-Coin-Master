-- Import Pipeline V2 hardening: job stage tracking, payload capture, and canonical import provenance.

create table if not exists rec_import_jobs (
  id bigserial primary key,
  guild_id text not null,
  ea_league_id bigint,
  import_type text not null,
  week_type text,
  week_number integer,
  stage text not null default 'started',
  status text not null default 'running',
  rows_received integer not null default 0,
  rows_upserted integer not null default 0,
  h2h_rows integer not null default 0,
  payload_hash text,
  error_message text,
  debug_json jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_by_discord_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table rec_import_jobs add column if not exists stage text not null default 'started';
alter table rec_import_jobs add column if not exists debug_json jsonb not null default '{}'::jsonb;
alter table rec_import_jobs add column if not exists created_by_discord_id text;
create index if not exists idx_rec_import_jobs_guild_started on rec_import_jobs(guild_id, started_at desc);
create index if not exists idx_rec_import_jobs_status_stage on rec_import_jobs(status, stage);

create table if not exists rec_import_payloads (
  id bigserial primary key,
  import_job_id bigint references rec_import_jobs(id) on delete cascade,
  guild_id text not null,
  payload_type text not null,
  payload_hash text not null,
  raw_json jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_rec_import_payloads_job on rec_import_payloads(import_job_id, payload_type);

alter table rec_league_games add column if not exists identity_key text;
alter table rec_league_games add column if not exists source_hash text;
alter table rec_league_games add column if not exists last_import_job_id bigint;
create unique index if not exists rec_league_games_rec_season_identity_key_idx
  on rec_league_games(rec_season_id, identity_key)
  where identity_key is not null;


alter table rec_import_jobs add column if not exists updated_at timestamptz not null default now();
