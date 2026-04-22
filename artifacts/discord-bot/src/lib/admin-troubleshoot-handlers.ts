/**
 * admin-troubleshoot-handlers.ts
 *
 * Button handlers for the Troubleshoot panel.
 * customId prefixes:
 *   ts_repair_records | ts_resync_data | ts_eos_testrun
 *   ts_repair_playoff | ts_playoff_proceed | ts_playoff_confirm | ts_playoff_cancel
 *   ts_eos_manual     | ts_eos_manual_confirm | ts_eos_manual_cancel
 *   ao_milestone_audit
 */

import {
  ButtonInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, seasonsTable, userRecordsTable, coinTransactionsTable,
} from "@workspace/db";
import { eq, and, sql, isNotNull, desc } from "drizzle-orm";

import {
  isAdminUser, getOrCreateActiveSeason,
  addBalance, logTransaction, getGuildChannel, CHANNEL_KEYS,
} from "./db-helpers.js";
import { repairUserRecords } from "./repair-records.js";
import { assignRosterLegends } from "./roster-legend-assign.js";
import { runEosTestRun } from "../commands/admin-eos-testrun.js";
import { runEosAutoPost } from "./eos-auto-post.js";
import {
  computePlayoffSeeds,
  getPlayoffSeedingRules,
  formatSeedingLines,
} from "./playoff-seeding.js";
import { getArticleStandings } from "./gcs-fallback.js";

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
      "**⚡ EOS Manual Run**\n" +
      "Triggers the actual end-of-season payout process for the active season. " +
      "Posts commissioner approval embeds to the commish channel for every user. " +
      "⚠️ Only run this once — duplicate runs will create duplicate payout requests.\n\n" +
      "**🎯 Milestone Audit**\n" +
      "Retroactively checks and pays any owed win-milestone bonuses for every registered " +
      "user on this server. Safe to run multiple times — duplicate detection is built in.",
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
    new ButtonBuilder().setCustomId("ts_eos_manual").setLabel("⚡ EOS Manual Run").setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_milestone_audit").setLabel("🎯 Milestone Audit").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2];
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
    result = await runEosAutoPost(guildId, season.id, interaction.client);
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
