import { Client, EmbedBuilder, Colors, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable, franchiseMcaTeamsTable, usersTable,
  playoffGotwPollsTable, type Season,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { purgeChannel, purgeGotwChannel, GOTW_CHANNEL_ID } from "./gotw-helpers.js";
import { cacheMatchupsForTwitter } from "./league-twitter.js";

const MATCHUPS_CHANNEL_ID  = "1478777175128932463";
const MIN_COMPLETED_STATUS = 2;

// ── Playoff week metadata ──────────────────────────────────────────────────────
// weekIndex mirrors the per-week EA export endpoint (weekType="reg", weekNum=N → weekIndex=N-1).
// wildcard=19-1=18, divisional=20-1=19, conference=21-1=20, superbowl=23-1=22
export const PLAYOFF_WEEK_META: Record<string, {
  weekIndex: number;
  weekNum:   number;
  label:     string;
}> = {
  wildcard:   { weekIndex: 18, weekNum: 19, label: "Wild Card"               },
  divisional: { weekIndex: 19, weekNum: 20, label: "Divisional"              },
  conference: { weekIndex: 20, weekNum: 21, label: "Conference Championship" },
  superbowl:  { weekIndex: 22, weekNum: 23, label: "Super Bowl"              },
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

  const { weekIndex, label } = meta;

  const teamToDiscord = await buildTeamMap(season.id);

  // 1. Fetch schedule for this playoff week
  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  season.id),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ));

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
      `⚠️ **${label}** matchups embed posted, but no H2H games found at weekIndex ${weekIndex}.\n` +
      `Make sure the EA playoff schedule export has been imported via \`/franchiseupdate\`.`
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
        weekIndex,
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
