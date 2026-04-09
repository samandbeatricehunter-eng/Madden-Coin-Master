import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import {
  playerSeasonStatsTable, playerStatWeekProcessedTable,
  teamSeasonStatsTable,
} from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { getPayoutValue, setPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";
import { deleteMcaPayloads } from "../lib/gcs-reader.js";

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
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(true);

  if (sub === "status") {
    await handleStatus(interaction);
  } else if (sub === "enable") {
    await handleEnable(interaction);
  } else if (sub === "disable") {
    await handleDisable(interaction);
  }
}

// ── /admin_stat_reimport status ──────────────────────────────────────────────

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason();
  const safeModeVal = await getPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE);
  const safeModeActive = safeModeVal > 0;

  // Weeks imported per stat type
  const weekRows = await db
    .select({
      statType: playerStatWeekProcessedTable.statType,
      weekCount: count(playerStatWeekProcessedTable.id),
    })
    .from(playerStatWeekProcessedTable)
    .where(eq(playerStatWeekProcessedTable.seasonId, season.id))
    .groupBy(playerStatWeekProcessedTable.statType);

  const weekMap: Record<string, number> = {};
  for (const r of weekRows) weekMap[r.statType] = Number(r.weekCount);

  // Player rows in DB for this season
  const [playerCountRow] = await db
    .select({ cnt: count(playerSeasonStatsTable.id) })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));
  const playerCount = Number(playerCountRow?.cnt ?? 0);

  // Team stat rows
  const [teamCountRow] = await db
    .select({ cnt: count(teamSeasonStatsTable.id) })
    .from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, season.id));
  const teamCount = Number(teamCountRow?.cnt ?? 0);

  const statTypes = ["passing", "rushing", "receiving", "defense"];

  const lines = statTypes.map(type => {
    const wks = weekMap[type] ?? 0;
    const bar = wks >= 17 ? "🟢" : wks >= 10 ? "🟡" : wks >= 1 ? "🟠" : "🔴";
    return `${bar} **${type.charAt(0).toUpperCase() + type.slice(1)}**: ${wks}/17 weeks`;
  });

  const defenseCount = weekMap["defense"] ?? 0;
  const defenseTip = defenseCount === 0
    ? "\n\n⚠️ **Defense is 0/17** — this means the defense endpoint was never hit OR the payload used an unrecognized JSON key. Check the API server logs for lines starting with `[mca/week#/defense]` after your next import to see the exact key MCA is sending."
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
        name: `Season ${season.seasonNumber} — Weeks Imported`,
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

// ── /admin_stat_reimport disable ─────────────────────────────────────────────

async function handleDisable(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const wasActive = (await getPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE)) > 0;
  await setPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE, 0, interaction.user.id);

  const season = await getOrCreateActiveSeason();

  // Quick stat summary so commissioner can confirm data looks right
  const weekRows = await db
    .select({
      statType: playerStatWeekProcessedTable.statType,
      weekCount: count(playerStatWeekProcessedTable.id),
    })
    .from(playerStatWeekProcessedTable)
    .where(eq(playerStatWeekProcessedTable.seasonId, season.id))
    .groupBy(playerStatWeekProcessedTable.statType);

  const weekMap: Record<string, number> = {};
  for (const r of weekRows) weekMap[r.statType] = Number(r.weekCount);

  const [{ playerCount }] = await db
    .select({ playerCount: count(playerSeasonStatsTable.id) })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));

  const statTypes = ["passing", "rushing", "receiving", "defense"];
  const weekLines = statTypes.map(t => `• **${t}**: ${weekMap[t] ?? 0}/17 weeks`).join("\n");

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
