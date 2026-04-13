import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, franchiseMcaTeamsTable, usersTable } from "@workspace/db";
import { eq, and, or, asc, sql } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason, getRosterSeasonId } from "../lib/db-helpers.js";
import { requireMcaEnabled } from "../lib/server-settings.js";

const MIN_COMPLETED_STATUS = 2;

export const data = new SlashCommandBuilder()
  .setName("seasonschedule")
  .setDescription("View your full season schedule — only visible to you");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!await requireMcaEnabled(interaction)) return;

  const user = await getOrCreateUser(interaction.user.id, interaction.user.username);

  if (!user.team) {
    await interaction.editReply({
      content: "❌ You don't have a registered team. Ask the commissioner to set you up with `/admin-setuser`.",
    });
    return;
  }

  const season         = await getOrCreateActiveSeason();
  const rosterSeasonId = await getRosterSeasonId();

  // ── Resolve the user's schedule team name from franchise_mca_teams ──────────
  // MCA full names (e.g. "Chicago Bears") match what's stored in franchise_schedule.
  // Fall back to economy_users.team if no MCA entry exists.
  const [mcaEntry] = await db
    .select({ fullName: franchiseMcaTeamsTable.fullName, nickName: franchiseMcaTeamsTable.nickName })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId,  rosterSeasonId),
      eq(franchiseMcaTeamsTable.discordId, interaction.user.id),
    ))
    .limit(1);

  // Names to try — MCA fullName first, then nickName, then economy short name
  const candidateNames: string[] = [];
  if (mcaEntry?.fullName) candidateNames.push(mcaEntry.fullName.toLowerCase().trim());
  if (mcaEntry?.nickName) candidateNames.push(mcaEntry.nickName.toLowerCase().trim());
  if (user.team)          candidateNames.push(user.team.toLowerCase().trim());

  // Deduplicate
  const uniqueNames = [...new Set(candidateNames)];

  // Build an OR condition: lower(home) = name1 OR lower(away) = name1 OR lower(home) = name2 ...
  const nameConditions = uniqueNames.flatMap(name => [
    sql`lower(${franchiseScheduleTable.homeTeamName}) = ${name}`,
    sql`lower(${franchiseScheduleTable.awayTeamName}) = ${name}`,
  ]);

  const allGames = await db
    .select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, season.id),
      or(...nameConditions),
    ))
    .orderBy(asc(franchiseScheduleTable.weekIndex));

  // ── Filter to regular season weeks (0–17) ───────────────────────────────────
  const regularGames = allGames.filter(g => g.weekIndex >= 0 && g.weekIndex <= 17);

  if (regularGames.length === 0) {
    const teamDisplay = mcaEntry?.fullName ?? user.team;
    await interaction.editReply({
      content: `📭 No schedule data found for **${teamDisplay}** in Season ${season.seasonNumber}. Make sure the full season schedule has been imported via \`/franchiseupdate\`.`,
    });
    return;
  }

  // Determine the team name as it appears in the schedule (for home/away detection)
  const scheduleTeamName = regularGames[0]
    ? (uniqueNames.find(n =>
        regularGames[0]!.homeTeamName.toLowerCase().trim() === n ||
        regularGames[0]!.awayTeamName.toLowerCase().trim() === n
      ) ?? uniqueNames[0]!)
    : uniqueNames[0]!;

  const played = regularGames.filter(g => g.status >= MIN_COMPLETED_STATUS).length;

  const lines = regularGames.map(g => {
    const isHome   = g.homeTeamName.toLowerCase().trim() === scheduleTeamName;
    const opponent = isHome ? g.awayTeamName : g.homeTeamName;
    const location = isHome ? "vs" : "@";
    const myScore  = isHome ? g.homeScore : g.awayScore;
    const oppScore = isHome ? g.awayScore : g.homeScore;
    const weekNum  = g.weekIndex + 1;

    if (g.status >= MIN_COMPLETED_STATUS && myScore !== null && oppScore !== null) {
      const tied  = myScore === oppScore;
      const won   = myScore > oppScore;
      const label = tied ? "T" : (won ? "W" : "L");
      const emoji = tied ? "🤝" : (won ? "✅" : "❌");
      return `**Wk ${weekNum}** ${location} ${opponent} — ${emoji} **${label}** (${myScore}–${oppScore})`;
    }
    return `**Wk ${weekNum}** ${location} ${opponent} — ⏳ Upcoming`;
  });

  const description  = lines.join("\n");
  const displayName  = mcaEntry?.fullName ?? user.team ?? "Your Team";

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`📅 ${displayName} — Season ${season.seasonNumber} Schedule`)
        .setDescription(description.length > 4000 ? description.slice(0, 3997) + "..." : description)
        .setFooter({ text: `${played} of ${regularGames.length} games played` })
        .setTimestamp(),
    ],
  });
}
