import {
  SlashCommandBuilder, ChatInputCommandInteraction, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { interviewRequestsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../db/db-helpers.js";
import { weekLabel } from "../helpers/week-helpers.js";

export const INTERVIEW_PAYOUT = 10;

export type InterviewType = "pregame" | "postgame" | "general";

export const PREGAME_QUESTIONS: string[] = [
  "How has your team prepared for this week's matchup?",
  "What aspects of your opponent's game concern you the most going in?",
  "What's the key to your game plan this week?",
  "How do you feel your team is trending heading into this game?",
  "What matchup do you think will decide the outcome of this game?",
  "How are you approaching this opponent differently than others you've faced?",
  "What does your team need to execute early to set the tone?",
  "How does your team handle the mental side of a big matchup?",
  "What does a successful performance look like for you going into this game?",
  "What are you most confident about heading into this matchup?",
  "How do you keep your team from overlooking an opponent?",
  "What adjustments have you made based on last week's game?",
  "What's the most important thing your team has worked on this week?",
  "How do you handle the preparation for an opponent with a different style of play?",
  "What message are you giving your team before kickoff?",
  "What advantage do you think your team has in this matchup?",
  "How important is this game to your season goals?",
  "What does your team need to avoid doing in this game?",
  "How have you been scouting this opponent?",
  "What's the mindset you're bringing into this game?",
];

export const POSTGAME_QUESTIONS: string[] = [
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
  "What message did you give your team after the game?",
  "How important was execution in today's outcome?",
  "What role did momentum play in this game?",
  "How do you evaluate your performance as a coach/player today?",
  "What's something fans might not see that impacted this game?",
  "How did preparation show up on the field today?",
  "What did you learn about your team from this game?",
  "What's your mindset heading into the next matchup?",
  "How do you respond to a game like this?",
  "What challenges did your opponent present?",
  "How did your team respond to those challenges?",
  "What part of your game plan worked best?",
  "What part didn't go as expected?",
  "How do you balance aggression and discipline in games like this?",
  "What does this game reveal about your team's identity?",
  "How do you stay composed in high-pressure moments?",
  "How do you evaluate success beyond just the scoreboard?",
  "What does your team need to clean up immediately?",
  "What impact did execution have on key moments?",
  "What's your biggest takeaway from this performance?",
  "How do you build on this result moving forward?",
  "What does this game mean for your team's trajectory?",
  "How do you approach adjustments between games?",
  "What role does leadership play in games like this?",
  "What are you emphasizing in practice after this game?",
  "What does a complete performance look like for your team?",
  "How do you plan to carry momentum forward (or bounce back)?",
  "What should people expect from your team going forward?",
];

export const GENERAL_QUESTIONS: string[] = [
  "What are your goals for this season?",
  "How would you describe your team's identity?",
  "What separates your franchise from others in this league?",
  "How do you build and maintain team culture?",
  "What's the standard you hold yourself and your team to?",
  "How do you approach player development in your franchise?",
  "What has been your proudest moment as a franchise owner this season?",
  "How do you keep your team motivated through the ups and downs of a season?",
  "What does success look like for your franchise long-term?",
  "How do you handle the pressure of competing at a high level week in and week out?",
  "What's the biggest lesson you've learned running this franchise?",
  "How do you make roster decisions that keep your team competitive?",
  "What part of your franchise management style do you think is underrated?",
  "How has your coaching/management philosophy evolved over time?",
  "What's the most important trait you look for in your players?",
  "How do you keep your team hungry when things are going well?",
  "What does building a winning culture mean to you?",
  "What's the hardest decision you've had to make this season?",
  "How do you balance short-term results with long-term franchise health?",
  "What do you want your franchise's legacy to be in this league?",
];

/** Kept for backward compatibility — existing modal customIds reference this pool by index */
export const INTERVIEW_QUESTIONS: string[] = POSTGAME_QUESTIONS;

export function getQuestionPool(type: InterviewType): string[] {
  switch (type) {
    case "pregame":  return PREGAME_QUESTIONS;
    case "postgame": return POSTGAME_QUESTIONS;
    case "general":  return GENERAL_QUESTIONS;
  }
}

export function interviewTypeLabel(type: InterviewType): string {
  switch (type) {
    case "pregame":  return "Pre-Game Interview";
    case "postgame": return "Post-Game Interview";
    case "general":  return "General Interview";
  }
}

export function pickThreeIndices(poolSize: number): [number, number, number] {
  const indices = new Set<number>();
  while (indices.size < 3) {
    indices.add(Math.floor(Math.random() * poolSize));
  }
  const [a, b, c] = [...indices];
  return [a!, b!, c!];
}

const data = new SlashCommandBuilder()
  .setName("interviewrequest")
  .setDescription(`Submit a weekly interview for ${INTERVIEW_PAYOUT} coins — one per in-game week`);

async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const requester     = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
  const requesterTeam = requester.team ?? interaction.user.username;

  const season      = await getOrCreateActiveSeason(interaction.guildId!);
  const currentWeek = (season as any).currentWeek ?? "1";
  const weekDisplay = weekLabel(currentWeek);

  // ── One interview per in-game week ────────────────────────────────────────
  const interviewThisWeek = await db
    .select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
    .from(interviewRequestsTable)
    .where(and(
      eq(interviewRequestsTable.discordId, interaction.user.id),
      eq(interviewRequestsTable.guildId,   interaction.guildId!),
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
