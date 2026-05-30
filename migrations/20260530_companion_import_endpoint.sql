alter table rec_import_jobs add column if not exists stage text not null default 'started';
alter table rec_import_jobs add column if not exists debug_json jsonb not null default '{}'::jsonb;
alter table rec_import_jobs add column if not exists created_by_discord_id text;
alter table rec_import_jobs add column if not exists updated_at timestamptz not null default now();
alter table rec_import_payloads add column if not exists created_at timestamptz not null default now();
create index if not exists idx_rec_import_jobs_guild_started on rec_import_jobs(guild_id, started_at desc);
create index if not exists idx_rec_import_jobs_status_stage on rec_import_jobs(status, stage);
create index if not exists idx_rec_import_payloads_job_type on rec_import_payloads(import_job_id, payload_type);
