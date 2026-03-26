import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { payoutRequestsTable, interviewRequestsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

export const INTERVIEW_PAYOUT = 10;

export const data = new SlashCommandBuilder()
  .setName("interviewrequest")
  .setDescription(`Submit a post-game interview to earn ${INTERVIEW_PAYOUT} coins — one per week, after reporting a game`);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
  const requester     = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const requesterTeam = requester.team ?? interaction.user.username;

  // Get current league week
  const season      = await getOrCreateActiveSeason();
  const currentWeek = (season as any).currentWeek ?? "1";
  const weekDisplay = weekLabel(currentWeek);

  // ── Rule 1: Must have submitted a game score this week ────────────────────
  const gameThisWeek = await db.select({
    id:       payoutRequestsTable.id,
    gameType: payoutRequestsTable.gameType,
  })
    .from(payoutRequestsTable)
    .where(and(
      eq(payoutRequestsTable.requesterId, interaction.user.id),
      eq(payoutRequestsTable.week, currentWeek),
    ))
    .limit(1);

  if (gameThisWeek.length === 0) {
    await interaction.editReply({
      content: [
        `❌ **No game submitted for ${weekDisplay} yet.**`,
        `You need to report a game with \`/reportscore\` before requesting an interview for this week.`,
      ].join("\n"),
    });
    return;
  }

  // ── Rule 2: Only one interview per week ───────────────────────────────────
  const interviewThisWeek = await db.select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
    .from(interviewRequestsTable)
    .where(and(
      eq(interviewRequestsTable.discordId, interaction.user.id),
      eq(interviewRequestsTable.week, currentWeek),
      inArray(interviewRequestsTable.status, ["pending", "approved"]),
    ))
    .limit(1);

  if (interviewThisWeek.length > 0) {
    const dupe = interviewThisWeek[0]!;
    const stateLabel = dupe.status === "approved" ? "already been approved" : "already been submitted and is pending review";
    await interaction.editReply({
      content: [
        `⚠️ **Interview already submitted for ${weekDisplay}.**`,
        `Your interview request has ${stateLabel} (Interview #\`${dupe.id}\`).`,
        `Only one interview is allowed per week.`,
      ].join("\n"),
    });
    return;
  }

  // ── All clear — create the interview request ──────────────────────────────
  const linkedReport = gameThisWeek[0]!;

  // Mark the linked score report's interview slot as claimed
  await db.update(payoutRequestsTable)
    .set({ interviewClaimed: true })
    .where(eq(payoutRequestsTable.id, linkedReport.id));

  const [interview] = await db.insert(interviewRequestsTable).values({
    discordId:       interaction.user.id,
    payoutRequestId: linkedReport.id,
    week:            currentWeek,
    status:          "pending",
  }).returning();

  const interviewId = interview!.id;

  // Build game context from the linked score report
  const fullReport = await db.select().from(payoutRequestsTable).where(eq(payoutRequestsTable.id, linkedReport.id)).limit(1);
  const report = fullReport[0];

  const gameTypeLabel = (report?.gameType ?? "cpu") === "cpu" ? "CPU Game" : "H2H Game";
  const myTeam   = report?.requesterTeam ?? requesterTeam;
  const oppTeam  = report?.opponentTeam  ?? "Unknown";
  const myScore  = report?.requesterScore ?? "?";
  const oppScore = report?.opponentScore  ?? "?";

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎙️ Post-Game Interview Request")
    .addFields(
      { name: "Player",    value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
      { name: "Week",      value: weekDisplay,  inline: true },
      { name: "Game Type", value: gameTypeLabel, inline: true },
      { name: "Game",      value: `**${myTeam}** ${myScore} – ${oppScore} **${oppTeam}**` },
      { name: "Payout if Approved", value: `+**${INTERVIEW_PAYOUT} coins**` },
    )
    .setFooter({ text: `Interview #${interviewId} • linked to Score Report #${linkedReport.id}` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`interview_approve:${interviewId}`)
      .setLabel("✅ Approve Interview")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`interview_deny:${interviewId}`)
      .setLabel("❌ Deny")
      .setStyle(ButtonStyle.Danger),
  );

  try {
    const channel = await interaction.client.channels.fetch(commChannelId);
    if (channel?.isTextBased()) {
      const msg = await (channel as any).send({ embeds: [embed], components: [row] });
      await db.update(interviewRequestsTable)
        .set({ discordMessageId: msg.id })
        .where(eq(interviewRequestsTable.id, interviewId));
    }
  } catch (err) {
    console.error("Failed to post interview request to commissioner channel:", err);
  }

  await interaction.editReply({
    content: `🎙️ Your interview request for **${weekDisplay}** has been sent! (Interview #\`${interviewId}\`)\nYou'll be notified once the commissioner reviews it.`,
  });
}
