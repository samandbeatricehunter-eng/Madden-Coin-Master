create table if not exists public.import_jobs (
  id bigserial primary key,
  guild_id text not null,
  import_type text not null,
  status text not null default 'queued',
  payload_ref text,
  requested_by text,
  progress_current integer not null default 0,
  progress_total integer not null default 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists import_jobs_status_idx
  on public.import_jobs(status, created_at);

create index if not exists import_jobs_guild_idx
  on public.import_jobs(guild_id, import_type, status);
