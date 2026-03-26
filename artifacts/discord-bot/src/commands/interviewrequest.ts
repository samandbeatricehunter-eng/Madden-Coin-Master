import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { payoutRequestsTable, interviewRequestsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getOrCreateUser } from "../lib/db-helpers.js";

export const INTERVIEW_PAYOUT = 10;

export const data = new SlashCommandBuilder()
  .setName("interviewrequest")
  .setDescription(`Submit a post-game interview to earn ${INTERVIEW_PAYOUT} coins — one per game reported`);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
  const requester = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const requesterTeam = requester.team ?? interaction.user.username;

  // Find the most recent score report where this user hasn't yet claimed an interview
  const unclaimedReports = await db.select()
    .from(payoutRequestsTable)
    .where(and(
      eq(payoutRequestsTable.requesterId, interaction.user.id),
      eq(payoutRequestsTable.interviewClaimed, false),
    ))
    .orderBy(desc(payoutRequestsTable.createdAt))
    .limit(1);

  if (unclaimedReports.length === 0) {
    await interaction.editReply({
      content: [
        "❌ **No eligible game found.**",
        "You can only submit one interview per game.",
        "Report your next game with `/reportscore` to become eligible again.",
      ].join("\n"),
    });
    return;
  }

  const scoreReport = unclaimedReports[0]!;

  // Mark this score report's interview slot as claimed immediately so they can't double-submit
  await db.update(payoutRequestsTable)
    .set({ interviewClaimed: true })
    .where(eq(payoutRequestsTable.id, scoreReport.id));

  // Create the interview request record
  const [interview] = await db.insert(interviewRequestsTable).values({
    discordId:       interaction.user.id,
    payoutRequestId: scoreReport.id,
    status:          "pending",
  }).returning();

  const interviewId = interview!.id;

  // Build game context line from the linked score report
  const gameTypeLabel = scoreReport.gameType === "cpu" ? "CPU Game" : "H2H Game";
  const myTeam   = scoreReport.requesterTeam ?? requesterTeam;
  const oppTeam  = scoreReport.opponentTeam  ?? "Unknown";
  const myScore  = scoreReport.requesterScore ?? "?";
  const oppScore = scoreReport.opponentScore  ?? "?";

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎙️ Post-Game Interview Request")
    .addFields(
      { name: "Player",    value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
      { name: "Game Type", value: gameTypeLabel, inline: true },
      { name: "Game",      value: `**${myTeam}** ${myScore} – ${oppScore} **${oppTeam}**` },
      { name: "Payout if Approved", value: `+**${INTERVIEW_PAYOUT} coins**` },
    )
    .setFooter({ text: `Interview #${interviewId} • linked to Score Report #${scoreReport.id}` })
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
    content: `🎙️ Your post-game interview request has been sent! (Interview #\`${interviewId}\`)\nYou'll be notified once the commissioner reviews it.`,
  });
}
