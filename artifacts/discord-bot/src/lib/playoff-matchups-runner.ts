import { Client, EmbedBuilder, Colors, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable, franchiseMcaTeamsTable, usersTable,
  playoffGotwPollsTable, type Season,
} from "@workspace/db";
import { eq, and, gte, lte } from "drizzle-orm";
import { purgeChannel, purgeGotwChannel, GOTW_CHANNEL_ID } from "./gotw-helpers.js";
import { cacheMatchupsForTwitter } from "./league-twitter.js";

const MATCHUPS_CHANNEL_ID  = "1478777175128932463";
const MIN_COMPLETED_STATUS = 2;

// ── Playoff week metadata ──────────────────────────────────────────────────────
// weekIndex: processSchedules offsets playoff games by +1000 (weekType !== 1 → 1000 + rawWeekIdx).
// syncWeekScoresToSchedule does the same: non-reg → 1000 + weekNum - 1.
// Madden sends a continuous weekIndex (0-based across the full season), so:
//   wildcard   rawWeekIdx=18  → stored as 1018  (weekNum 19, 1000+19-1=1018)
//   divisional rawWeekIdx=19  → stored as 1019  (weekNum 20, 1000+20-1=1019)
//   conference rawWeekIdx=20  → stored as 1020  (weekNum 21, 1000+21-1=1020)
//   superbowl  rawWeekIdx=22  → stored as 1022  (weekNum 23, 1000+23-1=1022)
// fallbackWeekIndex: the pre-1000-offset value, tried if primary lookup returns 0 rows.
export const PLAYOFF_WEEK_META: Record<string, {
  weekIndex:         number;
  fallbackWeekIndex: number;
  weekNum:           number;
  label:             string;
}> = {
  wildcard:   { weekIndex: 1018, fallbackWeekIndex: 18, weekNum: 19, label: "Wild Card"               },
  divisional: { weekIndex: 1019, fallbackWeekIndex: 19, weekNum: 20, label: "Divisional"              },
  conference: { weekIndex: 1020, fallbackWeekIndex: 20, weekNum: 21, label: "Conference Championship" },
  superbowl:  { weekIndex: 1022, fallbackWeekIndex: 22, weekNum: 23, label: "Super Bowl"              },
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
): Promise<string> {
  const meta = PLAYOFF_WEEK_META[weekKey];
  if (!meta) return `❌ Unknown playoff week: ${weekKey}`;

  const { weekIndex, fallbackWeekIndex, label } = meta;

  const teamToDiscord = await buildTeamMap(season.id);

  // 1. Fetch schedule for this playoff week.
  // Primary lookup uses the 1000-offset weekIndex (e.g. 1018 for wildcard).
  // Fallback tries the non-offset value (e.g. 18) in case the MCA export stored
  // playoff games with weekType=1 (no offset applied by processSchedules).
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

  const effectiveWeekIndex = games.length > 0 ? (games[0]?.weekIndex ?? weekIndex) : weekIndex;

  const h2hGames = games.filter(g =>
    teamToDiscord.has(toKey(g.awayTeamName)) &&
    teamToDiscord.has(toKey(g.homeTeamName)),
  );

  // 2. Clear GOTW channel
  await purgeGotwChannel(client).catch(err =>
    console.error("[playoff-runner] GOTW purge error:", err),
  );

  // 3. Clear & post matchup embed to matchups channel
  const matchupsCh = (client.channels.cache.get(MATCHUPS_CHANNEL_ID)
    ?? await client.channels.fetch(MATCHUPS_CHANNEL_ID).catch(() => null)) as TextChannel | null;

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
  const gotwCh = (client.channels.cache.get(GOTW_CHANNEL_ID)
    ?? await client.channels.fetch(GOTW_CHANNEL_ID).catch(() => null)) as TextChannel | null;

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
    `✅ **${label}** — ${pollsPosted}/${h2hGames.length} polls created in <#${GOTW_CHANNEL_ID}>.\n` +
    `Matchups posted to <#${MATCHUPS_CHANNEL_ID}>. Payouts issue automatically on next advance.`
  );
}
