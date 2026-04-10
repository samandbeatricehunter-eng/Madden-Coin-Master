import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import {
  playerSeasonStatsTable, playerStatWeekProcessedTable,
  teamSeasonStatsTable,
} from "@workspace/db";
import { eq, count, and, lte, gte } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { getPayoutValue, setPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";
import { deleteMcaPayloads, listMcaFiles, readMcaJson } from "../lib/gcs-reader.js";

export const data = new SlashCommandBuilder()
  .setName("admin_stat_reimport")
  .setDescription("Safe-mode stat reimport — clear accumulated stats so MCA can re-import from scratch")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("enable")
    .setDescription("Enable safe mode: clears accumulated player & team stats for this season so MCA can reimport")
    .addBooleanOption(o => o
      .setName("confirm")
      .setDescription("You MUST set this to True to confirm — this deletes all accumulated stat data for the current season")
      .setRequired(true)
    )
  )
  .addSubcommand(s => s
    .setName("disable")
    .setDescription("Disable safe mode: re-allows EOS payouts after verifying stats are correct")
  )
  .addSubcommand(s => s
    .setName("status")
    .setDescription("Show safe mode state and how many weeks of stats have been imported this season")
  )
  .addSubcommand(s => s
    .setName("fix_turnover")
    .setDescription("Recalculate turnover diff for every team from stored payloads — no re-import needed")
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(true);

  if (sub === "status") {
    await handleStatus(interaction);
  } else if (sub === "enable") {
    await handleEnable(interaction);
  } else if (sub === "disable") {
    await handleDisable(interaction);
  } else if (sub === "fix_turnover") {
    await handleFixTurnover(interaction);
  }
}

// ── /admin_stat_reimport status ──────────────────────────────────────────────

// Regular season = weeks 1-18; Playoffs = weeks 19+ (Wild Card=19, Div=20, Conf=21, SB=23)
const REG_TOTAL      = 18;
const PLAYOFF_TOTAL  = 4;   // Wild Card, Divisional, Conference, Super Bowl
const SEASON_TOTAL   = REG_TOTAL + PLAYOFF_TOTAL; // 22

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason();
  const safeModeVal = await getPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE);
  const safeModeActive = safeModeVal > 0;

  // Regular season weeks (weekNum 1–18) per stat type
  const regRows = await db
    .select({
      statType:  playerStatWeekProcessedTable.statType,
      weekCount: count(playerStatWeekProcessedTable.id),
    })
    .from(playerStatWeekProcessedTable)
    .where(and(
      eq(playerStatWeekProcessedTable.seasonId, season.id),
      lte(playerStatWeekProcessedTable.weekNum, REG_TOTAL),
    ))
    .groupBy(playerStatWeekProcessedTable.statType);

  // Playoff weeks (weekNum 19+) per stat type
  const postRows = await db
    .select({
      statType:  playerStatWeekProcessedTable.statType,
      weekCount: count(playerStatWeekProcessedTable.id),
    })
    .from(playerStatWeekProcessedTable)
    .where(and(
      eq(playerStatWeekProcessedTable.seasonId, season.id),
      gte(playerStatWeekProcessedTable.weekNum, REG_TOTAL + 1),
    ))
    .groupBy(playerStatWeekProcessedTable.statType);

  const regMap:  Record<string, number> = {};
  const postMap: Record<string, number> = {};
  for (const r of regRows)  regMap[r.statType]  = Number(r.weekCount);
  for (const r of postRows) postMap[r.statType] = Number(r.weekCount);

  // Player / team row counts
  const [playerCountRow] = await db
    .select({ cnt: count(playerSeasonStatsTable.id) })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));
  const playerCount = Number(playerCountRow?.cnt ?? 0);

  const [teamCountRow] = await db
    .select({ cnt: count(teamSeasonStatsTable.id) })
    .from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, season.id));
  const teamCount = Number(teamCountRow?.cnt ?? 0);

  const statTypes = ["passing", "rushing", "receiving", "defense"];

  // Per-type summary: "🟢 Passing: 18/18 reg · 4/4 post"
  const lines = statTypes.map(type => {
    const reg  = regMap[type]  ?? 0;
    const post = postMap[type] ?? 0;
    const total = reg + post;
    const bar = total >= SEASON_TOTAL ? "🟢"
              : total >= REG_TOTAL    ? "🟡"
              : total >= 10           ? "🟠"
              : total >= 1            ? "🟠"
              : "🔴";
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    return `${bar} **${label}**: ${reg}/${REG_TOTAL} reg · ${post}/${PLAYOFF_TOTAL} post (${total}/${SEASON_TOTAL} total)`;
  });

  const defenseTotal = (regMap["defense"] ?? 0) + (postMap["defense"] ?? 0);
  const defenseTip = defenseTotal === 0
    ? "\n\n⚠️ **Defense is 0/22** — the defense endpoint was never hit or used an unrecognized JSON key. Check API server logs for `[mca/week#/defense]` after your next import."
    : "";

  const embed = new EmbedBuilder()
    .setTitle("📊 Stat Reimport Status")
    .setColor(safeModeActive ? Colors.Orange : Colors.Green)
    .addFields(
      {
        name: `Safe Mode — ${safeModeActive ? "🔴 ACTIVE (EOS payouts blocked)" : "🟢 Disabled"}`,
        value: safeModeActive
          ? "Use `/admin_stat_reimport disable` after reimport is complete and stats look correct."
          : "Use `/admin_stat_reimport enable` before reimporting if you need to start from scratch.",
      },
      {
        name: `Season ${season.seasonNumber} — Weeks Imported (18 reg + 4 playoff = 22 total)`,
        value: lines.join("\n") + defenseTip,
      },
      {
        name: "DB Counts",
        value: `• **${playerCount}** player stat rows\n• **${teamCount}** team stat rows`,
      }
    )
    .setFooter({ text: `Season ${season.seasonNumber} (id: ${season.id})` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── /admin_stat_reimport enable ──────────────────────────────────────────────

async function handleEnable(interaction: ChatInputCommandInteraction): Promise<void> {
  const confirmed = interaction.options.getBoolean("confirm", true);
  if (!confirmed) {
    await interaction.reply({
      content: "❌ You must set **confirm: True** to proceed. No data was changed.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const season = await getOrCreateActiveSeason();

  // Count what will be deleted
  const [{ playerRows }] = await db
    .select({ playerRows: count(playerSeasonStatsTable.id) })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));

  const [{ weekRows }] = await db
    .select({ weekRows: count(playerStatWeekProcessedTable.id) })
    .from(playerStatWeekProcessedTable)
    .where(eq(playerStatWeekProcessedTable.seasonId, season.id));

  // Delete accumulated player stats for this season
  await db
    .delete(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));

  // Clear all week-processed markers so MCA will re-import every week
  await db
    .delete(playerStatWeekProcessedTable)
    .where(eq(playerStatWeekProcessedTable.seasonId, season.id));

  // Reset team stat accumulators to 0 (keep rows, clear counts — MCA will overwrite)
  await db
    .update(teamSeasonStatsTable)
    .set({
      offYds: 0, offPassYds: 0, offRushYds: 0, offTDs: 0,
      defPassYds: 0, defRushYds: 0, defTDs: 0,
      teamSacks: 0, teamInts: 0,
      offRedZonePct: 0, defRedZonePct: 0,
      defFumblesRec: 0, turnoverDiff: 0,
      offPtsPerGame: 0,
      wins: 0, losses: 0,
      updatedAt: new Date(),
    })
    .where(eq(teamSeasonStatsTable.seasonId, season.id));

  // Delete all stored MCA week-stat payloads from object storage so MCA re-imports write fresh files
  const gcsResult = await deleteMcaPayloads("mca/week-");

  // Activate safe mode
  await setPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE, 1, interaction.user.id);

  const gcsLine = gcsResult.error
    ? `⚠️ GCS wipe failed: ${gcsResult.error}`
    : `• **${gcsResult.deleted}** stored payload files deleted${gcsResult.errors > 0 ? ` (${gcsResult.errors} errors)` : ""}`;

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Safe Mode Enabled — Stat Data Cleared")
    .setColor(Colors.Orange)
    .setDescription(
      `All accumulated stat data for **Season ${season.seasonNumber}** has been wiped. ` +
      `MCA can now re-import from week 1 without double-counting.\n\n` +
      `**EOS payouts are now blocked** until you run \`/admin_stat_reimport disable\`.`
    )
    .addFields(
      {
        name: "Deleted from DB",
        value: `• **${playerRows}** player stat rows\n• **${weekRows}** week-processed markers`,
        inline: true,
      },
      { name: "Reset", value: "• Team stat accumulators → 0", inline: true },
      { name: "Object Storage", value: gcsLine },
    )
    .addFields({
      name: "Next Steps",
      value:
        "1. Re-upload all MCA JSON files (passing, rushing, receiving **and defense**)\n" +
        "2. Run `/admin_eos_testrun` to verify stat totals look correct\n" +
        "3. Run `/admin_stat_reimport disable` to re-enable EOS payouts\n" +
        "4. Advance to Wildcard week to trigger EOS payouts",
    })
    .setFooter({ text: `Season ${season.seasonNumber} (id: ${season.id})` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── /admin_stat_reimport fix_turnover ────────────────────────────────────────

function extractTeamList(body: unknown): any[] {
  if (!body || typeof body !== "object") return [];
  for (const key of ["teamStatInfoList", "teamStatsInfoList", "teamStats"]) {
    const val = (body as any)[key];
    if (Array.isArray(val)) return val;
  }
  if (Array.isArray(body)) return body;
  return [];
}

function getNum(obj: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

function parseTODiff(t: any): number {
  const direct = getNum(t, "tODiff","turnOverDiff","turnoverDiff","turnoverDifferential","toMargin","toDiff","tOMargin");
  if (direct !== 0) return direct;
  const takeaways  = getNum(t, "tOTakeaways","defTurnovers","defensiveTurnovers","defTO","takeaways");
  const giveaways  = getNum(t, "tOGiveaways","offTurnovers","offensiveTurnovers","offTO","giveaways");
  if (takeaways !== 0 || giveaways !== 0) return takeaways - giveaways;
  return 0;
}

async function handleFixTurnover(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  // 1. List every saved team-stat payload in GCS
  let files: string[];
  try {
    files = await listMcaFiles("mca/week-");
  } catch (err) {
    await interaction.editReply({ content: `❌ Could not list GCS files: ${err}` });
    return;
  }

  const teamFiles = files.filter(f => f.endsWith("-team.json"));
  if (teamFiles.length === 0) {
    await interaction.editReply({
      content: "❌ No stored team-stat payloads found in object storage. You'll need to re-import from MCA.",
    });
    return;
  }

  // 2. Sum tODiff per EA teamId across every week
  const toDiffByTeam = new Map<number, number>(); // teamId → season total
  let weeksParsed = 0;

  for (const key of teamFiles) {
    let body: unknown;
    try {
      body = await readMcaJson(key);
    } catch {
      continue; // skip unreadable files
    }

    const teams = extractTeamList(body);
    for (const t of teams) {
      const teamId = Number(t?.teamId ?? -1);
      if (isNaN(teamId) || teamId < 0) continue;
      const diff = parseTODiff(t);
      toDiffByTeam.set(teamId, (toDiffByTeam.get(teamId) ?? 0) + diff);
    }
    weeksParsed++;
  }

  if (toDiffByTeam.size === 0) {
    await interaction.editReply({
      content: `⚠️ Parsed ${weeksParsed} payload file(s) but found no team IDs with turnover data. ` +
               `Check that the files are valid team-stat payloads.`,
    });
    return;
  }

  // 3. Patch ONLY turnoverDiff in team_season_stats for the active season
  const season = await getOrCreateActiveSeason();
  let updated = 0;

  for (const [teamId, diff] of toDiffByTeam) {
    const result = await db
      .update(teamSeasonStatsTable)
      .set({ turnoverDiff: diff, updatedAt: new Date() })
      .where(
        and(
          eq(teamSeasonStatsTable.seasonId, season.id),
          eq(teamSeasonStatsTable.teamId,   teamId),
        ),
      );
    if (result.rowCount && result.rowCount > 0) updated++;
  }

  // 4. Show results with a sample
  const topTeams = [...toDiffByTeam.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const sampleLines = topTeams.map(([id, diff]) => {
    const sign = diff > 0 ? "+" : "";
    return `Team ${id}: **${sign}${diff}**`;
  });

  const embed = new EmbedBuilder()
    .setTitle("✅ Turnover Differential Fixed")
    .setColor(Colors.Green)
    .setDescription(
      `Read **${weeksParsed}** stored payload file(s) and recalculated turnover diff from scratch.\n` +
      `Updated **${updated}** team row(s) in the database — all other stats were left untouched.`,
    )
    .addFields(
      {
        name: `Top ${sampleLines.length} Teams by Turnover Diff`,
        value: sampleLines.join("\n") || "No data",
      },
      {
        name: "Next Step",
        value: "Run `/admin_eos_testrun` to verify payout totals now include correct turnover differential.",
      },
    )
    .setFooter({ text: `Season ${season.seasonNumber} — ${toDiffByTeam.size} teams patched` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── /admin_stat_reimport disable ─────────────────────────────────────────────

async function handleDisable(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const wasActive = (await getPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE)) > 0;
  await setPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE, 0, interaction.user.id);

  const season = await getOrCreateActiveSeason();

  // Quick stat summary so commissioner can confirm data looks right
  const [regWeekRows, postWeekRows] = await Promise.all([
    db.select({ statType: playerStatWeekProcessedTable.statType, weekCount: count(playerStatWeekProcessedTable.id) })
      .from(playerStatWeekProcessedTable)
      .where(and(eq(playerStatWeekProcessedTable.seasonId, season.id), lte(playerStatWeekProcessedTable.weekNum, REG_TOTAL)))
      .groupBy(playerStatWeekProcessedTable.statType),
    db.select({ statType: playerStatWeekProcessedTable.statType, weekCount: count(playerStatWeekProcessedTable.id) })
      .from(playerStatWeekProcessedTable)
      .where(and(eq(playerStatWeekProcessedTable.seasonId, season.id), gte(playerStatWeekProcessedTable.weekNum, REG_TOTAL + 1)))
      .groupBy(playerStatWeekProcessedTable.statType),
  ]);

  const regMap:  Record<string, number> = {};
  const postMap: Record<string, number> = {};
  for (const r of regWeekRows)  regMap[r.statType]  = Number(r.weekCount);
  for (const r of postWeekRows) postMap[r.statType] = Number(r.weekCount);

  const [{ playerCount }] = await db
    .select({ playerCount: count(playerSeasonStatsTable.id) })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));

  const statTypes = ["passing", "rushing", "receiving", "defense"];
  const weekLines = statTypes.map(t => {
    const reg  = regMap[t]  ?? 0;
    const post = postMap[t] ?? 0;
    return `• **${t}**: ${reg}/${REG_TOTAL} reg · ${post}/${PLAYOFF_TOTAL} post`;
  }).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🟢 Safe Mode Disabled — EOS Payouts Re-enabled")
    .setColor(Colors.Green)
    .setDescription(
      wasActive
        ? `Safe mode has been disabled. EOS payouts will fire normally when you advance to Wildcard week.`
        : `Safe mode was already disabled — no change made.`
    )
    .addFields(
      { name: "Current Stat Import Progress", value: weekLines },
      { name: "Players in DB", value: `${playerCount} player rows for Season ${season.seasonNumber}` },
      { name: "Recommended", value: "Run `/admin_eos_testrun` to verify payout totals before advancing week." },
    )
    .setFooter({ text: `Season ${season.seasonNumber} (id: ${season.id})` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
