import {
  SlashCommandBuilder, ChatInputCommandInteraction, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { interviewRequestsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

export const INTERVIEW_PAYOUT = 10;

export const INTERVIEW_QUESTIONS: string[] = [
  "What do you think was the biggest factor in today's result?",
  "How would you assess your team's overall performance?",
  "What adjustments did you make during the game?",
  "What stood out to you the most about your opponent?",
  "Where do you feel your team improved compared to last game?",
  "What areas still need the most work moving forward?",
  "How did your game plan evolve as the game progressed?",
  "What was the turning point in this matchup?",
  "How did you handle adversity during the game?",
  "What does this result say about your team right now?",
  "How do you keep your team focused week to week?",
  "What message did you give your team before kickoff?",
  "What message did you give your team after the game?",
  "How important was execution in today's outcome?",
  "What role did momentum play in this game?",
  "How do you evaluate your performance as a coach/player today?",
  "What's something fans might not see that impacted this game?",
  "How did preparation show up on the field today?",
  "What did you learn about your team from this game?",
  "How do you build consistency going forward?",
  "What's your mindset heading into the next matchup?",
  "How do you respond to a game like this?",
  "What challenges did your opponent present?",
  "How did your team respond to those challenges?",
  "What part of your game plan worked best?",
  "What part didn't go as expected?",
  "How do you balance aggression and discipline in games like this?",
  "What does this game reveal about your team's identity?",
  "How do you keep improving as the season progresses?",
  "What kind of standard are you holding your team to?",
  "How do you stay composed in high-pressure moments?",
  "What was your focus coming into this game?",
  "How do you evaluate success beyond just the scoreboard?",
  "What does your team need to clean up immediately?",
  "How do you prepare for different styles of opponents?",
  "What impact did execution have on key moments?",
  "How do you keep your team motivated throughout the season?",
  "What's your biggest takeaway from this performance?",
  "How do you build on this result moving forward?",
  "What does this game mean for your team's trajectory?",
  "How do you approach adjustments between games?",
  "What challenges do you anticipate next week?",
  "How do you keep your team locked in during tough stretches?",
  "What role does leadership play in games like this?",
  "How do you handle expectations from week to week?",
  "What are you emphasizing in practice after this game?",
  "How do you measure progress throughout the season?",
  "What does a complete performance look like for your team?",
  "How do you plan to carry momentum forward (or bounce back)?",
  "What should people expect from your team going forward?",
];

export function pickThreeIndices(poolSize: number): [number, number, number] {
  const indices = new Set<number>();
  while (indices.size < 3) {
    indices.add(Math.floor(Math.random() * poolSize));
  }
  const [a, b, c] = [...indices];
  return [a!, b!, c!];
}

export const data = new SlashCommandBuilder()
  .setName("interviewrequest")
  .setDescription(`Submit a weekly interview for ${INTERVIEW_PAYOUT} coins — one per in-game week`);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const requester     = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const requesterTeam = requester.team ?? interaction.user.username;

  const season      = await getOrCreateActiveSeason();
  const currentWeek = (season as any).currentWeek ?? "1";
  const weekDisplay = weekLabel(currentWeek);

  // ── One interview per in-game week ────────────────────────────────────────
  const interviewThisWeek = await db
    .select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
    .from(interviewRequestsTable)
    .where(and(
      eq(interviewRequestsTable.discordId, interaction.user.id),
      eq(interviewRequestsTable.week, currentWeek),
      inArray(interviewRequestsTable.status, ["pending", "approved"]),
    ))
    .limit(1);

  if (interviewThisWeek.length > 0) {
    const dupe       = interviewThisWeek[0]!;
    const stateLabel = dupe.status === "approved"
      ? "already been approved"
      : "already been submitted and is pending review";
    await interaction.editReply({
      content: [
        `⚠️ **Interview already submitted for ${weekDisplay}.**`,
        `Your interview has ${stateLabel} (Interview #\`${dupe.id}\`).`,
        `Only one interview is allowed per week.`,
      ].join("\n"),
    });
    return;
  }

  // ── Pick 3 unique questions from the pool ─────────────────────────────────
  const [i1, i2, i3] = pickThreeIndices(INTERVIEW_QUESTIONS.length);
  const q1 = INTERVIEW_QUESTIONS[i1]!;
  const q2 = INTERVIEW_QUESTIONS[i2]!;
  const q3 = INTERVIEW_QUESTIONS[i3]!;
  const indicesStr = `${i1},${i2},${i3}`;

  // ── Show questions + Submit button ────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎙️ Post-Game Interview")
    .setDescription(
      `Here are your **3 interview questions** for **${weekDisplay}**.\n` +
      `Click **Submit Your Answers** to fill them in — you'll have time to type each one.\n\n` +
      `*Questions are selected randomly from a pool of ${INTERVIEW_QUESTIONS.length}.*`,
    )
    .addFields(
      { name: "Q1", value: q1 },
      { name: "Q2", value: q2 },
      { name: "Q3", value: q3 },
    )
    .setFooter({ text: `${requesterTeam} • ${weekDisplay}` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`interview_answer:${interaction.user.id}:${indicesStr}`)
      .setLabel("📝 Submit Your Answers")
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}
