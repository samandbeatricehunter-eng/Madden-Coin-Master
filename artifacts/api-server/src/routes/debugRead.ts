import { Router, type IRouter, type Request, type Response } from "express";
import { requireApiKey } from "../middleware/requireApiKey.js";
import { listMcaPayloadKeys, readMcaPayload } from "../lib/mcaStorage.js";

const router: IRouter = Router();

/**
 * GET /api/v1/debug/mca-payloads
 * Lists all raw MCA payload keys stored in GCS.
 * Useful for confirming what data has been captured from each import type.
 */
router.get("/v1/debug/mca-payloads", requireApiKey, async (req: Request, res: Response) => {
  try {
    const keys = await listMcaPayloadKeys();
    res.json({ count: keys.length, keys });
  } catch (err) {
    req.log.error(err, "GET /v1/debug/mca-payloads failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/v1/debug/mca-payload?key=mca/leagueteams.json
 * Reads and returns a raw MCA payload from GCS by its storage key.
 * Use the /mca-payloads list endpoint to find available keys.
 *
 * For leagueteams imports the payload shape is:
 *   { leagueTeamInfoList: [ { teamId, userName, personaId, personaName, ... }, ... ] }
 * This lets you inspect every field EA sends per-user so you can identify
 * personaId, personaName, gamertags, and any other user-related data.
 */
router.get("/v1/debug/mca-payload", requireApiKey, async (req: Request, res: Response) => {
  const key = String(req.query["key"] ?? "").trim();
  if (!key) {
    res.status(400).json({ error: "Missing required query param: key" });
    return;
  }
  if (!key.startsWith("mca/")) {
    res.status(400).json({ error: "key must start with mca/" });
    return;
  }
  try {
    const payload = await readMcaPayload(key);
    if (payload === null) {
      res.status(404).json({ error: `No payload found for key: ${key}` });
      return;
    }
    res.json({ key, payload });
  } catch (err) {
    req.log.error(err, "GET /v1/debug/mca-payload failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
