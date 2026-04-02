import { Storage } from "@google-cloud/storage";

const SIDECAR_URL = "http://127.0.0.1:1106";

function makeBucket() {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) return null;
  const storage = new Storage({
    credentials: {
      type: "external_account",
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${SIDECAR_URL}/token`,
      credential_source: {
        url: `${SIDECAR_URL}/credential`,
        format: { type: "json", subject_token_field_name: "access_token" },
      },
      universe_domain: "googleapis.com",
    } as any,
    projectId: "",
  });
  return storage.bucket(bucketId);
}

/** List all GCS file names that start with `prefix`. Returns [] if unavailable. */
export async function listMcaFiles(prefix: string): Promise<string[]> {
  try {
    const bucket = makeBucket();
    if (!bucket) return [];
    const [files] = await bucket.getFiles({ prefix });
    return files.map(f => f.name).sort();
  } catch {
    return [];
  }
}

/** Download and JSON-parse a GCS file. Throws on failure. */
export async function readMcaJson(key: string): Promise<unknown> {
  const bucket = makeBucket();
  if (!bucket) throw new Error("GCS bucket not configured (DEFAULT_OBJECT_STORAGE_BUCKET_ID missing)");
  const [content] = await bucket.file(key).download();
  return JSON.parse(content.toString("utf8"));
}

/** Returns true if the file exists in GCS. */
export async function mcaFileExists(key: string): Promise<boolean> {
  try {
    const bucket = makeBucket();
    if (!bucket) return false;
    const [exists] = await bucket.file(key).exists();
    return exists;
  } catch {
    return false;
  }
}
