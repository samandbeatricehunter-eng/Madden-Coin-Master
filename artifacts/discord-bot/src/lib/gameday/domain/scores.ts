import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import type { GamedayContext } from "./context.js";
import { dmUser, postToGamedayChannel } from "./context.js";
import { ensureGamedaySchema, oneOf } from "./db.js";

export function scoreWinner(ctx: GamedayContext, awayScore: number, homeScore: number): string | null {
  if (awayScore > homeScore) return ctx.awayDiscordId;
  if (homeScore > awayScore) return ctx.homeDiscordId;
  return null;
}

export async function createScoreSubmission(interaction: ModalSubmitInteraction, ctx: GamedayContext, awayScore: number, homeScore: number): Promise<number> {
  await ensureGamedaySchema();
  const winnerDiscordId = scoreWinner(ctx, awayScore, homeScore);
  if (!winnerDiscordId) throw new Error("Tie scores require commissioner review.");

  await db.execute(sql`
    update gameday_score_submissions
    set status = 'superseded', updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and status = 'pending'
  `);

  const result = await db.execute(sql`
    insert into gameday_score_submissions (
      guild_id, season_id, week_index, matchup_key,
      away_discord_id, home_discord_id, away_team_name, home_team_name,
      submitted_by, opponent_discord_id, away_score, home_score, winner_discord_id, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName},
      ${ctx.userId}, ${ctx.opponentId}, ${awayScore}, ${homeScore}, ${winnerDiscordId}, 'pending'
    ) returning id
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: number }>;
  const id = Number(rows[0]?.id ?? 0);

  await dmUser(interaction, ctx.opponentId,
    `🏁 <@${ctx.userId}> submitted a final score for **${ctx.awayTeamName} @ ${ctx.homeTeamName}**:\n\n` +
    `**${ctx.awayTeamName}: ${awayScore}**\n` +
    `**${ctx.homeTeamName}: ${homeScore}**\n\n` +
    `Open \`/gameday\` to approve or dispute it.`);

  return id;
}

export async function getPendingScoreApproval(ctx: GamedayContext): Promise<any | null> {
  await ensureGamedaySchema();
  return oneOf(sql`
    select *
    from gameday_score_submissions
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and opponent_discord_id = ${ctx.userId}
      and status = 'pending'
    order by created_at desc
    limit 1
  `);
}

export async function approveScore(interaction: ButtonInteraction, ctx: GamedayContext, scoreId: number): Promise<any | null> {
  const score = await oneOf<any>(sql`
    select *
    from gameday_score_submissions
    where id = ${scoreId}
      and guild_id = ${ctx.guildId}
      and opponent_discord_id = ${ctx.userId}
      and status = 'pending'
    limit 1
  `);
  if (!score) return null;

  await db.execute(sql`update gameday_score_submissions set status = 'approved', updated_at = now() where id = ${score.id}`);
  await db.execute(sql`
    update game_schedules
    set away_score = ${score.away_score},
        home_score = ${score.home_score},
        winner_discord_id = ${score.winner_discord_id},
        status = 'completed_pending_import',
        finished_at = coalesce(finished_at, now()),
        updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and (
           (away_discord_id = ${ctx.awayDiscordId} and home_discord_id = ${ctx.homeDiscordId})
        or (away_discord_id = ${ctx.homeDiscordId} and home_discord_id = ${ctx.awayDiscordId})
      )
  `);

  await postToGamedayChannel(interaction, ctx,
    `🏁 **FINAL SUBMITTED & APPROVED**\n` +
    `<@${score.away_discord_id}> @ <@${score.home_discord_id}>\n` +
    `**${score.away_team_name}: ${score.away_score}**\n` +
    `**${score.home_team_name}: ${score.home_score}**\n` +
    `Winner: <@${score.winner_discord_id}>\n\n` +
    `Status: **Completed — pending EA import confirmation**.`);

  return score;
}

export async function disputeScore(ctx: GamedayContext, scoreId: number, reason: string): Promise<any | null> {
  const score = await oneOf<any>(sql`
    select *
    from gameday_score_submissions
    where id = ${scoreId}
      and guild_id = ${ctx.guildId}
      and opponent_discord_id = ${ctx.userId}
      and status = 'pending'
    limit 1
  `);
  if (!score) return null;
  await db.execute(sql`
    update gameday_score_submissions
    set status = 'disputed', dispute_reason = ${reason}, updated_at = now()
    where id = ${score.id}
  `);
  await db.execute(sql`
    insert into gameday_commissioner_requests (
      guild_id, season_id, week_index, matchup_key, request_type,
      requested_by, opponent_discord_id, reason, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, 'disputed_finals',
      ${ctx.userId}, ${score.submitted_by}, ${reason}, 'pending'
    )
  `);
  return score;
}
