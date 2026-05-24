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

/** List all GCS file names that start with `prefix`.
 *  Returns [] if the bucket env var isn't set.
 *  THROWS on GCS auth/network errors so callers can surface the problem. */
export async function listMcaFiles(prefix: string): Promise<string[]> {
  const bucket = makeBucket();
  if (!bucket) return [];
  const [files] = await bucket.getFiles({ prefix });
  return files.map(f => f.name).sort();
}

/** Like listMcaFiles but never throws — returns an object with files and any error. */
export async function listMcaFilesSafe(prefix: string): Promise<{ files: string[]; error?: string }> {
  try {
    const bucket = makeBucket();
    if (!bucket) return { files: [], error: "DEFAULT_OBJECT_STORAGE_BUCKET_ID not configured" };
    const [files] = await bucket.getFiles({ prefix });
    return { files: files.map(f => f.name).sort() };
  } catch (err) {
    return { files: [], error: String(err) };
  }
}

export interface McaFileMeta {
  name: string;
  sizeBytes: number;
  updatedAt: string | null;
}

/** List all GCS files under prefix with size + timestamp metadata. Never throws. */
export async function listMcaFilesWithMeta(
  prefix: string,
): Promise<{ files: McaFileMeta[]; error?: string }> {
  try {
    const bucket = makeBucket();
    if (!bucket) return { files: [], error: "DEFAULT_OBJECT_STORAGE_BUCKET_ID not configured" };
    const [files] = await bucket.getFiles({ prefix });
    const meta: McaFileMeta[] = files.map(f => ({
      name:      f.name,
      sizeBytes: Number(f.metadata?.size ?? 0),
      updatedAt: (f.metadata?.updated as string | undefined) ?? null,
    }));
    meta.sort((a, b) => a.name.localeCompare(b.name));
    return { files: meta };
  } catch (err) {
    return { files: [], error: String(err) };
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

// ── Team logo helpers ─────────────────────────────────────────────────────────
// Global defaults: team-logos/global/{teamId}.png
// Guild overrides:  team-logos/guilds/{guildId}/{teamId}.png

/** Upload a team logo image buffer to GCS at the given path. */
export async function uploadTeamLogo(
  gcsPath: string,
  imageBuffer: Buffer,
  contentType: string = "image/png",
): Promise<void> {
  const bucket = makeBucket();
  if (!bucket) throw new Error("GCS bucket not configured");
  const file = bucket.file(gcsPath);
  await file.save(imageBuffer, { contentType, resumable: false });
}

/** Download a team logo from GCS and return as a Buffer. Returns null if not found. */
export async function downloadTeamLogo(gcsPath: string): Promise<Buffer | null> {
  try {
    const bucket = makeBucket();
    if (!bucket) return null;
    const [exists] = await bucket.file(gcsPath).exists();
    if (!exists) return null;
    const [content] = await bucket.file(gcsPath).download();
    return content;
  } catch {
    return null;
  }
}

/** Delete a team logo from GCS. */
export async function deleteTeamLogo(gcsPath: string): Promise<void> {
  const bucket = makeBucket();
  if (!bucket) return;
  try { await bucket.file(gcsPath).delete(); } catch { /* ignore not-found */ }
}

/** Global default GCS path for a teamId. */
export function globalLogoPath(teamId: number): string {
  return `team-logos/global/${teamId}.png`;
}

/** Guild-specific GCS path for a teamId. */
export function guildLogoPath(guildId: string, teamId: number): string {
  return `team-logos/guilds/${guildId}/${teamId}.png`;
}

/** Delete all stored MCA payload files whose name starts with `prefix`.
 *  Defaults to "mca/week-" to wipe every week-stat JSON saved by the API server.
 *  Never throws — returns counts so callers can surface results to the user. */
export async function deleteMcaPayloads(
  prefix = "mca/week-",
): Promise<{ deleted: number; errors: number; error?: string }> {
  try {
    const bucket = makeBucket();
    if (!bucket) return { deleted: 0, errors: 0, error: "DEFAULT_OBJECT_STORAGE_BUCKET_ID not configured" };
    const [files] = await bucket.getFiles({ prefix });
    let deleted = 0, errors = 0;
    await Promise.all(
      files.map(async (file) => {
        try {
          await file.delete();
          deleted++;
        } catch {
          errors++;
        }
      }),
    );
    return { deleted, errors };
  } catch (err) {
    return { deleted: 0, errors: 0, error: String(err) };
  }
}
