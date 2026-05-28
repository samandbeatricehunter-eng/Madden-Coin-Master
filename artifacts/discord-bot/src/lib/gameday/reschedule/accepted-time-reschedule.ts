import {
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { parseAcceptedOfferDate } from "../domain/time.js";

export type ScheduledGameRow = {
  id: number;
  guild_id: string;
  season_id: number;
  week_index: number;
  away_discord_id: string | null;
  home_discord_id: string | null;
  away_team_name: string | null;
  home_team_name: string | null;
  scheduled_at: Date | string | null;
  scheduled_tz: string | null;
  status: string | null;
  channel_id: string | null;
  reschedule_pending_offer_id?: number | null;
};

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export async function getScheduledGameForReschedule(guildId: string, gameScheduleId: number): Promise<ScheduledGameRow | null> {
  const rows = await rowsOf<ScheduledGameRow>(sql`
    select id, guild_id, season_id, week_index,
           away_discord_id, home_discord_id,
           away_team_name, home_team_name,
           scheduled_at, scheduled_tz, status, channel_id,
           reschedule_pending_offer_id
    from game_schedules
    where guild_id = ${guildId}
      and id = ${gameScheduleId}
      and scheduled_at is not null
      and status in ('scheduled','confirmed','started')
    limit 1
  `);
  return rows[0] ?? null;
}

function opponentFor(game: ScheduledGameRow, actorId: string): string | null {
  if (game.away_discord_id === actorId) return game.home_discord_id;
  if (game.home_discord_id === actorId) return game.away_discord_id;
  return null;
}

function matchupKeyFor(game: ScheduledGameRow): string {
  const ids = [game.away_discord_id, game.home_discord_id].filter(Boolean).sort();
  return ids.join(":");
}

export async function showAcceptedTimeRescheduleModal(interaction: ButtonInteraction, gameScheduleId: number): Promise<void> {
  const guildId = interaction.guildId!;
  const game = await getScheduledGameForReschedule(guildId, gameScheduleId);
  if (!game) {
    await interaction.reply({ ephemeral: true, content: "Scheduled game not found or is not eligible for reschedule." });
    return;
  }

  const actorId = interaction.user.id;
  const opponentId = opponentFor(game, actorId);
  if (!opponentId) {
    await interaction.reply({ ephemeral: true, content: "Only one of the two scheduled opponents can request a reschedule." });
    return;
  }

  if (game.reschedule_pending_offer_id) {
    await interaction.reply({ ephemeral: true, content: "A reschedule request is already pending for this game. The opponent must approve, decline, or counter before another request is created." });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`gdrs_modal:${gameScheduleId}`)
    .setTitle("Request New Accepted Game Time");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("proposed_for")
        .setLabel("New proposed time")
        .setPlaceholder("Example: 2026-05-27 8:30 PM")
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("proposed_tz")
        .setLabel("Timezone")
        .setPlaceholder("CST, EST, America/Chicago, etc.")
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Reason / notes")
        .setPlaceholder("Optional context for your opponent")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false),
    ),
  );

  await interaction.showModal(modal);
}

export async function submitAcceptedTimeReschedule(interaction: ModalSubmitInteraction, gameScheduleId: number): Promise<void> {
  const guildId = interaction.guildId!;
  const game = await getScheduledGameForReschedule(guildId, gameScheduleId);
  if (!game) {
    await interaction.reply({ ephemeral: true, content: "Scheduled game not found or is not eligible for reschedule." });
    return;
  }

  const actorId = interaction.user.id;
  const opponentId = opponentFor(game, actorId);
  if (!opponentId) {
    await interaction.reply({ ephemeral: true, content: "Only one of the two scheduled opponents can request a reschedule." });
    return;
  }

  const proposedFor = interaction.fields.getTextInputValue("proposed_for").trim();
  const proposedTz = interaction.fields.getTextInputValue("proposed_tz").trim();
  const notes = interaction.fields.getTextInputValue("notes")?.trim() || null;
  const parsed = parseAcceptedOfferDate(proposedFor, proposedTz);
  if (!parsed) {
    await interaction.reply({ ephemeral: true, content: "I couldn’t understand that time. Use a format like `2026-05-27 8:30 PM` and a timezone like `CST`." });
    return;
  }

  const insert = await db.execute(sql`
    insert into gameday_schedule_offers (
      guild_id, season_id, week_index, matchup_key,
      proposer_discord_id, recipient_discord_id,
      away_discord_id, home_discord_id, away_team_name, home_team_name,
      proposed_for, proposed_tz, notes, status,
      offer_kind, game_schedule_id, replaces_scheduled_at, replaces_scheduled_tz, requires_approval
    ) values (
      ${guildId}, ${game.season_id}, ${game.week_index}, ${matchupKeyFor(game)},
      ${actorId}, ${opponentId},
      ${game.away_discord_id}, ${game.home_discord_id}, ${game.away_team_name}, ${game.home_team_name},
      ${proposedFor}, ${proposedTz}, ${notes}, 'pending',
      'reschedule', ${game.id}, ${game.scheduled_at ? new Date(game.scheduled_at).toISOString() : null}, ${game.scheduled_tz}, true
    ) returning id
  `);
  const offerId = Number((((insert as any).rows ?? insert) as Array<{ id: number }>)[0]?.id ?? 0);

  await db.execute(sql`
    update game_schedules
    set reschedule_pending_offer_id = ${offerId},
        reschedule_requested_at = now(),
        reschedule_requested_by = ${actorId},
        updated_at = now()
    where id = ${game.id}
      and guild_id = ${guildId}
  `);

  const previousTs = game.scheduled_at ? Math.floor(new Date(game.scheduled_at).getTime() / 1000) : null;
  const newTs = Math.floor(parsed.getTime() / 1000);
  const notice =
    `🔁 **Reschedule Approval Needed**\n` +
    `<@${actorId}> requested a new accepted time for Week ${Number(game.week_index ?? 0) + 1}:\n` +
    `<@${game.away_discord_id}> (${game.away_team_name ?? "Away"}) @ <@${game.home_discord_id}> (${game.home_team_name ?? "Home"})\n` +
    `Previous: **${previousTs ? `<t:${previousTs}:f>` : "Unknown"}**\n` +
    `Requested: **<t:${newTs}:f> (<t:${newTs}:R>)**\n\n` +
    `<@${opponentId}> must approve, decline, or counter this new time. The old accepted time remains active until approval.`;

  const components = [
    new ActionRowBuilder<any>().addComponents(
      { type: 2, custom_id: `gs_accept:${offerId}`, label: "Approve New Time", style: 3 },
      { type: 2, custom_id: `gs_reject:${offerId}`, label: "Decline", style: 4 },
      { type: 2, custom_id: `gs_counter:${offerId}`, label: "Counter", style: 2 },
    ),
  ] as any;

  if (game.channel_id) {
    const channel = await interaction.client.channels.fetch(game.channel_id).catch(() => null);
    if (channel?.isTextBased()) await (channel as any).send({ content: notice, components }).catch(() => null);
  }

  const opponent = await interaction.guild?.members.fetch(opponentId).catch(() => null);
  await opponent?.send({ content: notice, components }).catch(() => null);

  await interaction.reply({ ephemeral: true, content: "Reschedule request created. The original accepted time stays active until your opponent approves the new time." });
}

export async function handleAcceptedTimeRescheduleInteraction(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("gdrs_")) return false;

  if (interaction.isButton() && interaction.customId.startsWith("gdrs_edit:")) {
    const [, idRaw] = interaction.customId.split(":");
    await showAcceptedTimeRescheduleModal(interaction, Number(idRaw));
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("gdrs_modal:")) {
    const [, idRaw] = interaction.customId.split(":");
    await submitAcceptedTimeReschedule(interaction, Number(idRaw));
    return true;
  }

  return true;
}
