import { Client, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import {
  gotwHistoryTable, teamSeasonStatsTable, userRecordsTable,
} from "@workspace/db";
import { eq, and, gte, lt } from "drizzle-orm";

export const GOTW_CHANNEL_ID    = "1485290029294289037";
export const GOTW_COOLDOWN_WEEKS = 4;

export type ScoredH2HGame = {
  awayTeamName:   string;
  homeTeamName:   string;
  awayDiscordId:  string;
  homeDiscordId:  string;
  score:          number;
  eligible:       boolean;
};

// ── Score every H2H matchup for a given week ──────────────────────────────────
// Returns sorted array: eligible first (by score desc), then ineligible (by score desc).
// Does NOT write to the DB.
export async function scoreH2HMatchups(
  seasonId:      number,
  weekIndex:     number,
  games:         Array<{ awayTeamName: string; homeTeamName: string }>,
  teamToDiscord: Map<string, string>,
): Promise<ScoredH2HGame[]> {
  // Collect H2H games (both teams have a registered user)
  const h2hGames: Array<{ awayTeamName: string; homeTeamName: string; awayDiscordId: string; homeDiscordId: string }> = [];
  for (const g of games) {
    const awayId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim());
    const homeId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim());
    if (awayId && homeId) h2hGames.push({ ...g, awayDiscordId: awayId, homeDiscordId: homeId });
  }

  if (h2hGames.length === 0) return [];

  const allDiscordIds = [...new Set(h2hGames.flatMap(g => [g.awayDiscordId, g.homeDiscordId]))];

  // Team season stats
  const teamStats = await db.select()
    .from(teamSeasonStatsTable)
    .where(and(
      eq(teamSeasonStatsTable.seasonId, seasonId),
    ));

  const statsByDiscord = new Map<string, { offYds: number; defYds: number }>();
  for (const s of teamStats) {
    if (s.discordId) {
      statsByDiscord.set(s.discordId, {
        offYds: s.offYds,
        defYds: (s.defPassYds + s.defRushYds) || 0,
      });
    }
  }

  // Point differentials
  const records = await db.select({
    discordId:         userRecordsTable.discordId,
    pointDifferential: userRecordsTable.pointDifferential,
  }).from(userRecordsTable)
    .where(eq(userRecordsTable.seasonId, seasonId));

  const pdByDiscord = new Map<string, number>();
  for (const r of records) pdByDiscord.set(r.discordId, r.pointDifferential);

  // 4-week cooldown
  const onCooldown = new Set<string>();
  if (weekIndex > 0) {
    const recentHistory = await db.select()
      .from(gotwHistoryTable)
      .where(and(
        eq(gotwHistoryTable.seasonId, seasonId),
        gte(gotwHistoryTable.weekIndex, Math.max(0, weekIndex - GOTW_COOLDOWN_WEEKS)),
        lt(gotwHistoryTable.weekIndex, weekIndex),
      ));
    for (const h of recentHistory) {
      onCooldown.add(h.discordId1);
      onCooldown.add(h.discordId2);
    }
  }

  // Score each matchup
  const scored: ScoredH2HGame[] = h2hGames.map(g => {
    const awayStats = statsByDiscord.get(g.awayDiscordId);
    const homeStats = statsByDiscord.get(g.homeDiscordId);

    const awayScore =
      0.5 * (awayStats?.offYds ?? 0)
      - 0.25 * (awayStats?.defYds ?? 0)
      + 0.25 * Math.abs(pdByDiscord.get(g.awayDiscordId) ?? 0);

    const homeScore =
      0.5 * (homeStats?.offYds ?? 0)
      - 0.25 * (homeStats?.defYds ?? 0)
      + 0.25 * Math.abs(pdByDiscord.get(g.homeDiscordId) ?? 0);

    return {
      ...g,
      score:    awayScore + homeScore,
      eligible: !onCooldown.has(g.awayDiscordId) && !onCooldown.has(g.homeDiscordId),
    };
  });

  scored.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });

  return scored;
}

// ── Post GOTW announcement + poll to the GOTW channel ─────────────────────────
// Saves the game record + message IDs to gotwHistoryTable.
export async function postGotwToChannel(
  client:        Client,
  seasonId:      number,
  weekIndex:     number,
  weekNum:       number,
  awayTeamName:  string,
  homeTeamName:  string,
  awayDiscordId: string,
  homeDiscordId: string,
  combinedScore: number,
): Promise<{ announcementId: string; pollId: string } | null> {
  try {
    const channel = await client.channels.fetch(GOTW_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased()) return null;
    const tc = channel as TextChannel;

    // @everyone announcement
    const announcementMsg = await tc.send({
      content:
        `@everyone\n` +
        `🏈 **Week ${weekNum} Game of the Week!**\n` +
        `<@${awayDiscordId}> **${awayTeamName}** vs <@${homeDiscordId}> **${homeTeamName}**`,
    });

    // Poll (4-hour limit)
    const pollMsg = await tc.send({
      poll: {
        question: { text: `Who will win Week ${weekNum}'s GOTW?` },
        answers: [
          { text: awayTeamName },
          { text: homeTeamName },
        ],
        duration:         4,
        allowMultiselect: false,
      } as any,
    });

    // Upsert to gotwHistoryTable — INSERT or UPDATE if admin changed the selection
    await db.insert(gotwHistoryTable).values({
      seasonId,
      weekIndex,
      discordId1:           awayDiscordId,
      discordId2:           homeDiscordId,
      teamName1:            awayTeamName,
      teamName2:            homeTeamName,
      combinedScore:        Math.floor(combinedScore),
      announcementMessageId: announcementMsg.id,
      pollMessageId:         pollMsg.id,
    }).onConflictDoUpdate({
      target: [gotwHistoryTable.seasonId, gotwHistoryTable.weekIndex],
      set: {
        discordId1:            awayDiscordId,
        discordId2:            homeDiscordId,
        teamName1:             awayTeamName,
        teamName2:             homeTeamName,
        combinedScore:         Math.floor(combinedScore),
        announcementMessageId: announcementMsg.id,
        pollMessageId:         pollMsg.id,
      },
    });

    return { announcementId: announcementMsg.id, pollId: pollMsg.id };
  } catch (err) {
    console.error("[gotw-helpers] Failed to post GOTW:", err);
    return null;
  }
}

// ── Delete a week's GOTW posts from Discord ────────────────────────────────────
// Called by /advanceweek before moving to the next week.
export async function deleteGotwMessages(
  client:    Client,
  seasonId:  number,
  weekIndex: number,
): Promise<void> {
  try {
    const [row] = await db.select()
      .from(gotwHistoryTable)
      .where(and(
        eq(gotwHistoryTable.seasonId,  seasonId),
        eq(gotwHistoryTable.weekIndex, weekIndex),
      ))
      .limit(1);

    if (!row) return;

    const channel = await client.channels.fetch(GOTW_CHANNEL_ID).catch(() => null);
    if (channel?.isTextBased()) {
      const tc = channel as TextChannel;

      if (row.announcementMessageId) {
        await tc.messages.delete(row.announcementMessageId).catch(() => {});
      }
      if (row.pollMessageId) {
        await tc.messages.delete(row.pollMessageId).catch(() => {});
      }
    }

    // Clear stored message IDs
    await db.update(gotwHistoryTable)
      .set({ announcementMessageId: null, pollMessageId: null })
      .where(and(
        eq(gotwHistoryTable.seasonId,  seasonId),
        eq(gotwHistoryTable.weekIndex, weekIndex),
      ));
  } catch (err) {
    console.error("[gotw-helpers] Failed to delete GOTW messages:", err);
  }
}
