import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { userRecordsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

// ─── Power Ranking Formula ────────────────────────────────────────────────────
// PR Score = 60% × (Win-Loss Differential) + 40% × (Point Differential)
function calcPRScore(wins: number, losses: number, pointDiff: number): number {
  return 0.6 * (wins - losses) + 0.4 * pointDiff;
}

function formatDiff(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/** Return "Team Name" if set, else "@username" */
function displayName(username: string, team: string | null | undefined): string {
  return team ? `${team}` : username;
}

// ── Shared autocomplete helper ─────────────────────────────────────────────────
export async function autocompleteUpdateRecord(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused();
  const query = focused.toLowerCase();
  const results = NFL_TEAMS
    .filter(t => t.toLowerCase().startsWith(query))
    .slice(0, 25)
    .map(t => ({ name: t, value: t }));
  await interaction.respond(results);
}

// ── /updaterecord ──────────────────────────────────────────────────────────────
export const updateRecordData = new SlashCommandBuilder()
  .setName("updaterecord")
  .setDescription("Commissioner: Update a player's win/loss record for the current season")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
      .setDescription("Points scored margin (positive = won by this many, negative = lost by this many)")
      .setRequired(true)
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("The player (or use team name below)").setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("NFL team name (alternative to @user)")
      .setRequired(false)
      .setAutocomplete(true)
  );

export async function executeUpdateRecord(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user");
  const teamName = interaction.options.getString("team")?.trim();
  const result = interaction.options.getString("result", true) as "win" | "loss";
  const spread = interaction.options.getInteger("point_spread", true);

  if (!targetUser && !teamName) {
    return interaction.editReply({ content: "❌ Please provide either a **@user** or a **team** name." });
  }

  let discordId: string;
  let username: string;
  let team: string | null = null;

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) {
      return interaction.editReply({ content: `❌ No user found for team **${teamName}**.` });
    }
    discordId = found.discordId;
    username = found.discordUsername;
    team = found.team ?? null;
  } else {
    discordId = targetUser!.id;
    username = targetUser!.username;
    await getOrCreateUser(discordId, username);
    const row = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
    team = row[0]?.team ?? null;
  }

  const season = await getOrCreateActiveSeason();

  const existing = await db.select().from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userRecordsTable).set({
      wins: result === "win" ? sql`${userRecordsTable.wins} + 1` : userRecordsTable.wins,
      losses: result === "loss" ? sql`${userRecordsTable.losses} + 1` : userRecordsTable.losses,
      pointDifferential: sql`${userRecordsTable.pointDifferential} + ${spread}`,
      discordUsername: username,
      team: team ?? undefined,
      updatedAt: new Date(),
    }).where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)));
  } else {
    await db.insert(userRecordsTable).values({
      discordId,
      discordUsername: username,
      team: team ?? undefined,
      seasonId: season.id,
      wins: result === "win" ? 1 : 0,
      losses: result === "loss" ? 1 : 0,
      pointDifferential: spread,
    });
  }

  const updated = await db.select().from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
    .limit(1);
  const rec = updated[0]!;
  const label = displayName(username, team);

  const embed = new EmbedBuilder()
    .setColor(result === "win" ? Colors.Green : Colors.Red)
    .setTitle(`${result === "win" ? "✅ Win" : "❌ Loss"} Recorded — ${label}`)
    .addFields(
      { name: "Result", value: result === "win" ? "Win" : "Loss", inline: true },
      { name: "Spread", value: formatDiff(spread), inline: true },
      { name: "Season Record", value: `**${rec.wins}W - ${rec.losses}L** (${formatDiff(rec.pointDifferential)} pts)`, inline: false },
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ── /seasonpr ──────────────────────────────────────────────────────────────────
export const seasonPRData = new SlashCommandBuilder()
  .setName("seasonpr")
  .setDescription("View the current season power rankings for the full league");

export async function executeSeasonPR(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const season = await getOrCreateActiveSeason();
  const records = await db.select().from(userRecordsTable).where(eq(userRecordsTable.seasonId, season.id));

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

  const ranked = records.map(r => ({
    ...r,
    gamesPlayed: r.wins + r.losses,
    prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
    label: displayName(r.discordUsername, r.team),
  })).sort((a, b) => b.prScore - a.prScore);

  const medals = ["🥇", "🥈", "🥉"];
  const rows = ranked.map((r, i) => {
    const badge = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gamesPlayed > 0 ? ((r.wins / r.gamesPlayed) * 100).toFixed(1) : "0.0";
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${formatDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🏈 Season ${season.seasonNumber} Power Rankings`)
    .setDescription(rows.join("\n"))
    .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ── /alltimepr ─────────────────────────────────────────────────────────────────
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

  // Aggregate per discordId using the most recent team/username
  const aggregated = new Map<string, {
    username: string; team: string | null; wins: number; losses: number; pointDifferential: number;
  }>();

  for (const rec of allRecords) {
    const ex = aggregated.get(rec.discordId);
    if (ex) {
      ex.wins += rec.wins;
      ex.losses += rec.losses;
      ex.pointDifferential += rec.pointDifferential;
      ex.username = rec.discordUsername;
      if (rec.team) ex.team = rec.team;
    } else {
      aggregated.set(rec.discordId, {
        username: rec.discordUsername,
        team: rec.team ?? null,
        wins: rec.wins,
        losses: rec.losses,
        pointDifferential: rec.pointDifferential,
      });
    }
  }

  const ranked = Array.from(aggregated.values()).map(r => ({
    ...r,
    gamesPlayed: r.wins + r.losses,
    prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
    label: displayName(r.username, r.team),
  })).sort((a, b) => b.prScore - a.prScore);

  const medals = ["🥇", "🥈", "🥉"];
  const rows = ranked.map((r, i) => {
    const badge = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gamesPlayed > 0 ? ((r.wins / r.gamesPlayed) * 100).toFixed(1) : "0.0";
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${formatDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle("🏆 All-Time Power Rankings")
    .setDescription(rows.join("\n"))
    .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}
