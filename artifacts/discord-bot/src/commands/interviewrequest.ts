import {
  SlashCommandBuilder, ChatInputCommandInteraction, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { payoutRequestsTable, interviewRequestsTable } from "@workspace/db";
import { eq, and, or, inArray, desc } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

export const INTERVIEW_PAYOUT = 10;

export const INTERVIEW_QUESTIONS: string[] = [
  // Game recap
  "Walk us through the turning point of that game — when did you feel the momentum shift?",
  "What was the one play you knew was going to define how this game ended?",
  "You had full control of the clock late. How did you manage the situation mentally?",
  "Take us inside the locker room. What was the message at halftime?",
  "How did you adjust your game plan after the first few drives?",
  "There were moments that looked like the game could slip away. What kept you composed?",
  "What did your defense show today that you haven't seen from them all season?",
  "Talk about your offensive line tonight — how much does their performance set the tone?",
  "You found some big plays in the passing game. What coverages were you attacking and why?",
  "The run game was working early. Was that by design or did you audible into it based on what you saw?",

  // Opponent / competition
  "Your opponent has had a strong year. What specifically did you prepare for coming into today?",
  "Is there a player on that roster who gave you problems you didn't fully expect?",
  "After today's result, where do you think they rank in the league right now?",
  "What's the one thing you saw on their side of the ball that genuinely impressed you?",
  "How do you think this opponent stacks up against the other teams you've faced this season?",

  // Team / culture
  "You've been preaching consistency all season. Does today's win feel like proof of concept?",
  "Talk about your team's identity — what makes this squad different from what you've put together before?",
  "Is there a player on your roster who doesn't get enough credit for what they bring every week?",
  "How has your depth been tested this season, and what have you learned from those moments?",
  "You've dealt with some adversity this year. How has this group responded compared to past seasons?",

  // Strategy / coaching
  "You went for it on fourth down twice today. Walk us through those decisions.",
  "Your two-minute offense has been elite. Is that something you drill specifically or does it come naturally?",
  "Was there a coverage or scheme you wish you had attacked differently in this game?",
  "Talk about your red zone offense — what's the philosophy when you get inside the twenty?",
  "You made a personnel decision late in the game that raised some eyebrows. Explain your thinking.",

  // Personal / mental game
  "How do you stay focused when the game starts getting physical and personal fouls start stacking up?",
  "What's your pre-game routine like, and has it changed since the start of the season?",
  "Be honest — what part of your game are you still working to get right?",
  "Does winning ever feel routine at this point, or does each one still hit the same?",
  "What's the biggest lesson you've learned as a coach or competitor this season?",
  "At what point in the game did you let yourself believe you were going to win?",
  "How do you handle the pressure of high-expectation weeks when everyone expects you to dominate?",
  "What drives you to keep improving when you're already performing at a high level?",
  "How do you separate a tough loss from your preparation for the following week?",
  "When you look back at the beginning of this season, would you have believed you'd be where you are now?",

  // Season / big picture
  "Where do you see this team's ceiling, realistically, before the season is over?",
  "If you could fix one thing about how your season has gone so far, what would it be?",
  "How are you managing your roster's stamina and mental health this deep into the season?",
  "Do you study power rankings or do you block that noise out entirely?",
  "What does a championship look like for this team — is it even on your radar or are you week-to-week?",
  "Who in the league do you respect the most, and why?",
  "If you played yourself at your best from a few seasons ago, who wins?",
  "Give us a bold prediction for how the rest of the season plays out — yours or the league's.",
  "What's one thing the league hasn't seen from you yet that you're saving for when it matters most?",
  "If today's result gets talked about a year from now, what do you want people to remember about it?",
];

// Loss-specific questions — only shown when the user's most recent game report was an H2H loss.
export const LOSS_INTERVIEW_QUESTIONS: string[] = [
  "Be honest—did you win this game, or did your opponent lose it for you?",
  "At what point did you realize things were slipping, and why couldn't you stop it?",
  "There were some questionable decisions out there—do you put that on coaching or execution?",
  "Is this a one-off performance, or is this starting to become a pattern for your team?",
  "You've talked a lot about accountability—who needs to look in the mirror most after this one?",
  "Did you feel outcoached tonight?",
  "From the outside, it looked like a lack of discipline—would you agree with that assessment?",
  "How frustrating is it knowing you had chances to take control and didn't capitalize?",
  "Do you think your opponent exposed something that other teams are going to start targeting?",
  "There were moments where the energy looked flat—what was going on with the team mentally?",
  "Is this team as good as you thought it was coming into the game?",
  "You've got big expectations this season—did this performance fall short of that standard?",
  "Were you surprised by anything your opponent did, or were you just not prepared?",
  "How much pressure is starting to build on this team after a performance like this?",
  "If you had to send a message to the league after tonight, what would it be—because this didn't look like a statement game.",
  "Do you feel like this result says more about your team—or your opponent?",
  "Was this a case of being outplayed, or just outworked?",
  "How much of this falls on leadership in the locker room?",
  "Did you underestimate your opponent coming into this game?",
  "There were some costly mistakes—are those correctable, or are they deeper issues?",
  "At what point does this become a concern instead of just a bad game?",
  "Do you think your game plan actually gave you a chance to win tonight?",
  "How do you respond to critics who say this team can't handle pressure moments?",
  "Was there a turning point where you felt momentum completely shift?",
  "Do you feel like the team stayed composed, or did emotions get the best of you?",
  "Is this loss going to linger, or can this group realistically turn the page quickly?",
  "You've emphasized execution all season—why didn't it show up when it mattered most?",
  "Did anything you saw tonight shake your confidence in this team?",
  "Are you still confident this team can compete with the top teams in the league?",
  "If you faced this same opponent again tomorrow, what would you do differently?",
];

/**
 * Returns the full question pool based on whether this is a loss interview.
 * "l" (loss) = regular + loss questions combined.
 * "r" (regular) = regular questions only.
 */
export function getQuestionPool(poolType: "r" | "l"): string[] {
  return poolType === "l"
    ? [...INTERVIEW_QUESTIONS, ...LOSS_INTERVIEW_QUESTIONS]
    : INTERVIEW_QUESTIONS;
}

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
  .setDescription(`Submit a post-game interview to earn ${INTERVIEW_PAYOUT} coins — one per week, after reporting a game`);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const requester     = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const requesterTeam = requester.team ?? interaction.user.username;

  const season      = await getOrCreateActiveSeason();
  const currentWeek = (season as any).currentWeek ?? "1";
  const weekDisplay = weekLabel(currentWeek);

  // ── Rule 1: Must have a game score this week (either as reporter or opponent) ─
  const gameThisWeek = await db
    .select({
      id:             payoutRequestsTable.id,
      gameType:       payoutRequestsTable.gameType,
      requesterId:    payoutRequestsTable.requesterId,
      opponentId:     payoutRequestsTable.opponentId,
      requesterScore: payoutRequestsTable.requesterScore,
      opponentScore:  payoutRequestsTable.opponentScore,
    })
    .from(payoutRequestsTable)
    .where(and(
      or(
        eq(payoutRequestsTable.requesterId, interaction.user.id),
        eq(payoutRequestsTable.opponentId,  interaction.user.id),
      ),
      eq(payoutRequestsTable.week, currentWeek),
    ))
    .orderBy(desc(payoutRequestsTable.createdAt))
    .limit(1);

  if (gameThisWeek.length === 0) {
    await interaction.editReply({
      content: [
        `❌ **No game on record for ${weekDisplay} yet.**`,
        `A game score involving you must be submitted with \`/reportscore\` before you can request an interview this week.`,
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

  // ── Determine if most recent game was an H2H loss (from this user's POV) ──
  const recentGame   = gameThisWeek[0]!;
  const isRequester  = recentGame.requesterId === interaction.user.id;
  const myScore      = isRequester ? (recentGame.requesterScore ?? 0) : (recentGame.opponentScore ?? 0);
  const theirScore   = isRequester ? (recentGame.opponentScore ?? 0) : (recentGame.requesterScore ?? 0);
  const isH2HLoss    = recentGame.gameType === "h2h" && myScore < theirScore;

  // "l" = combined pool (regular + loss questions), "r" = regular pool only
  const poolType: "r" | "l" = isH2HLoss ? "l" : "r";
  const pool = getQuestionPool(poolType);

  // ── Pick 3 unique questions from the appropriate pool ─────────────────────
  const [i1, i2, i3] = pickThreeIndices(pool.length);
  const q1 = pool[i1]!;
  const q2 = pool[i2]!;
  const q3 = pool[i3]!;
  const indicesStr = `${i1},${i2},${i3}`;

  const lossNote = isH2HLoss
    ? `\n\n*After an H2H loss, questions may be drawn from the post-loss pool (${pool.length} total questions available).*`
    : `\n\n*Questions are selected randomly from a pool of ${pool.length}.*`;

  // ── Show questions + Submit button (DB record created on modal submit) ────
  const embed = new EmbedBuilder()
    .setColor(isH2HLoss ? Colors.Red : Colors.Blurple)
    .setTitle("🎙️ Post-Game Interview")
    .setDescription(
      `Here are your **3 interview questions** for **${weekDisplay}**.\n` +
      `Click **Submit Your Answers** to fill them in — you'll have time to type each one.` +
      lossNote,
    )
    .addFields(
      { name: "Q1", value: q1 },
      { name: "Q2", value: q2 },
      { name: "Q3", value: q3 },
    )
    .setFooter({ text: `${requesterTeam} • ${weekDisplay}${isH2HLoss ? " • Post-Loss Interview" : ""}` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`interview_answer:${interaction.user.id}:${poolType}:${indicesStr}`)
      .setLabel("📝 Submit Your Answers")
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}
