import { Storage } from "@google-cloud/storage";

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
  const storage = new Storage();
  _bucket = storage.bucket(bucketId);
  return _bucket;
}

/**
 * Fire-and-forget: write raw MCA payload to GCS as a JSON file.
 * Each key is deterministic so re-exports overwrite the previous file.
 * Deferred via setImmediate so serialization and upload never add latency
 * to the webhook response. Never throws.
 */
export function saveMcaPayload(key: string, body: unknown): void {
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
