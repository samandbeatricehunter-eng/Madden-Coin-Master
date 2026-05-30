import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createHash } from "crypto";
import { syncCanonicalGamesFromSchedulePayload, ensureCanonicalLeagueLayerApi } from "../lib/canonical-games.js";

const router: IRouter = Router();

const SUPPORTED_PAYLOAD_TYPES = new Set([
  "schedule", "schedules", "roster", "rosters", "standings",
  "passing", "rushing", "receiving", "defense", "teamStats", "teamstats",
  "kicking", "punting", "kickReturn", "kickreturn", "puntReturn", "puntreturn",
]);

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function normalizePayloadType(value: string): string {
  const raw = String(value || "").trim();
  if (raw === "schedules") return "schedule";
  if (raw === "rosters") return "roster";
  if (raw === "teamstats") return "teamStats";
  if (raw === "kickreturn") return "kickReturn";
  if (raw === "puntreturn") return "puntReturn";
  return raw;
}

function extractPayload(body: any): unknown {
  if (body && typeof body === "object" && "payload" in body) return body.payload;
  return body;
}

async function resolveEaLeagueId(guildId: string, body: any): Promise<number> {
  const explicit = Number(body?.leagueId ?? body?.eaLeagueId ?? body?.ea_league_id ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const [conn] = await rowsOf<{ ea_league_id: number }>(sql`
    select ea_league_id
    from ea_connections
    where guild_id=${guildId}
    order by updated_at desc nulls last, id desc
    limit 1
  `).catch(() => []);
  const resolved = Number((conn as any)?.ea_league_id ?? 0);
  if (Number.isFinite(resolved) && resolved > 0) return Math.trunc(resolved);
  throw new Error("Unable to resolve EA league id. Include leagueId in the request body or connect EA first.");
}

async function startCompanionJob(args: { guildId: string; eaLeagueId: number; payloadType: string; weekType: string; weekNumber: number | null; payloadHash: string; }): Promise<number> {
  await ensureCanonicalLeagueLayerApi();
  const [row] = await rowsOf<{ id: number }>(sql`
    insert into rec_import_jobs (guild_id, ea_league_id, import_type, week_type, week_number, stage, status, rows_received, payload_hash, debug_json)
    values (${args.guildId}, ${args.eaLeagueId}, 'companion_${args.payloadType}', ${args.weekType}, ${args.weekNumber}, 'payload_received', 'running', 0, ${args.payloadHash}, ${JSON.stringify({ source: "companion_url", payloadType: args.payloadType })}::jsonb)
    returning id
  `);
  return Number(row.id);
}

async function storePayload(args: { jobId: number; guildId: string; payloadType: string; payloadHash: string; payload: unknown; }): Promise<void> {
  await db.execute(sql`
    insert into rec_import_payloads (import_job_id, guild_id, payload_type, payload_hash, raw_json)
    values (${args.jobId}, ${args.guildId}, ${args.payloadType}, ${args.payloadHash}, ${JSON.stringify(args.payload ?? null)}::jsonb)
  `);
}

function requireSecret(req: Request, res: Response): boolean {
  const expected = process.env["REC_IMPORT_SECRET"] || process.env["MADDEN_WEBHOOK_KEY"] || "";
  if (!expected) {
    res.status(500).json({ ok: false, error: "REC_IMPORT_SECRET or MADDEN_WEBHOOK_KEY must be configured" });
    return false;
  }
  const provided = String(req.headers["x-rec-import-secret"] ?? req.query["secret"] ?? "").trim();
  if (provided !== expected) {
    res.status(403).json({ ok: false, error: "Invalid import secret" });
    return false;
  }
  return true;
}

router.post("/imports/companion/:guildId/:payloadType", async (req: Request, res: Response) => {
  if (!requireSecret(req, res)) return;

  const guildId = String(req.params["guildId"] ?? "").trim();
  const payloadType = normalizePayloadType(String(req.params["payloadType"] ?? ""));
  if (!guildId) { res.status(400).json({ ok: false, error: "Missing guildId" }); return; }
  if (!SUPPORTED_PAYLOAD_TYPES.has(payloadType)) { res.status(400).json({ ok: false, error: `Unsupported payloadType: ${payloadType}` }); return; }

  const body: any = req.body ?? {};
  const payload = extractPayload(body);
  const platform = String(body.platform ?? req.query["platform"] ?? "pc").toLowerCase();
  const weekType = String(body.weekType ?? body.week_type ?? req.query["weekType"] ?? "reg").toLowerCase();
  const weekNumberRaw = Number(body.weekNumber ?? body.week_number ?? body.weekNum ?? req.query["weekNumber"] ?? req.query["weekNum"] ?? 0);
  const weekNumber = Number.isFinite(weekNumberRaw) && weekNumberRaw > 0 ? Math.trunc(weekNumberRaw) : 0;
  const payloadHash = hashPayload(payload);

  let jobId = 0;
  try {
    const eaLeagueId = await resolveEaLeagueId(guildId, body);
    jobId = await startCompanionJob({ guildId, eaLeagueId, payloadType, weekType, weekNumber: weekNumber || null, payloadHash });
    await storePayload({ jobId, guildId, payloadType: `companion_${payloadType}`, payloadHash, payload });

    if (payloadType === "schedule") {
      await db.execute(sql`update rec_import_jobs set stage='schedule_writing', status='running' where id=${jobId}`).catch(() => null);
      const result = await syncCanonicalGamesFromSchedulePayload(payload, weekNumber, weekType, eaLeagueId, guildId, jobId);
      await db.execute(sql`
        update rec_import_jobs
        set stage='schedule_done', status='completed', rows_upserted=${result.upserted}, h2h_rows=${result.h2h}, finished_at=now()
        where id=${jobId}
      `).catch(() => null);
      res.json({ ok: true, importJobId: jobId, payloadType, platform, canonical: result });
      return;
    }

    await db.execute(sql`
      update rec_import_jobs
      set stage='payload_stored', status='completed', rows_received=1, rows_upserted=0, finished_at=now(),
          debug_json=coalesce(debug_json,'{}'::jsonb) || ${JSON.stringify({ note: "Payload stored. Canonical writer for this payload type is pending.", payloadType, platform })}::jsonb
      where id=${jobId}
    `).catch(() => null);

    res.json({
      ok: true,
      importJobId: jobId,
      payloadType,
      platform,
      status: "payload_stored",
      message: "Payload stored in rec_import_payloads. Canonical writer for this payload type is pending.",
    });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (jobId) {
      await db.execute(sql`update rec_import_jobs set stage='failed', status='failed', error_message=${message}, finished_at=now() where id=${jobId}`).catch(() => null);
    }
    res.status(500).json({ ok: false, importJobId: jobId || null, error: message });
  }
});

export default router;
