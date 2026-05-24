/**
 * admin-troubleshoot-handlers.ts
 *
 * Button handlers for the Troubleshoot panel.
 * customId prefixes:
 *   ts_repair_records | ts_resync_data | ts_eos_testrun
 *   ts_repair_playoff | ts_playoff_proceed | ts_playoff_confirm | ts_playoff_cancel
 *   ts_eos_manual     | ts_eos_manual_confirm | ts_eos_manual_cancel
 *   ts_eos_reset      | ts_eos_reset_confirm  | ts_eos_reset_cancel
 *   ao_milestone_audit
 *   ts_repair_schedules | ts_sched_review_week | ts_sched_sel | ts_sched_delete:<id>
 *   ts_modal_sched_week (modal)
 *   ts_import_schedule
 *   ts_repost_sched_headers
 */

import {
  ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction,
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  TextChannel, ChannelType, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, seasonsTable, userRecordsTable, coinTransactionsTable,
  franchiseScheduleTable, pendingEosPayoutsTable, gameSchedulesTable,
} from "@workspace/db";
import { eq, and, sql, isNotNull, desc, asc, inArray } from "drizzle-orm";

import {
  isAdminUser, getOrCreateActiveSeason, getScheduleSeasonId,
  addBalance, logTransaction, getGuildChannel, CHANNEL_KEYS,
} from "../db/db-helpers.js";
import { repairUserRecords } from "../db/repair-records.js";
import { assignRosterLegends } from "../economy/roster-legend-assign.js";
import { runEosTestRun } from "./admin-helpers/eos-testrun.js";
import { runEosAutoPost } from "../franchise/eos-auto-post.js";
import {
  computePlayoffSeeds,
  getPlayoffSeedingRules,
  formatSeedingLines,
} from "../franchise/playoff-seeding.js";
import { getArticleStandings } from "../franchise/gcs-fallback.js";
import { runScheduleOnlyImport } from "./league-data-handlers.js";
import { ensureScheduleRow, buildHeaderEmbed, buildHeaderRow } from "./game-scheduling-handlers.js";
import { nextAdvanceDeadline } from "../discord/timezones.js";
import { getServerSettings } from "../db/server-settings.js";

// ── Win milestones (mirror of admin-milestone-audit.ts) ───────────────────────
const WIN_MILESTONES = [
  { tier: 1, wins:  5, bonus:  100, label:  "5 All-Time H2H Wins" },
  { tier: 2, wins: 12, bonus:  250, label: "12 All-Time H2H Wins" },
  { tier: 3, wins: 25, bonus:  500, label: "25 All-Time H2H Wins" },
  { tier: 4, wins: 50, bonus: 1000, label: "50 All-Time H2H Wins" },
] as const;

// ── Troubleshoot Hub Embed / Rows ──────────────────────────────────────────────

export function buildTroubleshootEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.DarkNavy)
    .setTitle("🔧 Commissioner Troubleshoot Panel")
    .setDescription(
      "Use the buttons below to run repair and maintenance operations.\n\n" +
      "**🔩 Repair User Records**\n" +
      "Recalculates all W/L records and point differential for the active season " +
      "from the raw franchise schedule data. Counts CPU wins and H2H wins equally. " +
      "Also rebuilds the global all-time record.\n\n" +
      "**🔄 Resync Rosters & Data**\n" +
      "Re-stamps team ownership on all inventory and custom player rows, " +
      "force-syncs permanent vault items, and scans every league member's active " +
      "roster to assign matching permanent vault legends.\n\n" +
      "**🏈 Repair Playoff Seeding & Data**\n" +
      "Reviews the current playoff seeding for both conferences. Lets you confirm " +
      "it is incorrect and reseed all 7 AFC and 7 NFC slots from live season records " +
      "using NFL seeding rules. Requires confirmation before any changes are saved.\n\n" +
      "**📊 EOS Test Run**\n" +
      "Read-only dry run of the full end-of-season payout calculation. " +
      "No coins are awarded — shows exactly what each user would receive.\n\n" +
      "**🗓️ Repair Schedules**\n" +
      "Auto-scans the active season for weeks where a team appears in more than one " +
      "game (duplicate entries from EA import). Shows suspect games in a select menu " +
      "and lets you delete the invalid one. You can also manually browse any specific " +
      "week to remove incorrect games.\n\n" +
      "**⚡ EOS Manual Run**\n" +
      "Triggers the actual end-of-season payout process for the active season. " +
      "Posts commissioner approval embeds to the commish channel for every user. " +
      "⚠️ Only run this once — duplicate runs will create duplicate payout requests.\n\n" +
      "**🗑️ Clear & Rerun EOS**\n" +
      "Deletes all **pending** (not yet approved) EOS payout records for the active season, " +
      "then immediately reruns the full EOS calculation with only this server's members. " +
      "Use this to fix payouts that were posted to wrong users. Already-approved payouts are not affected.\n\n" +
      "**🎯 Milestone Audit**\n" +
      "Retroactively checks and pays any owed win-milestone bonuses for every registered " +
      "user on this server. Safe to run multiple times — duplicate detection is built in.\n\n" +
      "**📅 Import Schedule Only**\n" +
      "Connects to EA and fetches the schedule for the **current week** (regular season or playoffs) without " +
      "importing any stats, rosters, or awarding payouts. Use this to load matchup data " +
      "after advancing a week early, or any time the schedule is missing or incomplete.\n\n" +
      "**📌 Re-post Scheduling Headers**\n" +
      "Finds every game channel for the active season that is missing its pinned scheduling " +
      "header (Schedule Game / Fair Sim / Force Win buttons). Also corrects channel " +
      "permissions so only the two players, the Commissioner role, and bot-admins can see " +
      "each channel. Safe to run on channels that already exist — nothing is deleted.",
    )
    .setFooter({ text: "All operations are scoped to this server only" })
    .setTimestamp();
}

export function buildTroubleshootRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ts_repair_records").setLabel("🔩 Repair User Records").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ts_resync_data").setLabel("🔄 Resync Rosters & Data").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ts_repair_playoff").setLabel("🏈 Repair Playoff Seeding").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ts_eos_testrun").setLabel("📊 EOS Test Run").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ts_repair_schedules").setLabel("🗓️ Repair Schedules").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ts_eos_manual").setLabel("⚡ EOS Manual Run").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ts_eos_reset").setLabel("🗑️ Clear & Rerun EOS").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ao_milestone_audit").setLabel("🎯 Milestone Audit").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ts_import_schedule").setLabel("📅 Import Schedule Only").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ts_repost_sched_headers").setLabel("📌 Re-post Scheduling Headers").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2, row3];
}

// ── Shared admin guard ─────────────────────────────────────────────────────────
async function guardAdmin(interaction: ButtonInteraction): Promise<boolean> {
  if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
    await interaction.reply({ content: "❌ Commissioner access required.", ephemeral: true });
    return false;
  }
  return true;
}

// ── 1. Repair User Records ────────────────────────────────────────────────────
export async function handleTsRepairRecords(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;

  let result;
  try {
    result = await repairUserRecords(guildId);
  } catch (err) {
    console.error("[ts_repair_records]", err);
    await interaction.editReply({ content: "❌ An error occurred while repairing records. Check bot logs." });
    return;
  }

  if (!result) {
    await interaction.editReply({ content: "❌ No active season found for this server." });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🔩 User Records Repaired")
    .addFields(
      { name: "Season",           value: `Season ${result.seasonNumber}`,                     inline: true },
      { name: "Games Processed",  value: result.gamesProcessed.toLocaleString(),               inline: true },
      { name: "Users Updated",    value: result.usersUpdated.toLocaleString(),                 inline: true },
      { name: "Global Records",   value: `${result.globalUpdated.toLocaleString()} rebuilt`,   inline: true },
    )
    .setDescription(
      "W/L records rebuilt from raw schedule data. " +
      "CPU wins and H2H wins are both counted. " +
      "Global all-time records were also recalculated.",
    )
    .setFooter({ text: "Records zeroed and rebuilt — any manual overrides are gone" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── 2. Resync Rosters & Data ──────────────────────────────────────────────────
export async function handleTsResyncData(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;

  const invResult = await db.execute(sql`
    UPDATE inventory i
    SET    team = u.team
    FROM   economy_users u,
           seasons s
    WHERE  i.discord_id = u.discord_id
      AND  s.id         = i.season_id
      AND  s.guild_id   = u.guild_id
      AND  s.guild_id   = ${guildId}
      AND  i.team       IS NULL
      AND  u.team       IS NOT NULL
      AND  u.team       != ''
  `);
  const invCount = (invResult as { rowCount?: number }).rowCount ?? 0;

  const cpResult = await db.execute(sql`
    UPDATE custom_players cp
    SET    team_name = u.team
    FROM   economy_users u,
           seasons s
    WHERE  cp.discord_id = u.discord_id
      AND  s.id          = cp.season_id
      AND  s.guild_id    = u.guild_id
      AND  s.guild_id    = ${guildId}
      AND  cp.team_name  IS NULL
      AND  u.team        IS NOT NULL
      AND  u.team        != ''
  `);
  const cpCount = (cpResult as { rowCount?: number }).rowCount ?? 0;

  const permResult = await db.execute(sql`
    UPDATE inventory i
    SET    team = u.team
    FROM   economy_users u,
           seasons s
    WHERE  i.discord_id      = u.discord_id
      AND  s.id              = i.season_id
      AND  s.guild_id        = u.guild_id
      AND  s.guild_id        = ${guildId}
      AND  i.legend_category = 'permanent'
      AND  u.team            IS NOT NULL
      AND  u.team            != ''
      AND  i.team            IS DISTINCT FROM u.team
  `);
  const permCount = (permResult as { rowCount?: number }).rowCount ?? 0;

  const [season] = await db.select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);

  let legendsAdded = 0;
  let legendsScanned = 0;

  if (season) {
    const allUsers = await db.select({
      discordId: usersTable.discordId,
      team:      usersTable.team,
    })
      .from(usersTable)
      .where(eq(usersTable.guildId, guildId));

    for (const user of allUsers) {
      if (!user.team) continue;
      try {
        const res = await assignRosterLegends(user.discordId, guildId, user.team, season.id);
        legendsAdded   += res.added.length;
        legendsScanned++;
      } catch (err) {
        console.warn(`[ts_resync_data] assignRosterLegends failed for ${user.discordId}:`, err);
      }
    }
  }

  const lines: string[] = [];
  if (invCount > 0)
    lines.push(`🗂️ **${invCount}** inventory item(s) stamped with team (were null)`);
  if (cpCount > 0)
    lines.push(`🧬 **${cpCount}** custom player(s) stamped with team (were null)`);
  if (permCount > 0)
    lines.push(`🔒 **${permCount}** permanent vault item(s) re-synced to current team owner`);
  if (legendsScanned > 0)
    lines.push(`🏅 **${legendsScanned}** user(s) roster-scanned · **${legendsAdded}** legend(s) newly assigned`);
  if (lines.length === 0)
    lines.push("✅ Everything already in sync — nothing needed updating.");

  const embed = new EmbedBuilder()
    .setColor(lines.length === 1 && lines[0]!.startsWith("✅") ? Colors.Green : Colors.Gold)
    .setTitle("🔄 Resync Complete")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Run Milestone Audit after this to correct any milestone payouts that were affected." })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── 3. EOS Test Run ───────────────────────────────────────────────────────────
export async function handleTsEosTestRun(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await runEosTestRun({
    guildId:          interaction.guildId!,
    seasonIdOverride: null,
    deferReply: opts => interaction.deferReply(opts),
    editReply:  data => interaction.editReply(data as any),
    followUp:   data => interaction.followUp(data as any),
  });
}

// ── 4. Repair Playoff Seeding — Step 1: show current seeding ─────────────────
export async function handleTsRepairPlayoff(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const seededUsers = await db.select({
    discordId:         usersTable.discordId,
    discordUsername:   usersTable.discordUsername,
    team:              usersTable.team,
    playoffSeed:       usersTable.playoffSeed,
    playoffConference: usersTable.playoffConference,
  })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), isNotNull(usersTable.playoffSeed)))
    .orderBy(usersTable.playoffConference, usersTable.playoffSeed);

  const afcTeams = seededUsers.filter(u => u.playoffConference === "AFC");
  const nfcTeams = seededUsers.filter(u => u.playoffConference === "NFC");

  function formatCurrentSeeding(teams: typeof afcTeams): string {
    if (!teams.length) return "_No seeds recorded_";
    return teams
      .sort((a, b) => (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99))
      .map(u => {
        const seed  = u.playoffSeed!;
        const badge = seed <= 3 ? ["🥇","🥈","🥉"][seed-1] : `**${seed}.**`;
        const type  = seed <= 4 ? "Div" : "WC";
        const label = u.team ?? u.discordUsername;
        return `${badge} \`${type}\` **${label}**`;
      })
      .join("\n");
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle(`🏈 Current Playoff Seeding — Season ${season.seasonNumber}`)
    .setDescription(
      "Review the current playoff seeding below.\n" +
      "If it is **incorrect**, click **Proceed with Reseed** to recompute seeding " +
      "from live season records using NFL rules (division winners seeds 1–4, wild cards 5–7).\n\n" +
      "⚠️ This will **overwrite** the current seeding.",
    )
    .addFields(
      { name: "🔵 AFC Seeding", value: formatCurrentSeeding(afcTeams), inline: true },
      { name: "🔴 NFC Seeding", value: formatCurrentSeeding(nfcTeams), inline: true },
    )
    .setFooter({ text: "Seeding from usersTable — these are the values used for EOS payouts" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ts_playoff_proceed").setLabel("🔄 Proceed with Reseed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ts_playoff_cancel").setLabel("← Back / Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ── 4a. Repair Playoff Seeding — Step 2: compute and show proposed seeding ───
export async function handleTsPlayoffProceed(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  await getPlayoffSeedingRules();

  const allStandings = await getArticleStandings(season.id, 18);

  if (!allStandings.length) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ No Standings Data Found")
        .setDescription(
          "Cannot compute seeding — no schedule data found for the active season.\n\n" +
          "Make sure at least one week of MCA data has been imported.",
        )],
      components: [],
    });
    return;
  }

  const afcTeams = allStandings.filter(t => t.conference === "AFC");
  const nfcTeams = allStandings.filter(t => t.conference === "NFC");
  const afcSeeds = computePlayoffSeeds(afcTeams);
  const nfcSeeds = computePlayoffSeeds(nfcTeams);

  const guildUsers = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  }).from(usersTable).where(eq(usersTable.guildId, guildId));

  const usernameToId = new Map(guildUsers.map(u => [u.discordUsername.toLowerCase(), u.discordId]));
  const teamToId     = new Map(guildUsers.filter(u => u.team).map(u => [u.team!.toLowerCase(), u.discordId]));

  let mappedAfc = 0, mappedNfc = 0;
  for (const t of afcSeeds) {
    const id = (t.discordUsername ? usernameToId.get(t.discordUsername.toLowerCase()) : undefined)
            ?? (t.teamName ? teamToId.get(t.teamName.toLowerCase()) : undefined);
    if (id) mappedAfc++;
  }
  for (const t of nfcSeeds) {
    const id = (t.discordUsername ? usernameToId.get(t.discordUsername.toLowerCase()) : undefined)
            ?? (t.teamName ? teamToId.get(t.teamName.toLowerCase()) : undefined);
    if (id) mappedNfc++;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🏈 Proposed Playoff Seeding — Season ${season.seasonNumber}`)
    .setDescription(
      "The bot has computed the following seeding from live season records " +
      "(wins DESC → losses ASC → point differential).\n\n" +
      `Mapped to registered users: **${mappedAfc}/7 AFC**, **${mappedNfc}/7 NFC**\n\n` +
      "CPU-controlled teams will be skipped. Click **Confirm Changes** to save this seeding.",
    )
    .addFields(
      { name: "🔵 Proposed AFC Seeding", value: formatSeedingLines(afcSeeds, "AFC"), inline: true },
      { name: "🔴 Proposed NFC Seeding", value: formatSeedingLines(nfcSeeds, "NFC"), inline: true },
    )
    .setFooter({
      text: "Seeds 1–4 = division winners · Seeds 5–7 = wild cards · Tiebreaker: wins → losses → PD",
    })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ts_playoff_confirm").setLabel("✅ Confirm Changes").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ts_playoff_cancel").setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ── 4b. Repair Playoff Seeding — Step 3: apply seeding ───────────────────────
export async function handleTsPlayoffConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const allStandings = await getArticleStandings(season.id, 18);

  if (!allStandings.length) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ No standings data — seeding not applied")
        .setDescription("Import MCA schedule data first, then try again.")],
      components: [],
    });
    return;
  }

  const afcSeeds = computePlayoffSeeds(allStandings.filter(t => t.conference === "AFC"));
  const nfcSeeds = computePlayoffSeeds(allStandings.filter(t => t.conference === "NFC"));

  const guildUsers = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  }).from(usersTable).where(eq(usersTable.guildId, guildId));

  const usernameToId = new Map(guildUsers.map(u => [u.discordUsername.toLowerCase(), u.discordId]));
  const teamToId     = new Map(guildUsers.filter(u => u.team).map(u => [u.team!.toLowerCase(), u.discordId]));

  await db.update(usersTable)
    .set({ playoffSeed: null, playoffConference: null, updatedAt: new Date() })
    .where(eq(usersTable.guildId, guildId));

  let applied = 0;
  const appliedLines: string[] = [];

  const applyConf = async (seeds: typeof afcSeeds, conf: "AFC" | "NFC") => {
    for (let i = 0; i < seeds.length; i++) {
      const t    = seeds[i]!;
      const seed = i + 1;
      const id   = (t.discordUsername ? usernameToId.get(t.discordUsername.toLowerCase()) : undefined)
                ?? (t.teamName ? teamToId.get(t.teamName.toLowerCase()) : undefined);
      if (!id) continue;

      await db.update(usersTable)
        .set({ playoffSeed: seed, playoffConference: conf, updatedAt: new Date() })
        .where(and(eq(usersTable.discordId, id), eq(usersTable.guildId, guildId)));

      const label = t.teamName || t.discordUsername || id;
      appliedLines.push(`${seed <= 4 ? "🏆" : "🃏"} ${conf} Seed #${seed} — **${label}**`);
      applied++;
    }
  };

  await applyConf(afcSeeds, "AFC");
  await applyConf(nfcSeeds, "NFC");

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Playoff Seeding Updated")
    .setDescription(
      `**${applied}** human team(s) seeded across AFC and NFC.\n\n` +
      (appliedLines.join("\n") || "_No human teams matched_"),
    )
    .setFooter({ text: "Use Rerun Season Historical in the hub to refresh the historical channel" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [] });
}

// ── 4c. Repair Playoff Seeding — Cancel ──────────────────────────────────────
export async function handleTsPlayoffCancel(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferUpdate();
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Grey)
      .setTitle("↩️ Playoff Reseed Cancelled")
      .setDescription("No changes were made. Open Troubleshoot again to return to the panel.")],
    components: [],
  });
}

// ── 5. EOS Manual Run — Step 1: confirmation warning ─────────────────────────
export async function handleTsEosManual(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("⚡ EOS Manual Run — Confirmation Required")
    .setDescription(
      `**Season ${season.seasonNumber}**\n\n` +
      "This will trigger the **full end-of-season payout process** for the active season:\n\n" +
      "• Calculates stat-tier bonuses for every registered user\n" +
      "• Inserts pending payout records into the database\n" +
      "• Posts commissioner approval embeds to the commish channel\n\n" +
      "⚠️ **Only run this once per season.** Running it again will create **duplicate payout requests**.\n\n" +
      "Are you sure you want to proceed?",
    )
    .setFooter({ text: "Use EOS Test Run first to verify the payout amounts before running this." })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ts_eos_manual_confirm")
      .setLabel("⚡ Yes — Run EOS Payouts Now")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ts_eos_manual_cancel")
      .setLabel("← Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ── 5a. EOS Manual Run — Step 2: execute ─────────────────────────────────────
export async function handleTsEosManualConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("⏳ Running EOS Payouts…")
      .setDescription(`Processing Season ${season.seasonNumber} — this may take a moment.`)],
    components: [],
  });

  let result: { posted: number; skipped: number; errors: number };
  try {
    result = await runEosAutoPost(interaction.client, season.id, guildId);
  } catch (err) {
    console.error("[ts_eos_manual_confirm]", err);
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ EOS Run Failed")
        .setDescription(`An error occurred: \`${(err as Error).message}\``)],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ EOS Payouts Triggered")
    .addFields(
      { name: "Posted",  value: result.posted.toString(),  inline: true },
      { name: "Skipped", value: result.skipped.toString(), inline: true },
      { name: "Errors",  value: result.errors.toString(),  inline: true },
    )
    .setDescription(
      "Commissioner approval embeds have been posted to the commish channel. " +
      "Review and approve each payout there.",
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [] });
}

// ── 5b. EOS Manual Run — Cancel ──────────────────────────────────────────────
export async function handleTsEosManualCancel(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferUpdate();
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Grey)
      .setTitle("↩️ EOS Manual Run Cancelled")
      .setDescription("No payouts were triggered.")],
    components: [],
  });
}

// ── 6. Milestone Audit ────────────────────────────────────────────────────────
export async function handleTsMilestoneAudit(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;

  const guildUsers = await db.select({
    discordId:            usersTable.discordId,
    team:                 usersTable.team,
    milestoneTierAwarded: usersTable.milestoneTierAwarded,
  })
    .from(usersTable)
    .where(eq(usersTable.guildId, guildId));

  if (guildUsers.length === 0) {
    await interaction.editReply({ content: "❌ No registered users found for this server." });
    return;
  }

  const winTotals = await db.select({
    discordId: userRecordsTable.discordId,
    totalWins: sql<string>`COALESCE(SUM(${userRecordsTable.wins}), 0)`,
  })
    .from(userRecordsTable)
    .innerJoin(seasonsTable, eq(userRecordsTable.seasonId, seasonsTable.id))
    .where(eq(seasonsTable.guildId, guildId))
    .groupBy(userRecordsTable.discordId);

  const winMap = new Map(winTotals.map(r => [r.discordId, parseInt(r.totalWins, 10)]));

  const paid:    string[] = [];
  const correct: string[] = [];
  const skipped: string[] = [];

  for (const user of guildUsers) {
    const totalWins   = winMap.get(user.discordId) ?? 0;
    const currentTier = user.milestoneTierAwarded ?? 0;

    const correctTier = WIN_MILESTONES.filter(m => totalWins >= m.wins).reduce(
      (max, m) => (m.tier > max ? m.tier : max), 0,
    );

    if (totalWins === 0) {
      skipped.push(`<@${user.discordId}> — 0 wins`);
      continue;
    }

    if (currentTier >= correctTier) {
      correct.push(`<@${user.discordId}> — ${totalWins}W, tier ${currentTier} ✅`);
      continue;
    }

    const recentTxns = await db.select({ description: coinTransactionsTable.description })
      .from(coinTransactionsTable)
      .where(and(
        eq(coinTransactionsTable.discordId, user.discordId),
        eq(coinTransactionsTable.guildId, guildId),
      ))
      .orderBy(desc(coinTransactionsTable.createdAt))
      .limit(10);

    const paidDescriptions = new Set(recentTxns.map(t => t.description ?? ""));

    const owedMilestones = WIN_MILESTONES.filter(
      m => totalWins >= m.wins && currentTier < m.tier,
    );

    let highestNewTier = currentTier;
    const userPaidLines: string[] = [];

    for (const m of owedMilestones) {
      const expectedDesc = `Career milestone: ${m.label}`;

      if (paidDescriptions.has(expectedDesc)) {
        if (m.tier > highestNewTier) highestNewTier = m.tier;
        continue;
      }

      await addBalance(user.discordId, m.bonus, guildId);
      await logTransaction(user.discordId, m.bonus, "addcoins", expectedDesc, guildId);
      userPaidLines.push(`Tier ${m.tier} — ${m.label}: **+${m.bonus.toLocaleString()} coins**`);

      if (m.tier > highestNewTier) highestNewTier = m.tier;
    }

    if (highestNewTier > currentTier) {
      await db.update(usersTable)
        .set({ milestoneTierAwarded: highestNewTier, updatedAt: new Date() })
        .where(and(eq(usersTable.discordId, user.discordId), eq(usersTable.guildId, guildId)));
    }

    if (userPaidLines.length > 0) {
      const teamLabel = user.team ? ` (${user.team})` : "";
      paid.push(`<@${user.discordId}>${teamLabel} | ${totalWins}W\n  └ ${userPaidLines.join("\n  └ ")}`);
    } else {
      correct.push(`<@${user.discordId}> — ${totalWins}W, tier corrected to ${highestNewTier} (txns found)`);
    }
  }

  const paidBlock    = paid.length    > 0 ? paid.join("\n\n")   : "*None — no outstanding payouts found.*";
  const correctBlock = correct.length > 0
    ? correct.slice(0, 15).join("\n") + (correct.length > 15 ? `\n…and ${correct.length - 15} more` : "")
    : "*None*";

  const replyEmbed = new EmbedBuilder()
    .setColor(paid.length > 0 ? Colors.Gold : Colors.Green)
    .setTitle("🎯 Milestone Audit Complete")
    .addFields(
      { name: `💸 Payouts Issued (${paid.length})`, value: paidBlock },
      { name: `✅ Already Correct (${correct.length})`, value: correctBlock },
    )
    .setFooter({ text: `${skipped.length} user(s) had 0 wins and were skipped` })
    .setTimestamp();

  await interaction.editReply({ embeds: [replyEmbed] });

  if (paid.length === 0) return;

  try {
    const commChannelId =
      await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG)
      ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER)
      ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]
      ?? "";

    const commChannel = commChannelId
      ? await interaction.client.channels.fetch(commChannelId).catch(() => null)
      : null;

    if (commChannel instanceof TextChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🎯 Retroactive Milestone Audit — Payouts Issued")
        .setDescription(paid.map((p, i) => `**${i + 1}.** ${p}`).join("\n\n").slice(0, 4000))
        .addFields(
          { name: "Audited By",  value: `<@${interaction.user.id}>`, inline: true },
          { name: "Total Paid",  value: `${paid.length} user(s)`,     inline: true },
        )
        .setTimestamp();

      await commChannel.send({ embeds: [logEmbed] });
    }
  } catch (err) {
    console.error("[handleTsMilestoneAudit] Failed to post to commissioner channel:", err);
  }
}

// ── Repair Schedules ───────────────────────────────────────────────────────────

function wkLabel(weekIndex: number): string {
  if (weekIndex >= 0 && weekIndex <= 17) return `Wk ${weekIndex + 1}`;
  if (weekIndex === 1018) return "Wild Card";
  if (weekIndex === 1019) return "Divisional";
  if (weekIndex === 1020) return "Conference Championship";
  if (weekIndex === 1022) return "Super Bowl";
  return `Week ${weekIndex}`;
}

function buildSchedGameOptions(games: { id: number; weekIndex: number; homeTeamName: string; awayTeamName: string }[]) {
  return games.slice(0, 25).map(g => {
    const wk  = wkLabel(g.weekIndex);
    const lbl = `${wk}: ${g.awayTeamName} @ ${g.homeTeamName}`.slice(0, 100);
    return new StringSelectMenuOptionBuilder()
      .setLabel(lbl)
      .setValue(String(g.id))
      .setDescription(`Game ID #${g.id}`);
  });
}

function buildSchedReviewWeekModal(): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId("ts_modal_sched_week")
    .setTitle("Review Schedule — Enter Week #");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("week_num")
        .setLabel("Week number (1-18, 19=WC, 20=DIV, 21=CC, 22=SB)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2)
        .setPlaceholder("1"),
    ),
  );
  return modal;
}

export async function handleTsRepairSchedules(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  // Use schedule season fallback so we find data even if a new active season
  // was created before the schedule was re-imported.
  const schedSeasonId = await getScheduleSeasonId(guildId);

  // Load all regular-season games (weekIndex 0–17) for the schedule season
  const allGames = await db
    .select({
      id:           franchiseScheduleTable.id,
      weekIndex:    franchiseScheduleTable.weekIndex,
      homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
      homeTeamId:   franchiseScheduleTable.homeTeamId,
      awayTeamId:   franchiseScheduleTable.awayTeamId,
    })
    .from(franchiseScheduleTable)
    .where(eq(franchiseScheduleTable.seasonId, schedSeasonId))
    .orderBy(asc(franchiseScheduleTable.weekIndex), asc(franchiseScheduleTable.id));

  const regularGames = allGames.filter(g => g.weekIndex >= 0 && g.weekIndex <= 17);

  // Detect duplicates: any team appearing in 2+ games in the same week
  const suspectIds = new Set<number>();
  const weekTeamMap = new Map<string, number[]>(); // "weekIdx:teamId" → [gameId, ...]
  for (const g of regularGames) {
    for (const teamId of [g.homeTeamId, g.awayTeamId]) {
      const key = `${g.weekIndex}:${teamId}`;
      if (!weekTeamMap.has(key)) weekTeamMap.set(key, []);
      weekTeamMap.get(key)!.push(g.id);
    }
  }
  for (const [, ids] of weekTeamMap) {
    if (ids.length > 1) ids.forEach(id => suspectIds.add(id));
  }

  const suspects = regularGames.filter(g => suspectIds.has(g.id));

  const backNavRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  if (suspects.length === 0) {
    // No duplicates — offer manual week review
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ No Duplicate Games Found")
          .setDescription(
            `Scanned **${regularGames.length}** games across all regular-season weeks for Season ${season.seasonNumber}. ` +
            `No team appears in more than one game in the same week.\n\n` +
            `If you believe a specific game is incorrect, use **Review Any Week** to browse and remove it.`,
          )
          .setTimestamp(),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ts_sched_review_week").setLabel("🔍 Review Any Week").setStyle(ButtonStyle.Primary),
          ...backNavRow.components,
        ) as ActionRowBuilder<any>,
      ],
    });
    return;
  }

  // Show select menu of suspect games
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ts_sched_sel")
    .setPlaceholder("Pick the game to delete…")
    .addOptions(buildSchedGameOptions(suspects));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle(`⚠️ ${suspectIds.size} Suspect Game${suspectIds.size !== 1 ? "s" : ""} Found`)
        .setDescription(
          `The following games involve a team that appears **more than once** in the same week ` +
          `for Season ${season.seasonNumber}. Select the **invalid** game to remove it.\n\n` +
          `_(Removing a game also rebuilds all W/L records for the active season.)_`,
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu) as ActionRowBuilder<any>,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ts_sched_review_week").setLabel("🔍 Review Any Week Instead").setStyle(ButtonStyle.Secondary),
        ...backNavRow.components,
      ) as ActionRowBuilder<any>,
    ],
  });
}

export async function handleTsSchedReviewWeek(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;
  await interaction.showModal(buildSchedReviewWeekModal());
}

export async function handleTsSchedWeekModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!(await guardAdmin(interaction as unknown as ButtonInteraction))) return;

  await interaction.deferReply({ ephemeral: true });

  const raw     = interaction.fields.getTextInputValue("week_num").trim();
  const weekNum = parseInt(raw, 10);
  if (isNaN(weekNum) || weekNum < 1 || weekNum > 22) {
    await interaction.editReply({ content: "❌ Invalid week number. Enter 1–18 (regular season) or 19–22 (playoffs)." });
    return;
  }

  const weekIndexMap: Record<number, number> = { 19: 1018, 20: 1019, 21: 1020, 22: 1022 };
  const weekIndex = weekNum <= 18 ? weekNum - 1 : (weekIndexMap[weekNum] ?? -1);
  if (weekIndex === -1) {
    await interaction.editReply({ content: "❌ Could not resolve week index." });
    return;
  }

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const schedSeasonId = await getScheduleSeasonId(guildId);

  const games = await db
    .select({
      id:           franchiseScheduleTable.id,
      weekIndex:    franchiseScheduleTable.weekIndex,
      homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
    })
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  schedSeasonId),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ))
    .orderBy(asc(franchiseScheduleTable.id));

  if (games.length === 0) {
    await interaction.editReply({
      content: `❌ No games found for **${wkLabel(weekIndex)}** in Season ${season.seasonNumber}. ` +
               `Make sure the schedule has been imported.`,
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ts_sched_sel")
    .setPlaceholder("Pick the game to delete…")
    .addOptions(buildSchedGameOptions(games));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`📅 ${wkLabel(weekIndex)} — Season ${season.seasonNumber} (${games.length} games)`)
        .setDescription(
          games.map(g => `• **${g.awayTeamName}** @ **${g.homeTeamName}** _(ID #${g.id})_`).join("\n"),
        )
        .setFooter({ text: "Select a game below to remove it from the schedule" })
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu) as ActionRowBuilder<any>,
    ],
  });
}

export async function handleTsSchedSel(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!(await guardAdmin(interaction as unknown as ButtonInteraction))) return;

  const gameId = parseInt(interaction.values[0]!, 10);
  if (isNaN(gameId)) {
    await interaction.reply({ content: "❌ Invalid selection.", ephemeral: true });
    return;
  }

  const [game] = await db
    .select({
      id:           franchiseScheduleTable.id,
      weekIndex:    franchiseScheduleTable.weekIndex,
      homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
    })
    .from(franchiseScheduleTable)
    .where(eq(franchiseScheduleTable.id, gameId))
    .limit(1);

  if (!game) {
    await interaction.reply({ content: "❌ Game not found — it may have already been deleted.", ephemeral: true });
    return;
  }

  const label = `${wkLabel(game.weekIndex)}: ${game.awayTeamName} @ ${game.homeTeamName}`;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🗑️ Confirm Game Deletion")
        .setDescription(
          `You are about to **permanently delete** this schedule entry:\n\n` +
          `> **${label}** _(Game ID #${game.id})_\n\n` +
          `This will also rebuild all W/L records for the active season to reflect the removal. ` +
          `This action **cannot be undone**.`,
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ts_sched_delete:${game.id}`)
          .setLabel("🗑️ Delete This Game")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("ts_repair_schedules")
          .setLabel("← Back to Scan")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("ao_hub_back")
          .setLabel("← Back to Hub")
          .setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

// ── 9. Import Schedule Only ───────────────────────────────────────────────────
export async function handleTsImportSchedule(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setTitle("📅 Importing Schedule…")
        .setDescription("Connecting to EA and fetching the current week's schedule data.\nThis may take a few seconds.")
        .setTimestamp(),
    ],
  });

  const result = await runScheduleOnlyImport(guildId);

  if (!result.ok) {
    const msgs: Record<string, string> = {
      no_connection:        "No EA connection found for this server. Set up your EA connection first via the League Data menu.",
      token_refresh_failed: "Failed to refresh the EA access token. The stored credentials may have expired.",
      fetch_failed:         "Failed to fetch schedule data from EA. Check that the EA franchise is active and try again.",
    };
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Schedule Import Failed")
          .setDescription(msgs[result.error ?? ""] ?? `An unexpected error occurred: \`${result.error}\``)
          .setTimestamp(),
      ],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📅 Schedule Import Complete")
    .addFields(
      { name: "Week",         value: result.weekLabel,                                              inline: true },
      { name: "Games Synced", value: `${result.synced} / ${result.total}`,                          inline: true },
    )
    .setDescription(
      `Schedule for **${result.weekLabel}** has been imported from EA.\n` +
      "No stats, rosters, or payouts were changed.",
    )
    .setFooter({ text: "Only schedule data was touched — run a full import to get scores and stats" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

export async function handleTsSchedDelete(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  const gameId = parseInt(interaction.customId.split(":")[1] ?? "", 10);
  if (isNaN(gameId)) {
    await interaction.reply({ content: "❌ Invalid game ID.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const [game] = await db
    .select({
      id:           franchiseScheduleTable.id,
      weekIndex:    franchiseScheduleTable.weekIndex,
      homeTeamName: franchiseScheduleTable.homeTeamName,
      awayTeamName: franchiseScheduleTable.awayTeamName,
      seasonId:     franchiseScheduleTable.seasonId,
    })
    .from(franchiseScheduleTable)
    .where(eq(franchiseScheduleTable.id, gameId))
    .limit(1);

  if (!game) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setDescription("❌ Game not found — may have already been deleted.")],
      components: [],
    });
    return;
  }

  await db.delete(franchiseScheduleTable).where(eq(franchiseScheduleTable.id, gameId));

  const guildId = interaction.guildId!;
  let recordResult: Awaited<ReturnType<typeof repairUserRecords>> = null;
  try {
    recordResult = await repairUserRecords(guildId);
  } catch (err) {
    console.error("[handleTsSchedDelete] repairUserRecords failed:", err);
  }

  const label = `${wkLabel(game.weekIndex)}: ${game.awayTeamName} @ ${game.homeTeamName}`;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Game Removed")
        .setDescription(
          `**${label}** _(ID #${game.id})_ has been deleted from the season schedule.\n\n` +
          (recordResult
            ? `W/L records rebuilt — **${recordResult.usersUpdated}** user${recordResult.usersUpdated !== 1 ? "s" : ""} updated.`
            : `W/L rebuild skipped (no active season or error).`),
        )
        .setFooter({ text: `By ${interaction.user.username}` })
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ts_repair_schedules").setLabel("🔍 Scan Again").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ) as ActionRowBuilder<any>,
    ],
  });
}

// ── Clear & Rerun EOS — Step 1: confirmation ──────────────────────────────────
export async function handleTsEosReset(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const pending = await db.select({ id: pendingEosPayoutsTable.id })
    .from(pendingEosPayoutsTable)
    .where(and(
      eq(pendingEosPayoutsTable.seasonId, season.id),
      inArray(pendingEosPayoutsTable.status, ["pending"]),
    ));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🗑️ Clear & Rerun EOS — Confirmation Required")
        .setDescription(
          `**Season ${season.seasonNumber}**\n\n` +
          `This will:\n` +
          `• Delete **${pending.length}** pending EOS payout record(s) for this season\n` +
          `• Immediately rerun the EOS calculation scoped to **this server only**\n` +
          `• Repost fresh approval embeds to the commissioner channel\n\n` +
          `⚠️ Already-approved payouts are **not** deleted or reversed.\n\n` +
          `Are you sure?`,
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ts_eos_reset_confirm").setLabel("🗑️ Yes — Clear & Rerun").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("ts_eos_reset_cancel").setLabel("← Cancel").setStyle(ButtonStyle.Secondary),
      ) as ActionRowBuilder<any>,
    ],
  });
}

// ── Clear & Rerun EOS — Step 2: execute ───────────────────────────────────────
export async function handleTsEosResetConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;
  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(Colors.Yellow).setTitle("⏳ Clearing & Rerunning EOS…").setDescription("Deleting pending records and recalculating…")],
    components: [],
  });

  // Delete only pending records (not approved ones)
  const deleted = await db.delete(pendingEosPayoutsTable)
    .where(and(
      eq(pendingEosPayoutsTable.seasonId, season.id),
      inArray(pendingEosPayoutsTable.status, ["pending"]),
    ))
    .returning({ id: pendingEosPayoutsTable.id });

  let result: { posted: number; skipped: number; errors: number };
  try {
    result = await runEosAutoPost(interaction.client, season.id, guildId);
  } catch (err) {
    console.error("[ts_eos_reset_confirm]", err);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ EOS Rerun Failed")
        .setDescription(`Deleted **${deleted.length}** pending record(s), but the rerun failed: \`${(err as Error).message}\``)],
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ EOS Reset Complete")
        .setDescription(
          `• 🗑️ **${deleted.length}** pending record(s) cleared\n` +
          `• 📋 **${result.posted}** fresh payout embed(s) posted to the commissioner channel\n` +
          `• ⏭ **${result.skipped}** skipped (already have approved payouts)\n` +
          (result.errors > 0 ? `• ⚠️ **${result.errors}** error(s) — check bot logs` : ""),
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
      ) as ActionRowBuilder<any>,
    ],
  });
}

// ── Clear & Rerun EOS — Cancel ─────────────────────────────────────────────────
export async function handleTsEosResetCancel(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;
  await interaction.deferUpdate();
  await interaction.editReply({
    embeds: [buildTroubleshootEmbed()],
    components: buildTroubleshootRows() as ActionRowBuilder<any>[],
  });
}

// ── Re-post Scheduling Headers ─────────────────────────────────────────────────
export async function handleTsRepostSchedulingHeaders(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const guild   = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "❌ Could not access guild." });
    return;
  }

  const season = await getOrCreateActiveSeason(guildId);

  // Find game_channels rows with no matching game_schedules row.
  // Raw SQL needed because away_discord_id / home_discord_id are not in the Drizzle schema.
  const orphans = await db.execute<{
    id: number;
    channel_id: string;
    away_team_name: string;
    home_team_name: string;
    season_id: number;
    week_index: number;
    away_discord_id: string | null;
    home_discord_id: string | null;
  }>(sql`
    SELECT gc.id, gc.channel_id, gc.away_team_name, gc.home_team_name,
           gc.season_id, gc.week_index, gc.away_discord_id, gc.home_discord_id
    FROM game_channels gc
    WHERE gc.season_id = ${season.id}
      AND NOT EXISTS (
        SELECT 1 FROM game_schedules gs WHERE gs.channel_id = gc.channel_id
      )
  `);

  if (orphans.rows.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("📌 Scheduling Headers — All Good")
          .setDescription("Every game channel for the active season already has a scheduling header. Nothing to do.")
          .setTimestamp(),
      ],
    });
    return;
  }

  const settings = await getServerSettings(guildId);
  const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
  const commRole = guild.roles.cache.find((r) => r.name.toLowerCase() === "commissioner");
  const botAdmins = await db.select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), eq(usersTable.isAdmin, true)));

  let fixed   = 0;
  let skipped = 0;
  const lines: string[] = [];

  for (const row of orphans.rows) {
    const awayDiscordId = row.away_discord_id ?? "";
    const homeDiscordId = row.home_discord_id ?? "";
    const awayProper    = row.away_team_name;
    const homeProper    = row.home_team_name;

    try {
      const ch = await guild.channels.fetch(row.channel_id).catch(() => null);
      if (!ch || ch.type !== ChannelType.GuildText) {
        lines.push(`⏭️ **${awayProper} vs ${homeProper}** — channel not found in Discord, skipped`);
        skipped++;
        continue;
      }
      const textCh = ch as TextChannel;

      // Fix permission overwrites
      const overwrites: import("discord.js").OverwriteResolvable[] = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.client.user!.id,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels] },
      ];
      if (commRole) overwrites.push({ id: commRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      if (awayDiscordId && !awayDiscordId.startsWith("unlinked_")) overwrites.push({ id: awayDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      if (homeDiscordId && !homeDiscordId.startsWith("unlinked_")) overwrites.push({ id: homeDiscordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
      for (const a of botAdmins) {
        if (a.discordId && a.discordId !== awayDiscordId && a.discordId !== homeDiscordId && !a.discordId.startsWith("unlinked_")) {
          overwrites.push({ id: a.discordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
        }
      }
      await textCh.permissionOverwrites.set(overwrites).catch(() => {});

      // Insert game_schedules row and post header
      const sched = await ensureScheduleRow({
        guildId,
        channelId:    row.channel_id,
        seasonId:     season.id,
        weekIndex:    row.week_index,
        awayDiscordId,
        homeDiscordId,
        awayTeamName: awayProper,
        homeTeamName: homeProper,
        status:       "unscheduled",
      });

      const awayMember = awayDiscordId && !awayDiscordId.startsWith("unlinked_")
        ? await guild.members.fetch(awayDiscordId).catch(() => null) : null;
      const homeMember = homeDiscordId && !homeDiscordId.startsWith("unlinked_")
        ? await guild.members.fetch(homeDiscordId).catch(() => null) : null;
      const awayTag = awayMember ? `<@${awayDiscordId}> (@${awayMember.displayName})` : awayProper;
      const homeTag = homeMember ? `<@${homeDiscordId}> (@${homeMember.displayName})` : homeProper;

      const headerMsg = await textCh.send({
        content:
          `🏈 **${awayProper} @ ${homeProper}**\n` +
          `${awayTag}  vs  ${homeTag}\n` +
          `Schedule your game using the buttons below. Good luck!`,
        components: [buildHeaderRow(sched)],
      });
      await headerMsg.pin().catch(() => {});
      await db.update(gameSchedulesTable)
        .set({ headerMessageId: headerMsg.id })
        .where(eq(gameSchedulesTable.id, sched.id));

      lines.push(`✅ <#${row.channel_id}> — **${awayProper} vs ${homeProper}**`);
      fixed++;
    } catch (err) {
      console.error(`[ts_repost_sched_headers] Error for channel ${row.channel_id}:`, err);
      lines.push(`❌ **${awayProper} vs ${homeProper}** — error, check bot logs`);
      skipped++;
    }
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(fixed > 0 ? Colors.Green : Colors.Greyple)
        .setTitle("📌 Re-post Scheduling Headers")
        .addFields(
          { name: "Fixed",   value: String(fixed),   inline: true },
          { name: "Skipped", value: String(skipped), inline: true },
        )
        .setDescription(lines.join("\n") || "No channels processed.")
        .setFooter({ text: "Permissions corrected + scheduling header posted in each fixed channel" })
        .setTimestamp(),
    ],
  });
}
