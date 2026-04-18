import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
  Guild,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  loadEAConnection,
  fetchWeeklyStats,
  fetchAwardsData,
  fetchNewsData,
  fetchAllWeekSchedules,
  fetchLeagueTeamsAndRosters,
  updateStoredToken,
  refreshTokenIfNeeded,
  type WeeklyExportData,
  type RostersExportData,
} from "../lib/ea-client.js";
import { postFullSeasonScheduleToChannel } from "../lib/season-schedule-post.js";
import { getOrCreateActiveSeason, getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";
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
      )
      .addBooleanOption((o) =>
        o
          .setName("reset")
          .setDescription("Clear wrong/simulated scores first — use when games show as played incorrectly (default: false)")
          .setRequired(false),
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
  )
  .addSubcommand((s) =>
    s
      .setName("purge-preseason")
      .setDescription("⚠️ Delete preseason-tainted stats for a season so it can be cleanly re-imported")
      .addIntegerOption((o) =>
        o
          .setName("season_id")
          .setDescription("The numeric season ID to purge (check /viewstandings or ask dev for the number)")
          .setRequired(true)
          .setMinValue(1),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(true);
  if (sub === "week")             return handleWeek(interaction);
  if (sub === "playoffs")         return handlePlayoffs(interaction);
  if (sub === "awards")           return handleAwards(interaction);
  if (sub === "standings")        return handleStandings(interaction);
  if (sub === "full-schedule")    return handleFullSchedule(interaction);
  if (sub === "rosters")          return handleRosters(interaction);
  if (sub === "check-api")        return handleCheckApi(interaction);
  if (sub === "purge-preseason")  return handlePurgePreseason(interaction);
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
  guild?:     Guild | null,
): Promise<{ summaryLine: string; allOk: boolean }> {
  const apiBase    = getApiBase();
  const key        = getWebhookKey();
  const platform   = token.platform;
  const leagueBase = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}`;

  // ── Sync Discord server nicknames before leagueteams so the processor has
  // fresh display names to match EA teams against.
  if (guild) {
    try {
      const members = await guild.members.fetch();
      const guildId = guild.id;
      const ops: Promise<any>[] = [];
      for (const [memberId, member] of members) {
        const nick = member.displayName; // server nickname ?? global username
        ops.push(
          db.update(usersTable)
            .set({ serverNickname: nick, updatedAt: new Date() })
            .where(and(eq(usersTable.discordId, memberId), eq(usersTable.guildId, guildId))),
        );
      }
      await Promise.all(ops);
      console.log(`[ea-export/nicknames] Synced ${members.size} server nicknames for guild ${guildId}`);
    } catch (err) {
      console.error("[ea-export/nicknames] Failed to sync nicknames (non-fatal):", err);
    }
  }

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
  const conn = await loadEAConnection(interaction.guildId!);
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

  // ── PHASE 1: Fetch stats from EA (Blaze session 1) ───────────────────────────
  await interaction.editReply({ content: `⏳ Fetching **${weekLabel}** stats from EA...` });

  let stats: WeeklyExportData;
  try {
    stats = await fetchWeeklyStats(token, eaLeagueId, weekIndex, stageIndex);
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

  // ── PHASE 2: Fetch rosters from EA (Blaze session 2 — sequential, after session 1 closes)
  // Rosters are fetched BEFORE stats are posted so that when the processor handles
  // the stat payloads, franchise_mca_teams already has all 32 teams and their names.
  await interaction.editReply({ content: `⏳ Fetching rosters from EA (~60s)...` });

  const { summaryLine: rosterSummary, allOk: rostersAllOk } = await runRosterSync(token, eaLeagueId, interaction.guild);

  // ── PHASE 3: Post to API (rosters already posted inside runRosterSync, now post stats)
  const apiBase  = getApiBase();
  const key      = getWebhookKey();
  const platform = token.platform;
  const weekBase = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}/week/${weekType}/${weekNum}`;

  await interaction.editReply({ content: `⏳ Sending **${weekLabel}** stats to processor...` });

  const results: Array<{ name: string; ok: boolean; status: number; skipped?: boolean }> = [];

  if (!schedulesOnly) {
    // Player stats
    for (const [statType, urlSuffix] of [
      ["passing",    "passing"],
      ["rushing",    "rushing"],
      ["receiving",  "receiving"],
      ["defense",    "defense"],
      ["kicking",    "kicking"],
      ["punting",    "punting"],
      ["kickReturn", "kickreturn"],
      ["puntReturn", "puntreturn"],
    ] as const) {
      const payload = stats[statType as keyof WeeklyExportData];
      // null means EA didn't expose this endpoint (special teams on some versions)
      if (payload == null) {
        results.push({ name: statType, ok: true, status: 0, skipped: true });
        continue;
      }
      const res = await postToApiServer(`${weekBase}/${urlSuffix}`, payload);
      results.push({ name: statType, ...res });
    }

    // Team stats (note: URL suffix is "team" not "teamStats")
    const teamRes = await postToApiServer(`${weekBase}/team`, stats.teamStats);
    results.push({ name: "teamStats", ...teamRes });
  }

  // Schedules / scores (always included)
  const schedRes = await postToApiServer(`${weekBase}/schedules`, stats.schedules);
  results.push({ name: "schedules", ...schedRes });

  // ── In-game news feed (league-level — fetch once per week export) ─────────────
  // This populates the news context the League Twitter bot uses for tweet topics.
  // Runs silently — a 404 or unavailable endpoint is logged but not shown as an error.
  try {
    const newsData = await fetchNewsData(token, eaLeagueId);
    if (newsData != null) {
      const newsUrl = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}/news`;
      const newsRes = await postToApiServer(newsUrl, newsData);
      results.push({ name: "in-game news", ...newsRes });
      console.log(`[ea-export] News fetch: HTTP ${newsRes.status}`);
    } else {
      console.log("[ea-export] News endpoint unavailable for this EA version — skipped");
    }
  } catch (newsErr: any) {
    console.warn("[ea-export] News fetch failed (non-fatal):", newsErr?.message ?? newsErr);
  }

  // Build combined result embed
  const statsSuccessCount = results.filter((r) => r.ok).length;
  const statsFailCount    = results.filter((r) => !r.ok).length;

  const statsLines = results.map((r) =>
    r.skipped      ? `⏭ ${r.name} (not available)` :
    r.ok           ? `✅ ${r.name}` :
                     `❌ ${r.name} (HTTP ${r.status})`,
  );

  const overallOk  = statsFailCount === 0 && rostersAllOk;
  const hasWarning = (statsFailCount > 0 || !rostersAllOk);

  const fields: { name: string; value: string }[] = [
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
  ];

  const embed = new EmbedBuilder()
    .setColor(overallOk ? Colors.Green : hasWarning ? Colors.Yellow : Colors.Red)
    .setTitle(`📥 EA Export — ${weekLabel}`)
    .addFields(...fields)
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

  const conn = await loadEAConnection(interaction.guildId!);
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

  const conn = await loadEAConnection(interaction.guildId!);
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
// Opens ONE Blaze session and pulls all 18 weeks' schedules from EA in sequence,
// then posts each to the API server and (on full success) posts to the schedule
// channel. This is the snallabot-style "export allweeks" equivalent.
async function handleFullSchedule(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const conn = await loadEAConnection(interaction.guildId!);
  if (!conn) {
    await interaction.editReply({ content: "❌ **No EA connection.** Run `/admin_ea_connect start` first." });
    return;
  }

  const { token, eaLeagueId } = conn;
  const totalWeeks = interaction.options.getInteger("weeks") ?? 18;
  const doReset    = interaction.options.getBoolean("reset") ?? false;
  const apiBase    = getApiBase();
  const key        = getWebhookKey();

  await interaction.editReply({ content: `⏳ Opening EA session and pulling all ${totalWeeks} weeks…` });

  // ── Single session fetch ──────────────────────────────────────────────────
  let weekResults: Array<{ weekNum: number; data: unknown }>;
  let freshToken:  typeof token;
  try {
    const out = await fetchAllWeekSchedules(token, eaLeagueId, totalWeeks);
    weekResults = out.weekResults;
    freshToken  = out.token;
  } catch (err: any) {
    console.error("[ea-export/full-schedule] EA fetch error:", err);
    await interaction.editReply({
      content:
        `❌ Failed to fetch schedules from EA: ${err?.message ?? String(err)}\n\n` +
        "If you see an auth error, run `/admin_ea_connect code` to refresh the connection.",
    });
    return;
  }

  if (freshToken.accessToken !== token.accessToken) {
    await updateStoredToken(eaLeagueId, freshToken).catch(() => {});
  }

  const platform = freshToken.platform;

  // ── Post each week to the schedule-import endpoint ────────────────────────
  // Uses /schedule-import (not /schedules) so:
  //  · All games are stored as upcoming (status=0, no scores)
  //  · Simulated/CPU game results from EA are ignored
  //  · processWeekScores (payouts) is NOT triggered
  //  · Response is synchronous and includes game count per week
  await interaction.editReply({ content: `⏳ Sending ${totalWeeks} weeks to schedule processor…` });

  const apiResults: Array<{ week: number; ok: boolean; count: number; status: number }> = [];
  for (const { weekNum, data } of weekResults) {
    const weekUrl = `${apiBase}/madden/${key}/${platform}/${eaLeagueId}/week/reg/${weekNum}/schedule-import${doReset ? "?reset=true" : ""}`;
    const res     = await fetch(weekUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(data),
    }).catch(() => null);

    if (!res) {
      apiResults.push({ week: weekNum, ok: false, count: 0, status: 0 });
    } else {
      const json = await res.json().catch(() => ({})) as any;
      apiResults.push({ week: weekNum, ok: res.ok, count: Number(json?.count ?? 0), status: res.status });
    }

    if (weekNum % 6 === 0 || weekNum === totalWeeks) {
      await interaction.editReply({ content: `⏳ Sent ${weekNum}/${totalWeeks} weeks to processor…` });
    }
  }

  const succeeded  = apiResults.filter(r => r.ok).length;
  const failed     = apiResults.filter(r => !r.ok);
  const totalGames = apiResults.reduce((s, r) => s + r.count, 0);
  const lines      = apiResults.map(r =>
    r.ok
      ? r.count > 0 ? `✅ Week ${r.week} — ${r.count} games` : `⚪ Week ${r.week} — no games from EA`
      : `❌ Week ${r.week} (HTTP ${r.status})`,
  );

  // ── Post to schedule channel if all weeks succeeded ───────────────────────
  let channelNote = "";
  if (failed.length === 0) {
    try {
      const season      = await getOrCreateActiveSeason(interaction.guildId!);
      const postedWeeks = await postFullSeasonScheduleToChannel(
        interaction.client,
        season.id,
        season.seasonNumber ?? season.id,
        { guildId: interaction.guildId! },
      );
      channelNote = postedWeeks > 0
        ? `✅ Season schedule posted.`
        : `⚠️ All weeks saved but channel post returned 0 — run \`/postfullseasonschedule\` manually`;
    } catch (err: any) {
      console.error("[ea-export/full-schedule] Channel post error:", err);
      channelNote = `⚠️ All weeks saved but channel post failed — run \`/postfullseasonschedule\` manually`;
    }
  }

  // Chunk lines to stay within Discord's 4096-char embed limit
  const MAX = 3800;
  let description = lines.join("\n");
  if (description.length > MAX) {
    description = description.slice(0, MAX) + "\n…(truncated)";
  }

  const schedEmbed = new EmbedBuilder()
    .setColor(failed.length === 0 ? Colors.Green : succeeded > 0 ? Colors.Yellow : Colors.Red)
    .setTitle(`📅 Full Season Schedule — EA Export`)
    .setDescription(description)
    .addFields(
      {
        name:  "Result",
        value: failed.length === 0
          ? `✅ ${totalWeeks} weeks processed · **${totalGames} games** stored as upcoming`
          : `⚠️ ${succeeded}/${totalWeeks} weeks succeeded · ${totalGames} games stored`,
      },
      ...(doReset ? [{ name: "🔄 Reset Mode", value: "All existing schedule data was overwritten — games reset to upcoming" }] : []),
      { name: "ℹ️ Note", value: "⚪ weeks had no data from EA (league hasn't advanced there yet)" },
      ...(channelNote ? [{ name: "📣 Schedule Channel", value: channelNote }] : []),
    )
    .setFooter({ text: `League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()} · 1 EA session used` })
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

  const conn = await loadEAConnection(interaction.guildId!);
  if (!conn) {
    await interaction.editReply({ content: "❌ **No EA connection.** Run `/admin_ea_connect start` first." });
    return;
  }

  const { token, eaLeagueId } = conn;
  const platform = token.platform;

  await interaction.editReply({ content: "⏳ Fetching league teams + all rosters from EA (this takes ~60s)..." });

  const { summaryLine, allOk } = await runRosterSync(token, eaLeagueId, interaction.guild);

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

  const conn     = await loadEAConnection(interaction.guildId!);
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

// ── Purge preseason-tainted stats for a season ────────────────────────────────
async function handlePurgePreseason(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const seasonId = interaction.options.getInteger("season_id", true);

  let apiBase: string;
  let key: string;
  try {
    apiBase = getApiBase();
    key     = getWebhookKey();
  } catch (err: any) {
    await interaction.editReply({ content: `❌ Config error: ${err.message}` });
    return;
  }

  const url = `${apiBase}/madden/${key}/admin/purge-preseason-stats`;
  let responseMsg = "";
  let success = false;
  try {
    const res = await axios.post(url, { seasonId }, { timeout: 30_000, validateStatus: () => true });
    success = res.status >= 200 && res.status < 300;
    responseMsg = (res.data as any)?.message ?? (res.data as any)?.error ?? JSON.stringify(res.data);
  } catch (err: any) {
    responseMsg = err?.message ?? String(err);
  }

  const embed = new EmbedBuilder()
    .setColor(success ? Colors.Orange : Colors.Red)
    .setTitle(success ? "🗑️ Preseason Stats Purged" : "❌ Purge Failed")
    .setDescription(
      success
        ? `Season **${seasonId}** player stats and weekly processed records have been deleted.\n\n` +
          `**Next step:** Run \`/admin_ea_export week number:1\` (and any other completed reg-season weeks) to re-import clean data.`
        : `Error: ${responseMsg}`,
    )
    .setTimestamp();

  if (success) {
    console.log(`[ea-export/purge-preseason] Season ${seasonId} purged by ${interaction.user.tag}`);
  }

  await interaction.editReply({ embeds: [embed] });
}
