/**
 * season-schedule-post.ts
 * Shared logic for posting the full 18-week season schedule to a Discord channel.
 * Used by /postfullseasonschedule (manual) and advanceweek (auto on Week 1).
 */
import { Client, EmbedBuilder, Colors, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, franchiseMcaTeamsTable, usersTable } from "@workspace/db";
import { eq, and, asc, isNotNull } from "drizzle-orm";
import { getRosterSeasonId, PRIMARY_GUILD_ID } from "./db-helpers.js";

const SCHEDULE_CHANNEL_ID = "1478947361014288445";

/**
 * Build a map of team name (lower) → Discord mention string.
 * Indexes by MCA fullName + nickName so schedule names match correctly.
 */
async function buildMentionMap(seasonId: number): Promise<Map<string, string>> {
  const rosterSeasonId = await getRosterSeasonId(PRIMARY_GUILD_ID);

  const mcaTeams = await db
    .select({
      fullName:  franchiseMcaTeamsTable.fullName,
      nickName:  franchiseMcaTeamsTable.nickName,
      discordId: franchiseMcaTeamsTable.discordId,
    })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, rosterSeasonId),
      isNotNull(franchiseMcaTeamsTable.discordId),
    ));

  const map = new Map<string, string>();
  for (const t of mcaTeams) {
    if (t.discordId) {
      map.set(t.fullName.toLowerCase().trim(), `<@${t.discordId}>`);
      map.set(t.nickName.toLowerCase().trim(), `<@${t.discordId}>`);
    }
  }

  // Fallback: economy_users short names
  if (map.size === 0) {
    const allUsers = await db
      .select({ discordId: usersTable.discordId, team: usersTable.team })
      .from(usersTable);
    for (const u of allUsers) {
      if (u.team) map.set(u.team.toLowerCase().trim(), `<@${u.discordId}>`);
    }
  }

  return map;
}

function mention(teamName: string, mentionMap: Map<string, string>): string {
  return mentionMap.get(teamName.toLowerCase().trim()) ?? `**${teamName}**`;
}

/**
 * Post the full 18-week season schedule to SCHEDULE_CHANNEL_ID.
 * Clears existing messages first, then posts one embed per week.
 * Returns the number of week embeds posted, or throws on error.
 */
export async function postFullSeasonScheduleToChannel(
  client: Client,
  seasonId: number,
  seasonNumber: number,
  options?: { clearChannel?: boolean },
): Promise<number> {
  const clearChannel = options?.clearChannel ?? true;

  const targetCh = client.channels.cache.get(SCHEDULE_CHANNEL_ID)
    ?? await client.channels.fetch(SCHEDULE_CHANNEL_ID).catch(() => null);

  if (!targetCh?.isTextBased()) {
    throw new Error(`Cannot find or access schedule channel (${SCHEDULE_CHANNEL_ID})`);
  }

  const ch = targetCh as TextChannel;

  // Clear existing schedule posts
  if (clearChannel) {
    try {
      let cleared = 0;
      let lastId: string | undefined;
      while (true) {
        const fetched = await ch.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
        if (fetched.size === 0) break;
        for (const msg of fetched.values()) {
          await msg.delete().catch(() => {});
          cleared++;
        }
        lastId = fetched.last()?.id;
        if (fetched.size < 100) break;
        await new Promise(r => setTimeout(r, 500));
      }
      if (cleared > 0) console.log(`[season-schedule] Cleared ${cleared} messages from schedule channel`);
    } catch (err) {
      console.error("[season-schedule] Failed to clear schedule channel:", err);
    }
  }

  // Fetch all games for the season, regular weeks only (weekIndex 0–17)
  const allGames = await db
    .select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId, seasonId),
    ))
    .orderBy(asc(franchiseScheduleTable.weekIndex), asc(franchiseScheduleTable.id));

  // Filter to regular season weeks (0–17)
  const regularGames = allGames.filter(g => g.weekIndex >= 0 && g.weekIndex <= 17);

  if (regularGames.length === 0) return 0;

  const mentionMap = await buildMentionMap(seasonId);

  // Collect all teams in schedule (for bye detection)
  const allTeamsInSchedule = new Set<string>();
  for (const g of regularGames) {
    allTeamsInSchedule.add(g.homeTeamName.trim());
    allTeamsInSchedule.add(g.awayTeamName.trim());
  }

  // Group by weekIndex
  const gamesByWeek = new Map<number, typeof regularGames>();
  for (const g of regularGames) {
    if (!gamesByWeek.has(g.weekIndex)) gamesByWeek.set(g.weekIndex, []);
    gamesByWeek.get(g.weekIndex)!.push(g);
  }

  let postedWeeks = 0;
  for (let weekIndex = 0; weekIndex <= 17; weekIndex++) {
    const weekNum   = weekIndex + 1;
    const weekGames = gamesByWeek.get(weekIndex) ?? [];

    const teamsPlayingThisWeek = new Set<string>();
    for (const g of weekGames) {
      teamsPlayingThisWeek.add(g.homeTeamName.trim());
      teamsPlayingThisWeek.add(g.awayTeamName.trim());
    }
    const byeTeams = [...allTeamsInSchedule].filter(t => !teamsPlayingThisWeek.has(t)).sort();

    const lines: string[] = [];
    for (const g of weekGames) {
      const awayM = mention(g.awayTeamName, mentionMap);
      const homeM = mention(g.homeTeamName, mentionMap);

      if (g.status >= 2 && g.homeScore != null && g.awayScore != null) {
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

    if (lines.length === 0 && byeTeams.length === 0) continue;

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`📅 Week ${weekNum} — Season ${seasonNumber}`)
      .setDescription(lines.length > 0 ? lines.join("\n") : "*No games scheduled*");

    if (byeTeams.length > 0) {
      const byeLines = byeTeams.map(t => mention(t, mentionMap)).join("\n");
      embed.addFields({ name: "🛌 Bye Week", value: byeLines });
    }

    await ch.send({ embeds: [embed] });
    postedWeeks++;

    await new Promise(r => setTimeout(r, 750));
  }

  return postedWeeks;
}

export { SCHEDULE_CHANNEL_ID };
