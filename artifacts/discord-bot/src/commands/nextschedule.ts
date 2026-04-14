import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, usersTable, franchiseMcaTeamsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { WEEK_SEQUENCE, weekLabel } from "./advanceweek.js";
import { PLAYOFF_WEEK_META } from "../lib/playoff-matchups-runner.js";

const MIN_COMPLETED_STATUS = 2;

// Compute the DB weekIndex for a given week key.
// Regular-season weeks use 0-based continuous index (week 1 → 0, week 18 → 17).
// Playoff weeks use 1000-offset (1000 + rawWeekIdx where rawWeekIdx is continuous).
function weekIndexFor(weekKey: string): number | null {
  const num = parseInt(weekKey, 10);
  if (!isNaN(num) && num >= 1 && num <= 18) return num - 1;          // reg season
  const meta = PLAYOFF_WEEK_META[weekKey];
  return meta ? meta.weekIndex : null;                                 // 1018/1019/1020/1022
}

function weekDisplayLabel(weekKey: string): string {
  if (weekKey === "wildcard")   return "Wild Card";
  if (weekKey === "divisional") return "Divisional Round";
  if (weekKey === "conference") return "Conference Championship";
  if (weekKey === "superbowl")  return "Super Bowl";
  return weekLabel(weekKey);
}

export const data = new SlashCommandBuilder()
  .setName("nextschedule")
  .setDescription("Show the upcoming week's matchups pulled from the Madden import");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  // ── Determine next week ─────────────────────────────────────────────────────
  const currentWeek = season.currentWeek ?? "1";
  const currentIdx  = WEEK_SEQUENCE.indexOf(currentWeek);

  // Nothing to show if we're at offseason/training camp or off the sequence
  if (currentWeek === "offseason" || currentWeek === "training_camp" || currentIdx === -1) {
    const label = currentWeek === "training_camp" ? "Training Camp" : "off-season";
    await interaction.editReply({
      content: `📭 The league is currently in ${label}. No upcoming schedule to show.`,
    });
    return;
  }

  const nextWeek = WEEK_SEQUENCE[currentIdx + 1];
  if (!nextWeek || nextWeek === "offseason" || nextWeek === "training_camp") {
    await interaction.editReply({
      content: "📭 There are no more weeks after the current one. The season has concluded.",
    });
    return;
  }

  const weekIndex = weekIndexFor(nextWeek);
  if (weekIndex === null) {
    await interaction.editReply({ content: `❌ Cannot compute week index for \`${nextWeek}\`.` });
    return;
  }

  // ── Query schedule ───────────────────────────────────────────────────────────
  let games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ))
    .orderBy(asc(franchiseScheduleTable.id));

  // Fallback: playoff weeks might be stored without the 1000-offset if MCA
  // sent weekType=1 for all games. Try the raw weekIndex (weekIndex % 1000).
  if (games.length === 0 && weekIndex >= 1000) {
    const rawIdx = weekIndex - 1000;
    games = await db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId, season.id),
        eq(franchiseScheduleTable.weekIndex, rawIdx),
      ))
      .orderBy(asc(franchiseScheduleTable.id));
  }

  if (games.length === 0) {
    const hint = weekIndex >= 1000
      ? `\n\nNo schedule data found for **${weekDisplayLabel(nextWeek)}** (weekIndex ${weekIndex}). Make sure the EA playoff schedule export has been imported via \`/franchiseupdate\` before advancing.`
      : `\n\nNo schedule data found for **${weekDisplayLabel(nextWeek)}**. Make sure the full season schedule has been imported via \`/franchiseupdate\`.`;
    await interaction.editReply({ content: `📭 ${hint}` });
    return;
  }

  // ── Build team → Discord mention map ────────────────────────────────────────
  const allUsers = await db.select({ discordId: usersTable.discordId, team: usersTable.team }).from(usersTable)
    .where(eq(usersTable.guildId, interaction.guildId!));
  const mcaTeams = await db.select({ discordId: franchiseMcaTeamsTable.discordId, fullName: franchiseMcaTeamsTable.fullName })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id));

  const teamToDiscord = new Map<string, string>();
  for (const t of mcaTeams) {
    if (t.discordId) teamToDiscord.set(t.fullName.toLowerCase().trim(), t.discordId);
  }
  for (const u of allUsers) {
    if (u.team && !teamToDiscord.has(u.team.toLowerCase().trim())) {
      teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
    }
  }

  function mention(teamName: string): string {
    const id = teamToDiscord.get(teamName.toLowerCase().trim());
    return id ? `<@${id}>` : `**${teamName}**`;
  }

  // ── Build embed lines ────────────────────────────────────────────────────────
  const lines: string[] = [];

  for (const g of games) {
    const awayM = mention(g.awayTeamName);
    const homeM = mention(g.homeTeamName);

    if (g.status >= MIN_COMPLETED_STATUS && g.homeScore != null && g.awayScore != null) {
      const hs = g.homeScore, as_ = g.awayScore;
      if (hs === as_) {
        lines.push(`🤝 ${awayM} **${as_}** — **${hs}** ${homeM} *(Tie)*`);
      } else if (hs > as_) {
        lines.push(`🏆 ${awayM} ${as_} — **${hs}** ${homeM} ✅`);
      } else {
        lines.push(`🏆 ${awayM} **${as_}** — ${hs} ${homeM} ✅`);
      }
    } else {
      lines.push(`📅 ${awayM} @ ${homeM}`);
    }
  }

  const isPlayoff  = weekIndex >= 1000;
  const color      = isPlayoff ? Colors.Gold : Colors.Blue;
  const titleEmoji = isPlayoff ? "🏆" : "📅";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${titleEmoji} ${weekDisplayLabel(nextWeek)} Matchups — Season ${season.seasonNumber}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Current week: ${weekDisplayLabel(currentWeek)} • Next: ${weekDisplayLabel(nextWeek)}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
