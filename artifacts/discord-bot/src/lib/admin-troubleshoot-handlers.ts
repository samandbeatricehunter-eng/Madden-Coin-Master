/**
 * admin-troubleshoot-handlers.ts
 *
 * Button handlers for /admin-troubleshoot.
 * customId prefixes:
 *   ts_repair_records | ts_resync_data | ts_eos_testrun
 *   ts_repair_playoff | ts_playoff_proceed | ts_playoff_confirm | ts_playoff_cancel
 *   ts_eos_manual     | ts_eos_manual_confirm | ts_eos_manual_cancel
 */

import {
  ButtonInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  Client,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, seasonsTable } from "@workspace/db";
import { eq, and, sql, isNotNull } from "drizzle-orm";

import { isAdminUser, getOrCreateActiveSeason } from "./db-helpers.js";
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

// ── Shared admin guard ────────────────────────────────────────────────────────
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

  // ── Step A: Inventory team stamps (from admin-resync-teams logic) ─────────
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

  // ── Step B: Custom players team stamp ────────────────────────────────────
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

  // ── Step C: Force-sync permanent vault ───────────────────────────────────
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

  // ── Step D: Roster legend scan for ALL users in this guild ────────────────
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
    .setFooter({ text: "Run /admin-milestone-audit after this to correct any milestone payouts that were affected." })
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

  // Load current seeding from usersTable
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
      {
        name: "🔵 AFC Seeding",
        value: formatCurrentSeeding(afcTeams),
        inline: true,
      },
      {
        name: "🔴 NFC Seeding",
        value: formatCurrentSeeding(nfcTeams),
        inline: true,
      },
    )
    .setFooter({ text: "Seeding from usersTable — these are the values used for EOS payouts" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ts_playoff_proceed")
      .setLabel("🔄 Proceed with Reseed")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("ts_playoff_cancel")
      .setLabel("← Back / Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ── 4a. Repair Playoff Seeding — Step 2: compute and show proposed seeding ───
export async function handleTsPlayoffProceed(interaction: ButtonInteraction): Promise<void> {
  if (!(await guardAdmin(interaction))) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  // Load seeding rules (seeds into DB if first time)
  await getPlayoffSeedingRules();

  // Get all standings (week 18 = full regular season)
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

  // Compute seeds for each conference
  const afcTeams    = allStandings.filter(t => t.conference === "AFC");
  const nfcTeams    = allStandings.filter(t => t.conference === "NFC");
  const afcSeeds    = computePlayoffSeeds(afcTeams);
  const nfcSeeds    = computePlayoffSeeds(nfcTeams);

  // Collect user discordIds for seed assignment (match by discordUsername)
  const guildUsers = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
  }).from(usersTable).where(eq(usersTable.guildId, guildId));

  const usernameToId = new Map(guildUsers.map(u => [u.discordUsername.toLowerCase(), u.discordId]));
  const teamToId     = new Map(guildUsers.filter(u => u.team).map(u => [u.team!.toLowerCase(), u.discordId]));

  // Resolve how many human seeds we can map
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
    new ButtonBuilder()
      .setCustomId("ts_playoff_confirm")
      .setLabel("✅ Confirm Changes")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ts_playoff_cancel")
      .setLabel("✖ Cancel")
      .setStyle(ButtonStyle.Secondary),
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

  // First clear existing seeds for this guild
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
    .setFooter({ text: "Run /admin-rebuild-historical to refresh the historical channel" })
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
      .setDescription("No changes were made. Run `/admin-troubleshoot` again to return to the panel.")],
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
    result = await runEosAutoPost(interaction.client as Client, season.id, guildId);
  } catch (err) {
    console.error("[ts_eos_manual_confirm]", err);
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ EOS Manual Run Failed")
        .setDescription(`An error occurred: \`${err}\`\n\nCheck bot logs for details.`)],
      components: [],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(result.errors > 0 ? Colors.Orange : Colors.Green)
    .setTitle("✅ EOS Manual Run Complete")
    .addFields(
      { name: "Posted",  value: result.posted.toString(),  inline: true },
      { name: "Skipped", value: result.skipped.toString(), inline: true },
      { name: "Errors",  value: result.errors.toString(),  inline: true },
    )
    .setDescription(
      "Commissioner approval embeds have been posted to the commish channel. " +
      "Review and approve each user's payout there.",
    )
    .setFooter({ text: `Season ${season.seasonNumber}` })
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
      .setDescription("No payouts were run. Run `/admin-troubleshoot` again to return to the panel.")],
    components: [],
  });
}
