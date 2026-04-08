import {
  Client, Guild, EmbedBuilder, Colors, TextChannel,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseScheduleTable, usersTable, type Season } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import {
  scoreH2HMatchups, purgeChannel, purgeGotwChannel, autoPayoutGotwVoters,
} from "./gotw-helpers.js";

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

export async function runWeeklyMatchupsFlow(opts: RunWeeklyMatchupsOpts): Promise<void> {
  const { client, guild, season, displayWeekNum, payoutWeekIndex, replyFn } = opts;

  const displayWeekIndex = displayWeekNum - 1;
  const isPlayoff        = false; // regular-season only

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
      content: `📭 No matchups found for Week ${displayWeekNum}. Run \`/franchiseupdate\` first.`,
    });
    return;
  }

  // ── Team → Discord ID ──────────────────────────────────────────────────────
  const allUsers = await db.select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable);
  const teamToDiscord = new Map<string, string>();
  for (const u of allUsers) {
    if (u.team) teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
  }

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

  // ── Build reply content ────────────────────────────────────────────────────
  let replyContent =
    `✅ Week ${displayWeekNum} matchups posted to <#${MATCHUPS_CHANNEL_ID}>.\n` +
    `GOTW channel cleared.`;
  if (payoutSummary) {
    replyContent += `\n\n**Previous Week GOTW Payout:**\n${payoutSummary}`;
  }

  // ── Score H2H matchups for GOTW recommendation ─────────────────────────────
  let scored;
  try {
    scored = await scoreH2HMatchups(season.id, displayWeekIndex, games, teamToDiscord);
  } catch (err) {
    console.error("[weekly-runner] GOTW scoring error:", err);
  }

  if (!scored || scored.length === 0) {
    await replyFn({
      content: replyContent + `\n\n*No H2H matchups found for GOTW selection.*`,
    });
    return;
  }

  const top = scored[0]!;
  const cooldownNote = top.eligible ? "" : " *(all teams on cooldown — showing best available)*";

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gotw_confirm:${season.id}:${displayWeekIndex}:${top.awayDiscordId}:${top.homeDiscordId}`)
      .setLabel("✅ Confirm GOTW")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gotw_decline:${season.id}:${displayWeekIndex}`)
      .setLabel("❌ Choose Different")
      .setStyle(ButtonStyle.Secondary),
  );

  await replyFn({
    content:
      replyContent + `\n\n` +
      `**🏆 Recommended GOTW**${cooldownNote}\n` +
      `<@${top.awayDiscordId}> **${top.awayTeamName}** vs <@${top.homeDiscordId}> **${top.homeTeamName}**\n\n` +
      `Confirm this pick or choose a different game below:`,
    components: [confirmRow],
    ephemeral: true,
  });
}
