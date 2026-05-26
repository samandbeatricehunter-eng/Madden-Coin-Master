import {
  Client, Guild, EmbedBuilder, Colors, TextChannel,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, franchiseMcaTeamsTable, usersTable, type Season } from "@workspace/db";
import { eq, and, asc, isNotNull } from "drizzle-orm";
import {
  scoreH2HMatchups, purgeChannel, purgeGotwChannel,
} from "../helpers/gotw-helpers.js";
import { getRosterSeasonId, getScheduleSeasonId, PRIMARY_GUILD_ID } from "../db/db-helpers.js";
const MIN_COMPLETED_STATUS = 2;

export type MatchupsReplyFn = (opts: {
  content: string;
  components?: ActionRowBuilder<ButtonBuilder>[];
  ephemeral?: boolean;
}) => Promise<void>;

export interface RunWeeklyMatchupsOpts {
  client:          Client;
  guild:           Guild | null;
  season:          Season;
  displayWeekNum:  number;
  payoutWeekIndex: number | null;
  replyFn:         MatchupsReplyFn;
  guildId?:        string;
}

/**
 * Build a team-name → discordId map from franchise_mca_teams.
 * Indexes by BOTH fullName and nickName so schedule team names match correctly.
 * Falls back to the most recent season with roster data if the active season
 * has no MCA team entries yet (e.g. right after a new-season advance).
 * Exported so the GOTW decline handler can use the same map-building logic.
 */
export async function buildTeamToDiscord(guildId: string = PRIMARY_GUILD_ID): Promise<Map<string, string>> {
  const rosterSeasonId = await getRosterSeasonId(guildId);
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
      map.set(t.fullName.toLowerCase().trim(), t.discordId);
      map.set(t.nickName.toLowerCase().trim(), t.discordId);
    }
  }

  // Always supplement MCA data with economy_users team names (guild-scoped).
  // MCA entries take priority; economy_users only fill slots not already mapped.
  // This covers partial MCA setups where some teams have no discord ID assigned.
  const allUsers = await db
    .select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable)
    .where(eq(usersTable.guildId, guildId));
  for (const u of allUsers) {
    if (u.team) {
      const key = u.team.toLowerCase().trim();
      if (!map.has(key)) map.set(key, u.discordId);
    }
  }

  return map;
}

/**
 * Score H2H matchups for a week and send the commissioner the GOTW
 * selection prompt (confirm / choose-different buttons).
 *
 * Extracted so it can be called both from runWeeklyMatchupsFlow (auto)
 * and from the /admin-gotw post manual retry command.
 */
export async function runGotwPrompt(opts: {
  season:        Season;
  weekNum:       number;
  teamToDiscord: Map<string, string>;
  games:         Array<{ awayTeamName: string; homeTeamName: string }>;
  baseContent:   string;
  replyFn:       MatchupsReplyFn;
}): Promise<void> {
  const { season, weekNum, teamToDiscord, games, baseContent, replyFn } = opts;
  const weekIndex = weekNum - 1;

  let scored;
  try {
    scored = await scoreH2HMatchups(season.id, weekIndex, games, teamToDiscord);
  } catch (err) {
    console.error("[weekly-runner] GOTW scoring error:", err);
  }

  if (!scored || scored.length === 0) {
    await replyFn({
      content: baseContent + `\n\n⚠️ No H2H matchups found for GOTW selection. Make sure both teams in at least one game are registered members.`,
    });
    return;
  }

  const top = scored[0]!;
  const cooldownNote = top.eligible ? "" : " *(all teams on cooldown — showing best available)*";

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gotw_confirm:${season.id}:${weekIndex}:${top.awayDiscordId}:${top.homeDiscordId}`)
      .setLabel("✅ Confirm GOTW")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gotw_decline:${season.id}:${weekIndex}`)
      .setLabel("❌ Choose Different")
      .setStyle(ButtonStyle.Secondary),
  );

  await replyFn({
    content:
      baseContent + `\n\n` +
      `**🏆 Recommended GOTW${cooldownNote}**\n` +
      `<@${top.awayDiscordId}> **${top.awayTeamName}** vs <@${top.homeDiscordId}> **${top.homeTeamName}**\n\n` +
      `Confirm this pick or choose a different game:`,
    components: [confirmRow],
    ephemeral: true,
  });
}

export async function runWeeklyMatchupsFlow(opts: RunWeeklyMatchupsOpts): Promise<void> {
  const { client, guild, season, displayWeekNum, payoutWeekIndex, replyFn } = opts;
  const resolvedGuildId = opts.guildId ?? PRIMARY_GUILD_ID;

  const displayWeekIndex = displayWeekNum - 1;

  // GOTW payouts no longer happen here — they're settled per-game when the
  // winner is confirmed by import/game result flow. Gameday now uses one
  // league-wide weekly channel instead of per-matchup private channels. The previous-week voter readback from
  // the Discord poll is dead — in-menu voting writes to gotw_votes directly.
  void payoutWeekIndex;

  // Clear GOTW channel of any prior announcement before posting this week's.
  await purgeGotwChannel(client, resolvedGuildId).catch((err: unknown) =>
    console.error("[weekly-runner] GOTW purge error:", err),
  );

  // ── Fetch schedule for display week ────────────────────────────────────────
  // Use getScheduleSeasonId so we fall back to the most recent season with
  // schedule data when the active season hasn't had its schedule imported yet.
  const scheduleSeasonId = await getScheduleSeasonId(resolvedGuildId);
  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  scheduleSeasonId),
      eq(franchiseScheduleTable.weekIndex, displayWeekIndex),
    ))
    .orderBy(asc(franchiseScheduleTable.id));

  if (games.length === 0) {
    await replyFn({
      content: `📭 No matchups found for Week ${displayWeekNum}. Run \`/franchiseupdate\` first, then use \`/admin-gotw post week:${displayWeekNum}\` to retry the GOTW prompt.`,
    });
    return;
  }

  // Deduplicate by canonical pair: EA sometimes stores both (A home, B away) AND
  // (B home, A away) as separate rows for the same real game. Collapse them here,
  // preferring whichever row has the higher status (played over upcoming), then
  // the higher DB id (more recently imported) as a tiebreaker.
  {
    const canonMap = new Map<string, typeof games[0]>();
    for (const g of games) {
      const key = `${Math.min(g.homeTeamId, g.awayTeamId)}-${Math.max(g.homeTeamId, g.awayTeamId)}`;
      const ex  = canonMap.get(key);
      if (!ex || g.status > ex.status || (g.status === ex.status && g.id > ex.id)) {
        canonMap.set(key, g);
      }
    }
    games.splice(0, games.length, ...[...canonMap.values()].sort((a, b) => a.id - b.id));
  }

  // ── Build team → Discord ID from franchise_mca_teams ──────────────────────
  // Uses fullName + nickName so MCA schedule names match correctly.
  const teamToDiscord = await buildTeamToDiscord(resolvedGuildId);

  function mention(teamName: string): string {
    const id = teamToDiscord.get(teamName.toLowerCase().trim());
    return id ? `<@${id}>` : `**${teamName}**`;
  }

  // ── Format matchup lines ───────────────────────────────────────────────────
  const lines: string[] = [];
  for (const g of games) {
    const awayM = mention(g.awayTeamName);
    const homeM = mention(g.homeTeamName);
    if (g.status >= MIN_COMPLETED_STATUS && g.homeScore != null && g.awayScore != null) {
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

  const played   = games.filter(g => g.status >= MIN_COMPLETED_STATUS).length;
  const upcoming = games.length - played;
  const footerParts = [
    played   > 0 ? `${played} game${played > 1 ? "s" : ""} played` : "",
    upcoming > 0 ? `${upcoming} upcoming` : "",
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(played === games.length ? Colors.Green : Colors.Blue)
    .setTitle(`🏈 Week ${displayWeekNum} Matchups — Season ${season.seasonNumber}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: footerParts.join(" · ") || "No games" })
    .setTimestamp();

  // Matchup auto-post has been DISABLED — matchups are stored in the DB and
  // displayed in per-game private channels instead. We no longer require the
  // matchups channel to even exist, so the weekly flow can't be blocked by
  // a missing/misconfigured channel link.
  void embed;

  // ── Build reply base + send GOTW prompt ───────────────────────────────────
  let baseContent =
    `✅ Week ${displayWeekNum} matchups recorded (auto-post disabled — private channels carry the matchup).\n` +
    `GOTW seeded.`;

  await runGotwPrompt({ season, weekNum: displayWeekNum, teamToDiscord, games, baseContent, replyFn });
}
