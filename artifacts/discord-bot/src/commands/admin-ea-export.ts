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
  updateStoredToken,
  refreshTokenIfNeeded,
  type WeeklyExportData,
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
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(true);
  if (sub === "week")     return handleWeek(interaction);
  if (sub === "playoffs") return handlePlayoffs(interaction);
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

  await interaction.editReply({ content: `⏳ Sending **${weekLabel}** data to processor...` });

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

  // Build result summary
  const successCount = results.filter((r) => r.ok).length;
  const failCount    = results.filter((r) => !r.ok).length;

  const lines = results.map((r) =>
    r.ok
      ? `✅ ${r.name}`
      : `❌ ${r.name} (HTTP ${r.status})`,
  );

  const embed = new EmbedBuilder()
    .setColor(failCount === 0 ? Colors.Green : failCount < results.length ? Colors.Yellow : Colors.Red)
    .setTitle(`📥 EA Export — ${weekLabel}`)
    .setDescription(lines.join("\n"))
    .addFields({
      name:  "Result",
      value: failCount === 0
        ? `✅ All ${successCount} stat types processed successfully`
        : `⚠️ ${successCount}/${results.length} succeeded, ${failCount} failed`,
    })
    .setFooter({ text: `League ID: ${eaLeagueId} · Platform: ${platform.toUpperCase()}` })
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
