import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable, usersTable, seasonsTable,
  teamSeasonStatsTable, gotwHistoryTable, userRecordsTable,
} from "@workspace/db";
import { eq, and, asc, inArray, lt, gte } from "drizzle-orm";

const MATCHUPS_CHANNEL_ID = "1478777175128932463";

const MIN_COMPLETED_STATUS = 2; // Madden: 1=upcoming, 2=CPU-completed, 3=H2H-completed
const GOTW_COOLDOWN_WEEKS = 4;  // users who were in GOTW within last 4 weeks are excluded

export const data = new SlashCommandBuilder()
  .setName("weeklymatchups")
  .setDescription("Admin: post this week's matchups (or results) publicly to the channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

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
  const discordToTeam = new Map<string, string>();
  for (const u of allUsers) {
    if (u.team) {
      teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
      discordToTeam.set(u.discordId, u.team);
    }
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

    if (g.status >= MIN_COMPLETED_STATUS && g.homeScore != null && g.awayScore != null) {
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
      lines.push(`📅 ${awayMention} @ ${homeMention}`);
    }
  }

  // ── GOTW Recommendation ────────────────────────────────────────────────────
  let gotwField: { name: string; value: string } | null = null;

  try {
    gotwField = await computeGotwRecommendation(season.id, weekIndex, games, teamToDiscord);
  } catch (err) {
    console.error("[weeklymatchups] GOTW recommendation error:", err);
  }

  // ── Build embed ────────────────────────────────────────────────────────────
  const played   = games.filter(g => g.status >= MIN_COMPLETED_STATUS).length;
  const upcoming = games.length - played;
  const footerParts: string[] = [];
  if (played > 0)   footerParts.push(`${played} game${played > 1 ? "s" : ""} played`);
  if (upcoming > 0) footerParts.push(`${upcoming} upcoming`);

  const embed = new EmbedBuilder()
    .setColor(played === games.length ? Colors.Green : Colors.Blue)
    .setTitle(`🏈 Week ${currentWeekNum} Matchups — Season ${season.seasonNumber}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: footerParts.join(" · ") || "No games" })
    .setTimestamp();

  if (gotwField) {
    embed.addFields(gotwField);
  }

  // ── Post to dedicated matchups channel ─────────────────────────────────────
  const targetChannel = interaction.client.channels.cache.get(MATCHUPS_CHANNEL_ID)
    ?? await interaction.client.channels.fetch(MATCHUPS_CHANNEL_ID).catch(() => null);

  if (!targetChannel || !targetChannel.isTextBased()) {
    await interaction.editReply({
      content: `❌ Could not find or access the matchups channel (\`${MATCHUPS_CHANNEL_ID}\`).`,
    });
    return;
  }

  await (targetChannel as TextChannel).send({ embeds: [embed] });
  await interaction.editReply({ content: `✅ Week ${currentWeekNum} matchups posted to <#${MATCHUPS_CHANNEL_ID}>.` });
}

// ── GOTW recommendation helper ─────────────────────────────────────────────────
async function computeGotwRecommendation(
  seasonId: number,
  weekIndex: number,
  games: any[],
  teamToDiscord: Map<string, string>,
): Promise<{ name: string; value: string } | null> {

  // Find H2H matchups: both teams have registered users
  type H2HGame = {
    awayTeamName: string;
    homeTeamName: string;
    awayDiscordId: string;
    homeDiscordId: string;
  };

  const h2hGames: H2HGame[] = [];
  for (const g of games) {
    const awayId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim());
    const homeId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim());
    if (awayId && homeId) {
      h2hGames.push({
        awayTeamName: g.awayTeamName,
        homeTeamName: g.homeTeamName,
        awayDiscordId: awayId,
        homeDiscordId: homeId,
      });
    }
  }

  if (h2hGames.length === 0) return null;

  // Gather all discordIds involved
  const allDiscordIds = [...new Set(h2hGames.flatMap(g => [g.awayDiscordId, g.homeDiscordId]))];

  // Fetch team season stats (offYds, defYds) for all teams in H2H matchups
  // Match by discordId stored in teamSeasonStatsTable
  const teamStats = await db.select()
    .from(teamSeasonStatsTable)
    .where(and(
      eq(teamSeasonStatsTable.seasonId, seasonId),
      inArray(teamSeasonStatsTable.discordId, allDiscordIds),
    ));

  const statsByDiscord = new Map<string, { offYds: number; defYds: number }>();
  for (const s of teamStats) {
    if (s.discordId) {
      const defYds = (s.defPassYds + s.defRushYds) || 0;
      statsByDiscord.set(s.discordId, { offYds: s.offYds, defYds });
    }
  }

  // Fetch point differentials from userRecordsTable
  const records = await db.select({
    discordId:       userRecordsTable.discordId,
    pointDifferential: userRecordsTable.pointDifferential,
  }).from(userRecordsTable)
    .where(and(
      eq(userRecordsTable.seasonId, seasonId),
      inArray(userRecordsTable.discordId, allDiscordIds),
    ));

  const pdByDiscord = new Map<string, number>();
  for (const r of records) pdByDiscord.set(r.discordId, r.pointDifferential);

  // Check existing GOTW recommendation for this week (don't overwrite)
  const [existing] = await db.select()
    .from(gotwHistoryTable)
    .where(and(
      eq(gotwHistoryTable.seasonId, seasonId),
      eq(gotwHistoryTable.weekIndex, weekIndex),
    ))
    .limit(1);

  // Determine users on cooldown (appeared in GOTW in last GOTW_COOLDOWN_WEEKS weeks)
  const cooldownStart = weekIndex - GOTW_COOLDOWN_WEEKS;
  const onCooldown = new Set<string>();

  if (weekIndex > 0) {
    const recentHistory = await db.select()
      .from(gotwHistoryTable)
      .where(and(
        eq(gotwHistoryTable.seasonId, seasonId),
        gte(gotwHistoryTable.weekIndex, Math.max(0, cooldownStart)),
        lt(gotwHistoryTable.weekIndex, weekIndex),
      ));

    for (const h of recentHistory) {
      onCooldown.add(h.discordId1);
      onCooldown.add(h.discordId2);
    }
  }

  // Compute score for each H2H matchup
  //   Individual score = 0.5 * offYds - 0.25 * defYds + 0.25 * abs(pointDiff)
  //   Matchup score    = sum of both team scores
  type ScoredMatchup = H2HGame & { score: number; eligible: boolean };
  const scored: ScoredMatchup[] = [];

  for (const g of h2hGames) {
    const awayStats = statsByDiscord.get(g.awayDiscordId);
    const homeStats = statsByDiscord.get(g.homeDiscordId);

    // If no stats available yet, use 0s — still show recommendation slot
    const awayOff = awayStats?.offYds ?? 0;
    const awayDef = awayStats?.defYds ?? 0;
    const homeOff = homeStats?.offYds ?? 0;
    const homeDef = homeStats?.defYds ?? 0;

    const awayPD = Math.abs(pdByDiscord.get(g.awayDiscordId) ?? 0);
    const homePD = Math.abs(pdByDiscord.get(g.homeDiscordId) ?? 0);

    const awayScore = 0.5 * awayOff - 0.25 * awayDef + 0.25 * awayPD;
    const homeScore = 0.5 * homeOff - 0.25 * homeDef + 0.25 * homePD;
    const combinedScore = awayScore + homeScore;

    const eligible =
      !onCooldown.has(g.awayDiscordId) &&
      !onCooldown.has(g.homeDiscordId);

    scored.push({ ...g, score: combinedScore, eligible });
  }

  // Sort: eligible first by score desc, then ineligible by score desc
  scored.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });

  const recommended = scored[0];
  if (!recommended) return null;

  // Store recommendation (once per week — skip if already stored)
  if (!existing) {
    try {
      await db.insert(gotwHistoryTable).values({
        seasonId,
        weekIndex,
        discordId1:    recommended.awayDiscordId,
        discordId2:    recommended.homeDiscordId,
        teamName1:     recommended.awayTeamName,
        teamName2:     recommended.homeTeamName,
        combinedScore: Math.floor(recommended.score),
      }).onConflictDoNothing();
    } catch (_) {}
  }

  // Build display text
  const cooldownNote = recommended.eligible
    ? ""
    : " *(all teams on cooldown — showing best available)*";

  const hasStats = statsByDiscord.size > 0;
  const statsNote = hasStats
    ? ""
    : "\n*Run `/franchiseupdate` to load season stats for a data-driven pick.*";

  const value =
    `<@${recommended.awayDiscordId}> **vs** <@${recommended.homeDiscordId}>` +
    `\n*${recommended.awayTeamName} vs ${recommended.homeTeamName}*` +
    cooldownNote +
    statsNote;

  return {
    name: "🏆 Recommended Game of the Week",
    value,
  };
}
