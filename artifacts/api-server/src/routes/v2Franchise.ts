/**
 * v2 MCA Webhook Routes — Madden-native, no Discord.
 * MCA sends data here; the processor stores it in mca_* tables keyed by eaLeagueId.
 *
 * URL pattern: /mca/v2/:leagueKey/:platform/:eaLeagueId/<endpoint>
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  processV2LeagueTeams,
  processV2Roster,
  processV2FreeAgents,
  processV2Standings,
  processV2TeamWeekStats,
  processV2Schedules,
  processV2PlayerWeekStats,
  processV2DraftPicks,
  getOrCreateV2Season,
  setV2CurrentWeek,
  type WeekStatType,
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

function eid(req: Request): number {
  return parseInt(String(req.params["eaLeagueId"] ?? "0"), 10);
}

function wNum(req: Request): number {
  return parseInt(String(req.params["weekNum"] ?? "0"), 10);
}

function wType(req: Request): string {
  return String(req.params["weekType"] ?? "reg").toLowerCase();
}

// Fire-and-forget helper — logs errors so they're never silently swallowed
function bg(label: string, promise: Promise<{ ok: boolean; message: string }>) {
  promise.then(r => {
    if (!r.ok) console.error(`[${label}] FAILED: ${r.message}`);
    else       console.log(`[${label}] ${r.message}`);
  }).catch(err => console.error(`[${label}] UNHANDLED:`, err));
}

// ── /leagueteams ──────────────────────────────────────────────────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/leagueteams", validateKey, (req, res) => {
  const id = eid(req);
  saveMcaPayload(`mca/v2/${id}/leagueteams.json`, req.body);
  res.status(200).json({ status: "received" });
  bg(`v2/leagueteams/${id}`, processV2LeagueTeams(
    req.body, id,
    String(req.query["leagueName"] ?? ""),
    String(req.params["platform"]  ?? "pc"),
  ));
});

// ── /teams/:teamId/roster ─────────────────────────────────────────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/teams/:teamId/roster", validateKey, (req, res) => {
  const id     = eid(req);
  const teamId = parseInt(String(req.params["teamId"] ?? "0"), 10);
  saveMcaPayload(`mca/v2/${id}/roster-${teamId}.json`, req.body);
  res.status(200).json({ status: "received" });
  bg(`v2/roster/${id}/team${teamId}`, processV2Roster(req.body, teamId, id));
});

// ── /freeagents/roster ────────────────────────────────────────────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/freeagents/roster", validateKey, (req, res) => {
  const id = eid(req);
  saveMcaPayload(`mca/v2/${id}/freeagents.json`, req.body);
  res.status(200).json({ status: "received" });
  bg(`v2/freeagents/${id}`, processV2FreeAgents(req.body, id));
});

// ── /standings ────────────────────────────────────────────────────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/standings", validateKey, (req, res) => {
  const id = eid(req);
  saveMcaPayload(`mca/v2/${id}/standings.json`, req.body);
  res.status(200).json({ status: "received" });
  bg(`v2/standings/${id}`, processV2Standings(req.body, id));
});

// ── /schedules (full season) ──────────────────────────────────────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/schedules", validateKey, (req, res) => {
  const id = eid(req);
  saveMcaPayload(`mca/v2/${id}/schedules.json`, req.body);
  res.status(200).json({ status: "received" });
  bg(`v2/schedules/${id}`, processV2Schedules(req.body, id));
});

// ── /week/:weekType/:weekNum/schedules — per-week game results ─────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/week/:weekType/:weekNum/schedules", validateKey, (req, res) => {
  const id = eid(req);
  const wn = wNum(req); const wt = wType(req);
  saveMcaPayload(`mca/v2/${id}/week-${wt}-${wn}-schedules.json`, req.body);
  res.status(200).json({ status: "received" });
  bg(`v2/week${wn}/schedules/${id}`, processV2Schedules(req.body, id, wn, wt));
});

// ── /week/:weekType/:weekNum/team — per-week team stats ───────────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/week/:weekType/:weekNum/team", validateKey, (req, res) => {
  const id = eid(req);
  const wn = wNum(req); const wt = wType(req);
  saveMcaPayload(`mca/v2/${id}/week-${wt}-${wn}-team.json`, req.body);
  res.status(200).json({ status: "received" });
  bg(`v2/week${wn}/team/${id}`, processV2TeamWeekStats(req.body, wt, wn, id));
});

// ── /week/:weekType/:weekNum/:statType — per-week player stats ─────────────────
const PLAYER_STAT_TYPES: WeekStatType[] = [
  "passing","rushing","receiving","defense",
  "kicking","punting","kickreturn","kickreturning","puntreturn","puntreturning",
];
for (const statType of PLAYER_STAT_TYPES) {
  router.post(
    `/mca/v2/:leagueKey/:platform/:eaLeagueId/week/:weekType/:weekNum/${statType}`,
    validateKey,
    (req, res) => {
      const id = eid(req);
      const wn = wNum(req); const wt = wType(req);
      saveMcaPayload(`mca/v2/${id}/week-${wt}-${wn}-${statType}.json`, req.body);
      res.status(200).json({ status: "received" });
      bg(`v2/week${wn}/${statType}/${id}`, processV2PlayerWeekStats(req.body, statType, wt, wn, id));
    },
  );
}

// ── /draftpicks ───────────────────────────────────────────────────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/draftpicks", validateKey, (req, res) => {
  const id = eid(req);
  saveMcaPayload(`mca/v2/${id}/draftpicks.json`, req.body);
  res.status(200).json({ status: "received" });
  bg(`v2/draftpicks/${id}`, processV2DraftPicks(req.body, id));
});

// ── /season/week — update current week ────────────────────────────────────────
router.post("/mca/v2/:leagueKey/:platform/:eaLeagueId/season/week", validateKey, async (req, res) => {
  const id   = eid(req);
  const body = req.body as Record<string, unknown>;
  const week = String(body["week"] ?? req.query["week"] ?? "");
  if (!week) { res.status(400).json({ ok: false, error: "week is required" }); return; }
  const result = await setV2CurrentWeek(id, week).catch(err => ({ ok: false, message: String(err) }));
  res.status(result.ok ? 200 : 500).json(result);
});

// ── /ping ─────────────────────────────────────────────────────────────────────
router.get("/mca/v2/:leagueKey/:platform/:eaLeagueId/ping", validateKey, async (req, res) => {
  const id = eid(req);
  const season = await getOrCreateV2Season(id).catch(() => null);
  res.json({ ok: true, eaLeagueId: id, seasonId: season?.id ?? null });
});

export default router;
