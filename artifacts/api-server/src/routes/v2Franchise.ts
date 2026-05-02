/**
 * v2 MCA Webhook Routes — Madden-native, no Discord.
 * MCA sends data here; the processor stores it in mca_* tables keyed by eaLeagueId.
 *
 * URL pattern: /madden/v2/:leagueKey/:platform/:eaLeagueId/<endpoint>
 * Same leagueKey auth as v1 (MADDEN_WEBHOOK_KEY env var).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  processV2LeagueTeams,
  processV2Roster,
  processV2FreeAgents,
  processV2Standings,
  processV2Schedules,
  processV2PlayerWeekStats,
  processV2DraftPicks,
  getOrCreateV2Season,
  setV2CurrentWeek,
} from "../lib/v2-processor.js";
import { saveMcaPayload } from "../lib/mcaStorage.js";

const router: IRouter = Router();

function validateKey(req: Request, res: Response, next: () => void) {
  const expected = process.env["MADDEN_WEBHOOK_KEY"];
  if (!expected) {
    res.status(500).json({ error: "Webhook key not configured on server" });
    return;
  }
  if (req.params["leagueKey"] !== expected) {
    res.status(403).json({ error: "Invalid league key" });
    return;
  }
  next();
}

function leagueId(req: Request): number {
  return parseInt(String(req.params["eaLeagueId"] ?? "0"), 10);
}

// ── /leagueteams ──────────────────────────────────────────────────────────────
router.post("/madden/v2/:leagueKey/:platform/:eaLeagueId/leagueteams", validateKey, async (req, res) => {
  const eid = leagueId(req);
  saveMcaPayload(`mca/v2/${eid}/leagueteams.json`, req.body);
  res.status(200).json({ status: "received" });
  const result = await processV2LeagueTeams(
    req.body, eid,
    String(req.query["leagueName"] ?? ""),
    String(req.params["platform"] ?? "pc"),
  ).catch(err => ({ ok: false, message: String(err) }));
  console.log(`[v2/leagueteams/${eid}] ${result.message}`);
});

// ── /teams/:teamId/roster ─────────────────────────────────────────────────────
router.post("/madden/v2/:leagueKey/:platform/:eaLeagueId/teams/:teamId/roster", validateKey, async (req, res) => {
  const eid    = leagueId(req);
  const teamId = parseInt(String(req.params["teamId"] ?? "0"), 10);
  saveMcaPayload(`mca/v2/${eid}/roster-${teamId}.json`, req.body);
  res.status(200).json({ status: "received" });
  const result = await processV2Roster(req.body, teamId, eid)
    .catch(err => ({ ok: false, message: String(err) }));
  console.log(`[v2/roster/${eid}/team${teamId}] ${result.message}`);
});

// ── /freeagents/roster ────────────────────────────────────────────────────────
router.post("/madden/v2/:leagueKey/:platform/:eaLeagueId/freeagents/roster", validateKey, async (req, res) => {
  const eid = leagueId(req);
  saveMcaPayload(`mca/v2/${eid}/freeagents.json`, req.body);
  res.status(200).json({ status: "received" });
  const result = await processV2FreeAgents(req.body, eid)
    .catch(err => ({ ok: false, message: String(err) }));
  console.log(`[v2/freeagents/${eid}] ${result.message}`);
});

// ── /standings ────────────────────────────────────────────────────────────────
router.post("/madden/v2/:leagueKey/:platform/:eaLeagueId/standings", validateKey, async (req, res) => {
  const eid = leagueId(req);
  saveMcaPayload(`mca/v2/${eid}/standings.json`, req.body);
  res.status(200).json({ status: "received" });
  const result = await processV2Standings(req.body, eid)
    .catch(err => ({ ok: false, message: String(err) }));
  console.log(`[v2/standings/${eid}] ${result.message}`);
});

// ── /schedules ────────────────────────────────────────────────────────────────
router.post("/madden/v2/:leagueKey/:platform/:eaLeagueId/schedules", validateKey, async (req, res) => {
  const eid = leagueId(req);
  saveMcaPayload(`mca/v2/${eid}/schedules.json`, req.body);
  res.status(200).json({ status: "received" });
  const result = await processV2Schedules(req.body, eid)
    .catch(err => ({ ok: false, message: String(err) }));
  console.log(`[v2/schedules/${eid}] ${result.message}`);
});

// ── /week/:weekType/:weekNum/schedules — per-week game results ─────────────────
router.post("/madden/v2/:leagueKey/:platform/:eaLeagueId/week/:weekType/:weekNum/schedules", validateKey, async (req, res) => {
  const eid      = leagueId(req);
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
  saveMcaPayload(`mca/v2/${eid}/week-${weekType}-${weekNum}-schedules.json`, req.body);
  res.status(200).json({ status: "received" });
  const result = await processV2Schedules(req.body, eid, weekNum, weekType)
    .catch(err => ({ ok: false, message: String(err) }));
  console.log(`[v2/week${weekNum}/schedules/${eid}] ${result.message}`);
});

// ── /week/:weekType/:weekNum/:statType — per-week player stats ─────────────────
for (const statType of ["passing", "rushing", "receiving", "defense", "kicking", "punting", "kickreturn", "puntreturn"] as const) {
  router.post(
    `/madden/v2/:leagueKey/:platform/:eaLeagueId/week/:weekType/:weekNum/${statType}`,
    validateKey,
    async (req, res) => {
      const eid      = leagueId(req);
      const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
      const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
      saveMcaPayload(`mca/v2/${eid}/week-${weekType}-${weekNum}-${statType}.json`, req.body);
      res.status(200).json({ status: "received" });
      const result = await processV2PlayerWeekStats(req.body, statType, weekType, weekNum, eid)
        .catch(err => ({ ok: false, message: String(err) }));
      console.log(`[v2/week${weekNum}/${statType}/${eid}] ${result.message}`);
    },
  );
}

// ── /draftpicks ───────────────────────────────────────────────────────────────
router.post("/madden/v2/:leagueKey/:platform/:eaLeagueId/draftpicks", validateKey, async (req, res) => {
  const eid = leagueId(req);
  saveMcaPayload(`mca/v2/${eid}/draftpicks.json`, req.body);
  res.status(200).json({ status: "received" });
  const result = await processV2DraftPicks(req.body, eid)
    .catch(err => ({ ok: false, message: String(err) }));
  console.log(`[v2/draftpicks/${eid}] ${result.message}`);
});

// ── /season/week — update current week label ──────────────────────────────────
// Called by the companion app or admin tool when advancing to a new week.
router.post("/madden/v2/:leagueKey/:platform/:eaLeagueId/season/week", validateKey, async (req, res) => {
  const eid  = leagueId(req);
  const week = String((req.body as any)?.week ?? req.query["week"] ?? "");
  if (!week) { res.status(400).json({ ok: false, error: "week is required" }); return; }
  const result = await setV2CurrentWeek(eid, week)
    .catch(err => ({ ok: false, message: String(err) }));
  res.status(result.ok ? 200 : 500).json(result);
});

// ── /ping — confirm league is connected and has an active season ───────────────
router.get("/madden/v2/:leagueKey/:platform/:eaLeagueId/ping", validateKey, async (req, res) => {
  const eid = leagueId(req);
  const season = await getOrCreateV2Season(eid).catch(() => null);
  res.json({ ok: true, eaLeagueId: eid, seasonId: season?.id ?? null });
});

export default router;
