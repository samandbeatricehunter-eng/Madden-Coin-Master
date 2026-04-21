import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, TextChannel,
} from "discord.js";
import { getOrCreateActiveSeason, getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";
import { getSeasonRecords, getAllTimeRecords } from "../lib/gcs-fallback.js";
import { requireMcaEnabled } from "../lib/server-settings.js";

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

/** Season PR — team-first since each slot has one owner per season */
function seasonDisplayName(username: string, team: string | null | undefined): string {
  return team ? `${team}` : username;
}

/** All-time PR — username is primary; team shown as context to avoid duplicate-looking rows */
function allTimeDisplayName(username: string, team: string | null | undefined): string {
  return team ? `${username} (${team})` : username;
}

// ── General channel announcement helper (used by seasonpr/alltimepr for SB announcements) ──
async function announceInGeneral(interaction: ChatInputCommandInteraction, embed: EmbedBuilder) {
  const channelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.GENERAL) ?? process.env["DISCORD_GENERAL_CHANNEL_ID"];
  if (!channelId) {
    console.warn("⚠️  No general channel configured — skipping announcement");
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
  if (!await requireMcaEnabled(interaction)) return;

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const { records, source } = await getSeasonRecords(season.id);

  if (records.length === 0) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`📊 Season ${season.seasonNumber} Power Rankings`)
        .setDescription("No game records found yet this season.\n\nExport data from the Madden Companion App to populate this.")],
    });
  }

  const ranked = records.map(r => ({
    ...r,
    gamesPlayed: r.wins + r.losses,
    prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
    label: seasonDisplayName(r.discordUsername, r.team),
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

  const footerParts = ["PR Score = 60% × (W-L Diff) + 40% × (Point Diff)"];
  if (source === "gcs") footerParts.push("⚡ Data pulled from latest MCA export");

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(`🏈 Season ${season.seasonNumber} Power Rankings`)
        .setDescription(rows.join("\n"))
        .setFooter({ text: footerParts.join(" • ") })
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
  if (!await requireMcaEnabled(interaction)) return;

  const { records, source } = await getAllTimeRecords();

  if (records.length === 0) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle("📊 All-Time Power Rankings")
        .setDescription("No game records found yet.\n\nExport data from the Madden Companion App to populate this.")],
    });
  }

  const ranked = records.map(r => ({
    ...r,
    gamesPlayed: r.wins + r.losses,
    prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
    label: allTimeDisplayName(r.discordUsername, r.team),
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

  const footerParts = ["PR Score = 60% × (W-L Diff) + 40% × (Point Diff)"];
  if (source === "gcs") footerParts.push("⚡ Data pulled from latest MCA export");

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Purple)
        .setTitle("🏆 All-Time Power Rankings")
        .setDescription(rows.join("\n"))
        .setFooter({ text: footerParts.join(" • ") })
        .setTimestamp(),
    ],
  });
}
