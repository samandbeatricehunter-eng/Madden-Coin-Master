import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

let _bucket: ReturnType<InstanceType<typeof Storage>["bucket"]> | null = null;
let _disabled = false;

function getBucket() {
  if (_disabled) return null;
  if (_bucket) return _bucket;
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) {
    console.warn("[mcaStorage] DEFAULT_OBJECT_STORAGE_BUCKET_ID not set — raw payload storage disabled");
    _disabled = true;
    return null;
  }
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
}

/**
 * Read and parse a previously saved MCA payload from GCS.
 * Returns null if the file doesn't exist or GCS is unavailable.
 */
export async function readMcaPayload(key: string): Promise<unknown | null> {
  const bucket = getBucket();
  if (!bucket) return null;
  try {
    const [buf] = await bucket.file(key).download();
    return JSON.parse(buf.toString("utf8"));
  } catch (err: unknown) {
    const code = (err as any)?.code;
    if (code === 404 || code === "404") return null;
    console.error(`[mcaStorage] Failed to read ${key}:`, err);
    return null;
  }
}

/**
 * Fire-and-forget: write raw MCA payload to GCS as a JSON file.
 * Each key is deterministic so re-exports overwrite the previous file.
 * Deferred via setImmediate so serialization never adds latency to responses.
 * Never throws — a failed write must never affect the webhook response.
 */
export function saveMcaPayload(key: string, body: unknown): void {
  if (body === undefined || body === null) return;
  const bucket = getBucket();
  if (!bucket) return;

  setImmediate(() => {
    const json = JSON.stringify(body, null, 2);
    bucket
      .file(key)
      .save(json, { contentType: "application/json" })
      .then(() => console.log(`[mcaStorage] Saved ${key} (${json.length} bytes)`))
      .catch((err: unknown) => console.error(`[mcaStorage] Failed to save ${key}:`, err));
  });
}
