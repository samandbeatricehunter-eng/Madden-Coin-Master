import { Client, EmbedBuilder, Colors, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable, franchiseMcaTeamsTable, usersTable,
  userRecordsTable, franchiseProcessedGamesTable,
  playoffGotwPollsTable, type Season,
} from "@workspace/db";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { purgeChannel, purgeGotwChannel } from "../helpers/gotw-helpers.js";
import { addBalance, logTransaction, PRIMARY_GUILD_ID, getGuildChannel, CHANNEL_KEYS } from "../db/db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";
import { cacheMatchupsForTwitter } from "../discord/league-twitter.js";
const MIN_COMPLETED_STATUS = 2;

// ── Playoff week metadata ──────────────────────────────────────────────────────
// MCA may send playoff data in two formats:
//   Format A — weekType="reg",  weekNum=19-23  (canonical, continuous-season numbering)
//     Wild Card=19→1018, Divisional=20→1019, Conference=21→1020, SB=23→1022
//   Format B — weekType="post", weekNum=1-5   (alternate post-season numbering)
//     Wild Card=1→1018, Divisional=2→1019, Conference=3→1020, Pro Bowl=4→1021, SB=5→1022
//
// resolvePlayoffWeekIndex() in franchise-processor.ts normalises both formats to
// the canonical values (1018/1019/1020/1022) for new data.
//
// altWeekIndices: legacy weekIndex values that may have been stored by older code
// (before the fix) using the raw "post" format offset (1000 + weekNum - 1).
// These are tried in order if the primary and fallback queries return 0 rows.
export const PLAYOFF_WEEK_META: Record<string, {
  weekIndex:         number;
  fallbackWeekIndex: number;
  altWeekIndices:    number[];  // legacy "post"-format indices, tried last
  weekNum:           number;
  label:             string;
}> = {
  wildcard:   { weekIndex: 1018, fallbackWeekIndex: 18, altWeekIndices: [1000],       weekNum: 19, label: "Wild Card"               },
  divisional: { weekIndex: 1019, fallbackWeekIndex: 19, altWeekIndices: [1001],       weekNum: 20, label: "Divisional"              },
  conference: { weekIndex: 1020, fallbackWeekIndex: 20, altWeekIndices: [1002],       weekNum: 21, label: "Conference Championship" },
  superbowl:  { weekIndex: 1022, fallbackWeekIndex: 22, altWeekIndices: [1003, 1004], weekNum: 23, label: "Super Bowl"              },
};

function toKey(name: string): string {
  return name.toLowerCase().trim();
}

// ── Build team-name → discordId map ───────────────────────────────────────────
async function buildTeamMap(seasonId: number): Promise<Map<string, string>> {
  const mcaTeams = await db.select({
    fullName:  franchiseMcaTeamsTable.fullName,
    discordId: franchiseMcaTeamsTable.discordId,
  }).from(franchiseMcaTeamsTable).where(eq(franchiseMcaTeamsTable.seasonId, seasonId));

  const map = new Map<string, string>();
  for (const t of mcaTeams) {
    if (t.discordId) map.set(toKey(t.fullName), t.discordId);
  }

  const allUsers = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  }).from(usersTable);

  for (const u of allUsers) {
    if (u.team && !map.has(toKey(u.team))) {
      map.set(toKey(u.team), u.discordId);
    }
  }

  return map;
}

// ── Main playoff advance flow ──────────────────────────────────────────────────
// Called by advanceweek when advancing TO a playoff round.
// Returns a summary string for the admin ephemeral reply.
export async function runPlayoffMatchupsFlow(
  client:  Client,
  season:  Season,
  weekKey: string,  // "wildcard" | "divisional" | "conference" | "superbowl"
  guildId: string = PRIMARY_GUILD_ID,
): Promise<string> {
  const meta = PLAYOFF_WEEK_META[weekKey];
  if (!meta) return `❌ Unknown playoff week: ${weekKey}`;

  const { weekIndex, fallbackWeekIndex, altWeekIndices, label } = meta;

  const teamToDiscord = await buildTeamMap(season.id);

  // 1. Fetch schedule for this playoff week.
  // Try primary (canonical 1018/1019/…), then raw-offset fallback (18/19/…),
  // then altWeekIndices (legacy "post" format values 1000/1001/…).
  let games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  season.id),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ));

  if (games.length === 0) {
    console.log(`[playoff-runner] No games at weekIndex ${weekIndex}, trying fallback ${fallbackWeekIndex}...`);
    games = await db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId,  season.id),
        eq(franchiseScheduleTable.weekIndex, fallbackWeekIndex),
      ));
  }

  for (const alt of altWeekIndices) {
    if (games.length > 0) break;
    console.log(`[playoff-runner] No games at fallback ${fallbackWeekIndex}, trying alt ${alt}...`);
    games = await db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId,  season.id),
        eq(franchiseScheduleTable.weekIndex, alt),
      ));
  }

  const effectiveWeekIndex = games.length > 0 ? (games[0]?.weekIndex ?? weekIndex) : weekIndex;

  const h2hGames = games.filter(g =>
    teamToDiscord.has(toKey(g.awayTeamName)) &&
    teamToDiscord.has(toKey(g.homeTeamName)),
  );

  // 2. Clear GOTW channel
  await purgeGotwChannel(client, guildId).catch(err =>
    console.error("[playoff-runner] GOTW purge error:", err),
  );

  // 3. Clear & post matchup embed to matchups channel
  const matchupsChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.MATCHUPS);
  const matchupsCh = (matchupsChannelId
    ? (client.channels.cache.get(matchupsChannelId) ?? await client.channels.fetch(matchupsChannelId).catch(() => null))
    : null) as TextChannel | null;

  if (matchupsCh?.isTextBased()) {
    try { await purgeChannel(matchupsCh as TextChannel); } catch (_) {}

    const lines = h2hGames.map(g => {
      const awayId = teamToDiscord.get(toKey(g.awayTeamName));
      const homeId = teamToDiscord.get(toKey(g.homeTeamName));
      const awayM  = awayId ? `<@${awayId}>` : `**${g.awayTeamName}**`;
      const homeM  = homeId ? `<@${homeId}>` : `**${g.homeTeamName}**`;

      if (g.status >= MIN_COMPLETED_STATUS && g.homeScore != null && g.awayScore != null) {
        const hs = g.homeScore, as_ = g.awayScore;
        if (hs > as_)  return `🏆 ${awayM} ${as_} — **${hs}** ${homeM} ✅`;
        if (as_ > hs)  return `🏆 ${awayM} **${as_}** — ${hs} ${homeM} ✅`;
        return `🤝 ${awayM} **${as_}** — **${hs}** ${homeM} *(Tie)*`;
      }
      return `📅 ${awayM} @ ${homeM}`;
    });

    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`🏆 ${label} Matchups — Season ${season.seasonNumber}`)
      .setDescription(lines.length > 0 ? lines.join("\n") : "*No H2H matchups found*")
      .setFooter({ text: `All matchups are Game of the Week — vote in #gotw!` })
      .setTimestamp();

    await (matchupsCh as TextChannel).send({ embeds: [embed] }).catch(err =>
      console.error("[playoff-runner] Failed to post matchups embed:", err),
    );

    // Cache matchup list for League Twitter (4-hour freshness window)
    if (h2hGames.length > 0) {
      await cacheMatchupsForTwitter(
        season.id,
        label,
        h2hGames.map(g => ({ homeTeamName: g.homeTeamName, awayTeamName: g.awayTeamName })),
      );
    }
  }

  if (h2hGames.length === 0) {
    return (
      `⚠️ **${label}** matchups embed posted, but no H2H games found.\n` +
      `Looked at weekIndex ${weekIndex} and fallback ${fallbackWeekIndex} — both returned 0 rows.\n` +
      `Make sure the EA playoff schedule export has been imported via \`/franchiseupdate\` before advancing.`
    );
  }

  // 4. Post "Who will win?" poll for each H2H matchup in GOTW channel
  const gotwChannelId = await getGuildChannel(guildId, CHANNEL_KEYS.GOTW);
  const gotwCh = (gotwChannelId
    ? (client.channels.cache.get(gotwChannelId) ?? await client.channels.fetch(gotwChannelId).catch(() => null))
    : null) as TextChannel | null;

  if (!gotwCh?.isTextBased()) {
    return `⚠️ ${label} matchups posted, but cannot access GOTW channel for polls.`;
  }

  const tc = gotwCh as TextChannel;
  let pollsPosted = 0;

  for (let i = 0; i < h2hGames.length; i++) {
    const g       = h2hGames[i]!;
    const awayId  = teamToDiscord.get(toKey(g.awayTeamName))!;
    const homeId  = teamToDiscord.get(toKey(g.homeTeamName))!;

    try {
      await tc.send({
        content:
          `@everyone\n` +
          `🏆 **${label} Matchup!**\n` +
          `<@${awayId}> **${g.awayTeamName}** vs <@${homeId}> **${g.homeTeamName}**\n` +
          `Cast your vote below — **+10 coins** for a correct guess!`,
      });

      const pollMsg = await tc.send({
        poll: {
          question:         { text: `Who will win? ${g.awayTeamName} vs ${g.homeTeamName}` },
          answers:          [{ text: g.awayTeamName }, { text: g.homeTeamName }],
          duration:         4,
          allowMultiselect: false,
        } as any,
      });

      await db.insert(playoffGotwPollsTable).values({
        seasonId:     season.id,
        weekLabel:    weekKey,
        weekIndex:    effectiveWeekIndex,
        matchupIndex: i,
        discordId1:   awayId,
        discordId2:   homeId,
        teamName1:    g.awayTeamName,
        teamName2:    g.homeTeamName,
        pollMessageId: pollMsg.id,
      }).onConflictDoUpdate({
        target: [
          playoffGotwPollsTable.seasonId,
          playoffGotwPollsTable.weekIndex,
          playoffGotwPollsTable.matchupIndex,
        ],
        set: {
          discordId1:    awayId,
          discordId2:    homeId,
          teamName1:     g.awayTeamName,
          teamName2:     g.homeTeamName,
          pollMessageId: pollMsg.id,
          payoutIssuedAt: null,
        },
      });

      pollsPosted++;
    } catch (err) {
      console.error(`[playoff-runner] Failed to post poll for ${g.awayTeamName} vs ${g.homeTeamName}:`, err);
    }
  }

  return (
    `✅ **${label}** — ${pollsPosted}/${h2hGames.length} polls created${gotwChannelId ? ` in <#${gotwChannelId}>` : ""}.\n` +
    `Matchups posted${matchupsChannelId ? ` to <#${matchupsChannelId}>` : ""}. Payouts issue automatically on next advance.`
  );
}

// ── Playoff W/L payout (fires when leaving a playoff round) ───────────────────
// Awards per-win coins (+75 for top-4 seeds, +100 for wildcard seeds 5–7),
// elimination bonus (+50) to losers, and records playoff W/L in userRecordsTable.
// Uses franchiseProcessedGamesTable to guarantee idempotency (safe to call twice).

const PLAYOFF_WIN_BONUS_TOP4 = 75;
const PLAYOFF_WIN_BONUS_WC   = 100;
const PLAYOFF_LOSS_BONUS     = 50;

export async function payoutPlayoffRoundResults(
  client:  Client,
  season:  Season,
  weekKey: string,
  guildId: string = PRIMARY_GUILD_ID,
): Promise<string> {
  const meta = PLAYOFF_WEEK_META[weekKey];
  if (!meta) return `❌ Unknown playoff week: ${weekKey}`;

  const { weekIndex, fallbackWeekIndex, altWeekIndices, label } = meta;

  // ── Load already-processed playoff game IDs ─────────────────────────────
  const allProcessed = await db.select({ gameId: franchiseProcessedGamesTable.gameId })
    .from(franchiseProcessedGamesTable);
  const processedSet = new Set(allProcessed.map(r => r.gameId));

  // ── Build team-name → discordId map ─────────────────────────────────────
  const teamToDiscord = await buildTeamMap(season.id);

  // ── Fetch completed games for this playoff round ─────────────────────────
  // Try canonical weekIndex first, then raw fallback, then legacy alt values.
  let games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  season.id),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ));

  if (games.length === 0) {
    console.log(`[payout-runner] No games at weekIndex ${weekIndex}, trying fallback ${fallbackWeekIndex}...`);
    games = await db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId,  season.id),
        eq(franchiseScheduleTable.weekIndex, fallbackWeekIndex),
      ));
  }

  for (const alt of altWeekIndices) {
    if (games.length > 0) break;
    console.log(`[payout-runner] No games at fallback ${fallbackWeekIndex}, trying alt ${alt}...`);
    games = await db.select()
      .from(franchiseScheduleTable)
      .where(and(
        eq(franchiseScheduleTable.seasonId,  season.id),
        eq(franchiseScheduleTable.weekIndex, alt),
      ));
  }

  const effectiveWeekIndex = games[0]?.weekIndex ?? weekIndex;

  const completedH2H = games.filter(g =>
    g.status >= MIN_COMPLETED_STATUS &&
    g.homeScore != null &&
    g.awayScore != null &&
    teamToDiscord.has(toKey(g.homeTeamName)) &&
    teamToDiscord.has(toKey(g.awayTeamName)),
  );

  if (completedH2H.length === 0) {
    return (
      `⚠️ No completed H2H playoff games found for **${label}** ` +
      `(weekIndex ${weekIndex} / fallback ${fallbackWeekIndex}). ` +
      `Run \`/franchiseupdate\` to import results first.`
    );
  }

  // ── Load user data (seed for win-bonus rate, username for upsert) ────────
  const allUsers = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    team:            usersTable.team,
    playoffSeed:     usersTable.playoffSeed,
  }).from(usersTable);
  const discordToUser = new Map(allUsers.map(u => [u.discordId, u]));

  const lines:   string[] = [];
  const skipped: string[] = [];

  for (const g of completedH2H) {
    const gameId = `playoff-${season.id}-${effectiveWeekIndex}-${toKey(g.homeTeamName)}-${toKey(g.awayTeamName)}`;

    if (processedSet.has(gameId)) {
      skipped.push(`${g.awayTeamName} @ ${g.homeTeamName}`);
      continue;
    }

    const homeId = teamToDiscord.get(toKey(g.homeTeamName))!;
    const awayId = teamToDiscord.get(toKey(g.awayTeamName))!;
    const hs     = g.homeScore!;
    const as_    = g.awayScore!;

    if (hs === as_) continue; // playoff ties don't exist in Madden but guard anyway

    const winnerId   = hs > as_ ? homeId : awayId;
    const loserId    = hs > as_ ? awayId : homeId;
    const winnerTeam = hs > as_ ? g.homeTeamName : g.awayTeamName;
    const loserTeam  = hs > as_ ? g.awayTeamName : g.homeTeamName;
    const hiScore    = Math.max(hs, as_);
    const loScore    = Math.min(hs, as_);

    const winnerUser = discordToUser.get(winnerId);
    const loserUser  = discordToUser.get(loserId);

    // ── Determine win bonus from winner's playoff seed ──────────────────
    const seed = winnerUser?.playoffSeed ?? null;
    const winBonus = (seed !== null && seed >= 1 && seed <= 4)
      ? PLAYOFF_WIN_BONUS_TOP4
      : PLAYOFF_WIN_BONUS_WC;

    // ── Award coins ─────────────────────────────────────────────────────
    await addBalance(winnerId, winBonus, guildId);
    await logTransaction(winnerId, winBonus, "addcoins",
      `Playoff win vs ${loserTeam} — ${label} (${hiScore}–${loScore})`, guildId);

    await addBalance(loserId, PLAYOFF_LOSS_BONUS, guildId);
    await logTransaction(loserId, PLAYOFF_LOSS_BONUS, "addcoins",
      `Playoff elimination vs ${winnerTeam} — ${label} (${loScore}–${hiScore})`, guildId);

    // ── Update season playoff W/L in userRecordsTable ───────────────────
    // Upsert for winner
    const existingWinner = await db.select({ id: userRecordsTable.id })
      .from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)))
      .limit(1);

    if (existingWinner.length > 0) {
      await db.update(userRecordsTable)
        .set({
          playoffWins: sql`${userRecordsTable.playoffWins} + 1`,
          wins:        sql`${userRecordsTable.wins} + 1`,
          updatedAt:   new Date(),
        })
        .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)));
    } else {
      await db.insert(userRecordsTable).values({
        discordId:       winnerId,
        discordUsername: winnerUser?.discordUsername ?? "",
        team:            winnerUser?.team ?? null,
        seasonId:        season.id,
        playoffWins:     1,
        wins:            1,
      });
    }

    // Upsert for loser
    const existingLoser = await db.select({ id: userRecordsTable.id })
      .from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)))
      .limit(1);

    if (existingLoser.length > 0) {
      await db.update(userRecordsTable)
        .set({
          playoffLosses: sql`${userRecordsTable.playoffLosses} + 1`,
          losses:        sql`${userRecordsTable.losses} + 1`,
          updatedAt:     new Date(),
        })
        .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)));
    } else {
      await db.insert(userRecordsTable).values({
        discordId:       loserId,
        discordUsername: loserUser?.discordUsername ?? "",
        team:            loserUser?.team ?? null,
        seasonId:        season.id,
        playoffLosses:   1,
        losses:          1,
      });
    }

    // ── Super Bowl: also record SB win/loss (season + all-time) ────────
    if (weekKey === "superbowl") {
      // season SB W/L → userRecordsTable
      if (existingWinner.length > 0) {
        await db.update(userRecordsTable)
          .set({ superbowlWins: sql`${userRecordsTable.superbowlWins} + 1`, updatedAt: new Date() })
          .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)));
      } else {
        // row was just inserted above with playoffWins=1 but superbowlWins defaulted to 0 — patch it now
        await db.update(userRecordsTable)
          .set({ superbowlWins: 1, updatedAt: new Date() })
          .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)));
      }

      if (existingLoser.length > 0) {
        await db.update(userRecordsTable)
          .set({ superbowlLosses: sql`${userRecordsTable.superbowlLosses} + 1`, updatedAt: new Date() })
          .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)));
      } else {
        await db.update(userRecordsTable)
          .set({ superbowlLosses: 1, updatedAt: new Date() })
          .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)));
      }

      // all-time SB W/L → usersTable (per guild)
      await db.update(usersTable)
        .set({ allTimeSuperbowlWins: sql`${usersTable.allTimeSuperbowlWins} + 1`, updatedAt: new Date() })
        .where(and(eq(usersTable.discordId, winnerId), eq(usersTable.guildId, guildId)));

      await db.update(usersTable)
        .set({ allTimeSuperbowlLosses: sql`${usersTable.allTimeSuperbowlLosses} + 1`, updatedAt: new Date() })
        .where(and(eq(usersTable.discordId, loserId), eq(usersTable.guildId, guildId)));
    }

    // ── Mark game as processed ──────────────────────────────────────────
    await db.insert(franchiseProcessedGamesTable).values({
      gameId,
      payoutType:       "playoff",
      winnerDiscordId:  winnerId,
      loserDiscordId:   loserId,
      winnerCoins:      winBonus,
      loserCoins:       PLAYOFF_LOSS_BONUS,
      appliedPointDiff: hiScore - loScore,
      seasonIdRef:      season.id,
      weekIndexRef:     effectiveWeekIndex,
      homeTeamRef:      toKey(g.homeTeamName),
      awayTeamRef:      toKey(g.awayTeamName),
    }).onConflictDoNothing();

    processedSet.add(gameId);

    lines.push(
      `🏆 **${winnerTeam}** +${winBonus} 🪙 (${hiScore}–${loScore}) | ` +
      `**${loserTeam}** +${PLAYOFF_LOSS_BONUS} 🪙 (elim bonus)`,
    );

    // ── DM both players ─────────────────────────────────────────────────
    try {
      const wu = await client.users.fetch(winnerId).catch(() => null);
      if (wu) await wu.send(
        `🏆 **Playoff Win!** You defeated **${loserTeam}** in the **${label}** ` +
        `(${hiScore}–${loScore}) — **+${winBonus} 🪙 coins** added to your balance!\n` +
        `Your season playoff record has been updated.`
      ).catch(() => {});
    } catch (_) {}

    try {
      const lu = await client.users.fetch(loserId).catch(() => null);
      if (lu) await lu.send(
        `🏈 **Playoff Elimination.** You were eliminated by **${winnerTeam}** in the **${label}** ` +
        `(${loScore}–${hiScore}) — **+${PLAYOFF_LOSS_BONUS} 🪙 coins** added as an elimination bonus.\n` +
        `Your season playoff record has been updated.`
      ).catch(() => {});
    } catch (_) {}
  }

  if (lines.length === 0 && skipped.length > 0) {
    return `ℹ️ **${label}** playoff results already processed — ${skipped.length} game(s) skipped.`;
  }

  const skipNote = skipped.length > 0 ? `\n*(${skipped.length} already-processed game(s) skipped)*` : "";
  return `✅ **${label}** playoff payouts issued:\n${lines.join("\n")}${skipNote}`;
}

// ── Auto division winner bonus (fires at Week 18 → Wildcard advance) ──────────
// Awards the configured division_winner_bonus to every user whose playoff seed
// is 1–4 (division winners) in this guild.  If no seeds are set, posts a notice
// to the commissioner log channel and skips payouts.

export async function autoDivisionBonus(
  client:  Client,
  guildId: string = PRIMARY_GUILD_ID,
): Promise<string> {
  const bonusAmount = await getPayoutValue(PAYOUT_KEYS.DIVISION_WINNER_BONUS, guildId);

  const divisionWinners = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
    playoffSeed:     usersTable.playoffSeed,
    playoffConference: usersTable.playoffConference,
  })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.guildId, guildId),
        inArray(usersTable.playoffSeed, [1, 2, 3, 4]),
      ),
    );

  if (divisionWinners.length === 0) {
    const notice =
      "⚠️ **Division Winner Bonus — No Seeds Found**\n" +
      "Playoff seeds have not been set for this season. No division winner bonus was issued.\n" +
      "Seeds 1–4 in each conference are auto-set via the standings reseed that runs at this transition. " +
      "If the reseed failed or no standings data exists, set seeds manually and issue the bonus via the economy admin tools.";

    const commLogId = await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG);
    if (commLogId) {
      const ch = (
        client.channels.cache.get(commLogId) ??
        await client.channels.fetch(commLogId).catch(() => null)
      ) as TextChannel | null;
      if (ch?.isTextBased()) {
        await (ch as TextChannel).send({ content: notice }).catch(err =>
          console.error("[auto-division-bonus] Failed to post commissioner notice:", err),
        );
      }
    }

    console.warn("[auto-division-bonus] No playoff seeds found — bonus skipped, commissioner notified.");
    return "⚠️ No playoff seeds set — division bonus skipped, commissioner log notified.";
  }

  const lines: string[] = [];
  for (const winner of divisionWinners) {
    await addBalance(winner.discordId, bonusAmount, guildId);
    await logTransaction(
      winner.discordId, bonusAmount, "addcoins",
      `Division winner bonus (${winner.playoffConference ?? "?"} Seed #${winner.playoffSeed ?? "?"})`,
      guildId,
    );
    lines.push(
      `✅ <@${winner.discordId}> (${winner.playoffConference ?? "?"} Seed #${winner.playoffSeed ?? "?"}) → +**${bonusAmount} coins**`,
    );

    try {
      const u = await client.users.fetch(winner.discordId).catch(() => null);
      if (u) {
        await u.send(
          `🏆 **Division Winner Bonus!** You've been awarded **+${bonusAmount} coins** for winning your division this season!`,
        ).catch(() => {});
      }
    } catch (_) {}
  }

  return `🏆 Division winner bonuses issued:\n${lines.join("\n")}`;
}
