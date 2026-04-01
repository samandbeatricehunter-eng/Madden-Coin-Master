import { Router, type IRouter, type Request, type Response } from "express";
import {
  processLeagueTeams,
  processTeamStats,
  processSchedules,
  processWeekScores,
} from "../lib/franchise-processor.js";
import { sendDiscordEmbed } from "../lib/discord-notify.js";

const router: IRouter = Router();

const COMMISSIONER_CHANNEL_ID = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";
const GENERAL_CHANNEL_ID      = process.env["DISCORD_GENERAL_CHANNEL_ID"]      ?? "1476321282868908052";

// ── Key validation middleware ─────────────────────────────────────────────────
function validateKey(req: Request, res: Response, next: () => void) {
  const expected = process.env["MADDEN_WEBHOOK_KEY"];
  if (!expected) {
    console.warn("[mca] MADDEN_WEBHOOK_KEY not set — rejecting request");
    res.status(500).json({ error: "Webhook key not configured on server" });
    return;
  }
  if (req.params["leagueKey"] !== expected) {
    console.warn(`[mca] Invalid key: ${req.params["leagueKey"]}`);
    res.status(403).json({ error: "Invalid league key" });
    return;
  }
  next();
}

// The MCA appends /platform/leagueId/ between the base URL and endpoint slug.
// e.g. base = /api/madden/:leagueKey  →  actual call = /api/madden/:leagueKey/pc/21960156/leagueteams
// We use /:platform/:leagueId/ to absorb those segments and keep the key check simple.

// ── /leagueteams — team info ───────────────────────────────────────────────────
router.post("/madden/:leagueKey/:platform/:leagueId/leagueteams", validateKey, async (req, res) => {
  res.status(200).json({ status: "received" });
  console.log("[mca/leagueteams] Received payload, processing async...");
  const result = await processLeagueTeams(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/leagueteams] Result:", result.message);
});

// ── /standings — league standings; log structure so we know what fields arrive ─
router.post("/madden/:leagueKey/:platform/:leagueId/standings", validateKey, (req, res) => {
  res.status(200).json({ status: "received" });
  const body = req.body as Record<string, unknown>;
  const keys = Object.keys(body ?? {});
  const firstKey = keys[0];
  const sample = firstKey && Array.isArray(body[firstKey]) ? (body[firstKey] as any[])[0] : body;
  console.log("[mca/standings] Top-level keys:", keys);
  console.log("[mca/standings] First item sample:", JSON.stringify(sample)?.slice(0, 500));
});

// ── /teamstats — season-level team stats (some MCA versions send this) ────────
router.post("/madden/:leagueKey/:platform/:leagueId/teamstats", validateKey, async (req, res) => {
  res.status(200).json({ status: "received" });
  console.log("[mca/teamstats] Received payload, processing async...");
  const result = await processTeamStats(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/teamstats] Result:", result.message);
});

// ── /schedules — full season schedule ─────────────────────────────────────────
router.post("/madden/:leagueKey/:platform/:leagueId/schedules", validateKey, async (req, res) => {
  res.status(200).json({ status: "received" });
  console.log("[mca/schedules] Received payload, processing async...");
  const result = await processSchedules(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/schedules] Result:", result.message);
  if (!result.ok && COMMISSIONER_CHANNEL_ID) {
    sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
      title: "⚠️ MCA Schedule Import Issue",
      description: result.message,
      color: 0xed4245,
    }).catch(() => {});
  }
});

// ── /freeagents/roster — known EA bug (always empty); just acknowledge ─────────
router.post("/madden/:leagueKey/:platform/:leagueId/freeagents/roster", validateKey, (req, res) => {
  res.status(200).json({ status: "received" });
  console.log("[mca/freeagents/roster] Acknowledged (EA bug — payload skipped)");
});

// ── /week/:weekType/:weekNum/team — per-week team offense stats ───────────────
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/team", validateKey, async (req, res) => {
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
  res.status(200).json({ status: "received" });
  console.log(`[mca/week${weekNum}/team] Received team stats (weekType=${weekType}), processing...`);
  const result = await processTeamStats(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log(`[mca/week${weekNum}/team] Result:`, result.message);
});

// ── /week/:weekType/:weekNum/defense — per-week defensive stats (acknowledge) ─
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/defense", validateKey, (req, res) => {
  const weekNum = req.params["weekNum"] ?? "?";
  res.status(200).json({ status: "received" });
  console.log(`[mca/week${weekNum}/defense] Acknowledged (no-op)`);
});

// ── /week/:weekType/:weekNum/passing — per-week passing stats (acknowledge) ───
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/passing", validateKey, (req, res) => {
  res.status(200).json({ status: "received" });
});

// ── /week/:weekType/:weekNum/rushing — per-week rushing stats (acknowledge) ───
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/rushing", validateKey, (req, res) => {
  res.status(200).json({ status: "received" });
});

// ── /week/:weekType/:weekNum/receiving — per-week receiving stats (acknowledge)
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/receiving", validateKey, (req, res) => {
  res.status(200).json({ status: "received" });
});

// ── /week/:weekType/:weekNum/schedules — per-week game results → payouts ──────
// The MCA sends scores here (NOT /scores). This is the primary payout trigger.
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/schedules", validateKey, async (req, res) => {
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
  res.status(200).json({ status: "received" });
  console.log(`[mca/week${weekNum}/schedules] Received schedule+scores (weekType=${weekType}), processing payouts...`);
  const result = await processWeekScores(req.body, weekNum).catch(err => ({
    ok: false, message: String(err),
    gamesProcessed: 0, gamesDuplicate: 0, gamesCpuVsCpu: 0, gamesUnregistered: 0,
    payoutLines: [] as string[], milestoneLines: [] as string[],
    weekNum, seasonId: 0,
  }));
  console.log(`[mca/week${weekNum}/schedules] Result: ${result.message} | processed=${result.gamesProcessed} dupes=${result.gamesDuplicate}`);

  if (!result.ok) {
    console.error(`[mca/week${weekNum}/schedules] Processing failed:`, result.message);
    if (COMMISSIONER_CHANNEL_ID) {
      sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
        title: `❌ Week ${weekNum} Import Failed`,
        description: result.message,
        color: 0xed4245,
      }).catch(() => {});
    }
    return;
  }

  if (COMMISSIONER_CHANNEL_ID) {
    const fields = [];
    if (result.payoutLines.length > 0) {
      fields.push({ name: "💰 Coin Payouts", value: result.payoutLines.slice(0, 10).join("\n") || "None", inline: false });
    }
    if (result.milestoneLines.length > 0) {
      fields.push({ name: "🎯 Milestones", value: result.milestoneLines.join("\n"), inline: false });
    }
    fields.push({
      name: "📊 Summary",
      value: [
        `✅ Games paid: **${result.gamesProcessed}**`,
        result.gamesDuplicate   > 0 ? `⏭ Already processed: ${result.gamesDuplicate}` : null,
        result.gamesCpuVsCpu    > 0 ? `🤖 CPU vs CPU skipped: ${result.gamesCpuVsCpu}` : null,
        result.gamesUnregistered > 0 ? `⚠️ Unregistered players: ${result.gamesUnregistered}` : null,
      ].filter(Boolean).join("\n") || "No games to process",
      inline: false,
    });
    await sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
      title: `✅ Week ${weekNum} — MCA Import Complete`,
      color: 0x57f287,
      fields,
      footer: { text: `Season ${result.seasonId} · Madden Companion App` },
    }).catch(() => {});
  }

  if (GENERAL_CHANNEL_ID && result.payoutLines.length > 0) {
    const lines = result.payoutLines
      .filter(l => l.startsWith("🏆") || l.startsWith("🤝"))
      .map(l => {
        const m = l.match(/\*\*(.+?)\*\* \+\d+ \| 🎮 \*\*(.+?)\*\* \+\d+ \*\((\d+)–(\d+)\)\*/);
        if (m) return `🏆 **${m[1]}** ${m[3]} — ${m[4]} **${m[2]}**`;
        return l;
      });
    if (lines.length > 0) {
      await sendDiscordEmbed(GENERAL_CHANNEL_ID, {
        title: `🏈 Week ${weekNum} Results`,
        description: lines.join("\n"),
        color: 0xf0b132,
      }).catch(() => {});
    }
  }
});

// ── /team/:teamId/roster — per-team roster (no-op, we don't use this data) ───
router.post("/madden/:leagueKey/:platform/:leagueId/team/:teamId/roster", validateKey, (req, res) => {
  res.status(200).json({ status: "received" });
  console.log(`[mca/team/${req.params["teamId"]}/roster] Acknowledged (no-op)`);
});

// ── /week/:weekType/:weekNum/scores — game results + payouts ─────────────────
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/scores", validateKey, async (req, res) => {
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();

  res.status(200).json({ status: "received" });

  if (weekType !== "reg" || weekNum < 1 || weekNum > 18) {
    console.log(`[mca] Ignoring non-regular-season scores: weekType=${weekType} weekNum=${weekNum}`);
    return;
  }

  console.log(`[mca/week${weekNum}/scores] Received, processing payouts...`);
  const result = await processWeekScores(req.body, weekNum).catch(err => ({
    ok: false, message: String(err),
    gamesProcessed: 0, gamesDuplicate: 0, gamesCpuVsCpu: 0, gamesUnregistered: 0,
    payoutLines: [] as string[], milestoneLines: [] as string[],
    weekNum, seasonId: 0,
  }));

  if (!result.ok) {
    console.error(`[mca/week${weekNum}/scores] Processing failed:`, result.message);
    if (COMMISSIONER_CHANNEL_ID) {
      sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
        title: `❌ Week ${weekNum} Import Failed`,
        description: result.message,
        color: 0xed4245,
      }).catch(() => {});
    }
    return;
  }

  if (COMMISSIONER_CHANNEL_ID) {
    const fields = [];

    if (result.payoutLines.length > 0) {
      fields.push({
        name: "💰 Coin Payouts",
        value: result.payoutLines.slice(0, 10).join("\n") || "None",
        inline: false,
      });
    }

    if (result.milestoneLines.length > 0) {
      fields.push({
        name: "🎯 Win Milestones",
        value: result.milestoneLines.join("\n"),
        inline: false,
      });
    }

    fields.push({
      name: "📊 Import Stats",
      value: [
        `Games processed: **${result.gamesProcessed}**`,
        `Duplicates skipped: ${result.gamesDuplicate}`,
        `CPU vs CPU: ${result.gamesCpuVsCpu}`,
        `Unregistered: ${result.gamesUnregistered}`,
      ].join("\n"),
      inline: false,
    });

    await sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
      title: `✅ Week ${weekNum} — MCA Import Complete`,
      color: 0x57f287,
      fields,
      footer: { text: `Season ${result.seasonId} · Madden Companion App` },
    }).catch(() => {});
  }

  if (GENERAL_CHANNEL_ID && result.payoutLines.length > 0) {
    const lines = result.payoutLines
      .filter(l => l.startsWith("🏆") || l.startsWith("🤝"))
      .map(l => {
        const m = l.match(/\*\*(.+?)\*\* \+\d+ \| 🎮 \*\*(.+?)\*\* \+\d+ \*\((\d+)–(\d+)\)\*/);
        if (m) return `🏆 **${m[1]}** ${m[3]} — ${m[4]} **${m[2]}**`;
        return l;
      });

    if (lines.length > 0) {
      await sendDiscordEmbed(GENERAL_CHANNEL_ID, {
        title: `🏈 Week ${weekNum} Results`,
        description: lines.join("\n"),
        color: 0xf0b132,
      }).catch(() => {});
    }
  }
});

// ── /schedules — full season schedule (may include completed game scores) ─────
router.post("/madden/:leagueKey/:platform/:leagueId/schedules", validateKey, async (req, res) => {
  res.status(200).json({ status: "received" });
  const body = req.body as Record<string, unknown>;
  const keys = Object.keys(body ?? {});
  const firstKey = keys[0];
  const sample = firstKey && Array.isArray(body[firstKey]) ? (body[firstKey] as any[])[0] : body;
  console.log("[mca/schedules] Top-level keys:", keys);
  console.log("[mca/schedules] First item sample:", JSON.stringify(sample)?.slice(0, 500));
  const result = await processSchedules(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/schedules] Result:", result.message);
});

// ── Catch-all: log any MCA endpoint we haven't explicitly handled ─────────────
// Uses router.use() to avoid path-to-regexp wildcard restrictions.
// validateKey not supported here; check key manually.
router.use("/madden", (req, res) => {
  const expectedKey = process.env["MADDEN_WEBHOOK_KEY"];
  const pathParts   = req.path.split("/").filter(Boolean); // ["recleague001","pc","21960156","some","endpoint"]
  const urlKey      = pathParts[0] ?? "";
  if (expectedKey && urlKey !== expectedKey) {
    res.status(401).json({ error: "Invalid key" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const keys = Object.keys(body ?? {});
  const firstKey = keys[0];
  const sample = firstKey && Array.isArray(body[firstKey]) ? (body[firstKey] as any[])[0] : body;
  console.log(`[mca/UNKNOWN] ${req.method} /madden${req.path} — top-level keys: ${JSON.stringify(keys)}`);
  console.log(`[mca/UNKNOWN] First item sample: ${JSON.stringify(sample)?.slice(0, 400)}`);
  res.status(200).json({ status: "received" });
});

export default router;
