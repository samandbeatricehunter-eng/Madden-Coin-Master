import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable, usersTable, seasonsTable,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import {
  scoreH2HMatchups, purgeChannel, purgeGotwChannel, autoPayoutGotwVoters,
} from "../lib/gotw-helpers.js";

const MATCHUPS_CHANNEL_ID  = "1478777175128932463";
const MIN_COMPLETED_STATUS = 2; // 1=upcoming, 2=CPU-completed, 3=H2H-completed

const PLAYOFF_WEEKS = new Set(["wildcard", "divisional", "conference", "superbowl"]);

export const data = new SlashCommandBuilder()
  .setName("weeklymatchups")
  .setDescription("Admin: post this week's matchups (or results) publicly, then confirm GOTW")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // ── Active season ──────────────────────────────────────────────────────────
  const [season] = await db.select()
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found." });
    return;
  }

  const currentWeekStr = season.currentWeek ?? "1";
  const currentWeekNum = parseInt(currentWeekStr, 10);
  if (isNaN(currentWeekNum) || currentWeekNum < 1 || currentWeekNum > 18) {
    await interaction.editReply({
      content: `⚠️ League is on **${currentWeekStr}** (not a regular-season week). Use \`/advanceweek\` first.`,
    });
    return;
  }

  const weekIndex   = currentWeekNum - 1;
  const isPlayoff   = PLAYOFF_WEEKS.has(currentWeekStr.toLowerCase());

  // ── Clear GOTW channel + auto-payout previous week's voters ───────────────
  // These run in parallel — clear is cosmetic, payout is the important part.
  const [payoutSummary] = await Promise.all([
    // Auto-pay voters from the previous week's GOTW (weekIndex - 1)
    weekIndex > 0
      ? autoPayoutGotwVoters(
          interaction.client,
          interaction.guild,
          season.id,
          weekIndex - 1,
          currentWeekNum - 1,
          isPlayoff,
        ).catch(err => {
          console.error("[weeklymatchups] GOTW auto-payout error:", err);
          return `❌ GOTW auto-payout failed: ${err}`;
        })
      : Promise.resolve(""),
    // Wipe the GOTW channel (all messages)
    purgeGotwChannel(interaction.client).catch(err =>
      console.error("[weeklymatchups] GOTW channel purge error:", err),
    ),
  ]);

  // ── Schedule for this week ─────────────────────────────────────────────────
  const games = await db.select()
    .from(franchiseScheduleTable)
    .where(and(
      eq(franchiseScheduleTable.seasonId,  season.id),
      eq(franchiseScheduleTable.weekIndex, weekIndex),
    ))
    .orderBy(asc(franchiseScheduleTable.id));

  if (games.length === 0) {
    await interaction.editReply({
      content: `📭 No matchups found for Week ${currentWeekNum}. Run \`/franchiseupdate\` first.`,
    });
    return;
  }

  // ── Team → Discord ID lookup ───────────────────────────────────────────────
  const allUsers = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  }).from(usersTable);

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
    const awayMention = mention(g.awayTeamName);
    const homeMention = mention(g.homeTeamName);

    if (g.status >= MIN_COMPLETED_STATUS && g.homeScore != null && g.awayScore != null) {
      const hs  = g.homeScore;
      const as_ = g.awayScore;
      if (hs === as_) {
        lines.push(`🤝 ${awayMention} **${as_}** — **${hs}** ${homeMention} *(Tie)*`);
      } else if (hs > as_) {
        lines.push(`🏆 ${awayMention} ${as_} — **${hs}** ${homeMention} ✅`);
      } else {
        lines.push(`🏆 ${awayMention} **${as_}** — ${hs} ${homeMention} ✅`);
      }
    } else {
      lines.push(`📅 ${awayMention} @ ${homeMention}`);
    }
  }

  // ── Build and post matchups embed ──────────────────────────────────────────
  const played   = games.filter(g => g.status >= MIN_COMPLETED_STATUS).length;
  const upcoming = games.length - played;
  const footerParts: string[] = [];
  if (played > 0)   footerParts.push(`${played} game${played > 1 ? "s" : ""} played`);
  if (upcoming > 0) footerParts.push(`${upcoming} upcoming`);

  const embed = new EmbedBuilder()
    .setColor(played === games.length ? Colors.Green : Colors.Blue)
    .setTitle(`🏈 Week ${currentWeekNum} Matchups — Season ${season.seasonNumber}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: footerParts.join(" · ") || "No games" })
    .setTimestamp();

  // ── Clear matchups channel ─────────────────────────────────────────────────
  const targetChannel = interaction.client.channels.cache.get(MATCHUPS_CHANNEL_ID)
    ?? await interaction.client.channels.fetch(MATCHUPS_CHANNEL_ID).catch(() => null);

  if (!targetChannel?.isTextBased()) {
    await interaction.editReply({ content: `❌ Cannot find matchups channel (\`${MATCHUPS_CHANNEL_ID}\`).` });
    return;
  }

  try {
    const cleared = await purgeChannel(targetChannel as TextChannel);
    if (cleared > 0) {
      console.log(`[weeklymatchups] Cleared ${cleared} old message(s) from matchups channel`);
    }
  } catch (err) {
    console.error("[weeklymatchups] Failed to clear matchups channel:", err);
  }

  await (targetChannel as TextChannel).send({ embeds: [embed] });

  // ── Build admin reply (include payout summary + GOTW prompt) ───────────────
  let replyContent =
    `✅ Week ${currentWeekNum} matchups posted to <#${MATCHUPS_CHANNEL_ID}>.\n` +
    `GOTW channel cleared.`;

  if (payoutSummary) {
    replyContent += `\n\n**Previous Week GOTW Payout:**\n${payoutSummary}`;
  }

  // ── Compute GOTW scored matchups ───────────────────────────────────────────
  let scored;
  try {
    scored = await scoreH2HMatchups(season.id, weekIndex, games, teamToDiscord);
  } catch (err) {
    console.error("[weeklymatchups] GOTW scoring error:", err);
  }

  if (!scored || scored.length === 0) {
    await interaction.editReply({
      content: replyContent + `\n\n*No H2H matchups found for GOTW selection.*`,
    });
    return;
  }

  const top = scored[0]!;
  const cooldownNote = top.eligible ? "" : " *(all teams on cooldown — showing best available)*";

  // ── Prompt admin to confirm GOTW ───────────────────────────────────────────
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

  await interaction.editReply({
    content:
      replyContent + `\n\n` +
      `**🏆 Recommended GOTW**${cooldownNote}\n` +
      `<@${top.awayDiscordId}> **${top.awayTeamName}** vs <@${top.homeDiscordId}> **${top.homeTeamName}**\n\n` +
      `Confirm this pick or choose a different game below:`,
    components: [confirmRow],
  });
}
