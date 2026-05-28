import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { GamedayContext, GamedayInteraction } from "../domain/context.js";
import { ensureGamedaySchema } from "../domain/db.js";

export type CheckInResult = {
  mode: "checked_in" | "early_available" | "no_accepted_time" | "already_checked_in";
  userMessage: string;
  publicMessage: string;
};

type ScheduledGameRow = {
  id: number;
  guild_id: string;
  season_id: number;
  week_index: number;
  away_discord_id: string;
  home_discord_id: string;
  away_team_name: string | null;
  home_team_name: string | null;
  status: string;
  scheduled_at: string | Date | null;
  scheduled_tz: string | null;
  channel_id: string | null;
};

type MatchupStatusRow = {
  away_checked_in: boolean;
  home_checked_in: boolean;
  away_checked_in_at?: string | Date | null;
  home_checked_in_at?: string | Date | null;
  away_early_available_at?: string | Date | null;
  home_early_available_at?: string | Date | null;
};

function rowsOf<T = any>(result: any): T[] {
  return ((result as any).rows ?? result) as T[];
}

function isAway(ctx: GamedayContext): boolean {
  return ctx.userId === ctx.awayDiscordId;
}

function opponentIdFor(ctx: GamedayContext): string {
  return isAway(ctx) ? ctx.homeDiscordId : ctx.awayDiscordId;
}

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function scheduledWindowText(scheduledAt: Date): string {
  const checkinOpens = new Date(scheduledAt.getTime() - 60 * 60 * 1000);
  const fwEligible = new Date(scheduledAt.getTime() + 60 * 60 * 1000);
  return `Check-in opens: <t:${unix(checkinOpens)}:f> · Agreed start: <t:${unix(scheduledAt)}:f> · FW prompt eligibility: <t:${unix(fwEligible)}:f>`;
}

export async function getAcceptedScheduledGame(ctx: GamedayContext): Promise<ScheduledGameRow | null> {
  if (ctx.isCpuGame) return null;
  const result = await db.execute(sql`
    select id, guild_id, season_id, week_index,
           away_discord_id, home_discord_id, away_team_name, home_team_name,
           status, scheduled_at, scheduled_tz, channel_id
    from game_schedules
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and scheduled_at is not null
      and status in ('scheduled','accepted','started')
      and (
        (away_discord_id = ${ctx.awayDiscordId} and home_discord_id = ${ctx.homeDiscordId})
        or
        (away_discord_id = ${ctx.homeDiscordId} and home_discord_id = ${ctx.awayDiscordId})
      )
    order by scheduled_at desc, updated_at desc
    limit 1
  `);
  return rowsOf<ScheduledGameRow>(result)[0] ?? null;
}

async function getStatus(ctx: GamedayContext): Promise<MatchupStatusRow | null> {
  const result = await db.execute(sql`
    select away_checked_in, home_checked_in,
           away_checked_in_at, home_checked_in_at,
           away_early_available_at, home_early_available_at
    from gameday_matchup_status
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
    limit 1
  `);
  return rowsOf<MatchupStatusRow>(result)[0] ?? null;
}

async function postToChannel(interaction: GamedayInteraction, ctx: GamedayContext, content: string): Promise<void> {
  const channel = await interaction.client.channels.fetch(ctx.channelId).catch(() => null);
  if (channel?.isTextBased()) await (channel as any).send({ content }).catch(() => null);
}

async function dmOpponent(interaction: GamedayInteraction, userId: string, content: string, components?: any[]): Promise<void> {
  const member = await interaction.guild?.members.fetch(userId).catch(() => null);
  await member?.send({ content, components }).catch(() => null);
}

async function ensureStatusRow(ctx: GamedayContext): Promise<void> {
  await ensureGamedaySchema();
  await db.execute(sql`
    insert into gameday_matchup_status (
      guild_id, season_id, week_index, matchup_key,
      away_discord_id, home_discord_id, away_team_name, home_team_name
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      ${ctx.awayDiscordId}, ${ctx.homeDiscordId}, ${ctx.awayTeamName}, ${ctx.homeTeamName}
    ) on conflict (guild_id, season_id, week_index, matchup_key) do nothing
  `);
}

export async function processGamedayCheckIn(interaction: GamedayInteraction, ctx: GamedayContext): Promise<CheckInResult> {
  await ensureStatusRow(ctx);

  const scheduledGame = await getAcceptedScheduledGame(ctx);
  if (!scheduledGame?.scheduled_at) {
    const msg = "❌ You need an accepted scheduled time before official game check-in is available. Use scheduling first, or ask a commissioner to review the matchup.";
    return { mode: "no_accepted_time", userMessage: msg, publicMessage: "" };
  }

  const scheduledAt = new Date(scheduledGame.scheduled_at);
  const now = new Date();
  const opensAt = new Date(scheduledAt.getTime() - 60 * 60 * 1000);
  const actorIsAway = isAway(ctx);
  const opponentId = opponentIdFor(ctx);
  const status = await getStatus(ctx);
  const alreadyChecked = actorIsAway ? status?.away_checked_in : status?.home_checked_in;

  if (alreadyChecked) {
    return {
      mode: "already_checked_in",
      userMessage: `✅ You are already checked in for this game. ${scheduledWindowText(scheduledAt)}`,
      publicMessage: "",
    };
  }

  if (now < opensAt) {
    await db.execute(sql`
      update gameday_matchup_status
      set away_early_available_at = case when ${actorIsAway} then coalesce(away_early_available_at, now()) else away_early_available_at end,
          home_early_available_at = case when ${!actorIsAway} then coalesce(home_early_available_at, now()) else home_early_available_at end,
          updated_at = now()
      where guild_id = ${ctx.guildId}
        and season_id = ${ctx.season.id}
        and week_index = ${ctx.weekIndex}
        and matchup_key = ${ctx.matchupKey}
    `);

    const publicMessage =
      `🟡 **Early Availability Notice**\n` +
      `<@${ctx.userId}> is available early for <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>.\n` +
      `<@${opponentId}> has been notified, but is **not required to show up until the agreed time**: <t:${unix(scheduledAt)}:f>.`;

    await postToChannel(interaction, ctx, publicMessage);
    await dmOpponent(interaction, opponentId,
      `🟡 <@${ctx.userId}> is available early for your scheduled game. You are **not required to show up until the agreed time**: <t:${unix(scheduledAt)}:f>.`
    );

    return {
      mode: "early_available",
      userMessage:
        `🟡 You are more than one hour early, so this is logged as **early availability**, not an official check-in. Your opponent was notified, but they are not required to show up until <t:${unix(scheduledAt)}:f>.`,
      publicMessage,
    };
  }

  await db.execute(sql`
    update gameday_matchup_status
    set away_checked_in = case when ${actorIsAway} then true else away_checked_in end,
        home_checked_in = case when ${!actorIsAway} then true else home_checked_in end,
        away_checked_in_at = case when ${actorIsAway} then coalesce(away_checked_in_at, now()) else away_checked_in_at end,
        home_checked_in_at = case when ${!actorIsAway} then coalesce(home_checked_in_at, now()) else home_checked_in_at end,
        updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
  `);

  const publicMessage = `✅ **Checked In:** <@${ctx.userId}> for <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>. Agreed start: <t:${unix(scheduledAt)}:f>.`;
  await postToChannel(interaction, ctx, publicMessage);
  await dmOpponent(interaction, opponentId, `✅ <@${ctx.userId}> has checked in for your scheduled game. Agreed start: <t:${unix(scheduledAt)}:f>.`);

  await maybeNotifyCheckinForceWinEligibility(interaction, ctx);

  return {
    mode: "checked_in",
    userMessage: `✅ You are officially checked in. ${scheduledWindowText(scheduledAt)}`,
    publicMessage,
  };
}

export async function maybeNotifyCheckinForceWinEligibility(interaction: GamedayInteraction, ctx: GamedayContext): Promise<boolean> {
  const scheduledGame = await getAcceptedScheduledGame(ctx);
  if (!scheduledGame?.scheduled_at) return false;

  const scheduledAt = new Date(scheduledGame.scheduled_at);
  const eligibleAt = new Date(scheduledAt.getTime() + 60 * 60 * 1000);
  if (Date.now() < eligibleAt.getTime()) return false;

  const status = await getStatus(ctx);
  if (!status) return false;

  const awayChecked = Boolean(status.away_checked_in);
  const homeChecked = Boolean(status.home_checked_in);
  if (awayChecked === homeChecked) return false;

  const eligibleUserId = awayChecked ? ctx.awayDiscordId : ctx.homeDiscordId;
  const lateUserId = awayChecked ? ctx.homeDiscordId : ctx.awayDiscordId;

  const already = rowsOf(await db.execute(sql`
    select id
    from gameday_commissioner_requests
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and request_type = 'checkin_force_win'
      and status in ('pending','approved')
    limit 1
  `))[0];
  if (already) return false;

  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`gd_checkin_fw_request:${scheduledGame.id}`).setLabel("Request FW Review").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`gd_checkin_fw_decline:${scheduledGame.id}`).setLabel("Decline FW").setStyle(ButtonStyle.Secondary),
    ),
  ];

  const content =
    `🚨 **Check-In Force Win Eligibility**\n` +
    `<@${eligibleUserId}> checked in by game time. <@${lateUserId}> has not checked in within 1 hour of the agreed start time.\n` +
    `<@${eligibleUserId}> may now request commissioner FW review or decline the FW option.`;

  await postToChannel(interaction, ctx, content);
  await dmOpponent(interaction, eligibleUserId, content, components as any);
  await db.execute(sql`
    update gameday_matchup_status
    set checkin_force_win_eligible_at = coalesce(checkin_force_win_eligible_at, now()),
        checkin_force_win_notified_at = coalesce(checkin_force_win_notified_at, now()),
        checkin_force_win_eligible_for = coalesce(checkin_force_win_eligible_for, ${eligibleUserId}),
        updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
  `);
  return true;
}

export async function handleCheckinForceWinDecision(interaction: ButtonInteraction, ctx: GamedayContext, action: "request" | "decline", gameScheduleId: number): Promise<void> {
  await ensureStatusRow(ctx);
  const scheduledGame = await getAcceptedScheduledGame(ctx);
  if (!scheduledGame || Number(scheduledGame.id) !== Number(gameScheduleId)) {
    await interaction.reply({ ephemeral: true, content: "❌ This FW option is no longer tied to the active accepted scheduled time." });
    return;
  }

  const scheduledAt = new Date(scheduledGame.scheduled_at!);
  const eligibleAt = new Date(scheduledAt.getTime() + 60 * 60 * 1000);
  if (Date.now() < eligibleAt.getTime()) {
    await interaction.reply({ ephemeral: true, content: `❌ FW eligibility does not open until <t:${unix(eligibleAt)}:f>.` });
    return;
  }

  const status = await getStatus(ctx);
  const actorIsAway = isAway(ctx);
  const actorChecked = actorIsAway ? status?.away_checked_in : status?.home_checked_in;
  const opponentChecked = actorIsAway ? status?.home_checked_in : status?.away_checked_in;

  if (!actorChecked || opponentChecked) {
    await interaction.reply({ ephemeral: true, content: "❌ Only the checked-in user can use this FW option, and only while the opponent remains unchecked after the 1-hour grace window." });
    return;
  }

  if (action === "decline") {
    await db.execute(sql`
      update gameday_matchup_status
      set checkin_force_win_declined_at = now(),
          checkin_force_win_declined_by = ${ctx.userId},
          updated_at = now()
      where guild_id = ${ctx.guildId}
        and season_id = ${ctx.season.id}
        and week_index = ${ctx.weekIndex}
        and matchup_key = ${ctx.matchupKey}
    `);
    await postToChannel(interaction, ctx, `ℹ️ <@${ctx.userId}> declined the available check-in FW option for <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>.`);
    await interaction.reply({ ephemeral: true, content: "FW option declined. Commissioners can still review manually if needed." });
    return;
  }

  await db.execute(sql`
    insert into gameday_commissioner_requests (
      guild_id, season_id, week_index, matchup_key,
      request_type, requested_by, opponent_discord_id, reason, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey},
      'checkin_force_win', ${ctx.userId}, ${ctx.opponentId},
      'Opponent failed to check in within 1 hour of the accepted scheduled start time.',
      'pending'
    )
  `);
  await db.execute(sql`
    update gameday_matchup_status
    set checkin_force_win_requested_at = now(),
        checkin_force_win_requested_by = ${ctx.userId},
        updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
  `);
  await postToChannel(interaction, ctx, `🚨 <@${ctx.userId}> requested commissioner FW review because <@${ctx.opponentId}> did not check in within 1 hour of the accepted scheduled time.`);
  await interaction.reply({ ephemeral: true, content: "✅ FW review request submitted to commissioners." });
}
