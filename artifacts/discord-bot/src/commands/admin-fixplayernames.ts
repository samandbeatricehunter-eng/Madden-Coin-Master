import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { playerSeasonStatsTable, franchiseRostersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-fixplayernames")
  .setDescription("Backfill missing player names in stat leaders from roster data (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const season = await getOrCreateActiveSeason();

  // Load all roster data for this season
  const rosterRows = await db
    .select({
      playerId:  franchiseRostersTable.playerId,
      firstName: franchiseRostersTable.firstName,
      lastName:  franchiseRostersTable.lastName,
      position:  franchiseRostersTable.position,
    })
    .from(franchiseRostersTable)
    .where(eq(franchiseRostersTable.seasonId, season.id));

  if (rosterRows.length === 0) {
    await interaction.editReply({
      content: "⚠️ No roster data found for this season. Run `/franchiseupdate` first to import roster data.",
    });
    return;
  }

  const rosterMap = new Map(rosterRows.map(r => [r.playerId, r]));

  // Load all player stat rows for this season
  const statRows = await db
    .select({
      id:        playerSeasonStatsTable.id,
      playerId:  playerSeasonStatsTable.playerId,
      firstName: playerSeasonStatsTable.firstName,
      lastName:  playerSeasonStatsTable.lastName,
      position:  playerSeasonStatsTable.position,
    })
    .from(playerSeasonStatsTable)
    .where(eq(playerSeasonStatsTable.seasonId, season.id));

  let updated = 0;
  let skipped = 0;
  const updateOps: Promise<any>[] = [];

  for (const row of statRows) {
    const roster = rosterMap.get(row.playerId);
    if (!roster) { skipped++; continue; }

    // Only update if we have roster data and the stat row has missing info
    const needsFirstName = !row.firstName && roster.firstName;
    const needsLastName  = !row.lastName  && roster.lastName;
    const needsPosition  = !row.position  && roster.position;

    if (!needsFirstName && !needsLastName && !needsPosition) { skipped++; continue; }

    const patch: Record<string, any> = {};
    if (needsFirstName) patch["firstName"] = roster.firstName;
    if (needsLastName)  patch["lastName"]  = roster.lastName;
    if (needsPosition)  patch["position"]  = roster.position;

    updateOps.push(
      db.update(playerSeasonStatsTable)
        .set(patch)
        .where(and(
          eq(playerSeasonStatsTable.seasonId, season.id),
          eq(playerSeasonStatsTable.playerId, row.playerId),
        ))
    );
    updated++;
  }

  await Promise.all(updateOps);

  const embed = new EmbedBuilder()
    .setTitle("✅ Player Names Backfilled")
    .setColor(Colors.Green)
    .addFields(
      { name: "📋 Stat Rows Found",    value: String(statRows.length),    inline: true },
      { name: "✅ Updated",            value: String(updated),             inline: true },
      { name: "⏭️ Already Had Names", value: String(skipped),             inline: true },
      { name: "🗃️ Roster Entries",    value: String(rosterRows.length),   inline: true },
    )
    .setDescription(
      updated > 0
        ? `Fixed **${updated}** player stat rows with names from the roster.`
        : "All stat rows already had player names — nothing to fix."
    )
    .setFooter({ text: `Season ${season.seasonNumber}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
