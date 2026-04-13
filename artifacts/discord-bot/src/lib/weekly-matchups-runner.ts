import {
  Client, Guild, EmbedBuilder, Colors, TextChannel,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, franchiseMcaTeamsTable, usersTable, type Season } from "@workspace/db";
import { eq, and, asc, isNotNull } from "drizzle-orm";
import {
  scoreH2HMatchups, purgeChannel, purgeGotwChannel, autoPayoutGotwVoters,
} from "./gotw-helpers.js";
import { cacheMatchupsForTwitter } from "./league-twitter.js";
import { getRosterSeasonId } from "./db-helpers.js";

const MATCHUPS_CHANNEL_ID  = "1478777175128932463";
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
}

/**
 * Build a team-name → discordId map from franchise_mca_teams.
 * Indexes by BOTH fullName and nickName so schedule team names match correctly.
 * Falls back to the most recent season with roster data if the active season
 * has no MCA team entries yet (e.g. right after a new-season advance).
 * Exported so the GOTW decline handler can use the same map-building logic.
 */
export async function buildTeamToDiscord(): Promise<Map<string, string>> {
  const rosterSeasonId = await getRosterSeasonId();
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

  // Also add economy_users short names as a secondary fallback
  if (map.size === 0) {
    const allUsers = await db
      .select({ discordId: usersTable.discordId, team: usersTable.team })
      .from(usersTable);
    for (const u of allUsers) {
      if (u.team) map.set(u.team.toLowerCase().trim(), u.discordId);
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

  const displayWeekIndex = displayWeekNum - 1;
  const isPlayoff        = false;

  let payoutSummary = "";

  // ── Parallel: payout previous week voters + clear GOTW channel ─────────────
  const [payout] = await Promise.all([
    payoutWeekIndex != null && payoutWeekIndex >= 0
      ? autoPayoutGotwVoters(client, guild, season.id, payoutWeekIndex, payoutWeekIndex + 1, isPlayoff)
          .catch((err: unknown) => {
            console.error("[weekly-runner] GOTW auto-payout error:", err);
            return `❌ GOTW auto-payout failed`;
          })
      : Promise.resolve(""),
    purgeGotwChannel(client).catch((err: unknown) =>
      console.error("[weekly-runner] GOTW purge error:", err),
    ),
  ]);
  payoutSummary = payout ?? "";

  // ── Fetch schedule for display week ────────────────────────────────────────
  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  season.id),
      eq(franchiseScheduleTable.weekIndex, displayWeekIndex),
    ))
    .orderBy(asc(franchiseScheduleTable.id));

  if (games.length === 0) {
    await replyFn({
      content: `📭 No matchups found for Week ${displayWeekNum}. Run \`/franchiseupdate\` first, then use \`/admin-gotw post week:${displayWeekNum}\` to retry the GOTW prompt.`,
    });
    return;
  }

  // ── Build team → Discord ID from franchise_mca_teams ──────────────────────
  // Uses fullName + nickName so MCA schedule names match correctly.
  const teamToDiscord = await buildTeamToDiscord();

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

  // ── Clear & post to matchups channel ──────────────────────────────────────
  const targetCh = client.channels.cache.get(MATCHUPS_CHANNEL_ID)
    ?? await client.channels.fetch(MATCHUPS_CHANNEL_ID).catch(() => null);

  if (!targetCh?.isTextBased()) {
    await replyFn({ content: `❌ Cannot find matchups channel (\`${MATCHUPS_CHANNEL_ID}\`).` });
    return;
  }

  try {
    const cleared = await purgeChannel(targetCh as TextChannel);
    if (cleared > 0) console.log(`[weekly-runner] Cleared ${cleared} message(s) from matchups channel`);
  } catch (err) {
    console.error("[weekly-runner] Failed to clear matchups channel:", err);
  }

  await (targetCh as TextChannel).send({ embeds: [embed] });

  // Cache matchup list for League Twitter
  await cacheMatchupsForTwitter(
    season.id,
    `Week ${displayWeekNum}`,
    games.map(g => ({ homeTeamName: g.homeTeamName, awayTeamName: g.awayTeamName })),
  );

  // ── Build reply base + send GOTW prompt ───────────────────────────────────
  let baseContent =
    `✅ Week ${displayWeekNum} matchups posted to <#${MATCHUPS_CHANNEL_ID}>.\n` +
    `GOTW channel cleared.`;
  if (payoutSummary) {
    baseContent += `\n\n**Previous Week GOTW Payout:**\n${payoutSummary}`;
  }

  await runGotwPrompt({ season, weekNum: displayWeekNum, teamToDiscord, games, baseContent, replyFn });
}
