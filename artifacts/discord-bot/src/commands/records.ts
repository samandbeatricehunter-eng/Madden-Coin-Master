import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { userRecordsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

// ─── Power Ranking Formula ────────────────────────────────────────────────────
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

function displayName(username: string, team: string | null | undefined): string {
  return team ? `${team}` : username;
}

// ── General channel announcement helper (used by seasonpr/alltimepr for SB announcements) ──
async function announceInGeneral(interaction: ChatInputCommandInteraction, embed: EmbedBuilder) {
  const channelId = process.env["DISCORD_GENERAL_CHANNEL_ID"];
  if (!channelId) {
    console.warn("⚠️  DISCORD_GENERAL_CHANNEL_ID not set — skipping announcement");
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) {
    await (channel as TextChannel).send({ embeds: [embed] }).catch(console.error);
  }
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
      embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📊 Season ${season.seasonNumber} Power Rankings`).setDescription("No games have been recorded yet this season.")],
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
    const postseason = [
      r.playoffWins + r.playoffLosses > 0 ? `PO: ${r.playoffWins}W-${r.playoffLosses}L` : "",
      r.superbowlWins + r.superbowlLosses > 0 ? `SB: ${r.superbowlWins}W-${r.superbowlLosses}L` : "",
    ].filter(Boolean).join(" | ");
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${formatDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}${postseason ? ` *(${postseason})*` : ""}`;
  });

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(`🏈 Season ${season.seasonNumber} Power Rankings`)
        .setDescription(rows.join("\n"))
        .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
        .setTimestamp(),
    ],
  });
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
      embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("📊 All-Time Power Rankings").setDescription("No games have been recorded yet.")],
    });
  }

  const aggregated = new Map<string, {
    username: string; team: string | null;
    wins: number; losses: number; pointDifferential: number;
    playoffWins: number; playoffLosses: number;
    superbowlWins: number; superbowlLosses: number;
  }>();

  for (const rec of allRecords) {
    const ex = aggregated.get(rec.discordId);
    if (ex) {
      ex.wins               += rec.wins;
      ex.losses             += rec.losses;
      ex.pointDifferential  += rec.pointDifferential;
      ex.playoffWins        += rec.playoffWins;
      ex.playoffLosses      += rec.playoffLosses;
      ex.superbowlWins      += rec.superbowlWins;
      ex.superbowlLosses    += rec.superbowlLosses;
      ex.username = rec.discordUsername;
      if (rec.team) ex.team = rec.team;
    } else {
      aggregated.set(rec.discordId, {
        username: rec.discordUsername,
        team: rec.team ?? null,
        wins: rec.wins,
        losses: rec.losses,
        pointDifferential: rec.pointDifferential,
        playoffWins: rec.playoffWins,
        playoffLosses: rec.playoffLosses,
        superbowlWins: rec.superbowlWins,
        superbowlLosses: rec.superbowlLosses,
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
    const postseason = [
      r.playoffWins + r.playoffLosses > 0 ? `PO: ${r.playoffWins}W-${r.playoffLosses}L` : "",
      r.superbowlWins + r.superbowlLosses > 0 ? `🏆SB: ${r.superbowlWins}W-${r.superbowlLosses}L` : "",
    ].filter(Boolean).join(" | ");
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${formatDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}${postseason ? ` *(${postseason})*` : ""}`;
  });

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Purple)
        .setTitle("🏆 All-Time Power Rankings")
        .setDescription(rows.join("\n"))
        .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
        .setTimestamp(),
    ],
  });
}
