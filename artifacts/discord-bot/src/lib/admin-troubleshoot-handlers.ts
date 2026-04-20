/**
 * admin-troubleshoot-handlers.ts
 *
 * Button handlers for /admin-troubleshoot.
 * customId prefixes: ts_repair_records | ts_resync_data | ts_eos_testrun
 */

import { ButtonInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { usersTable, seasonsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

import { isAdminUser } from "./db-helpers.js";
import { repairUserRecords } from "./repair-records.js";
import { assignRosterLegends } from "./roster-legend-assign.js";
import { runEosTestRun } from "../commands/admin-eos-testrun.js";

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
