import { Client, Guild, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import {
  gotwHistoryTable, teamSeasonStatsTable, userRecordsTable,
  franchiseScheduleTable,
} from "@workspace/db";
import { eq, and, gte, lt } from "drizzle-orm";
import { addBalance, logTransaction } from "./db-helpers.js";
import { GOTW_REGULAR_BONUS, GOTW_PLAYOFF_BONUS } from "../commands/admin-gotw.js";

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

// ── Purge all messages from a text channel ─────────────────────────────────────
export async function purgeChannel(tc: TextChannel): Promise<number> {
  let cleared = 0;
  while (true) {
    const fetched = await tc.messages.fetch({ limit: 100 });
    if (fetched.size === 0) break;

    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = fetched.filter(m => m.createdTimestamp > cutoff);
    const old    = fetched.filter(m => m.createdTimestamp <= cutoff);

    if (recent.size >= 2) {
      await tc.bulkDelete(recent);
      cleared += recent.size;
    } else if (recent.size === 1) {
      await recent.first()!.delete();
      cleared++;
    }

    for (const msg of old.values()) {
      await msg.delete().catch(() => {});
      cleared++;
      await new Promise(r => setTimeout(r, 500));
    }

    if (fetched.size < 100) break;
  }
  return cleared;
}

// ── Purge the entire GOTW channel ─────────────────────────────────────────────
export async function purgeGotwChannel(client: Client): Promise<void> {
  const ch = await client.channels.fetch(GOTW_CHANNEL_ID).catch(() => null);
  if (!ch?.isTextBased()) return;
  await purgeChannel(ch as TextChannel).catch(err =>
    console.error("[gotw-helpers] GOTW channel purge error:", err),
  );
}

// ── Score every H2H matchup for a given week ──────────────────────────────────
// Returns sorted array: eligible first (by score desc), then ineligible (by score desc).
// Does NOT write to the DB.
export async function scoreH2HMatchups(
  seasonId:      number,
  weekIndex:     number,
  games:         Array<{ awayTeamName: string; homeTeamName: string }>,
  teamToDiscord: Map<string, string>,
): Promise<ScoredH2HGame[]> {
  const h2hGames: Array<{ awayTeamName: string; homeTeamName: string; awayDiscordId: string; homeDiscordId: string }> = [];
  for (const g of games) {
    const awayId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim());
    const homeId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim());
    if (awayId && homeId) h2hGames.push({ ...g, awayDiscordId: awayId, homeDiscordId: homeId });
  }

  if (h2hGames.length === 0) return [];

  const teamStats = await db.select()
    .from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, seasonId));

  const statsByDiscord = new Map<string, { offYds: number; defYds: number }>();
  for (const s of teamStats) {
    if (s.discordId) {
      statsByDiscord.set(s.discordId, {
        offYds: s.offYds,
        defYds: (s.defPassYds + s.defRushYds) || 0,
      });
    }
  }

  const records = await db.select({
    discordId:         userRecordsTable.discordId,
    pointDifferential: userRecordsTable.pointDifferential,
  }).from(userRecordsTable)
    .where(eq(userRecordsTable.seasonId, seasonId));

  const pdByDiscord = new Map<string, number>();
  for (const r of records) pdByDiscord.set(r.discordId, r.pointDifferential);

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

  const scored: ScoredH2HGame[] = h2hGames.map(g => {
    const awayStats = statsByDiscord.get(g.awayDiscordId);
    const homeStats = statsByDiscord.get(g.homeDiscordId);

    const awayScore =
      0.5  * (awayStats?.offYds ?? 0)
      - 0.25 * (awayStats?.defYds ?? 0)
      + 0.25 * Math.abs(pdByDiscord.get(g.awayDiscordId) ?? 0);

    const homeScore =
      0.5  * (homeStats?.offYds ?? 0)
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

    const announcementMsg = await tc.send({
      content:
        `@everyone\n` +
        `🏈 **Week ${weekNum} Game of the Week!**\n` +
        `<@${awayDiscordId}> **${awayTeamName}** vs <@${homeDiscordId}> **${homeTeamName}**`,
    });

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
// Called by /advanceweek before moving to the next week (legacy — only deletes 2 msgs).
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
      if (row.announcementMessageId) await tc.messages.delete(row.announcementMessageId).catch(() => {});
      if (row.pollMessageId)         await tc.messages.delete(row.pollMessageId).catch(() => {});
    }

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

// ── Auto-pay GOTW poll voters for a completed week ────────────────────────────
// Resolves the winning team from franchise_schedule, fetches poll voters,
// and awards coins to everyone who voted for the winner.
// Safe to call multiple times — skips if payoutIssuedAt is already set.
// Returns a summary string for the admin to display.
export async function autoPayoutGotwVoters(
  client:    Client,
  guild:     Guild | null,
  seasonId:  number,
  weekIndex: number,  // the week whose GOTW result we're paying out
  weekNum:   number,  // human-readable (weekIndex + 1)
  isPlayoff: boolean,
): Promise<string> {
  if (weekIndex < 0) return "";

  // 1. Load GOTW history row
  const [row] = await db.select()
    .from(gotwHistoryTable)
    .where(and(
      eq(gotwHistoryTable.seasonId,  seasonId),
      eq(gotwHistoryTable.weekIndex, weekIndex),
    ))
    .limit(1);

  if (!row) {
    return `⚠️ No GOTW was set for Week ${weekNum} — skipping payout.`;
  }

  if (row.payoutIssuedAt) {
    return `ℹ️ GOTW payouts for Week ${weekNum} were already issued on <t:${Math.floor(row.payoutIssuedAt.getTime() / 1000)}:F>.`;
  }

  if (!row.pollMessageId) {
    return `⚠️ No poll message recorded for Week ${weekNum} GOTW — use \`/admin-gotw\` to pay manually.`;
  }

  // 2. Determine winner from franchise_schedule
  const scheduleRows = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  seasonId),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ));

  // Match the GOTW game by team names (case-insensitive)
  const t1 = row.teamName1.toLowerCase().trim();
  const t2 = row.teamName2.toLowerCase().trim();
  const gotwGame = scheduleRows.find(g => {
    const away = g.awayTeamName.toLowerCase().trim();
    const home = g.homeTeamName.toLowerCase().trim();
    return (
      (away === t1 && home === t2) ||
      (away === t2 && home === t1)
    );
  });

  if (!gotwGame) {
    return `⚠️ Could not find GOTW game (${row.teamName1} vs ${row.teamName2}) in Week ${weekNum} schedule — use \`/admin-gotw\` to pay manually.`;
  }

  if (gotwGame.homeScore == null || gotwGame.awayScore == null || gotwGame.status < 2) {
    return `⏳ GOTW game (${row.teamName1} vs ${row.teamName2}) isn't scored yet for Week ${weekNum} — re-run after importing scores.`;
  }

  // Determine which discord ID won
  let winnerDiscordId: string | null = null;
  let winnerTeamName:  string | null = null;
  let winningAnswerId: number | null = null; // 1 = discordId1 (away in poll), 2 = discordId2 (home in poll)

  const gotwAwayName = gotwGame.awayTeamName.toLowerCase().trim();
  const gotw1Name    = t1;

  // Figure out which answer in the poll corresponds to which team
  // Poll answer 1 = teamName1 (away GOTW team), answer 2 = teamName2 (home GOTW team)
  const awayWon = gotwGame.awayScore > gotwGame.homeScore;
  const homeWon = gotwGame.homeScore > gotwGame.awayScore;

  if (!awayWon && !homeWon) {
    return `🤝 The Week ${weekNum} GOTW ended in a tie — no payouts issued.`;
  }

  const gameAwayName = gotwGame.awayTeamName.toLowerCase().trim();
  if (gameAwayName === gotw1Name) {
    // teamName1 was the away team in the actual game
    winningAnswerId  = awayWon ? 1 : 2;
    winnerDiscordId  = awayWon ? row.discordId1 : row.discordId2;
    winnerTeamName   = awayWon ? row.teamName1  : row.teamName2;
  } else {
    // teamName1 was the home team in the actual game
    winningAnswerId  = homeWon ? 1 : 2;
    winnerDiscordId  = homeWon ? row.discordId1 : row.discordId2;
    winnerTeamName   = homeWon ? row.teamName1  : row.teamName2;
  }

  // 3. Fetch the poll message
  const ch = await client.channels.fetch(GOTW_CHANNEL_ID).catch(() => null);
  if (!ch?.isTextBased()) {
    return `❌ Cannot access GOTW channel — use \`/admin-gotw\` to pay manually.`;
  }
  const tc = ch as TextChannel;

  const pollMsg = await tc.messages.fetch(row.pollMessageId).catch(() => null);
  if (!pollMsg || !pollMsg.poll) {
    return `⚠️ Poll message for Week ${weekNum} GOTW not found (may have been deleted) — use \`/admin-gotw\` to pay manually.`;
  }

  // 4. Fetch voters for the winning answer
  const winningAnswer = pollMsg.poll.answers.get(winningAnswerId);
  if (!winningAnswer) {
    return `❌ Could not find answer ${winningAnswerId} in the Week ${weekNum} GOTW poll — use \`/admin-gotw\` to pay manually.`;
  }

  const voters = await winningAnswer.fetchVoters().catch(() => null);
  if (!voters) {
    return `❌ Failed to fetch voters for Week ${weekNum} GOTW poll — use \`/admin-gotw\` to pay manually.`;
  }

  // 5. Issue payouts
  const bonus     = isPlayoff ? GOTW_PLAYOFF_BONUS : GOTW_REGULAR_BONUS;
  const weekLabel = `Week ${weekNum}`;
  const paid: string[] = [];

  for (const [userId, user] of voters) {
    // Don't pay the winning player themselves (they already get the H2H payout)
    // — actually the user may want to allow it; let's just pay all voters equally
    await addBalance(userId, bonus);
    await logTransaction(
      userId, bonus, "addcoins",
      `GOTW correct guess bonus — ${weekLabel}`,
      "auto",
    );
    paid.push(`<@${userId}>`);

    // DM the winner
    try {
      await user.send(
        `🏈 **GOTW Correct Guess Bonus!** Your prediction for **${weekLabel}**'s Game of the Week was correct!\n` +
        `**+${bonus} coins** added to your balance.`,
      ).catch(() => {});
    } catch (_) {}
  }

  // 6. Mark payout as issued
  await db.update(gotwHistoryTable)
    .set({ payoutIssuedAt: new Date() })
    .where(and(
      eq(gotwHistoryTable.seasonId,  seasonId),
      eq(gotwHistoryTable.weekIndex, weekIndex),
    ));

  if (paid.length === 0) {
    return `📊 Week ${weekNum} GOTW winner: **${winnerTeamName}** (<@${winnerDiscordId}>)\nNo one voted for the correct team — no payouts issued.`;
  }

  return (
    `📊 **Week ${weekNum} GOTW auto-payout complete!**\n` +
    `Winner: **${winnerTeamName}** (<@${winnerDiscordId}>)\n` +
    `Score: ${gotwGame.awayTeamName} **${gotwGame.awayScore}** – **${gotwGame.homeScore}** ${gotwGame.homeTeamName}\n` +
    `**+${bonus} coins** paid to ${paid.length} correct voter${paid.length === 1 ? "" : "s"}: ${paid.join(", ")}`
  );
}
