import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { userRecordsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

// ─── Power Ranking Formula ───────────────────────────────────────────────────
// PR Score = (Wins × 3) + (Point Differential × 0.1) - (Losses × 1)
// Higher is better. Swap this out when the user provides their formula.
function calcPRScore(wins: number, losses: number, pointDiff: number): number {
  return wins * 3 + pointDiff * 0.1 - losses * 1;
}

function formatDiff(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

// ── /updaterecord ─────────────────────────────────────────────────────────────
export const updateRecordData = new SlashCommandBuilder()
  .setName("updaterecord")
  .setDescription("Commissioner: Update a player's win/loss record for the current season")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(opt =>
    opt.setName("user").setDescription("The player to update").setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("result")
      .setDescription("Win or Loss?")
      .setRequired(true)
      .addChoices(
        { name: "Win", value: "win" },
        { name: "Loss", value: "loss" },
      )
  )
  .addIntegerOption(opt =>
    opt.setName("point_spread")
      .setDescription("Point differential for this game (positive = won by this, negative = lost by this)")
      .setRequired(true)
  );

export async function executeUpdateRecord(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user", true);
  const result = interaction.options.getString("result", true) as "win" | "loss";
  const spread = interaction.options.getInteger("point_spread", true);

  await getOrCreateUser(target.id, target.username);
  const season = await getOrCreateActiveSeason();

  // Upsert season record
  const existing = await db.select().from(userRecordsTable)
    .where(and(
      eq(userRecordsTable.discordId, target.id),
      eq(userRecordsTable.seasonId, season.id),
    )).limit(1);

  if (existing.length > 0) {
    await db.update(userRecordsTable)
      .set({
        wins: result === "win" ? sql`${userRecordsTable.wins} + 1` : userRecordsTable.wins,
        losses: result === "loss" ? sql`${userRecordsTable.losses} + 1` : userRecordsTable.losses,
        pointDifferential: sql`${userRecordsTable.pointDifferential} + ${spread}`,
        discordUsername: target.username,
        updatedAt: new Date(),
      })
      .where(and(
        eq(userRecordsTable.discordId, target.id),
        eq(userRecordsTable.seasonId, season.id),
      ));
  } else {
    await db.insert(userRecordsTable).values({
      discordId: target.id,
      discordUsername: target.username,
      seasonId: season.id,
      wins: result === "win" ? 1 : 0,
      losses: result === "loss" ? 1 : 0,
      pointDifferential: spread,
    });
  }

  const updated = await db.select().from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, target.id), eq(userRecordsTable.seasonId, season.id)))
    .limit(1);
  const rec = updated[0]!;

  const embed = new EmbedBuilder()
    .setColor(result === "win" ? Colors.Green : Colors.Red)
    .setTitle(`${result === "win" ? "✅ Win" : "❌ Loss"} Recorded — ${target.username}`)
    .addFields(
      { name: "Result", value: result === "win" ? "Win" : "Loss", inline: true },
      { name: "Spread", value: formatDiff(spread), inline: true },
      { name: "Season Record", value: `**${rec.wins}W - ${rec.losses}L** (${formatDiff(rec.pointDifferential)} pts)`, inline: false },
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ── /seasonpr ─────────────────────────────────────────────────────────────────
export const seasonPRData = new SlashCommandBuilder()
  .setName("seasonpr")
  .setDescription("View the current season power rankings for the full league");

export async function executeSeasonPR(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const season = await getOrCreateActiveSeason();

  const records = await db.select().from(userRecordsTable)
    .where(eq(userRecordsTable.seasonId, season.id));

  if (records.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Blue)
          .setTitle(`📊 Season ${season.seasonNumber} Power Rankings`)
          .setDescription("No games have been recorded yet this season."),
      ],
    });
  }

  // Rank by PR score
  const ranked = records
    .map(r => ({
      ...r,
      gamesPlayed: r.wins + r.losses,
      prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
    }))
    .sort((a, b) => b.prScore - a.prScore);

  const medals = ["🥇", "🥈", "🥉"];

  const rows = ranked.map((r, i) => {
    const medal = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gamesPlayed > 0 ? ((r.wins / r.gamesPlayed) * 100).toFixed(1) : "0.0";
    return `${medal} **${r.discordUsername}** — ${r.wins}W-${r.losses}L | ${formatDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🏈 Season ${season.seasonNumber} Power Rankings`)
    .setDescription(rows.join("\n"))
    .setFooter({ text: "PR Score = (Wins × 3) + (Point Diff × 0.1) − (Losses × 1)" })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ── /alltimepr ────────────────────────────────────────────────────────────────
export const allTimePRData = new SlashCommandBuilder()
  .setName("alltimepr")
  .setDescription("View all-time records and power rankings across all seasons");

export async function executeAllTimePR(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const allRecords = await db.select().from(userRecordsTable);

  if (allRecords.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Blue)
          .setTitle("📊 All-Time Power Rankings")
          .setDescription("No games have been recorded yet."),
      ],
    });
  }

  // Aggregate by player
  const aggregated = new Map<string, { username: string; wins: number; losses: number; pointDifferential: number }>();
  for (const rec of allRecords) {
    const existing = aggregated.get(rec.discordId);
    if (existing) {
      existing.wins += rec.wins;
      existing.losses += rec.losses;
      existing.pointDifferential += rec.pointDifferential;
      existing.username = rec.discordUsername; // use latest username
    } else {
      aggregated.set(rec.discordId, {
        username: rec.discordUsername,
        wins: rec.wins,
        losses: rec.losses,
        pointDifferential: rec.pointDifferential,
      });
    }
  }

  const ranked = Array.from(aggregated.entries())
    .map(([discordId, r]) => ({
      discordId,
      ...r,
      gamesPlayed: r.wins + r.losses,
      prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
    }))
    .sort((a, b) => b.prScore - a.prScore);

  const medals = ["🥇", "🥈", "🥉"];

  const rows = ranked.map((r, i) => {
    const medal = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gamesPlayed > 0 ? ((r.wins / r.gamesPlayed) * 100).toFixed(1) : "0.0";
    return `${medal} **${r.username}** — ${r.wins}W-${r.losses}L | ${formatDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle("🏆 All-Time Power Rankings")
    .setDescription(rows.join("\n"))
    .setFooter({ text: "PR Score = (Wins × 3) + (Point Diff × 0.1) − (Losses × 1)" })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}
