import { Storage } from "@google-cloud/storage";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

let _bucket: ReturnType<InstanceType<typeof Storage>["bucket"]> | null = null;
let _bucketChecked = false;
let _bucketDisabledReason: string | null = null;

function getBucket() {
  if (_bucket) return _bucket;
  if (_bucketChecked && _bucketDisabledReason) return null;

  _bucketChecked = true;
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) {
    _bucketDisabledReason = "DEFAULT_OBJECT_STORAGE_BUCKET_ID not set";
    console.warn("[mcaStorage] DEFAULT_OBJECT_STORAGE_BUCKET_ID not set — using database payload archive fallback");
    return null;
  }

  try {
    const storage = new Storage({
      credentials: {
        type: "external_account",
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
        credential_source: {
          url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
          format: {
            type: "json",
            subject_token_field_name: "access_token",
          },
        },
        universe_domain: "googleapis.com",
      } as any,
      projectId: "",
    });
    _bucket = storage.bucket(bucketId);
    return _bucket;
  } catch (err) {
    _bucketDisabledReason = String(err);
    console.error("[mcaStorage] Failed to initialize object storage — using database payload archive fallback:", err);
    return null;
  }
}

async function ensurePayloadArchiveTable(): Promise<void> {
  await db.execute(sql`
    create table if not exists mca_payload_archives (
      id bigserial primary key,
      payload_key text not null unique,
      payload_json jsonb not null,
      payload_size_bytes integer,
      storage_backend text not null default 'database',
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);
}

async function savePayloadToDatabase(key: string, body: unknown, backend = "database"): Promise<void> {
  try {
    await ensurePayloadArchiveTable();
    const json = JSON.stringify(body ?? null);
    await db.execute(sql`
      insert into mca_payload_archives (payload_key, payload_json, payload_size_bytes, storage_backend, updated_at)
      values (${key}, ${JSON.stringify(body ?? null)}::jsonb, ${Buffer.byteLength(json, "utf8")}, ${backend}, now())
      on conflict (payload_key) do update
      set payload_json = excluded.payload_json,
          payload_size_bytes = excluded.payload_size_bytes,
          storage_backend = excluded.storage_backend,
          updated_at = now()
    `);
    console.log(`[mcaStorage] Archived ${key} to database (${json.length} bytes)`);
  } catch (err) {
    console.error(`[mcaStorage] Failed to archive ${key} to database:`, err);
  }
}

/**
 * Read and parse a previously saved MCA payload from GCS or database fallback.
 */
export async function readMcaPayload(key: string): Promise<unknown | null> {
  const bucket = getBucket();
  if (bucket) {
    try {
      const [buf] = await bucket.file(key).download();
      return JSON.parse(buf.toString("utf8"));
    } catch (err: unknown) {
      const code = (err as any)?.code;
      if (!(code === 404 || code === "404")) console.error(`[mcaStorage] Failed to read ${key} from object storage:`, err);
    }
  }

  try {
    await ensurePayloadArchiveTable();
    const rows = await db.execute(sql`
      select payload_json
      from mca_payload_archives
      where payload_key = ${key}
      limit 1
    `);
    const out = ((rows as any).rows ?? rows) as any[];
    return out[0]?.payload_json ?? null;
  } catch (err) {
    console.error(`[mcaStorage] Failed to read ${key} from database archive:`, err);
    return null;
  }
}

/**
 * List all saved MCA payload keys from GCS plus database fallback.
 */
export async function listMcaPayloadKeys(): Promise<string[]> {
  const keys = new Set<string>();
  const bucket = getBucket();
  if (bucket) {
    try {
      const [files] = await bucket.getFiles({ prefix: "mca/" });
      for (const file of files) keys.add(file.name);
    } catch (err: unknown) {
      console.error("[mcaStorage] Failed to list object storage keys:", err);
    }
  }

  try {
    await ensurePayloadArchiveTable();
    const rows = await db.execute(sql`
      select payload_key
      from mca_payload_archives
      where payload_key like 'mca/%'
      order by payload_key
    `);
    for (const row of (((rows as any).rows ?? rows) as any[])) keys.add(String(row.payload_key));
  } catch (err) {
    console.error("[mcaStorage] Failed to list database archive keys:", err);
  }

  return [...keys].sort();
}

/**
 * Fire-and-forget: write raw MCA payload to object storage when configured,
 * and always retain a database fallback archive when object storage is absent
 * or fails. Never throws — archival must never affect webhook responses.
 */
export function saveMcaPayload(key: string, body: unknown): void {
  if (body === undefined || body === null) return;

  setImmediate(() => {
    const bucket = getBucket();
    if (!bucket) {
      void savePayloadToDatabase(key, body, "database_fallback");
      return;
    }

    const json = JSON.stringify(body, null, 2);
    bucket
      .file(key)
      .save(json, { contentType: "application/json" })
      .then(async () => {
        console.log(`[mcaStorage] Saved ${key} to object storage (${json.length} bytes)`);
        await savePayloadToDatabase(key, body, "object_storage_mirror");
      })
      .catch(async (err: unknown) => {
        console.error(`[mcaStorage] Failed to save ${key} to object storage:`, err);
        await savePayloadToDatabase(key, body, "database_after_object_storage_failure");
      });
  });
}
