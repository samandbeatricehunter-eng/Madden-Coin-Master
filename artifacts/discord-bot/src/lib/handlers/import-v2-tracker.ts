import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createHash } from "crypto";

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export type ImportV2Stage =
  | "started"
  | "blaze_session"
  | "stats_fetching"
  | "stats_done"
  | "rosters_fetching"
  | "rosters_done"
  | "rosters_failed"
  | "stats_writing"
  | "stats_done_writing"
  | "schedule_writing"
  | "schedule_done"
  | "schedule_fetching"
  | "schedule_failed"
  | "cache_refresh"
  | "completed"
  | "partial"
  | "failed";

export function importPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

export async function ensureImportV2Tables(): Promise<void> {
  await db.execute(sql`
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
    )
  `);
  await db.execute(sql`alter table rec_import_jobs add column if not exists stage text not null default 'started'`).catch(() => null);
  await db.execute(sql`alter table rec_import_jobs add column if not exists debug_json jsonb not null default '{}'::jsonb`).catch(() => null);
  await db.execute(sql`alter table rec_import_jobs add column if not exists created_by_discord_id text`).catch(() => null);
  await db.execute(sql`create index if not exists idx_rec_import_jobs_guild_started on rec_import_jobs(guild_id, started_at desc)`).catch(() => null);
  await db.execute(sql`create index if not exists idx_rec_import_jobs_status_stage on rec_import_jobs(status, stage)`).catch(() => null);

  await db.execute(sql`
    create table if not exists rec_import_payloads (
      id bigserial primary key,
      import_job_id bigint references rec_import_jobs(id) on delete cascade,
      guild_id text not null,
      payload_type text not null,
      payload_hash text not null,
      raw_json jsonb not null,
      created_at timestamptz not null default now()
    )
  `);
  await db.execute(sql`create index if not exists idx_rec_import_payloads_job on rec_import_payloads(import_job_id, payload_type)`).catch(() => null);
}

export async function startImportV2Job(args: {
  guildId: string;
  eaLeagueId: number;
  importType: string;
  weekType?: string;
  weekNumber?: number;
  createdByDiscordId?: string | null;
  debug?: Record<string, unknown>;
}): Promise<number> {
  await ensureImportV2Tables();
  const [row] = await rowsOf<{ id: number }>(sql`
    insert into rec_import_jobs (guild_id, ea_league_id, import_type, week_type, week_number, stage, status, created_by_discord_id, debug_json)
    values (${args.guildId}, ${args.eaLeagueId}, ${args.importType}, ${args.weekType ?? null}, ${args.weekNumber ?? null}, 'started', 'running', ${args.createdByDiscordId ?? null}, ${JSON.stringify(args.debug ?? {})}::jsonb)
    returning id
  `);
  return Number(row?.id ?? 0);
}

export async function updateImportV2Job(jobId: number | null | undefined, patch: {
  stage?: ImportV2Stage | string;
  status?: "running" | "completed" | "partial" | "failed" | "failed_retryable" | string;
  rowsReceived?: number;
  rowsUpserted?: number;
  h2hRows?: number;
  payloadHash?: string | null;
  errorMessage?: string | null;
  debug?: Record<string, unknown>;
  finish?: boolean;
}): Promise<void> {
  if (!jobId) return;
  await ensureImportV2Tables();
  await db.execute(sql`
    update rec_import_jobs
    set stage = coalesce(${patch.stage ?? null}, stage),
        status = coalesce(${patch.status ?? null}, status),
        rows_received = coalesce(${patch.rowsReceived ?? null}, rows_received),
        rows_upserted = coalesce(${patch.rowsUpserted ?? null}, rows_upserted),
        h2h_rows = coalesce(${patch.h2hRows ?? null}, h2h_rows),
        payload_hash = coalesce(${patch.payloadHash ?? null}, payload_hash),
        error_message = ${patch.errorMessage === undefined ? null : patch.errorMessage},
        debug_json = coalesce(debug_json, '{}'::jsonb) || ${JSON.stringify(patch.debug ?? {})}::jsonb,
        finished_at = case when ${Boolean(patch.finish)} then now() else finished_at end,
        updated_at = now()
    where id = ${jobId}
  `).catch(() => null);
}

export async function storeImportV2Payload(args: {
  jobId: number | null | undefined;
  guildId: string;
  payloadType: string;
  payload: unknown;
}): Promise<string> {
  await ensureImportV2Tables();
  const hash = importPayloadHash(args.payload);
  await db.execute(sql`
    insert into rec_import_payloads (import_job_id, guild_id, payload_type, payload_hash, raw_json)
    values (${args.jobId ?? null}, ${args.guildId}, ${args.payloadType}, ${hash}, ${JSON.stringify(args.payload ?? null)}::jsonb)
  `).catch(() => null);
  return hash;
}

export async function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function importErrorMessage(err: unknown): string {
  const anyErr = err as any;
  const name = anyErr?.errorname ?? anyErr?.name ?? "Error";
  const msg = anyErr?.userMessage ?? anyErr?.message ?? String(err);
  return `${name}: ${msg}`.slice(0, 2000);
}
