import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  seasonsTable, playerSeasonStatsTable, teamSeasonStatsTable,
  playerStatWeekProcessedTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../../lib/db/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-catchup")
  .setDescription("Manage stat catchup mode for historical MCA imports (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("on")
      .setDescription("Enable catchup mode — clears all season stats and disables payouts during MCA imports")
  )
  .addSubcommand(sub =>
    sub.setName("off")
      .setDescription("Disable catchup mode — MCA imports resume normal payouts and notifications")
  )
  .addSubcommand(sub =>
    sub.setName("status")
      .setDescription("Check whether catchup mode is currently active")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const sub    = interaction.options.getSubcommand(true);
  const season = await getOrCreateActiveSeason(interaction.guildId!);

  // ── STATUS ──────────────────────────────────────────────────────────────────
  if (sub === "status") {
    const embed = new EmbedBuilder()
      .setTitle("📋 Catchup Mode Status")
      .setColor(season.catchupMode ? Colors.Yellow : Colors.Green)
      .setDescription(
        season.catchupMode
          ? "🟡 **Catchup mode is ON**\nMCA imports will record stats only — no payouts, no notifications.\nExport weeks in order from Week 1 to build up season totals."
          : "🟢 **Catchup mode is OFF**\nMCA imports are running normally with payouts and notifications."
      )
      .addFields({ name: "Active Season", value: `Season ${season.seasonNumber}`, inline: true })
      .setFooter({ text: `Season ${season.seasonNumber}` });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── ENABLE ──────────────────────────────────────────────────────────────────
  if (sub === "on") {
    if (season.catchupMode) {
      await interaction.editReply({
        content: "⚠️ Catchup mode is already ON. No changes made.",
      });
      return;
    }

    // Count what will be cleared so we can confirm
    const [playerCount, teamCount, dedupCount] = await Promise.all([
      db.select({ id: playerSeasonStatsTable.playerId }).from(playerSeasonStatsTable)
        .where(eq(playerSeasonStatsTable.seasonId, season.id)),
      db.select({ id: teamSeasonStatsTable.teamId }).from(teamSeasonStatsTable)
        .where(eq(teamSeasonStatsTable.seasonId, season.id)),
      db.select({ id: playerStatWeekProcessedTable.id }).from(playerStatWeekProcessedTable)
        .where(eq(playerStatWeekProcessedTable.seasonId, season.id)),
    ]);

    // Clear all season stat tables — wins/losses are NOT touched
    await Promise.all([
      db.delete(playerSeasonStatsTable).where(eq(playerSeasonStatsTable.seasonId, season.id)),
      db.delete(teamSeasonStatsTable).where(eq(teamSeasonStatsTable.seasonId, season.id)),
      db.delete(playerStatWeekProcessedTable).where(eq(playerStatWeekProcessedTable.seasonId, season.id)),
    ]);

    // Enable catchup mode on the season
    await db.update(seasonsTable)
      .set({ catchupMode: true })
      .where(eq(seasonsTable.id, season.id));

    const embed = new EmbedBuilder()
      .setTitle("🟡 Catchup Mode ENABLED")
      .setColor(Colors.Yellow)
      .setDescription(
        "All player and team stat data for this season has been cleared.\n\n" +
        "**Wins, losses, and coin balances were NOT affected.**\n\n" +
        "Now export weeks from MCA **in ascending order starting from Week 1**. " +
        "Each week's stats will accumulate. No payouts or notifications will fire until you turn this off."
      )
      .addFields(
        { name: "🗑️ Cleared", value: [
          `Player season stats: **${playerCount.length}** rows`,
          `Team season stats: **${teamCount.length}** rows`,
          `Week dedup records: **${dedupCount.length}** rows`,
        ].join("\n"), inline: false },
        { name: "✅ Untouched", value: "Wins/losses, coin balances, purchases, legends, game logs", inline: false },
        { name: "📋 Next Steps", value: "Export Week 1 → Week 2 → ... in order via the Madden Companion App", inline: false },
      )
      .setFooter({ text: `Season ${season.seasonNumber}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── DISABLE ─────────────────────────────────────────────────────────────────
  if (sub === "off") {
    if (!season.catchupMode) {
      await interaction.editReply({
        content: "⚠️ Catchup mode is already OFF. No changes made.",
      });
      return;
    }

    await db.update(seasonsTable)
      .set({ catchupMode: false })
      .where(eq(seasonsTable.id, season.id));

    const embed = new EmbedBuilder()
      .setTitle("🟢 Catchup Mode DISABLED")
      .setColor(Colors.Green)
      .setDescription(
        "MCA imports are now back to normal.\n\n" +
        "Future exports will issue coin payouts, post results to channels, and track game history as usual."
      )
      .setFooter({ text: `Season ${season.seasonNumber}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
