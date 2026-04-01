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

// ── /leagueteams — team info + roster ─────────────────────────────────────────
router.post("/madden/:leagueKey/leagueteams", validateKey, async (req, res) => {
  res.status(200).json({ status: "received" }); // respond immediately so MCA doesn't retry
  console.log("[mca/leagueteams] Received payload, processing async...");
  const result = await processLeagueTeams(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/leagueteams] Result:", result.message);
});

// ── /standings — optional, just acknowledge ────────────────────────────────────
router.post("/madden/:leagueKey/standings", validateKey, (req, res) => {
  res.status(200).json({ status: "received" });
  console.log("[mca/standings] Received standings payload (no-op)");
});

// ── /teamstats — team season stats ────────────────────────────────────────────
router.post("/madden/:leagueKey/teamstats", validateKey, async (req, res) => {
  res.status(200).json({ status: "received" });
  console.log("[mca/teamstats] Received payload, processing async...");
  const result = await processTeamStats(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/teamstats] Result:", result.message);
});

// ── /schedules — full season schedule ─────────────────────────────────────────
router.post("/madden/:leagueKey/schedules", validateKey, async (req, res) => {
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

// ── /week/:weekType/:weekNum/scores — game results + payouts ─────────────────
router.post("/madden/:leagueKey/week/:weekType/:weekNum/scores", validateKey, async (req, res) => {
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

  // Post summary to commissioner channel
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

  // Post game results to general channel
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

export default router;
