import { Router, type IRouter, type Request, type Response } from "express";
import {
  processLeagueTeams,
  processTeamStats,
  processTeamWeekStats,
  processSchedules,
  processWeekScores,
  syncWeekScoresToSchedule,
  processPlayerWeekStats,
  processTeamRoster,
  processFreeAgentRoster,
  processDraftPicks,
  processPlayoffSeedings,
  processStandingsSeedings,
} from "../lib/franchise-processor.js";
import { sendDiscordEmbed, sendDiscordEmbedWithButtons } from "../lib/discord-notify.js";
import { saveMcaPayload, readMcaPayload } from "../lib/mcaStorage.js";
import { db, statPaddingViolationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { ViolationRecord } from "../lib/stat-padding-detector.js";

const router: IRouter = Router();

const COMMISSIONER_CHANNEL_ID  = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";
const GENERAL_CHANNEL_ID       = process.env["DISCORD_GENERAL_CHANNEL_ID"]      ?? "1476321282868908052";
const VIOLATION_LOG_CHANNEL_ID = "1491529826060734524";

// ── Per-violation commissioner posting (with Confirm/Deny buttons) ────────────
async function postViolationMessages(
  violations: ViolationRecord[],
  week: string,
  seasonId: number,
  commChannelId: string,
): Promise<void> {
  for (const v of violations) {
    // Resolve discordId by teamName if not already provided
    let discordId = v.discordId ?? null;
    if (!discordId && v.teamName) {
      const [userRow] = await db
        .select({ discordId: usersTable.discordId })
        .from(usersTable)
        .where(eq(usersTable.team, v.teamName))
        .limit(1);
      discordId = userRow?.discordId ?? null;
    }

    const typeLabel: Record<string, string> = {
      h2h_blowout: "H2H Blowout",
      cpu_score:   "CPU Score Anomaly",
      player_stat: "Player Stat Padding",
    };

    // Save violation record to DB
    const [inserted] = await db
      .insert(statPaddingViolationsTable)
      .values({
        seasonId,
        week,
        type:        v.type,
        discordId,
        playerName:  v.playerName ?? null,
        teamName:    v.teamName,
        description: v.description,
        status:      "pending",
      })
      .returning({ id: statPaddingViolationsTable.id });

    if (!inserted) continue;
    const violationId = inserted.id;

    // Post individual embed to commissioner log with Confirm/Deny buttons
    const embed = {
      title:       `🚨 Violation Flagged — ${typeLabel[v.type] ?? v.type}`,
      description: v.description + (discordId ? `\n\n**Owner:** <@${discordId}>` : ""),
      color:       0xed4245,
      footer:      { text: `Violation #${violationId} · ${week} · Requires commissioner review` },
    };

    const msgId = await sendDiscordEmbedWithButtons(
      commChannelId,
      embed,
      `violation_confirm:${violationId}`,
      `violation_deny:${violationId}`,
    ).catch(() => null);

    // Store the message ID so the bot can edit it on confirm/deny
    if (msgId) {
      await db
        .update(statPaddingViolationsTable)
        .set({ commMessageId: msgId })
        .where(eq(statPaddingViolationsTable.id, violationId));
    }
  }
}

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
  saveMcaPayload("mca/leagueteams.json", req.body);
  res.status(200).json({ status: "received" });
  console.log("[mca/leagueteams] Received payload, processing async...");
  const result = await processLeagueTeams(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/leagueteams] Result:", result.message);
});

// ── /standings — league standings; log structure so we know what fields arrive ─
router.post("/madden/:leagueKey/:platform/:leagueId/standings", validateKey, (req, res) => {
  saveMcaPayload("mca/standings.json", req.body);
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
  saveMcaPayload("mca/teamstats.json", req.body);
  res.status(200).json({ status: "received" });
  console.log("[mca/teamstats] Received payload, processing async...");
  const result = await processTeamStats(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/teamstats] Result:", result.message);
});

// ── /seedings — set playoff seeds from EA conferenceRank data ─────────────────
// Called by /admin_ea_export standings on the bot. Accepts the same team stats
// payload shape as /week/:weekType/:weekNum/team but bypasses the dedup guard
// so it can be re-run any time to refresh seeds from the latest EA data.
router.post("/madden/:leagueKey/:platform/:leagueId/seedings", validateKey, async (req, res) => {
  saveMcaPayload("mca/seedings-latest.json", req.body);
  res.status(200).json({ status: "received" });
  console.log("[mca/seedings] Received playoff seedings payload, processing...");
  const result = await processPlayoffSeedings(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/seedings] Result:", result.message);
  if (!result.ok && COMMISSIONER_CHANNEL_ID) {
    sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
      title: "⚠️ Playoff Seedings Import Issue",
      description: result.message,
      color: 0xed4245,
    }).catch(() => {});
  }
});

// ── /internal/reseed-from-standings — internal bot call, no league key in URL ──
// Uses Authorization: Bearer <MADDEN_WEBHOOK_KEY> header instead of URL param.
// Called by /admin-playoffs reseed on the bot.
router.post("/internal/reseed-from-standings", async (req: Request, res: Response) => {
  const expected = process.env["MADDEN_WEBHOOK_KEY"];
  const auth = req.headers["authorization"] ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (expected && provided !== expected) {
    res.status(403).json({ ok: false, message: "Unauthorized" });
    return;
  }
  const standingsData = await readMcaPayload("mca/standings.json").catch(() => null);
  if (!standingsData) {
    res.status(404).json({ ok: false, message: "mca/standings.json not found in storage — run a full MCA export first" });
    return;
  }
  const result = await processStandingsSeedings(standingsData).catch(err => ({ ok: false, message: String(err) }));
  res.status(result.ok ? 200 : 500).json(result);
});

// ── /schedules — full season schedule ─────────────────────────────────────────
router.post("/madden/:leagueKey/:platform/:leagueId/schedules", validateKey, async (req, res) => {
  saveMcaPayload("mca/schedules.json", req.body);
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

// ── /freeagents/roster — free agent pool (EA historically sent empty; process if populated) ──
router.post("/madden/:leagueKey/:platform/:leagueId/freeagents/roster", validateKey, async (req, res) => {
  saveMcaPayload("mca/freeagents-roster.json", req.body);
  res.status(200).json({ status: "received" });
  const result = await processFreeAgentRoster(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/freeagents/roster]", result.message);
});

// ── /week/:weekType/:weekNum/team — per-week team offense stats ───────────────
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/team", validateKey, async (req, res) => {
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
  saveMcaPayload(`mca/week-${weekType}-${weekNum}-team.json`, req.body);
  res.status(200).json({ status: "received" });
  console.log(`[mca/week${weekNum}/team] Received team stats (weekType=${weekType}), processing...`);
  const result = await processTeamWeekStats(req.body, weekType, weekNum).catch(err => ({ ok: false, message: String(err) }));
  console.log(`[mca/week${weekNum}/team] Result:`, result.message);
});

// ── /week/:weekType/:weekNum/{passing|rushing|receiving|defense} → player stat upserts ──
for (const statType of ["passing", "rushing", "receiving", "defense"] as const) {
  router.post(
    `/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/${statType}`,
    validateKey,
    async (req, res) => {
      const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
      const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
      saveMcaPayload(`mca/week-${weekType}-${weekNum}-${statType}.json`, req.body);
      res.status(200).json({ status: "received" });
      const result = await processPlayerWeekStats(req.body, statType, weekType, weekNum).catch(err => ({
        ok: false, message: String(err), violations: [] as ViolationRecord[],
      }));
      if (result.ok) {
        console.log(`[mca/week${weekNum}/${statType}] ${result.message}`);
      } else {
        console.error(`[mca/week${weekNum}/${statType}] Error: ${result.message}`);
      }
      if (COMMISSIONER_CHANNEL_ID && result.violations && result.violations.length > 0) {
        postViolationMessages(
          result.violations,
          weekLabel(weekType, weekNum),
          (result as any).seasonId ?? 0,
          COMMISSIONER_CHANNEL_ID,
        ).catch(() => {});
      }
    },
  );
}

// ── Playoff round label helper ─────────────────────────────────────────────────
function weekLabel(weekType: string, weekNum: number): string {
  if (weekType === "reg") return `Week ${weekNum}`;
  if (weekType === "pre") return `Preseason Week ${weekNum}`;
  const ROUNDS: Record<number, string> = {
    1: "Wild Card", 2: "Divisional Round", 3: "Conference Championship", 4: "Super Bowl",
  };
  return ROUNDS[weekNum] ?? `Playoff Round ${weekNum}`;
}

// ── /week/:weekType/:weekNum/schedules — per-week game results → payouts ──────
// The MCA sends scores here (NOT /scores). This is the primary payout trigger.
// Handles both regular season (weekType=reg) and playoffs (weekType=post, etc.)
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/schedules", validateKey, async (req, res) => {
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
  saveMcaPayload(`mca/week-${weekType}-${weekNum}-schedules.json`, req.body);
  res.status(200).json({ status: "received" });
  console.log(`[mca/week${weekNum}/schedules] Received schedule+scores (weekType=${weekType}), processing...`);
  // Write completed scores to franchise_schedule immediately so /seasonschedule
  // reflects results regardless of whether /schedules is sent before or after this.
  await syncWeekScoresToSchedule(req.body, weekNum, weekType);
  const result = await processWeekScores(req.body, weekNum, weekType).catch(err => ({
    ok: false, message: String(err),
    gamesProcessed: 0, gamesDuplicate: 0, gamesCpuVsCpu: 0, gamesUnregistered: 0,
    payoutLines: [] as string[], milestoneLines: [] as string[],
    resultLines: [] as string[], unregisteredLines: [] as string[], violations: [] as ViolationRecord[],
    weekNum, seasonId: 0, catchupMode: false,
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

  const roundLabel = weekLabel(weekType, weekNum);

  if (COMMISSIONER_CHANNEL_ID) {
    // ── Catchup mode: send a minimal commissioner-only confirmation, no payouts ──
    if (result.catchupMode) {
      const gameLines = result.resultLines.length > 0
        ? result.resultLines.slice(0, 15).join("\n")
        : "No completed games found";
      await sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
        title: `📋 ${roundLabel} — MCA Import (Catchup Mode)`,
        description: `Scores logged — no payouts issued\n\n${gameLines}`,
        color: 0x5865f2,
        footer: { text: `Season ${result.seasonId} · Catchup Mode Active` },
      }).catch(() => {});
      if (result.violations.length > 0) {
        await postViolationMessages(result.violations, roundLabel, result.seasonId, COMMISSIONER_CHANNEL_ID).catch(() => {});
      }
      return;
    }

    const fields = [];

    if (result.resultLines.length > 0) {
      fields.push({
        name: "🏈 Game Results",
        value: result.resultLines.slice(0, 15).join("\n"),
        inline: false,
      });
    }

    if (result.unregisteredLines.length > 0) {
      fields.push({
        name: "⚠️ Unregistered — no coins paid",
        value: result.unregisteredLines.join("\n"),
        inline: false,
      });
    }

    if (result.milestoneLines.length > 0) {
      fields.push({ name: "🎯 Milestones", value: result.milestoneLines.join("\n"), inline: false });
    }

    const summaryParts: string[] = [];
    if (result.gamesProcessed > 0)    summaryParts.push(`✅ Paid out: **${result.gamesProcessed}** game(s)`);
    if (result.gamesDuplicate > 0)    summaryParts.push(`⏭ Already processed: ${result.gamesDuplicate}`);
    if (result.gamesCpuVsCpu > 0)     summaryParts.push(`🤖 CPU vs CPU skipped: ${result.gamesCpuVsCpu}`);
    if (result.gamesUnregistered > 0) summaryParts.push(`⚠️ Unregistered (no payout): ${result.gamesUnregistered}`);
    if (result.resultLines.length === 0 && result.gamesProcessed === 0) summaryParts.push("No completed games found in this week's data yet");

    fields.push({ name: "📊 Summary", value: summaryParts.join("\n") || "Nothing to process", inline: false });

    await sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
      title: `✅ ${roundLabel} — MCA Import`,
      color: result.gamesProcessed > 0 ? 0x57f287 : 0x5865f2,
      fields,
      footer: { text: `Season ${result.seasonId} · Madden Companion App` },
    }).catch(() => {});

    // ── Violation alerts — individual messages with Confirm/Deny ─────────────
    if (result.violations.length > 0) {
      await postViolationMessages(result.violations, roundLabel, result.seasonId, COMMISSIONER_CHANNEL_ID).catch(() => {});
    }
  }

  // Only post results to the general channel in normal (non-catchup) mode
  if (GENERAL_CHANNEL_ID && result.payoutLines.length > 0 && !result.catchupMode) {
    const lines = result.payoutLines
      .filter(l => l.startsWith("🏆") || l.startsWith("🤝"))
      .map(l => {
        const m = l.match(/\*\*(.+?)\*\* \+\d+ \| 🎮 \*\*(.+?)\*\* \+\d+ \*\((\d+)–(\d+)\)\*/);
        if (m) return `🏆 **${m[1]}** ${m[3]} — ${m[4]} **${m[2]}**`;
        return l;
      });
    if (lines.length > 0) {
      await sendDiscordEmbed(GENERAL_CHANNEL_ID, {
        title: `🏈 ${roundLabel} Results`,
        description: lines.join("\n"),
        color: 0xf0b132,
      }).catch(() => {});
    }
  }
});

// ── /draftpicks — league-wide draft pick ledger (next 3 classes) ─────────────
// The MCA exports all 32 teams' picks in one flat list. We accept both the
// top-level /draftpicks slug and the per-team variant /team/:teamId/draftpicks.
router.post("/madden/:leagueKey/:platform/:leagueId/draftpicks", validateKey, async (req, res) => {
  saveMcaPayload("mca/draftpicks.json", req.body);
  res.status(200).json({ status: "received" });
  const result = await processDraftPicks(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/draftpicks]", result.message);
});

router.post("/madden/:leagueKey/:platform/:leagueId/leaguedraftpicks", validateKey, async (req, res) => {
  saveMcaPayload("mca/draftpicks.json", req.body);
  res.status(200).json({ status: "received" });
  const result = await processDraftPicks(req.body).catch(err => ({ ok: false, message: String(err) }));
  console.log("[mca/leaguedraftpicks]", result.message);
});

// ── /team/:teamId/draftpicks — per-team picks (MCA sends one per team) ────────
// The MCA issues one POST per team when exporting draft picks. We accumulate
// all individual payloads through the same processDraftPicks upsert so the
// table ends up with the full league ledger once all 32 teams have posted.
router.post("/madden/:leagueKey/:platform/:leagueId/team/:teamId/draftpicks", validateKey, async (req, res) => {
  const teamIdStr = String(req.params["teamId"] ?? "0");
  const mcaTeamId = parseInt(teamIdStr, 10);
  saveMcaPayload(`mca/team-${teamIdStr}-draftpicks.json`, req.body);
  res.status(200).json({ status: "received" });
  const result = await processDraftPicks(req.body, isNaN(mcaTeamId) ? undefined : mcaTeamId)
    .catch(err => ({ ok: false, message: String(err) }));
  console.log(`[mca/team/${teamIdStr}/draftpicks]`, result.message);
});

// ── /team/:teamId/roster — per-team active 53-man roster ─────────────────────
router.post("/madden/:leagueKey/:platform/:leagueId/team/:teamId/roster", validateKey, async (req, res) => {
  const teamIdStr = String(req.params["teamId"] ?? "0");
  const mcaTeamId = parseInt(teamIdStr, 10);
  saveMcaPayload(`mca/team-${teamIdStr}-roster.json`, req.body);
  res.status(200).json({ status: "received" });
  if (isNaN(mcaTeamId)) {
    console.warn(`[mca/team/${teamIdStr}/roster] Invalid teamId — skipping`);
    return;
  }
  const result = await processTeamRoster(req.body, mcaTeamId).catch(err => ({ ok: false, message: String(err) }));
  console.log(`[mca/team/${teamIdStr}/roster] ${result.message}`);
});

// ── /week/:weekType/:weekNum/scores — game results + payouts ─────────────────
// Fallback endpoint — MCA primarily uses /week/:weekType/:weekNum/schedules, but some
// versions also fire /scores. Supports both regular season and playoffs.
router.post("/madden/:leagueKey/:platform/:leagueId/week/:weekType/:weekNum/scores", validateKey, async (req, res) => {
  const weekNum  = parseInt(String(req.params["weekNum"]  ?? "0"), 10);
  const weekType = String(req.params["weekType"] ?? "reg").toLowerCase();
  saveMcaPayload(`mca/week-${weekType}-${weekNum}-scores.json`, req.body);
  res.status(200).json({ status: "received" });

  console.log(`[mca/week${weekNum}/scores] Received (weekType=${weekType}), processing payouts...`);
  const result = await processWeekScores(req.body, weekNum, weekType).catch(err => ({
    ok: false, message: String(err),
    gamesProcessed: 0, gamesDuplicate: 0, gamesCpuVsCpu: 0, gamesUnregistered: 0,
    payoutLines: [] as string[], milestoneLines: [] as string[],
    resultLines: [] as string[], unregisteredLines: [] as string[], violations: [] as ViolationRecord[],
    weekNum, seasonId: 0, catchupMode: false,
  }));

  const scoresRoundLabel = weekLabel(weekType, weekNum);

  if (!result.ok) {
    console.error(`[mca/week${weekNum}/scores] Processing failed:`, result.message);
    if (COMMISSIONER_CHANNEL_ID) {
      sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
        title: `❌ ${scoresRoundLabel} Import Failed`,
        description: result.message,
        color: 0xed4245,
      }).catch(() => {});
    }
    return;
  }

  if (COMMISSIONER_CHANNEL_ID) {
    if (result.catchupMode) {
      const gameLines = result.resultLines.length > 0
        ? result.resultLines.slice(0, 15).join("\n")
        : "No completed games found";
      await sendDiscordEmbed(COMMISSIONER_CHANNEL_ID, {
        title: `📋 ${scoresRoundLabel} — MCA Import (Catchup Mode)`,
        description: `Scores logged — no payouts issued\n\n${gameLines}`,
        color: 0x5865f2,
        footer: { text: `Season ${result.seasonId} · Catchup Mode Active` },
      }).catch(() => {});
      if (result.violations.length > 0) {
        await postViolationMessages(result.violations, scoresRoundLabel, result.seasonId, COMMISSIONER_CHANNEL_ID).catch(() => {});
      }
      return;
    }

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
      title: `✅ ${scoresRoundLabel} — MCA Import Complete`,
      color: 0x57f287,
      fields,
      footer: { text: `Season ${result.seasonId} · Madden Companion App` },
    }).catch(() => {});

    if (result.violations.length > 0) {
      await postViolationMessages(result.violations, scoresRoundLabel, result.seasonId, COMMISSIONER_CHANNEL_ID).catch(() => {});
    }
  }

  if (GENERAL_CHANNEL_ID && result.payoutLines.length > 0 && !result.catchupMode) {
    const lines = result.payoutLines
      .filter(l => l.startsWith("🏆") || l.startsWith("🤝"))
      .map(l => {
        const m = l.match(/\*\*(.+?)\*\* \+\d+ \| 🎮 \*\*(.+?)\*\* \+\d+ \*\((\d+)–(\d+)\)\*/);
        if (m) return `🏆 **${m[1]}** ${m[3]} — ${m[4]} **${m[2]}**`;
        return l;
      });

    if (lines.length > 0) {
      await sendDiscordEmbed(GENERAL_CHANNEL_ID, {
        title: `🏈 ${scoresRoundLabel} Results`,
        description: lines.join("\n"),
        color: 0xf0b132,
      }).catch(() => {});
    }
  }
});

// ── /awards — season award winners (sent by MCA at end of regular season) ─────
router.post("/madden/:leagueKey/:platform/:leagueId/awards", validateKey, (req, res) => {
  saveMcaPayload("mca/awards.json", req.body);
  res.status(200).json({ status: "received" });
  const body = req.body as Record<string, unknown>;
  const keys = Object.keys(body ?? {});
  const firstKey = keys[0];
  const sample = firstKey && Array.isArray(body[firstKey]) ? (body[firstKey] as any[])[0] : body;
  console.log("[mca/awards] Received. Top-level keys:", keys);
  console.log("[mca/awards] First item sample:", JSON.stringify(sample)?.slice(0, 600));
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
  // Save unknown payloads using a sanitized path as the key
  const sanitizedPath = req.path.replace(/[^a-zA-Z0-9-_/]/g, "-").replace(/\/+/g, "-").replace(/^-|-$/g, "");
  saveMcaPayload(`mca/unknown-${sanitizedPath}.json`, req.body);
  res.status(200).json({ status: "received" });
});

export default router;
