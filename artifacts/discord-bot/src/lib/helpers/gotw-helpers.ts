import { Client, Guild, TextChannel, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import {
  gotwHistoryTable, teamSeasonStatsTable, userRecordsTable,
  franchiseScheduleTable, playoffGotwPollsTable, franchiseMcaTeamsTable,
} from "@workspace/db";
import { eq, and, gte, lt } from "drizzle-orm";
import { addBalance, logTransaction, PRIMARY_GUILD_ID, getGuildChannel, CHANNEL_KEYS } from "../db/db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";

export const GOTW_COOLDOWN_WEEKS = 4;

/**
 * Fuzzy team-name match: handles "Vikings" stored in gotwHistory vs
 * "Minnesota Vikings" stored in franchise_schedule.
 * Returns true when either name fully contains the other (case-insensitive).
 */
function nameMatch(a: string, b: string): boolean {
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Silently send an embed to the commissioner log channel.
 * Never throws — all errors are swallowed so a logging failure never
 * interrupts the main payout flow.
 */
async function sendGotwCommLog(
  client:  Client,
  guildId: string,
  embed:   EmbedBuilder,
): Promise<void> {
  try {
    const commId =
      await getGuildChannel(guildId, CHANNEL_KEYS.TRANSACTION_LOG)
      ?? await getGuildChannel(guildId, CHANNEL_KEYS.TRANSACTIONS)
      ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG)
      ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER);
    if (!commId) return;
    const ch = await client.channels.fetch(commId).catch(() => null);
    if (!ch?.isTextBased()) return;
    await (ch as TextChannel).send({ embeds: [embed] });
  } catch (_) {}
}

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
export async function purgeGotwChannel(client: Client, guildId: string = PRIMARY_GUILD_ID): Promise<void> {
  const gotwId = await getGuildChannel(guildId, CHANNEL_KEYS.GOTW);
  if (!gotwId) return;
  const ch = await client.channels.fetch(gotwId).catch(() => null);
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
  guildId:       string = PRIMARY_GUILD_ID,
): Promise<{ announcementId: string; pollId: string } | null> {
  try {
    const gotwId = await getGuildChannel(guildId, CHANNEL_KEYS.GOTW);
    const channel = gotwId ? await client.channels.fetch(gotwId).catch(() => null) : null;
    if (!channel?.isTextBased()) return null;
    const tc = channel as TextChannel;

    // Discord poll has been replaced with in-menu GOTW voting (see
    // lib/handlers/gotw-voting-handlers.ts). We still post a short
    // announcement so the GOTW channel reflects the active matchup, but
    // there is no poll message — voting happens via /menu → GOTW Vote.
    const announcementMsg = await tc.send({
      content:
        `@everyone\n` +
        `🏈 **Week ${weekNum} Game of the Week!**\n` +
        `<@${awayDiscordId}> **${awayTeamName}** vs <@${homeDiscordId}> **${homeTeamName}**\n` +
        `\n🗳️ Vote via **/menu → 🏆 GOTW Vote**. You can change your vote until the game starts.`,
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
    }).onConflictDoUpdate({
      target: [gotwHistoryTable.seasonId, gotwHistoryTable.weekIndex],
      set: {
        discordId1:            awayDiscordId,
        discordId2:            homeDiscordId,
        teamName1:             awayTeamName,
        teamName2:             homeTeamName,
        combinedScore:         Math.floor(combinedScore),
        announcementMessageId: announcementMsg.id,
      },
    });

    return { announcementId: announcementMsg.id, pollId: "" };
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
  guildId:   string = PRIMARY_GUILD_ID,
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

    const gotwId = await getGuildChannel(guildId, CHANNEL_KEYS.GOTW);
    const channel = gotwId ? await client.channels.fetch(gotwId).catch(() => null) : null;
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

/** Split a list of voter strings into chunks ≤ 1024 chars for embed fields. */
function voterFieldChunks(
  label:  string,
  lines:  string[],
  empty:  string,
): Array<{ name: string; value: string }> {
  if (lines.length === 0) return [{ name: label, value: empty }];
  const MAX = 1024;
  const chunks: string[][] = [[]];
  for (const line of lines) {
    const cur = chunks[chunks.length - 1]!;
    if ((cur.join("\n") + "\n" + line).length > MAX) chunks.push([line]);
    else cur.push(line);
  }
  return chunks.map((chunk, i) => ({
    name:  chunks.length === 1 ? label : `${label} (${i + 1}/${chunks.length})`,
    value: chunk.join("\n"),
  }));
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
  guildId:   string = PRIMARY_GUILD_ID,
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
    // No DB row — but the poll may still exist in the GOTW channel (e.g. if the
    // GOTW confirmation failed to save to DB). Scan the channel for active polls
    // so the commissioner can pay manually before the channel is purged.
    const _gotwChanId = await getGuildChannel(guildId, CHANNEL_KEYS.GOTW);
    const _gotwCh = _gotwChanId ? await client.channels.fetch(_gotwChanId).catch(() => null) : null;
    const _gotwTc  = _gotwCh?.isTextBased() ? (_gotwCh as TextChannel) : null;
    if (_gotwTc) {
      try {
        const recent = await _gotwTc.messages.fetch({ limit: 20 });
        const pollMsgs = recent.filter(m => m.poll != null);
        if (pollMsgs.size > 0) {
          const voterLines: string[] = [
            `⚠️ No GOTW was recorded for Week ${weekNum}, but **${pollMsgs.size} poll(s)** found in the GOTW channel. Voter lists below — use \`/admin-gotw payout\` to pay correct voters manually.`,
          ];
          for (const pollMsg of pollMsgs.values()) {
            const q = pollMsg.poll!.question.text;
            voterLines.push(`\n📊 **Poll:** ${q}`);
            for (const [, answer] of pollMsg.poll!.answers) {
              const voters = await answer.fetchVoters().catch(() => null);
              const names = voters ? [...voters.values()].map(u => `• <@${u.id}>`).join("\n") : "_Could not fetch_";
              voterLines.push(`**${answer.text}** (${voters?.size ?? "?"}): \n${names || "_No votes_"}`);
            }
          }
          return voterLines.join("\n");
        }
      } catch {
        // Best-effort — fall through to the default message
      }
    }
    return `⚠️ No GOTW was set for Week ${weekNum} — skipping payout.`;
  }

  if (row.payoutIssuedAt) {
    return `ℹ️ GOTW payouts for Week ${weekNum} were already issued on <t:${Math.floor(row.payoutIssuedAt.getTime() / 1000)}:F>.`;
  }

  if (!row.pollMessageId) {
    return `⚠️ No poll message recorded for Week ${weekNum} GOTW — use \`/admin-gotw\` to pay manually.`;
  }

  // 2. Fetch the poll message and BOTH answers' voters immediately,
  //    BEFORE the schedule lookup so they're available for every error path.
  const _gotwId = await getGuildChannel(guildId, CHANNEL_KEYS.GOTW);
  const ch = _gotwId ? await client.channels.fetch(_gotwId).catch(() => null) : null;
  const tc = ch?.isTextBased() ? (ch as TextChannel) : null;

  // Try to fetch both answer voter lists right away
  type VoterEntry = { id: string; username: string };
  let answer1Voters: VoterEntry[] = [];
  let answer2Voters: VoterEntry[] = [];
  let pollAvailable = false;

  if (tc && row.pollMessageId) {
    const pollMsg = await tc.messages.fetch(row.pollMessageId).catch(() => null);
    if (pollMsg?.poll) {
      pollAvailable = true;
      const a1 = pollMsg.poll.answers.get(1);
      const a2 = pollMsg.poll.answers.get(2);
      const [v1, v2] = await Promise.all([
        a1?.fetchVoters().catch(() => null),
        a2?.fetchVoters().catch(() => null),
      ]);
      if (v1) for (const [id, u] of v1) answer1Voters.push({ id, username: u.username });
      if (v2) for (const [id, u] of v2) answer2Voters.push({ id, username: u.username });
    }
  }

  // Helper: format voter list into mention strings
  const fmtVoters = (vs: VoterEntry[]) => vs.map(v => `• <@${v.id}>`);

  // 3. Determine winner from franchise_schedule
  //    Match by discordId (not team name) to avoid Madden short-name mismatches.
  //    Build a scheduleName → discordId map from franchiseMcaTeamsTable, then
  //    find the game where the two discordIds match the GOTW row.
  const [scheduleRows, mcaTeams] = await Promise.all([
    db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId,  seasonId),
        eq(franchiseScheduleTable.weekIndex, weekIndex),
      )),
    db.select({
      discordId: franchiseMcaTeamsTable.discordId,
      fullName:  franchiseMcaTeamsTable.fullName,
      nickName:  franchiseMcaTeamsTable.nickName,
    })
      .from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, seasonId)),
  ]);

  // Map every known name variant → discordId
  const nameToDiscordId = new Map<string, string>();
  for (const t of mcaTeams) {
    if (t.discordId) {
      nameToDiscordId.set(t.fullName.toLowerCase().trim(), t.discordId);
      nameToDiscordId.set(t.nickName.toLowerCase().trim(), t.discordId);
    }
  }

  // Also fall back to fuzzy name-match in case MCA data is sparse
  const t1 = row.teamName1.toLowerCase().trim();
  const t2 = row.teamName2.toLowerCase().trim();

  const gotwGame = scheduleRows.find(g => {
    const away = g.awayTeamName.toLowerCase().trim();
    const home = g.homeTeamName.toLowerCase().trim();

    // Primary: match via discordId (most reliable)
    const awayId = nameToDiscordId.get(away);
    const homeId = nameToDiscordId.get(home);
    if (awayId && homeId) {
      return (
        (awayId === row.discordId1 && homeId === row.discordId2) ||
        (awayId === row.discordId2 && homeId === row.discordId1)
      );
    }

    // Fallback: fuzzy name match (handles cases where MCA data is missing)
    return (
      (nameMatch(away, t1) && nameMatch(home, t2)) ||
      (nameMatch(away, t2) && nameMatch(home, t1))
    );
  });

  // Build voter fields for both teams (used in all error + success embeds)
  const voterFields1 = voterFieldChunks(
    `🗳️ Voted for ${row.teamName1} (${answer1Voters.length})`,
    fmtVoters(answer1Voters),
    "_No votes_",
  );
  const voterFields2 = voterFieldChunks(
    `🗳️ Voted for ${row.teamName2} (${answer2Voters.length})`,
    fmtVoters(answer2Voters),
    "_No votes_",
  );

  if (!gotwGame) {
    const desc = pollAvailable
      ? "Game was **not found** in the schedule. Voter lists captured below — pay correct voters manually with `/admin-gotw payout`."
      : "Game was **not found** in the schedule and the poll was **already deleted** — voter list is unrecoverable.";

    const embed = new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle(`⚠️ GOTW Payout Issue — Week ${weekNum}`)
      .setDescription(desc)
      .addFields(
        { name: "Matchup",      value: `**${row.teamName1}** vs **${row.teamName2}**` },
        { name: "Participants", value: `<@${row.discordId1}> (${row.teamName1})\n<@${row.discordId2}> (${row.teamName2})` },
        ...voterFields1,
        ...voterFields2,
        { name: "Action", value: "Check that MCA schedules are imported, then use `/admin-gotw payout` to pay correct voters manually." },
      )
      .setTimestamp();
    await sendGotwCommLog(client, guildId, embed);
    return `⚠️ Could not find GOTW game (${row.teamName1} vs ${row.teamName2}) in Week ${weekNum} schedule — use \`/admin-gotw\` to pay manually.`;
  }

  if (gotwGame.homeScore == null || gotwGame.awayScore == null || gotwGame.status < 2) {
    return `⏳ GOTW game (${row.teamName1} vs ${row.teamName2}) isn't scored yet for Week ${weekNum} — re-run after importing scores.`;
  }

  // 4. Determine which answer corresponds to the winner
  // Poll answer 1 = teamName1, answer 2 = teamName2
  const awayWon = gotwGame.awayScore > gotwGame.homeScore;
  const homeWon = gotwGame.homeScore > gotwGame.awayScore;

  if (!awayWon && !homeWon) {
    return `🤝 The Week ${weekNum} GOTW ended in a tie — no payouts issued.`;
  }

  let winnerDiscordId: string;
  let loserDiscordId:  string;
  let winnerTeamName:  string;
  let loserTeamName:   string;
  let winningAnswerId: number;  // 1 or 2

  // Identify which GOTW team was the away team using discordId first (most reliable),
  // falling back to fuzzy name match when MCA team data is sparse.
  const gameAwayName      = gotwGame.awayTeamName.toLowerCase().trim();
  const gameAwayDiscordId = nameToDiscordId.get(gameAwayName);
  const team1IsAway       = gameAwayDiscordId
    ? gameAwayDiscordId === row.discordId1
    : nameMatch(gameAwayName, t1);

  if (team1IsAway) {
    // teamName1 (poll answer 1) was the away team in the schedule
    winningAnswerId = awayWon ? 1 : 2;
    winnerDiscordId = awayWon ? row.discordId1 : row.discordId2;
    loserDiscordId  = awayWon ? row.discordId2 : row.discordId1;
    winnerTeamName  = awayWon ? row.teamName1  : row.teamName2;
    loserTeamName   = awayWon ? row.teamName2  : row.teamName1;
  } else {
    // teamName1 (poll answer 1) was the home team — away team won → answer 2 wins
    winningAnswerId = awayWon ? 2 : 1;
    winnerDiscordId = awayWon ? row.discordId2 : row.discordId1;
    loserDiscordId  = awayWon ? row.discordId1 : row.discordId2;
    winnerTeamName  = awayWon ? row.teamName2  : row.teamName1;
    loserTeamName   = awayWon ? row.teamName1  : row.teamName2;
  }

  // Voters who picked the winner / loser (already fetched above)
  const correctVoters = winningAnswerId === 1 ? answer1Voters : answer2Voters;
  const wrongVoters   = winningAnswerId === 1 ? answer2Voters : answer1Voters;

  // If the poll wasn't available we can't pay — log and bail
  if (!pollAvailable || !tc) {
    const embed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle(`❌ GOTW Payout Issue — Week ${weekNum}: Poll Deleted`)
      .setDescription("The poll was **already deleted** when payout ran. Voter list is **unrecoverable**.")
      .addFields(
        { name: "Matchup",     value: `**${row.teamName1}** vs **${row.teamName2}**` },
        { name: "Final Score", value: `${gotwGame.awayTeamName} **${gotwGame.awayScore}** – **${gotwGame.homeScore}** ${gotwGame.homeTeamName}` },
        { name: "Winner",      value: `**${winnerTeamName}** (<@${winnerDiscordId}>)` },
        { name: "Action",      value: "Use `/admin-gotw payout` to manually pay anyone you know voted correctly." },
      )
      .setTimestamp();
    await sendGotwCommLog(client, guildId, embed);
    return `⚠️ Poll for Week ${weekNum} GOTW not found (deleted before payout) — use \`/admin-gotw\` to pay manually.`;
  }

  // 5. Issue payouts to correct voters
  const bonus     = await getPayoutValue(isPlayoff ? PAYOUT_KEYS.GOTW_PLAYOFF_BONUS : PAYOUT_KEYS.GOTW_REGULAR_BONUS);
  const weekLabel = `Week ${weekNum}`;

  for (const voter of correctVoters) {
    await addBalance(voter.id, bonus, guildId);
    await logTransaction(
      voter.id, bonus, "addcoins",
      `GOTW correct guess bonus — ${weekLabel}`,
      guildId, "auto",
    );
    // DM the voter
    try {
      const discordUser = await client.users.fetch(voter.id).catch(() => null);
      await discordUser?.send(
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

  // 7. Commissioner log — full voter breakdown for both teams
  const correctLines = fmtVoters(correctVoters);
  const wrongLines   = fmtVoters(wrongVoters);

  const correctFieldName = correctVoters.length > 0
    ? `✅ Voted for **${winnerTeamName}** (winner) — +${bonus} coins each (${correctVoters.length})`
    : `✅ Voted for **${winnerTeamName}** (winner) — 0 correct`;
  const wrongFieldName = `❌ Voted for **${loserTeamName}** (loser) — ${wrongVoters.length}`;

  const embed = new EmbedBuilder()
    .setColor(correctVoters.length > 0 ? Colors.Green : Colors.Blue)
    .setTitle(`📋 GOTW Payout Log — Week ${weekNum}`)
    .addFields(
      { name: "Matchup",     value: `**${row.teamName1}** vs **${row.teamName2}**` },
      { name: "Final Score", value: `${gotwGame.awayTeamName} **${gotwGame.awayScore}** – **${gotwGame.homeScore}** ${gotwGame.homeTeamName}`, inline: true },
      { name: "Winner",      value: `**${winnerTeamName}** (<@${winnerDiscordId}>)`, inline: true },
      ...voterFieldChunks(correctFieldName, correctLines, "No one voted for the correct team."),
      ...voterFieldChunks(wrongFieldName,   wrongLines,   "_No votes_"),
    )
    .setTimestamp();
  await sendGotwCommLog(client, guildId, embed);

  if (correctVoters.length === 0) {
    return `📊 Week ${weekNum} GOTW winner: **${winnerTeamName}** (<@${winnerDiscordId}>)\nNo one voted for the correct team — no payouts issued.`;
  }

  const paidMentions = correctVoters.map(v => `<@${v.id}>`).join(", ");
  return (
    `📊 **Week ${weekNum} GOTW auto-payout complete!**\n` +
    `Winner: **${winnerTeamName}** (<@${winnerDiscordId}>)\n` +
    `Score: ${gotwGame.awayTeamName} **${gotwGame.awayScore}** – **${gotwGame.homeScore}** ${gotwGame.homeTeamName}\n` +
    `**+${bonus} coins** paid to ${correctVoters.length} correct voter${correctVoters.length === 1 ? "" : "s"}: ${paidMentions}`
  );
}

// ── Auto-pay all playoff GOTW polls for a completed playoff week ───────────────
// Finds all unpaid polls for a given playoff weekIndex, determines each winner
// from franchise_schedule, and awards GOTW_PLAYOFF_BONUS to correct voters.
// Safe to call multiple times — skips rows where payoutIssuedAt is already set.
export async function autoPayoutPlayoffGotw(
  client:     Client,
  seasonId:   number,
  weekIndex:  number,  // 18=wildcard, 19=divisional, 20=conference, 22=superbowl
  weekLabel:  string,  // "wildcard" | "divisional" | "conference" | "superbowl" (for display)
  guildId:    string = PRIMARY_GUILD_ID,
): Promise<string> {
  const polls = await db.select()
    .from(playoffGotwPollsTable)
    .where(and(
      eq(playoffGotwPollsTable.seasonId,  seasonId),
      eq(playoffGotwPollsTable.weekIndex, weekIndex),
    ));

  if (polls.length === 0) {
    return `⚠️ No playoff polls found for ${weekLabel} — skipping GOTW payout.`;
  }

  const _gotwId = await getGuildChannel(guildId, CHANNEL_KEYS.GOTW);
  const ch = _gotwId ? await client.channels.fetch(_gotwId).catch(() => null) : null;
  if (!ch?.isTextBased()) {
    return `❌ Cannot access GOTW channel for ${weekLabel} poll payouts.`;
  }
  const tc = ch as TextChannel;

  const [scheduleRows, mcaTeams] = await Promise.all([
    db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId,  seasonId),
        eq(franchiseScheduleTable.weekIndex, weekIndex),
      )),
    db.select({
      discordId: franchiseMcaTeamsTable.discordId,
      fullName:  franchiseMcaTeamsTable.fullName,
      nickName:  franchiseMcaTeamsTable.nickName,
    })
      .from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, seasonId)),
  ]);

  // Map every known name variant → discordId (for schedule-game lookup by discordId)
  const nameToDiscordId = new Map<string, string>();
  for (const t of mcaTeams) {
    if (t.discordId) {
      nameToDiscordId.set(t.fullName.toLowerCase().trim(), t.discordId);
      nameToDiscordId.set(t.nickName.toLowerCase().trim(), t.discordId);
    }
  }

  const playoffBonus = await getPayoutValue(PAYOUT_KEYS.GOTW_PLAYOFF_BONUS);
  const results: string[] = [];

  for (const poll of polls) {
    if (poll.payoutIssuedAt) {
      results.push(`ℹ️ ${poll.teamName1} vs ${poll.teamName2} — already paid out`);
      continue;
    }

    if (!poll.pollMessageId) {
      results.push(`⚠️ ${poll.teamName1} vs ${poll.teamName2} — no poll message ID, skipping`);
      continue;
    }

    // Match the game by discordId (most reliable — avoids Madden short-name mismatches).
    // Fall back to fuzzy name match if MCA data is missing.
    const t1 = poll.teamName1.toLowerCase().trim();
    const t2 = poll.teamName2.toLowerCase().trim();
    const game = scheduleRows.find(g => {
      const away = g.awayTeamName.toLowerCase().trim();
      const home = g.homeTeamName.toLowerCase().trim();
      const awayId = nameToDiscordId.get(away);
      const homeId = nameToDiscordId.get(home);
      if (awayId && homeId) {
        return (
          (awayId === poll.discordId1 && homeId === poll.discordId2) ||
          (awayId === poll.discordId2 && homeId === poll.discordId1)
        );
      }
      return (
        (nameMatch(away, t1) && nameMatch(home, t2)) ||
        (nameMatch(away, t2) && nameMatch(home, t1))
      );
    });

    if (!game) {
      results.push(`⚠️ ${poll.teamName1} vs ${poll.teamName2} — game not found in schedule`);
      continue;
    }

    if (game.homeScore == null || game.awayScore == null || game.status < 2) {
      results.push(`⏳ ${poll.teamName1} vs ${poll.teamName2} — game not scored yet`);
      continue;
    }

    if (game.homeScore === game.awayScore) {
      results.push(`🤝 ${poll.teamName1} vs ${poll.teamName2} — tie, no payout`);
      await db.update(playoffGotwPollsTable)
        .set({ payoutIssuedAt: new Date() })
        .where(eq(playoffGotwPollsTable.id, poll.id));
      continue;
    }

    // Determine which poll answer (1=discordId1, 2=discordId2) corresponds to the winner.
    // Use discordId to identify which team was away in the actual game.
    const awayWon  = game.awayScore > game.homeScore;
    const gameAwayId = nameToDiscordId.get(game.awayTeamName.toLowerCase().trim());

    let winningAnswerId: number;
    let winnerName: string;
    // answer 1 = discordId1; check if discordId1 was the away team
    if (gameAwayId ? gameAwayId === poll.discordId1 : nameMatch(game.awayTeamName.toLowerCase().trim(), t1)) {
      winningAnswerId = awayWon ? 1 : 2;
      winnerName      = awayWon ? poll.teamName1 : poll.teamName2;
    } else {
      winningAnswerId = awayWon ? 2 : 1;
      winnerName      = awayWon ? poll.teamName2 : poll.teamName1;
    }

    const pollMsg = await tc.messages.fetch(poll.pollMessageId).catch(() => null);
    if (!pollMsg?.poll) {
      await sendGotwCommLog(client, guildId, new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle(`❌ Playoff GOTW Payout Issue — ${weekLabel}: Poll Deleted`)
        .setDescription("The poll message was **not found or already deleted**. The voter list is **unrecoverable**. Manual payout required.")
        .addFields(
          { name: "Matchup",     value: `**${poll.teamName1}** vs **${poll.teamName2}**` },
          { name: "Final Score", value: `${game.awayTeamName} **${game.awayScore}** – **${game.homeScore}** ${game.homeTeamName}` },
          { name: "Winner",      value: `**${winnerName}**` },
          { name: "Action",      value: "Use `/admin-gotw` to manually pay anyone you know voted correctly for the winner." },
        )
        .setTimestamp(),
      );
      results.push(`⚠️ ${poll.teamName1} vs ${poll.teamName2} — poll message not found`);
      continue;
    }

    const winningAnswer = pollMsg.poll.answers.get(winningAnswerId);
    if (!winningAnswer) {
      await sendGotwCommLog(client, guildId, new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle(`❌ Playoff GOTW Payout Issue — ${weekLabel}: Answer Missing`)
        .setDescription(`Could not find answer ${winningAnswerId} in the poll.`)
        .addFields(
          { name: "Matchup", value: `**${poll.teamName1}** vs **${poll.teamName2}**` },
          { name: "Winner",  value: `**${winnerName}**` },
          { name: "Action",  value: "Use `/admin-gotw` to pay correct voters manually." },
        )
        .setTimestamp(),
      );
      results.push(`❌ ${poll.teamName1} vs ${poll.teamName2} — answer ${winningAnswerId} missing from poll`);
      continue;
    }

    const voters = await winningAnswer.fetchVoters().catch(() => null);
    if (!voters) {
      await sendGotwCommLog(client, guildId, new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle(`❌ Playoff GOTW Payout Issue — ${weekLabel}: Voter Fetch Failed`)
        .setDescription("Could not retrieve voter list from the poll.")
        .addFields(
          { name: "Matchup", value: `**${poll.teamName1}** vs **${poll.teamName2}**` },
          { name: "Winner",  value: `**${winnerName}**` },
          { name: "Action",  value: "Use `/admin-gotw` to pay correct voters manually." },
        )
        .setTimestamp(),
      );
      results.push(`❌ ${poll.teamName1} vs ${poll.teamName2} — failed to fetch voters`);
      continue;
    }

    const paid:     string[]                             = [];
    const voterLog: { id: string; username: string }[]  = [];

    for (const [userId, user] of voters) {
      await addBalance(userId, playoffBonus, guildId);
      await logTransaction(
        userId, playoffBonus, "addcoins",
        `Playoff GOTW correct guess — ${weekLabel} (${poll.teamName1} vs ${poll.teamName2})`,
        guildId, "auto",
      );
      paid.push(`<@${userId}>`);
      voterLog.push({ id: userId, username: user.username });
      try {
        await user.send(
          `🏆 **Playoff GOTW Correct Guess!** Your pick of **${winnerName}** in the ` +
          `${poll.teamName1} vs ${poll.teamName2} matchup was right!\n` +
          `**+${playoffBonus} coins** added to your balance.`,
        ).catch(() => {});
      } catch (_) {}
    }

    await db.update(playoffGotwPollsTable)
      .set({ payoutIssuedAt: new Date() })
      .where(eq(playoffGotwPollsTable.id, poll.id));

    // Commissioner log for this playoff poll
    await sendGotwCommLog(client, guildId, new EmbedBuilder()
      .setColor(paid.length > 0 ? Colors.Green : Colors.Blue)
      .setTitle(`📋 Playoff GOTW Payout Log — ${weekLabel.charAt(0).toUpperCase() + weekLabel.slice(1)}`)
      .addFields(
        { name: "Matchup",     value: `**${poll.teamName1}** vs **${poll.teamName2}**` },
        { name: "Final Score", value: `${game.awayTeamName} **${game.awayScore}** – **${game.homeScore}** ${game.homeTeamName}`, inline: true },
        { name: "Winner",      value: `**${winnerName}**`, inline: true },
        {
          name:  paid.length > 0 ? `✅ Correct Voters Paid — +${playoffBonus} coins each (${paid.length})` : "📊 No Correct Voters",
          value: paid.length > 0
            ? voterLog.map(v => `• <@${v.id}> (\`${v.username}\`)`).join("\n")
            : "No one voted for the correct team.",
        },
      )
      .setTimestamp(),
    );

    results.push(
      paid.length > 0
        ? `✅ ${poll.teamName1} vs ${poll.teamName2} — **${winnerName}** won · paid ${paid.length} voter${paid.length === 1 ? "" : "s"}: ${paid.join(", ")}`
        : `📊 ${poll.teamName1} vs ${poll.teamName2} — **${winnerName}** won · no correct voters`,
    );
  }

  const header = `**${weekLabel.charAt(0).toUpperCase() + weekLabel.slice(1)} GOTW Payouts (+${playoffBonus} coins/correct guess):**`;
  return `${header}\n${results.join("\n")}`;
}
