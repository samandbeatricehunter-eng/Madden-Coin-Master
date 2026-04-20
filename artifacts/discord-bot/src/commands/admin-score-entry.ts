/**
 * /admin-score-entry
 *
 * Commissioner tool to manually enter or inspect game scores for weeks that
 * are missing score data in franchise_schedule.
 *
 * Subcommands:
 *   list  week:<1–18>   → show all games + current scores for that week
 *   set   week:<1–18> home_team:<partial> home_score:<int> away_score:<int>
 *         → find the game whose homeTeamName matches the partial string,
 *           update both scores, and confirm what was changed
 *
 * After entering all missing scores, run /admin-troubleshoot → Repair User
 * Records to rebuild W/L from the updated data.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, seasonsTable } from "@workspace/db";
import { eq, and, isNotNull, sql } from "drizzle-orm";

import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-score-entry")
  .setDescription("Commissioner: View or manually enter game scores for a specific week")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub
      .setName("list")
      .setDescription("Show all scheduled games for a week and their current scores")
      .addIntegerOption(opt =>
        opt
          .setName("week")
          .setDescription("Week number (1–18)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(18),
      ),
  )
  .addSubcommand(sub =>
    sub
      .setName("set")
      .setDescription("Manually set the score for a game (matched by home team name)")
      .addIntegerOption(opt =>
        opt
          .setName("week")
          .setDescription("Week number (1–18)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(18),
      )
      .addStringOption(opt =>
        opt
          .setName("home_team")
          .setDescription("Part of the home team's name (e.g. 'Niners', 'Cowboys', 'Chiefs')")
          .setRequired(true),
      )
      .addIntegerOption(opt =>
        opt
          .setName("home_score")
          .setDescription("Home team final score")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(120),
      )
      .addIntegerOption(opt =>
        opt
          .setName("away_score")
          .setDescription("Away team final score")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(120),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
    await interaction.editReply({ content: "❌ Commissioner access required." });
    return;
  }

  const guildId = interaction.guildId!;
  const sub     = interaction.options.getSubcommand();

  // ── Resolve active season ────────────────────────────────────────────────
  const [season] = await db
    .select({ id: seasonsTable.id, seasonNumber: seasonsTable.seasonNumber })
    .from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found for this server." });
    return;
  }

  const weekNum   = interaction.options.getInteger("week", true);
  const weekIndex = weekNum - 1; // franchise_schedule uses 0-based index

  // ── Subcommand: list ──────────────────────────────────────────────────────
  if (sub === "list") {
    const games = await db
      .select({
        id:           franchiseScheduleTable.id,
        homeTeamName: franchiseScheduleTable.homeTeamName,
        awayTeamName: franchiseScheduleTable.awayTeamName,
        homeScore:    franchiseScheduleTable.homeScore,
        awayScore:    franchiseScheduleTable.awayScore,
      })
      .from(franchiseScheduleTable)
      .where(
        and(
          eq(franchiseScheduleTable.seasonId,  season.id),
          eq(franchiseScheduleTable.weekIndex, weekIndex),
        ),
      )
      .orderBy(franchiseScheduleTable.homeTeamName);

    if (games.length === 0) {
      await interaction.editReply({
        content: `❌ No games found for Season ${season.seasonNumber} Week ${weekNum}. The schedule may not have been imported yet.`,
      });
      return;
    }

    const scored   = games.filter(g => g.homeScore !== null && g.awayScore !== null);
    const unscored = games.filter(g => g.homeScore === null || g.awayScore === null);

    const lines: string[] = [];

    if (scored.length > 0) {
      lines.push("**✅ Games with scores:**");
      for (const g of scored) {
        lines.push(`• **${g.homeTeamName}** ${g.homeScore} – ${g.awayScore} **${g.awayTeamName}**`);
      }
    }

    if (unscored.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("**❌ Missing scores (use `/admin-score-entry set`):**");
      for (const g of unscored) {
        lines.push(`• **${g.homeTeamName}** vs **${g.awayTeamName}**`);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(unscored.length === 0 ? Colors.Green : Colors.Orange)
      .setTitle(`📅 Season ${season.seasonNumber} — Week ${weekNum} Games`)
      .setDescription(lines.join("\n") || "No games found.")
      .setFooter({
        text: `${scored.length}/${games.length} games scored · use /admin-score-entry set to fill in missing scores`,
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Subcommand: set ───────────────────────────────────────────────────────
  if (sub === "set") {
    const homeTeamPartial = interaction.options.getString("home_team", true).trim();
    const homeScore       = interaction.options.getInteger("home_score", true);
    const awayScore       = interaction.options.getInteger("away_score", true);

    // Load all games for this week so we can do a case-insensitive partial match
    const games = await db
      .select({
        id:           franchiseScheduleTable.id,
        homeTeamName: franchiseScheduleTable.homeTeamName,
        awayTeamName: franchiseScheduleTable.awayTeamName,
        homeScore:    franchiseScheduleTable.homeScore,
        awayScore:    franchiseScheduleTable.awayScore,
      })
      .from(franchiseScheduleTable)
      .where(
        and(
          eq(franchiseScheduleTable.seasonId,  season.id),
          eq(franchiseScheduleTable.weekIndex, weekIndex),
        ),
      );

    if (games.length === 0) {
      await interaction.editReply({
        content: `❌ No games found for Season ${season.seasonNumber} Week ${weekNum}. The schedule may not have been imported yet.`,
      });
      return;
    }

    // Case-insensitive partial match on homeTeamName
    const needle  = homeTeamPartial.toLowerCase();
    const matches = games.filter(g => g.homeTeamName.toLowerCase().includes(needle));

    if (matches.length === 0) {
      const teamList = games.map(g => `• ${g.homeTeamName}`).join("\n");
      await interaction.editReply({
        content:
          `❌ No home team matched **"${homeTeamPartial}"** in Week ${weekNum}.\n\n` +
          `**Home teams in Week ${weekNum}:**\n${teamList}`,
      });
      return;
    }

    if (matches.length > 1) {
      const matchList = matches.map(g => `• ${g.homeTeamName} vs ${g.awayTeamName}`).join("\n");
      await interaction.editReply({
        content:
          `⚠️ Multiple games matched **"${homeTeamPartial}"** — be more specific:\n\n${matchList}`,
      });
      return;
    }

    const game      = matches[0]!;
    const prevHome  = game.homeScore;
    const prevAway  = game.awayScore;

    // Update the score
    await db
      .update(franchiseScheduleTable)
      .set({ homeScore, awayScore })
      .where(eq(franchiseScheduleTable.id, game.id));

    const prevStr =
      prevHome !== null && prevAway !== null
        ? `${prevHome}–${prevAway}`
        : "no score";

    const winner =
      homeScore > awayScore
        ? `🏆 ${game.homeTeamName} win`
        : homeScore < awayScore
          ? `🏆 ${game.awayTeamName} win`
          : "Tie";

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Game Score Updated")
      .addFields(
        { name: "Week",      value: `Season ${season.seasonNumber} · Week ${weekNum}`, inline: true },
        { name: "Matchup",   value: `${game.homeTeamName} vs ${game.awayTeamName}`,    inline: true },
        { name: "New Score", value: `**${game.homeTeamName}** ${homeScore} – ${awayScore} **${game.awayTeamName}**`, inline: false },
        { name: "Result",    value: winner,  inline: true },
        { name: "Previous",  value: prevStr, inline: true },
      )
      .setDescription(
        "Score saved to the schedule. Once all missing scores are entered, " +
        "run `/admin-troubleshoot` → **🔩 Repair User Records** to rebuild W/L records.",
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
