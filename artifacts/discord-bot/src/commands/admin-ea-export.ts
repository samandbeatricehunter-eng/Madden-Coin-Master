import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
} from "discord.js";
import {
  loadEAConnection,
  fetchWeeklyStats,
  fetchAwardsData,
  fetchScheduleForWeek,
  fetchLeagueTeamsAndRosters,
  updateStoredToken,
  refreshTokenIfNeeded,
  type WeeklyExportData,
  type RostersExportData,
} from "../lib/ea-client.js";
import axios from "axios";

export const data = new SlashCommandBuilder()
  .setName("admin_ea_export")
  .setDescription("Pull franchise data directly from EA and process it (replaces MCA import)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand((s) =>
    s
      .setName("week")
      .setDescription("Export stats for a specific regular season or preseason week")
      .addIntegerOption((o) =>
        o
          .setName("number")
          .setDescription("Week number (1–18 for regular season, 1–4 for preseason)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(23),
      )
      .addStringOption((o) =>
        o
          .setName("stage")
          .setDescription("Season stage (default: reg)")
          .setRequired(false)
          .addChoices(
            { name: "Regular Season", value: "reg" },
            { name: "Preseason",      value: "pre" },
          ),
      )
      .addBooleanOption((o) =>
        o
          .setName("schedules_only")
          .setDescription("Only import schedule/scores (skip player stats) — useful for score corrections")
          .setRequired(false),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("playoffs")
      .setDescription("Export stats for a playoff round")
      .addStringOption((o) =>
        o
          .setName("round")
          .setDescription("Which playoff round to export")
          .setRequired(true)
          .addChoices(
            { name: "Wild Card (Week 19)",              value: "19" },
            { name: "Divisional Round (Week 20)",       value: "20" },
            { name: "Conference Championship (Week 21)", value: "21" },
            { name: "Super Bowl (Week 23)",              value: "23" },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("awards")
      .setDescription("Pull end-of-season award winners directly from EA (replaces MCA awards push)"),
  )
  .addSubcommand((s) =>
    s
      .setName("standings")
      .setDescription("Auto-set playoff seeds from EA conference rank data (run after Week 18 export)")
      .addIntegerOption((o) =>
        o
          .setName("week")
          .setDescription("Regular season week to pull standings from (default: 18)")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(18),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("full-schedule")
      .setDescription("Fetch all 18 weeks of matchups from EA and populate the full season schedule table")
      .addIntegerOption((o) =>
        o
          .setName("weeks")
          .setDescription("How many weeks to fetch (default: 18)")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(18),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("rosters")
      .setDescription(
        "Fetch league team info + all 32 team rosters + free agents from EA and sync them (run weekly)",
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("check-api")
      .setDescription("Verify that the bot can reach the API server (use when MCA exports seem to fail silently)"),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(true);
  if (sub === "week")          return handleWeek(interaction);
  if (sub === "playoffs")      return handlePlayoffs(interaction);
  if (sub === "awards")        return handleAwards(interaction);
  if (sub === "standings")     return handleStandings(interaction);
  if (sub === "full-schedule") return handleFullSchedule(interaction);
  if (sub === "rosters")       return handleRosters(interaction);
  if (sub === "check-api")     return handleCheckApi(interaction);
}

// ── Build API base URL ────────────────────────────────────────────────────────
function getApiBase(): string {
  const domain = (process.env["REPLIT_DOMAINS"] ?? "").split(",")[0]?.trim() ?? "";
  if (!domain) throw new Error("REPLIT_DOMAINS is not set — cannot reach API server");
  return `https://${domain}/api`;
}

function getWebhookKey(): string {
  const key = process.env["MADDEN_WEBHOOK_KEY"];
  if (!key) throw new Error("MADDEN_WEBHOOK_KEY is not set");
  return key;
}

// ── POST a stat payload to the API server ─────────────────────────────────────
async function postToApiServer(
  url:     string,
  payload: unknown,
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30_000,
      validateStatus: () => true,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err: any) {
    console.error("[ea-export] POST error:", err?.message);
    return { ok: false, status: 0 };
  }
}

// ── Shared roster fetch + POST helper (no interaction needed) ─────────────────
// Returns a condensed summary line and a flag indicating full success.
async function runRosterSync(
  token:      Parameters<typeof fetchLeagueTeamsAndRosters>[0],
  eaLeagueId: number,
): Promise<{ summaryLine: string; allOk: boolean }> {
  const apiBase    = getApiBase();
  const key        = getWebhookKey();
  const platform   = token.platform;
  const leagueBase = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}`;

  let rosterData: RostersExportData;
  try {
    rosterData = await fetchLeagueTeamsAndRosters(token, eaLeagueId);
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) await updateStoredToken(eaLeagueId, refreshed);
  } catch (err: any) {
    console.error("[ea-export/rosters] Fetch error:", err);
    return {
      summaryLine: `❌ Roster sync failed — ${err?.message ?? String(err)}`,
      allOk:       false,
    };
  }

  const results: Array<{ name: string; ok: boolean; status: number }> = [];

  // 1 — leagueTeams
  const teamsRes = await postToApiServer(`${leagueBase}/leagueteams`, rosterData.leagueTeams);
  results.push({ name: "leagueTeams", ...teamsRes });

  // 2 — per-team rosters
  for (const { teamId, data } of rosterData.teamRosters) {
    const res = await postToApiServer(`${leagueBase}/team/${teamId}/roster`, data);
    results.push({ name: `roster:${teamId}`, ...res });
  }

  // 3 — free agents
  const faRes = await postToApiServer(`${leagueBase}/freeagents/roster`, rosterData.freeAgents);
  results.push({ name: "freeAgents", ...faRes });

  const failed       = results.filter(r => !r.ok);
  const rosterSynced = results.filter(r => r.ok && (r.name.startsWith("roster:") || r.name === "freeAgents")).length;
  const teamsOk      = !failed.find(r => r.name === "leagueTeams");

  let summaryLine: string;
  if (failed.length === 0) {
    summaryLine = `✅ leagueTeams + ${rosterSynced} rosters + free agents synced`;
  } else {
    const rosterFails = failed.filter(r => r.name.startsWith("roster:") || r.name === "freeAgents").length;
    summaryLine = `⚠️ Roster sync partial — ${failed.length} failed (leagueTeams:${teamsOk ? "ok" : "fail"}, rosters:${rosterFails} failed)`;
  }

  return { summaryLine, allOk: failed.length === 0 };
}

// ── Export a single week's worth of data ─────────────────────────────────────
async function exportWeek(
  interaction:    ChatInputCommandInteraction,
  weekNum:        number,
  weekType:       string,   // "reg" | "pre" | "post"
  schedulesOnly:  boolean = false,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  // Load stored EA connection
  const conn = await loadEAConnection();
  if (!conn) {
    await interaction.editReply({
      content:
        "❌ **No EA connection.** Run `/admin_ea_connect start` first to link your franchise.",
    });
    return;
  }

  const { token, eaLeagueId } = conn;

  // Convert our weekType/weekNum to EA's stageIndex/weekIndex
  // stageIndex: 0=preseason, 1=regular season (also used for playoffs)
  // weekIndex:  0-based (EA week 1 = index 0)
  const stageIndex = weekType === "pre" ? 0 : 1;
  const weekIndex  = weekNum - 1; // EA is 0-indexed

  const stageLabel = weekType === "pre" ? "Preseason" : weekType === "post" ? "Playoff" : "Reg Season";
  const weekLabel  = `${stageLabel} Week ${weekNum}`;

  await interaction.editReply({ content: `⏳ Fetching **${weekLabel}** data from EA...` });

  let stats: WeeklyExportData;
  try {
    stats = await fetchWeeklyStats(token, eaLeagueId, weekIndex, stageIndex);
    // Persist refreshed token if it was updated
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) {
      await updateStoredToken(eaLeagueId, refreshed);
    }
  } catch (err: any) {
    console.error("[ea-export] Fetch error:", err);
    await interaction.editReply({
      content:
        `❌ Failed to fetch data from EA: ${err?.message ?? String(err)}\n\n` +
        "If you see an auth error, run `/admin_ea_connect code` to refresh the connection.",
    });
    return;
  }

  // POST each stat type to the API server
  const apiBase  = getApiBase();
  const key      = getWebhookKey();
  const platform = token.platform;
  const weekBase = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}/week/${weekType}/${weekNum}`;

  await interaction.editReply({ content: `⏳ Sending **${weekLabel}** stats to processor...` });

  const results: Array<{ name: string; ok: boolean; status: number }> = [];

  if (!schedulesOnly) {
    // Player stats
    for (const [statType, urlSuffix] of [
      ["passing",   "passing"],
      ["rushing",   "rushing"],
      ["receiving", "receiving"],
      ["defense",   "defense"],
    ] as const) {
      const payload = stats[statType as keyof WeeklyExportData];
      const res     = await postToApiServer(`${weekBase}/${urlSuffix}`, payload);
      results.push({ name: statType, ...res });
    }

    // Team stats (note: URL suffix is "team" not "teamStats")
    const teamRes = await postToApiServer(`${weekBase}/team`, stats.teamStats);
    results.push({ name: "teamStats", ...teamRes });
  }

  // Schedules / scores (always included)
  const schedRes = await postToApiServer(`${weekBase}/schedules`, stats.schedules);
  results.push({ name: "schedules", ...schedRes });

  // ── Now automatically sync rosters (league teams + all 32 rosters + free agents)
  await interaction.editReply({ content: `⏳ **${weekLabel}** stats done — now syncing rosters (~60s)...` });

  const { summaryLine: rosterSummary, allOk: rostersAllOk } = await runRosterSync(token, eaLeagueId);

  // Build combined result embed
  const statsSuccessCount = results.filter((r) => r.ok).length;
  const statsFailCount    = results.filter((r) => !r.ok).length;

  const statsLines = results.map((r) =>
    r.ok ? `✅ ${r.name}` : `❌ ${r.name} (HTTP ${r.status})`,
  );

  const overallOk = statsFailCount === 0 && rostersAllOk;
  const hasWarning = (statsFailCount > 0 || !rostersAllOk);

  const embed = new EmbedBuilder()
    .setColor(overallOk ? Colors.Green : hasWarning ? Colors.Yellow : Colors.Red)
    .setTitle(`📥 EA Export — ${weekLabel}`)
    .addFields(
      {
        name:  "📊 Weekly Stats",
        value: statsLines.join("\n") || "none",
      },
      {
        name:  "🏈 Roster Sync",
        value: rosterSummary,
      },
      {
        name:  "Result",
        value: overallOk
          ? `✅ Stats + rosters fully synced`
          : `⚠️ ${statsSuccessCount}/${results.length} stats ok · ${rostersAllOk ? "rosters ok" : "rosters had errors"}`,
      },
    )
    .setFooter({ text: `League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()} · Rosters auto-updated each week` })
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [embed] });
}

// ── /admin_ea_export week ─────────────────────────────────────────────────────
async function handleWeek(interaction: ChatInputCommandInteraction): Promise<void> {
  const weekNum      = interaction.options.getInteger("number", true);
  const stage        = interaction.options.getString("stage") ?? "reg";
  const schedOnly    = interaction.options.getBoolean("schedules_only") ?? false;
  return exportWeek(interaction, weekNum, stage, schedOnly);
}

// ── /admin_ea_export playoffs ─────────────────────────────────────────────────
async function handlePlayoffs(interaction: ChatInputCommandInteraction): Promise<void> {
  const roundStr = interaction.options.getString("round", true);
  const weekNum  = parseInt(roundStr, 10);
  // Playoffs are weeks 19–23 within the regular season stage (stageIndex=1)
  return exportWeek(interaction, weekNum, "reg", false);
}

// ── /admin_ea_export standings ────────────────────────────────────────────────
async function handleStandings(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const conn = await loadEAConnection();
  if (!conn) {
    await interaction.editReply({
      content: "❌ **No EA connection.** Run `/admin_ea_connect start` first to link your franchise.",
    });
    return;
  }

  const weekNum  = interaction.options.getInteger("week") ?? 18;
  const { token, eaLeagueId } = conn;

  await interaction.editReply({ content: `⏳ Fetching **Week ${weekNum}** team stats from EA for playoff seeding...` });

  let stats: WeeklyExportData;
  try {
    // stageIndex=1 = regular season, weekIndex is 0-based
    stats = await fetchWeeklyStats(token, eaLeagueId, weekNum - 1, 1);
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) {
      await updateStoredToken(eaLeagueId, refreshed);
    }
  } catch (err: any) {
    console.error("[ea-export/standings] Fetch error:", err);
    await interaction.editReply({
      content:
        `❌ Failed to fetch Week ${weekNum} data from EA: ${err?.message ?? String(err)}\n\n` +
        "If you see an auth error, run `/admin_ea_connect code` to refresh the connection.",
    });
    return;
  }

  await interaction.editReply({ content: "⏳ Applying playoff seeds from conference rank data..." });

  const apiBase  = getApiBase();
  const key      = getWebhookKey();
  const platform = token.platform;
  const url      = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}/seedings`;

  const res = await postToApiServer(url, stats.teamStats);

  const embed = new EmbedBuilder()
    .setColor(res.ok ? Colors.Green : Colors.Red)
    .setTitle("🏈 Playoff Seedings from EA")
    .setDescription(
      res.ok
        ? `✅ Playoff seeds auto-applied from Week ${weekNum} EA conference rank data.\n\n` +
          "Check the API server logs to see which teams were seeded. " +
          "If the seeds look wrong (wrong conference), the EA conferenceId mapping may need adjustment — let the dev know."
        : `❌ Seeds data was fetched but failed to save (HTTP ${res.status}).\n\nCheck API server logs for details.`,
    )
    .addFields({
      name: "What happens next",
      value:
        "Playoff seeds are now set in the database. Run `/admin-rebuild-historical` to refresh the historical channel with the updated playoff picture.",
    })
    .setFooter({ text: `Week ${weekNum} · League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()}` })
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [embed] });
}

// ── /admin_ea_export awards ───────────────────────────────────────────────────
async function handleAwards(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const conn = await loadEAConnection();
  if (!conn) {
    await interaction.editReply({
      content: "❌ **No EA connection.** Run `/admin_ea_connect start` first to link your franchise.",
    });
    return;
  }

  const { token, eaLeagueId } = conn;

  await interaction.editReply({ content: "⏳ Fetching **end-of-season awards** from EA..." });

  let awardsData: unknown;
  try {
    awardsData = await fetchAwardsData(token, eaLeagueId);
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) {
      await updateStoredToken(eaLeagueId, refreshed);
    }
  } catch (err: any) {
    console.error("[ea-export/awards] Fetch error:", err);
    await interaction.editReply({
      content:
        `❌ Failed to fetch awards from EA: ${err?.message ?? String(err)}\n\n` +
        "If you see an auth error, run `/admin_ea_connect code` to refresh the connection.\n" +
        "If you see a 404 or endpoint error, the awards may not yet be available in EA — try again after the regular season ends.",
    });
    return;
  }

  // POST to the API server's existing awards endpoint so it saves to mca/awards.json
  await interaction.editReply({ content: "⏳ Saving awards data..." });

  const apiBase  = getApiBase();
  const key      = getWebhookKey();
  const platform = token.platform;
  const url      = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}/awards`;

  const res = await postToApiServer(url, awardsData);

  const embed = new EmbedBuilder()
    .setColor(res.ok ? Colors.Green : Colors.Red)
    .setTitle("🏆 EA Awards Export")
    .setDescription(
      res.ok
        ? "✅ Awards data successfully pulled from EA and saved.\n\nYou can now run `/admin-rebuild-historical` to post awards to the historical channel."
        : `❌ Awards were fetched from EA but failed to save (HTTP ${res.status}).\n\nCheck API server logs for details.`,
    )
    .setFooter({ text: `League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()}` })
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [embed] });
}

// ── /admin_ea_export full-schedule ────────────────────────────────────────────
// Fetches schedule data for every regular-season week from EA and posts each one
// to /week/reg/N/schedules. This populates the franchise_schedule table for the
// whole season without needing an MCA "full export" from the companion app.
async function handleFullSchedule(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const conn = await loadEAConnection();
  if (!conn) {
    await interaction.editReply({ content: "❌ **No EA connection.** Run `/admin_ea_connect start` first." });
    return;
  }

  const { token, eaLeagueId } = conn;
  const totalWeeks = interaction.options.getInteger("weeks") ?? 18;
  const apiBase    = getApiBase();
  const key        = getWebhookKey();
  const platform   = token.platform;

  await interaction.editReply({ content: `⏳ Fetching schedule for weeks 1–${totalWeeks} from EA...` });

  const results: Array<{ week: number; ok: boolean; status: number }> = [];

  for (let weekNum = 1; weekNum <= totalWeeks; weekNum++) {
    try {
      const scheduleData = await fetchScheduleForWeek(token, eaLeagueId, weekNum - 1, 1);
      const weekUrl = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}/week/reg/${weekNum}/schedules`;
      const res     = await postToApiServer(weekUrl, scheduleData);
      results.push({ week: weekNum, ...res });
    } catch (err: any) {
      console.error(`[ea-export/full-schedule] Week ${weekNum} error:`, err);
      results.push({ week: weekNum, ok: false, status: 0 });
    }

    // Update progress every 3 weeks so the admin can see it's working
    if (weekNum % 3 === 0 || weekNum === totalWeeks) {
      await interaction.editReply({ content: `⏳ Fetched ${weekNum}/${totalWeeks} weeks...` });
    }
  }

  try {
    const refreshed = await refreshTokenIfNeeded(token);
    if (refreshed.accessToken !== token.accessToken) await updateStoredToken(eaLeagueId, refreshed);
  } catch {}

  const succeeded = results.filter(r => r.ok).length;
  const failed    = results.filter(r => !r.ok);
  const lines     = results.map(r =>
    r.ok ? `✅ Week ${r.week}` : `❌ Week ${r.week} (HTTP ${r.status})`
  );

  const schedEmbed = new EmbedBuilder()
    .setColor(failed.length === 0 ? Colors.Green : succeeded > 0 ? Colors.Yellow : Colors.Red)
    .setTitle(`📅 Full Season Schedule — EA Export`)
    .setDescription(lines.join("\n"))
    .addFields({
      name:  "Result",
      value: failed.length === 0
        ? `✅ All ${totalWeeks} weeks synced — run \`/seasonschedule\` to confirm`
        : `⚠️ ${succeeded}/${totalWeeks} weeks succeeded`,
    })
    .setFooter({ text: `League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()}` })
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [schedEmbed] });
}

// ── /admin_ea_export rosters ──────────────────────────────────────────────────
// Fetches: leagueTeams (all 32 teams' info + userName mapping) → per-team rosters
// → free agents. Uses the shared runRosterSync helper.
// Note: week exports also call runRosterSync automatically — this command is for
// on-demand syncs after trades or when you need a standalone roster update.
async function handleRosters(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const conn = await loadEAConnection();
  if (!conn) {
    await interaction.editReply({ content: "❌ **No EA connection.** Run `/admin_ea_connect start` first." });
    return;
  }

  const { token, eaLeagueId } = conn;
  const platform = token.platform;

  await interaction.editReply({ content: "⏳ Fetching league teams + all rosters from EA (this takes ~60s)..." });

  const { summaryLine, allOk } = await runRosterSync(token, eaLeagueId);

  const embed = new EmbedBuilder()
    .setColor(allOk ? Colors.Green : Colors.Yellow)
    .setTitle("🏈 EA Roster Sync")
    .setDescription(summaryLine)
    .addFields({
      name:  "Result",
      value: allOk
        ? "✅ All endpoints synced — rosters + free agents are up to date"
        : "⚠️ Some endpoints failed — check logs and retry",
    })
    .setFooter({ text: `League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()} · Runs automatically with each week export` })
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [embed] });
}

// ── /admin_ea_export check-api ────────────────────────────────────────────────
// POSTs a health check to the API server to verify the webhook key and URL are
// correct. Shows the exact webhook base URL so you can verify it matches MCA.
async function handleCheckApi(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  let apiBase: string;
  let key: string;
  try {
    apiBase = getApiBase();
    key     = getWebhookKey();
  } catch (err: any) {
    await interaction.editReply({ content: `❌ Config error: ${err.message}` });
    return;
  }

  const healthUrl = `${apiBase}/health`;
  let httpStatus  = 0;
  let ok          = false;
  try {
    const res = await axios.get(healthUrl, { timeout: 10_000, validateStatus: () => true });
    httpStatus = res.status;
    ok         = res.status >= 200 && res.status < 300;
  } catch (err: any) {
    console.error("[ea-export/check-api] Health check error:", err?.message);
  }

  const conn     = await loadEAConnection();
  const platform = conn?.token.platform ?? "<platform>";
  const leagueId = conn?.eaLeagueId     ?? "<leagueId>";
  const mcaBase  = `${apiBase}/madden/${key}/${platform}/${leagueId}`;

  const lines = [
    `**API health:** ${ok ? `✅ HTTP ${httpStatus}` : `❌ HTTP ${httpStatus || "no response"}`}`,
    "",
    "**Webhook base URL** (must match what's set in the MCA app):",
    `\`${mcaBase}\``,
    "",
    ok
      ? "The API server is reachable. If MCA exports still fail, verify the URL above matches your MCA app's webhook settings exactly."
      : "❌ API server is not responding. Make sure the API Server workflow is running.",
  ];

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(ok ? Colors.Green : Colors.Red)
      .setTitle("🔌 API Connection Check")
      .setDescription(lines.join("\n"))
      .setTimestamp()],
  });
}
