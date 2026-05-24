import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

let _bucket: ReturnType<InstanceType<typeof Storage>["bucket"]> | null = null;
let _disabled = false;

function getBucket() {
  if (_disabled) return null;
  if (_bucket) return _bucket;
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) {
    console.warn("[mcaReader] DEFAULT_OBJECT_STORAGE_BUCKET_ID not set — GCS reads disabled");
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
        format: { type: "json", subject_token_field_name: "access_token" },
      },
      universe_domain: "googleapis.com",
    } as any,
    projectId: "",
  });
  _bucket = storage.bucket(bucketId);
  return _bucket;
}

/**
 * Read and parse a stored MCA JSON file from GCS.
 * Returns null if the file doesn't exist or bucket is not configured.
 */
export async function readMcaJson(key: string): Promise<unknown | null> {
  const bucket = getBucket();
  if (!bucket) return null;
  try {
    const [contents] = await bucket.file(key).download();
    return JSON.parse(contents.toString("utf8"));
  } catch (err: any) {
    if (err?.code === 404 || String(err).includes("No such object")) {
      console.warn(`[mcaReader] File not found: ${key}`);
      return null;
    }
    console.error(`[mcaReader] Error reading ${key}:`, err);
    return null;
  }
}
