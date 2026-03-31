import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, usersTable, seasonsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

const COMPLETED_STATUS = 2;

export const data = new SlashCommandBuilder()
  .setName("weeklymatchups")
  .setDescription("Admin: post this week's matchups (or results) publicly to the channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  // ── Get active season ──────────────────────────────────────────────────────
  const [season] = await db.select()
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found. Start a season first." });
    return;
  }

  const currentWeekStr = season.currentWeek ?? "1";
  const currentWeekNum = parseInt(currentWeekStr, 10);
  if (isNaN(currentWeekNum) || currentWeekNum < 1 || currentWeekNum > 18) {
    await interaction.editReply({
      content: `⚠️ The league is set to **${currentWeekStr}** which is not a regular-season week. Set the week with \`/advanceweek\` first.`,
    });
    return;
  }

  const weekIndex = currentWeekNum - 1; // schedule uses 0-based weekIndex

  // ── Fetch all games for this week ──────────────────────────────────────────
  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  season.id),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ))
    .orderBy(asc(franchiseScheduleTable.id));

  if (games.length === 0) {
    await interaction.editReply({
      content: `📭 No matchups found for Week ${currentWeekNum}. Run \`/franchiseupdate\` first to import the schedule.`,
    });
    return;
  }

  // ── Build team name (lowercase) → discordId lookup ────────────────────────
  const allUsers = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  }).from(usersTable);

  const teamToDiscord = new Map<string, string>();
  for (const u of allUsers) {
    if (u.team) teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
  }

  function mention(teamName: string): string {
    const discordId = teamToDiscord.get(teamName.toLowerCase().trim());
    return discordId ? `<@${discordId}>` : `**${teamName}**`;
  }

  // ── Format each game ───────────────────────────────────────────────────────
  const lines: string[] = [];

  for (const g of games) {
    const awayMention = mention(g.awayTeamName);
    const homeMention = mention(g.homeTeamName);

    if (g.status === COMPLETED_STATUS && g.homeScore != null && g.awayScore != null) {
      const hs = g.homeScore;
      const as_ = g.awayScore;
      const tied     = hs === as_;
      const homeWon  = hs > as_;

      let resultLine: string;
      if (tied) {
        resultLine = `🤝 ${awayMention} **${as_}** — **${hs}** ${homeMention} *(Tie)*`;
      } else if (homeWon) {
        resultLine = `🏆 ${awayMention} ${as_} — **${hs}** ${homeMention} ✅`;
      } else {
        resultLine = `🏆 ${awayMention} **${as_}** — ${hs} ${homeMention} ✅`;
      }
      lines.push(resultLine);
    } else {
      // Upcoming or in progress
      lines.push(`📅 ${awayMention} @ ${homeMention}`);
    }
  }

  const played   = games.filter(g => g.status === COMPLETED_STATUS).length;
  const upcoming = games.length - played;
  const footerParts: string[] = [];
  if (played > 0)   footerParts.push(`${played} game${played > 1 ? "s" : ""} played`);
  if (upcoming > 0) footerParts.push(`${upcoming} upcoming`);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(played === games.length ? Colors.Green : Colors.Blue)
        .setTitle(`🏈 Week ${currentWeekNum} Matchups — Season ${season.seasonNumber}`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: footerParts.join(" · ") || "No games" })
        .setTimestamp(),
    ],
  });
}
