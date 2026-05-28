import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { weekLabel } from "../helpers/week-helpers.js";
import { handleAcPressOpen } from "../handlers/press-conference-handlers.js";
import { handleAcRivalries } from "../handlers/rivalries-handlers.js";
import { canUseCommissionerOffice } from "../roles/rec-role-access.js";
import { renderCommissionerGamedayReview } from "./commissioner-gameday-review.js";
import { nextAdvanceDeadline } from "../discord/timezones.js";
import { getServerSettings } from "../db/server-settings.js";
import {
  dmUser,
  ensureMatchupStatus,
  getMatchupStatus,
  postToGamedayChannel,
  resolveGamedayContext,
  type GamedayContext,
  type GamedayInteraction,
} from "./domain/context.js";
import { ensureGamedaySchema, oneOf } from "./domain/db.js";
import {
  GAMEDAY_TZ_OPTIONS,
  displayTime,
  isValidTz,
  localDateTimeToUtc,
  localIsoDate,
  pad2,
  type GamedayTzKey,
} from "./domain/time.js";
import {
  acceptOffer,
  cancelOffer,
  countActiveOffers,
  countPendingOffers,
  counterOffer,
  createOffer,
  getOffer,
  listOffers,
  rejectOffer,
  type OfferRow,
} from "./domain/offers.js";
import {
  approveScore,
  createScoreSubmission,
  disputeScore,
  getPendingScoreApproval,
} from "./domain/scores.js";
import {
  getAcceptedScheduledGame,
  handleCheckinForceWinDecision,
  maybeNotifyCheckinForceWinEligibility,
  processGamedayCheckIn,
} from "./checkin/game-checkin-service.js";

type ScheduleDraft = { dayIso?: string; tz?: GamedayTzKey; time?: string; notes?: string };
const scheduleDrafts = new Map<string, ScheduleDraft>();

function draftKey(ctx: GamedayContext): string {
  return `${ctx.guildId}:${ctx.season.id}:${ctx.weekIndex}:${ctx.matchupKey}:${ctx.userId}`;
}
function getDraft(ctx: GamedayContext): ScheduleDraft {
  const key = draftKey(ctx);
  let draft = scheduleDrafts.get(key);
  if (!draft) {
    draft = {};
    scheduleDrafts.set(key, draft);
  }
  return draft;
}
function patchDraft(ctx: GamedayContext, patch: Partial<ScheduleDraft>): ScheduleDraft {
  const next = { ...getDraft(ctx), ...patch };
  scheduleDrafts.set(draftKey(ctx), next);
  return next;
}

async function respond(interaction: GamedayInteraction, payload: any): Promise<void> {
  const full = { ephemeral: true, ...payload };
  if (interaction.isChatInputCommand()) {
    if ((interaction as any).replied || (interaction as any).deferred) await interaction.editReply(full).catch(() => null);
    else await interaction.reply(full).catch(() => null);
    return;
  }
  if ((interaction as any).replied || (interaction as any).deferred) {
    await (interaction as any).editReply(full).catch(async () => (interaction as any).followUp(full).catch(() => null));
    return;
  }
  if (interaction.isModalSubmit()) {
    await interaction.reply(full).catch(() => null);
    return;
  }
  await (interaction as ButtonInteraction | StringSelectMenuInteraction).update(full).catch(async () => {
    await (interaction as any).reply(full).catch(() => null);
  });
}

function dashboardRows(activeCount: number, pendingCount: number) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_schedule").setLabel("🗓️ Schedule Game").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("gd_pending").setLabel(`📨 Pending (${pendingCount})`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_queue").setLabel("🎮 Game Queue").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("gd_assist").setLabel("🚨 Assistance").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_manage_offers").setLabel(`⚙️ Sent (${activeCount})`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_commish_review").setLabel("🎮 Commissioner Review").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_press").setLabel("🎙️ Press").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_rivalries").setLabel("⚔️ Rivalries").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function renderDashboard(interaction: GamedayInteraction, ctx: GamedayContext): Promise<void> {
  if (ctx.isCpuGame) return renderCpuDashboard(interaction, ctx);
  const [activeCount, pendingCount, status] = await Promise.all([
    countActiveOffers(ctx),
    countPendingOffers(ctx),
    getMatchupStatus(ctx),
  ]);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🎮 Gameday Dashboard")
    .setDescription([
      `**Week:** ${weekLabel(String((ctx.season as any).currentWeek ?? ""))}`,
      `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>`,
      `**You are:** ${ctx.homeAway}`,
      `**Opponent:** <@${ctx.opponentId}>`,
    ].join("\n"))
    .addFields(
      { name: "Scheduling", value: `Sent offers: **${activeCount}** · Pending offers: **${pendingCount}**`, inline: false },
      { name: "Check-in", value: `Away: **${status?.away_checked_in ? "checked in" : "not checked in"}** · Home: **${status?.home_checked_in ? "checked in" : "not checked in"}**`, inline: false },
      { name: "Game State", value: status?.begun_at ? `Started: <t:${Math.floor(new Date(status.begun_at).getTime() / 1000)}:R>` : "Not marked begun yet", inline: false },
      { name: "Completion", value: "Final scores and winners are imported from MCA. Users only confirm that the game ended.", inline: false },
    );

  await respond(interaction, { embeds: [embed], components: dashboardRows(activeCount, pendingCount) as any });
}

async function renderCommissionerOnlyDashboard(interaction: GamedayInteraction, reason = "No active user matchup found for you this week."): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(Colors.Greyple)
    .setTitle("🎮 Gameday")
    .setDescription([
      reason,
      "",
      "Commissioners can always access the Gameday Review hub, including CPU weeks and bye weeks.",
    ].join("\n"));

  await respond(interaction, {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_commish_review").setLabel("🎮 Commissioner Review").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
      ),
    ] as any,
  });
}

async function renderCpuDashboard(interaction: GamedayInteraction, ctx: GamedayContext): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(Colors.Greyple)
    .setTitle("🎮 CPU Gameday Dashboard")
    .setDescription([
      `**Week:** ${weekLabel(String((ctx.season as any).currentWeek ?? ""))}`,
      `**Your Team:** ${ctx.userTeamName ?? "Unknown"}`,
      `**CPU Team:** ${ctx.cpuTeamName ?? "Unknown"}`,
      "CPU games use a simplified flow: stream/report through Commissioner assistance when needed.",
    ].join("\n"));
  await respond(interaction, {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_cpu_stream").setLabel("📺 Report CPU Stream").setStyle(ButtonStyle.Primary).setDisabled(!ctx.cpuTeamName),
        new ButtonBuilder().setCustomId("gd_cpu_fw").setLabel("🏳️ Request CPU FW").setStyle(ButtonStyle.Danger).setDisabled(!ctx.cpuTeamName),
        new ButtonBuilder().setCustomId("gd_commish_review").setLabel("🎮 Commissioner Review").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("gd_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Secondary),
      ),
    ] as any,
  });
}

async function getAdvanceDeadline(ctx: GamedayContext): Promise<Date> {
  const override = await oneOf<{ advance_at_utc: string | Date }>(sql`
    select advance_at_utc
    from gameday_advance_overrides
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and status = 'active'
    order by created_at desc
    limit 1
  `);
  if (override?.advance_at_utc) return new Date(override.advance_at_utc);
  const settings = await getServerSettings(ctx.guildId);
  return nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
}

async function availableDays(ctx: GamedayContext, tzKey: GamedayTzKey) {
  const deadline = await getAdvanceDeadline(ctx);
  const todayIso = localIsoDate(new Date(), tzKey);
  const deadlineIso = localIsoDate(deadline, tzKey);
  const [year, month, day] = todayIso.split("-").map(Number);
  let cursor = new Date(Date.UTC(year!, month! - 1, day!));
  const out: Array<{ iso: string; label: string }> = [];
  for (let i = 0; i < 10; i++) {
    const iso = `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`;
    if (iso > deadlineIso) break;
    if ((await availableTimes(ctx, iso, tzKey)).length) {
      out.push({ iso, label: iso === todayIso ? `Today — ${iso}` : iso === deadlineIso ? `Advance Day — ${iso}` : iso });
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
  }
  return out;
}

async function availableTimes(ctx: GamedayContext, dayIso: string, tzKey: GamedayTzKey) {
  const now = Date.now();
  const deadline = await getAdvanceDeadline(ctx);
  const out: Array<{ value: string; label: string; late: boolean }> = [];
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 30]) {
      const value = `${pad2(hour)}:${pad2(minute)}`;
      const utc = localDateTimeToUtc(dayIso, value, tzKey);
      if (utc.getTime() <= now + 60_000 || utc.getTime() > deadline.getTime()) continue;
      const late = utc.getTime() >= deadline.getTime() - 60 * 60_000;
      out.push({ value, label: `${displayTime(value)} ${tzKey}${late ? " ⚠️ late" : ""}`, late });
    }
  }
  return out;
}

async function showScheduleHub(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const activeCount = await countActiveOffers(ctx);
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🗓️ Schedule Game").setDescription(`You may keep up to **3 active pending offers**.\n\nActive offers sent by you: **${activeCount}/3**.`)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_offer_new").setLabel("➕ Send Proposed Time").setStyle(ButtonStyle.Primary).setDisabled(activeCount >= 3),
      new ButtonBuilder().setCustomId("gd_manage_offers").setLabel("Manage Sent Offers").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary),
    )] as any,
  });
}

async function showTimezoneSelect(interaction: ButtonInteraction | StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const menu = new StringSelectMenuBuilder().setCustomId("gd_sched_tz").setPlaceholder("Select timezone…")
    .addOptions(GAMEDAY_TZ_OPTIONS.map((tz) => new StringSelectMenuOptionBuilder().setLabel(tz.label).setValue(tz.key)));
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🗓️ Schedule Game — Step 1").setDescription("Select the timezone for your proposed game time.")],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_schedule").setLabel("← Back").setStyle(ButtonStyle.Secondary)),
    ] as any,
  });
}

async function showDaySelect(interaction: ButtonInteraction | StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const draft = getDraft(ctx);
  const tz = draft.tz ?? "CST";
  const days = await availableDays(ctx, tz);
  if (!days.length) {
    await respond(interaction, { content: "❌ No selectable days remain before the advance deadline.", embeds: [], components: [] });
    return;
  }
  const menu = new StringSelectMenuBuilder().setCustomId("gd_sched_day").setPlaceholder("Select day…")
    .addOptions(days.slice(0, 25).map((d) => new StringSelectMenuOptionBuilder().setLabel(d.label).setValue(d.iso)));
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🗓️ Schedule Game — Step 2").setDescription(`Timezone: **${tz}**`) ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_offer_new").setLabel("← Timezone").setStyle(ButtonStyle.Secondary)),
    ] as any,
  });
}

async function showTimeSelect(interaction: ButtonInteraction | StringSelectMenuInteraction, ctx: GamedayContext, page = 0): Promise<void> {
  const draft = getDraft(ctx);
  if (!draft.tz || !draft.dayIso) return showTimezoneSelect(interaction, ctx);
  const times = await availableTimes(ctx, draft.dayIso, draft.tz);
  const pageSize = 24;
  const pageCount = Math.max(1, Math.ceil(times.length / pageSize));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const slice = times.slice(safePage * pageSize, safePage * pageSize + pageSize);
  if (!slice.length) {
    await respond(interaction, { content: "❌ No selectable times remain for that day.", embeds: [], components: [] });
    return;
  }
  const menu = new StringSelectMenuBuilder().setCustomId("gd_sched_time").setPlaceholder(`Select time — ${safePage + 1}/${pageCount}`)
    .addOptions(slice.map((t) => new StringSelectMenuOptionBuilder().setLabel(t.label).setDescription(t.late ? "Within 1 hour of advance" : "Available before advance").setValue(t.value)));
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("🗓️ Schedule Game — Step 3").setDescription(`Timezone: **${draft.tz}**\nDay: **${draft.dayIso}**`) ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_sched_time_page:${safePage - 1}`).setLabel("← Prev").setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
        new ButtonBuilder().setCustomId(`gd_sched_time_page:${safePage + 1}`).setLabel("Next →").setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
        new ButtonBuilder().setCustomId("gd_sched_back_day").setLabel("Back to Day").setStyle(ButtonStyle.Secondary),
      ),
    ] as any,
  });
}

async function showOfferConfirm(interaction: ButtonInteraction | StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const draft = getDraft(ctx);
  if (!draft.tz || !draft.dayIso || !draft.time) return showTimezoneSelect(interaction, ctx);
  const selectedUtc = localDateTimeToUtc(draft.dayIso, draft.time, draft.tz);
  const deadline = await getAdvanceDeadline(ctx);
  const late = selectedUtc.getTime() >= deadline.getTime() - 60 * 60_000;
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(late ? Colors.Orange : Colors.Green).setTitle("🗓️ Confirm Scheduling Offer").setDescription([
      `**Proposed:** ${draft.dayIso} at ${displayTime(draft.time)} ${draft.tz}`,
      `**Opponent:** <@${ctx.opponentId}>`,
      draft.notes ? `**Note:** ${draft.notes}` : "",
      late ? "⚠️ This time is within 1 hour of advance; commissioners will be notified." : "",
    ].filter(Boolean).join("\n"))],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("gd_offer_confirm").setLabel("✅ Send Offer").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("gd_sched_note").setLabel("📝 Add Note").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("gd_sched_back_time").setLabel("← Time").setStyle(ButtonStyle.Secondary),
    )] as any,
  });
}

async function sendOffer(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const draft = getDraft(ctx);
  if (!draft.tz || !draft.dayIso || !draft.time) return showTimezoneSelect(interaction, ctx);
  if ((await countActiveOffers(ctx)) >= 3) {
    await interaction.reply({ ephemeral: true, content: "❌ You already have 3 active offers. Cancel one before sending another." });
    return;
  }
  const proposedFor = `${draft.dayIso} ${displayTime(draft.time)}`;
  const id = await createOffer(ctx, proposedFor, draft.tz, draft.notes ?? null);
  await dmUser(interaction, ctx.opponentId,
    `🗓️ **New Scheduling Offer**\n\n<@${ctx.userId}> proposed **${proposedFor} ${draft.tz}** for **${ctx.awayTeamName} @ ${ctx.homeTeamName}**.\n\nOpen \`/gameday\` to accept, counter, or reject.`);

  const selectedUtc = localDateTimeToUtc(draft.dayIso, draft.time, draft.tz);
  const deadline = await getAdvanceDeadline(ctx);
  if (selectedUtc.getTime() >= deadline.getTime() - 60 * 60_000) {
    await db.execute(sql`
      insert into gameday_commissioner_requests (
        guild_id, season_id, week_index, matchup_key, request_type,
        requested_by, opponent_discord_id, reason, status
      ) values (
        ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, 'advance_delay',
        ${ctx.userId}, ${ctx.opponentId}, ${`Late scheduling offer #${id}: ${proposedFor} ${draft.tz}`}, 'pending'
      )
    `);
    await postToGamedayChannel(interaction, ctx, `⚠️ **Late Game Scheduled — Delay Review Needed**\n<@${ctx.userId}> proposed **${proposedFor} ${draft.tz}** within 1 hour of advance for <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>.`);
  }

  scheduleDrafts.delete(draftKey(ctx));
  await respond(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Scheduling Offer Sent").setDescription(`Offer #${id} sent to <@${ctx.opponentId}>.`)], components: [backRow()] as any });
}

function backRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_refresh").setLabel("← Dashboard").setStyle(ButtonStyle.Secondary));
}

function offerMenuRow(customId: string, offers: OfferRow[], placeholder: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(
      offers.map((o) => new StringSelectMenuOptionBuilder()
        .setLabel(`#${o.id} · ${o.proposed_for}`.slice(0, 100))
        .setDescription((customId === "gd_pending_select" ? `From ${o.proposer_discord_id}` : `To ${o.recipient_discord_id}`).slice(0, 100))
        .setValue(String(o.id))),
    ),
  );
}

async function showPendingOffers(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const offers = await listOffers(ctx, "received");
  if (!offers.length) return respond(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("📨 Pending Offers").setDescription("No pending scheduling offers are waiting on you.")], components: [backRow()] as any });
  await respond(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📨 Pending Offers (${offers.length})`).setDescription("Select an offer to review.")], components: [offerMenuRow("gd_pending_select", offers, "Select offer…"), backRow()] as any });
}

async function showSentOffers(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const offers = await listOffers(ctx, "sent");
  if (!offers.length) return respond(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("⚙️ Sent Offers").setDescription("You do not have any active sent offers.")], components: [backRow()] as any });
  await respond(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`⚙️ Sent Offers (${offers.length})`).setDescription("Select an offer to manage.")], components: [offerMenuRow("gd_manage_select", offers, "Select sent offer…"), backRow()] as any });
}

async function showPendingOfferDetail(interaction: StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const offer = await getOffer(Number(interaction.values[0]));
  if (!offer || offer.recipient_discord_id !== ctx.userId || offer.status !== "pending") return respond(interaction, { content: "❌ Offer not found or no longer pending.", embeds: [], components: [] });
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📨 Scheduling Offer #${offer.id}`).setDescription([
      `**From:** <@${offer.proposer_discord_id}>`,
      `**Matchup:** <@${offer.away_discord_id}> @ <@${offer.home_discord_id}>`,
      `**Proposed:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`,
      offer.notes ? `**Note:** ${offer.notes}` : "",
    ].filter(Boolean).join("\n"))],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_offer_accept:${offer.id}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gd_offer_counter:${offer.id}`).setLabel("🔁 Counter").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`gd_offer_reject:${offer.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_pending").setLabel("← Pending").setStyle(ButtonStyle.Secondary)),
    ] as any,
  });
}

async function showSentOfferDetail(interaction: StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const offer = await getOffer(Number(interaction.values[0]));
  if (!offer || offer.proposer_discord_id !== ctx.userId || offer.status !== "pending") return respond(interaction, { content: "❌ Offer not found or no longer pending.", embeds: [], components: [] });
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`⚙️ Sent Offer #${offer.id}`).setDescription([
      `**To:** <@${offer.recipient_discord_id}>`,
      `**Proposed:** ${offer.proposed_for}${offer.proposed_tz ? ` ${offer.proposed_tz}` : ""}`,
      offer.notes ? `**Note:** ${offer.notes}` : "",
    ].filter(Boolean).join("\n"))],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_offer_delete:${offer.id}`).setLabel("🗑️ Cancel Offer").setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_manage_offers").setLabel("← Sent Offers").setStyle(ButtonStyle.Secondary)),
    ] as any,
  });
}

async function showCounterModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  const modal = new ModalBuilder().setCustomId(`gd_modal_counter:${offerId}`).setTitle("Counter Scheduling Offer");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("proposed_for").setLabel("Counter date/time").setPlaceholder("Example: 2026-05-27 8:30 PM").setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("proposed_tz").setLabel("Timezone").setPlaceholder("CST, EST, MST, PST, AKST, UTC").setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(true)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("notes").setLabel("Optional note").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)),
  );
  await interaction.showModal(modal);
}

async function showRejectModal(interaction: ButtonInteraction, offerId: number): Promise<void> {
  const modal = new ModalBuilder().setCustomId(`gd_modal_reject:${offerId}`).setTitle("Reject Scheduling Offer");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Reason").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)));
  await interaction.showModal(modal);
}

async function showNoteModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder().setCustomId("gd_modal_offer_note").setTitle("Optional Scheduling Note");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("notes").setLabel("Optional note").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)));
  await interaction.showModal(modal);
}

async function showQueue(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const status = await getMatchupStatus(ctx);
  const scheduledGame = await getAcceptedScheduledGame(ctx);
  const scheduledAt = scheduledGame?.scheduled_at ? new Date(scheduledGame.scheduled_at) : null;
  const checkinOpens = scheduledAt ? new Date(scheduledAt.getTime() - 60 * 60 * 1000) : null;
  const fwEligible = scheduledAt ? new Date(scheduledAt.getTime() + 60 * 60 * 1000) : null;
  const ts = (date: Date | null) => date ? `<t:${Math.floor(date.getTime() / 1000)}:f> (<t:${Math.floor(date.getTime() / 1000)}:R>)` : "Not set";

  await maybeNotifyCheckinForceWinEligibility(interaction, ctx).catch(() => null);

  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("🎮 Game Queue").setDescription([
      `**Matchup:** <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>`,
      `Accepted time: **${ts(scheduledAt)}**`,
      `Official check-in opens: **${ts(checkinOpens)}**`,
      `Late check-in FW review window: **${ts(fwEligible)}**`,
      `Away checked in: **${status?.away_checked_in ? "yes" : "no"}**${status?.away_checked_in_at ? ` · <t:${Math.floor(new Date(status.away_checked_in_at).getTime() / 1000)}:R>` : ""}`,
      `Home checked in: **${status?.home_checked_in ? "yes" : "no"}**${status?.home_checked_in_at ? ` · <t:${Math.floor(new Date(status.home_checked_in_at).getTime() / 1000)}:R>` : ""}`,
      status?.away_early_available_at ? `Away early available: <t:${Math.floor(new Date(status.away_early_available_at).getTime() / 1000)}:R>` : "",
      status?.home_early_available_at ? `Home early available: <t:${Math.floor(new Date(status.home_early_available_at).getTime() / 1000)}:R>` : "",
      status?.begun_at ? `Begun: <t:${Math.floor(new Date(status.begun_at).getTime() / 1000)}:R>` : "Begun: **no**",
    ].filter(Boolean).join("\n"))],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_checkin").setLabel("✅ Check In").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("gd_message_opponent").setLabel("✉️ Message Opponent").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("gd_mark_begun").setLabel("▶️ Mark Begun").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("gd_mark_complete").setLabel("✅ Mark Complete").setStyle(ButtonStyle.Success),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_report_desync").setLabel("⚠️ Report Desync").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("gd_report_dasher").setLabel("🏃 Report Dashed").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("gd_report_connection").setLabel("📡 Connection Issues").setStyle(ButtonStyle.Secondary),
      ),
      backRow(),
    ] as any,
  });
}

async function handleCheckIn(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const result = await processGamedayCheckIn(interaction, ctx);
  await respond(interaction, { content: result.userMessage, embeds: [], components: [backRow()] as any });
}

async function requireBothCheckedIn(interaction: GamedayInteraction, ctx: GamedayContext): Promise<boolean> {
  const status = await getMatchupStatus(ctx);
  if (status?.away_checked_in && status?.home_checked_in) return true;
  await respond(interaction, { content: "❌ Both users must check in before this action.", embeds: [], components: [backRow()] as any });
  return false;
}

async function showMarkBegunModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder().setCustomId("gd_modal_mark_begun").setTitle("Mark Game Begun");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId("stream_url")
      .setLabel("Stream URL or Discord (optional)")
      .setPlaceholder("Paste Twitch/YouTube link, or type Discord")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(300)));
  await interaction.showModal(modal);
}

type StreamPostingChoice = {
  platform: "none" | "discord" | "external";
  url: string | null;
  label: string | null;
};

function parseStreamPostingChoice(raw: string): StreamPostingChoice | null {
  const value = raw.trim();
  if (!value) return { platform: "none", url: null, label: null };

  const normalized = value.toLowerCase();
  if (["discord", "disc", "dc", "discord stream", "streaming in discord", "stream in discord"].includes(normalized)) {
    return { platform: "discord", url: null, label: "Discord" };
  }

  try {
    const u = new URL(value);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return { platform: "external", url: value, label: value };
    }
  } catch {
    return null;
  }

  return null;
}

async function handleMarkBegunModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  if (!(await requireBothCheckedIn(interaction, ctx))) return;
  const streamInput = interaction.fields.getTextInputValue("stream_url").trim();
  const streamChoice = parseStreamPostingChoice(streamInput);
  if (!streamChoice) return interaction.reply({ ephemeral: true, content: "❌ Paste a valid http:// or https:// stream URL, type **Discord**, or leave it blank." });
  await db.execute(sql`
    update gameday_matchup_status
    set begun_by = ${ctx.userId},
        begun_at = coalesce(begun_at, now()),
        stream_platform = coalesce(${streamChoice.platform === "none" ? null : streamChoice.platform}, stream_platform),
        stream_url = coalesce(${streamChoice.url}, stream_url),
        updated_at = now()
    where guild_id = ${ctx.guildId} and season_id = ${ctx.season.id} and week_index = ${ctx.weekIndex} and matchup_key = ${ctx.matchupKey}
  `);
  await db.execute(sql`
    update game_schedules
    set status = case when status in ('unscheduled','pending','confirmed') then 'started' else status end,
        started_at = coalesce(started_at, now()),
        updated_at = now()
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and ((away_discord_id = ${ctx.awayDiscordId} and home_discord_id = ${ctx.homeDiscordId}) or (away_discord_id = ${ctx.homeDiscordId} and home_discord_id = ${ctx.awayDiscordId}))
  `);
  await postToGamedayChannel(interaction, ctx, `▶️ **Game Begun**\n<@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>\nMarked by <@${ctx.userId}>.${streamChoice.platform === "discord" ? "\n📺 Stream: Discord" : streamChoice.url ? `\n📺 Stream: ${streamChoice.url}` : ""}`);
  await respond(interaction, { content: "✅ Game marked begun.", embeds: [], components: [backRow()] as any });
}

async function showFinalModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder().setCustomId("gd_modal_submit_final").setTitle("Submit Final Score");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("away_score").setLabel("Away score").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("home_score").setLabel("Home score").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3)),
  );
  await interaction.showModal(modal);
}

async function handleFinalModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  if (!(await requireBothCheckedIn(interaction, ctx))) return;
  const status = await getMatchupStatus(ctx);
  if (!status?.begun_at) return respond(interaction, { content: "❌ Mark the game as begun before submitting a final score.", embeds: [], components: [backRow()] as any });
  const awayScore = Number(interaction.fields.getTextInputValue("away_score").trim());
  const homeScore = Number(interaction.fields.getTextInputValue("home_score").trim());
  if (!Number.isInteger(awayScore) || !Number.isInteger(homeScore) || awayScore < 0 || homeScore < 0) {
    await interaction.reply({ ephemeral: true, content: "❌ Scores must be non-negative whole numbers." });
    return;
  }
  try {
    const id = await createScoreSubmission(interaction, ctx, awayScore, homeScore);
    await respond(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("🏁 Final Score Submitted").setDescription(`Score submission #${id} was sent to <@${ctx.opponentId}> for approval.`)], components: [backRow()] as any });
  } catch (err: any) {
    await interaction.reply({ ephemeral: true, content: `❌ ${err?.message ?? "Could not submit final score."}` });
  }
}

async function showScoreApproval(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const score = await getPendingScoreApproval(ctx);
  if (!score) return respond(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("🏁 Score Approval").setDescription("You do not have any pending score approvals.")], components: [backRow()] as any });
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`🏁 Score Approval #${score.id}`).setDescription([
      `**Submitted by:** <@${score.submitted_by}>`,
      `**${score.away_team_name}:** ${score.away_score}`,
      `**${score.home_team_name}:** ${score.home_score}`,
      `**Winner:** <@${score.winner_discord_id}>`,
    ].join("\n"))],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gd_score_approve:${score.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gd_score_dispute:${score.id}`).setLabel("⚠️ Dispute").setStyle(ButtonStyle.Danger),
      ),
      backRow(),
    ] as any,
  });
}

async function showDisputeModal(interaction: ButtonInteraction, id: number): Promise<void> {
  const modal = new ModalBuilder().setCustomId(`gd_modal_score_dispute:${id}`).setTitle("Dispute Final Score");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Reason").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)));
  await interaction.showModal(modal);
}

async function showOpponentMessageModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder().setCustomId("gd_modal_message_opponent").setTitle("Message Opponent");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("message").setLabel("Message").setStyle(TextInputStyle.Paragraph).setMaxLength(800).setRequired(true)));
  await interaction.showModal(modal);
}

async function handleOpponentMessageModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  const msg = interaction.fields.getTextInputValue("message").trim();
  await dmUser(interaction, ctx.opponentId, `✉️ **Message from your opponent <@${ctx.userId}>**\n\n${msg}`);
  await respond(interaction, { content: "✅ Message sent by DM.", embeds: [], components: [backRow()] as any });
}

async function showAssist(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("🚨 Gameday Assistance").setDescription("Submit one clean commissioner request. It will appear in Commissioner Gameday Review.")],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("gd_assist_violation").setLabel("Report Violation").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("gd_assist_fw").setLabel("Request Force Win").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("gd_assist_fs").setLabel("Request Fair Sim").setStyle(ButtonStyle.Secondary),
      ),
      backRow(),
    ] as any,
  });
  void ctx;
}

async function showAssistModal(interaction: ButtonInteraction, type: string): Promise<void> {
  const modal = new ModalBuilder().setCustomId(`gd_modal_assist:${type}`).setTitle("Gameday Assistance");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Explain the issue").setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)));
  await interaction.showModal(modal);
}

async function handleAssistModal(interaction: ModalSubmitInteraction, ctx: GamedayContext, type: string): Promise<void> {
  const map: Record<string, string> = { violation: "violation", fw: "force_win", fs: "fair_sim" };
  const requestType = map[type] ?? "violation";
  const reason = interaction.fields.getTextInputValue("reason").trim();
  await db.execute(sql`
    insert into gameday_commissioner_requests (
      guild_id, season_id, week_index, matchup_key, request_type,
      requested_by, opponent_discord_id, reason, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, ${requestType},
      ${ctx.userId}, ${ctx.opponentId || null}, ${reason}, 'pending'
    )
  `);
  await postToGamedayChannel(interaction, ctx, `🚨 **Commissioner Review Request**\nType: **${requestType.replaceAll("_", " ")}**\nUser: <@${ctx.userId}>\nMatchup: <@${ctx.awayDiscordId}> @ <@${ctx.homeDiscordId}>`);
  await respond(interaction, { content: "✅ Request submitted for commissioner review.", embeds: [], components: [backRow()] as any });
}


async function commissionerMention(interaction: GamedayInteraction): Promise<string> {
  const guild = interaction.guild;
  const role = guild?.roles.cache.find((r) => /commissioner|co[-\s]?commissioner|commish/i.test(r.name));
  return role ? `<@&${role.id}>` : "@Commissioners";
}

function isCommissionerMember(interaction: GamedayInteraction): boolean {
  return canUseCommissionerOffice(interaction.member as GuildMember | null | undefined, true);
}

async function showDesyncSelect(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("gd_desync_choice")
    .setPlaceholder("Choose desync request type…")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Request Retry").setValue("retry").setDescription("Tell opponent you are ready and willing to replay."),
      new StringSelectMenuOptionBuilder().setLabel("Request Fair Sim").setValue("fair_sim").setDescription("Ask opponent to confirm fair sim request."),
      new StringSelectMenuOptionBuilder().setLabel("Request Force Win").setValue("force_win").setDescription("Send FW reason to commissioners for decision."),
    );
  await respond(interaction, {
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle("⚠️ Report Desync").setDescription("Select what you are requesting after the desync.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backRow()] as any,
  });
  void ctx;
}

async function handleDesyncChoice(interaction: StringSelectMenuInteraction, ctx: GamedayContext): Promise<void> {
  const choice = interaction.values[0] ?? "retry";
  if (choice === "force_win") {
    const modal = new ModalBuilder().setCustomId("gd_modal_desync_fw").setTitle("Desync Force Win Request");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Reason for FW request").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
    await interaction.showModal(modal);
    return;
  }

  const commish = await commissionerMention(interaction);
  const requestType = choice === "fair_sim" ? "fair_sim" : "desync_retry";
  const result = await db.execute(sql`
    insert into gameday_issue_reports (
      guild_id, season_id, week_index, matchup_key, issue_type,
      requested_by, opponent_discord_id, status, details
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, ${requestType},
      ${ctx.userId}, ${ctx.opponentId}, 'pending', ${choice === "fair_sim" ? "Desync: fair sim requested." : "Desync: retry requested."}
    ) returning id
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: number }>;
  const issueId = Number(rows[0]?.id ?? 0);

  if (choice === "retry") {
    await dmUser(interaction, ctx.opponentId, `⚠️ <@${ctx.userId}> reported a desync and is ready and willing to replay your game.`);
    await postToGamedayChannel(interaction, ctx, `${commish}\n⚠️ **Desync Reported — Retry Requested**\n<@${ctx.userId}> reported a desync vs <@${ctx.opponentId}> and is ready and willing to play again.`);
  } else {
    await dmUser(interaction, ctx.opponentId, `⚖️ <@${ctx.userId}> reported a desync and requested a Fair Sim. Use /gameday → Game Queue to respond if prompted.`);
    await postToGamedayChannel(interaction, ctx, `${commish}\n⚖️ **Desync Reported — Fair Sim Requested**\n<@${ctx.userId}> requested a Fair Sim after a desync vs <@${ctx.opponentId}>. Opponent confirmation requested.\nIssue #${issueId}`);
  }
  await respond(interaction, { content: "✅ Desync report submitted.", embeds: [], components: [backRow()] as any });
}

async function handleDesyncFwModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const commish = await commissionerMention(interaction);
  await db.execute(sql`
    insert into gameday_commissioner_requests (
      guild_id, season_id, week_index, matchup_key, request_type,
      requested_by, opponent_discord_id, reason, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, 'force_win',
      ${ctx.userId}, ${ctx.opponentId}, ${`Desync FW request: ${reason}`}, 'pending'
    )
  `);
  await postToGamedayChannel(interaction, ctx, `${commish}\n🚨 **Desync Reported — Force Win Requested**\n<@${ctx.userId}> requested FW vs <@${ctx.opponentId}> after a desync.\n**Reason:** ${reason}\nFinal ruling is commissioner discretion.`);
  await respond(interaction, { content: "✅ Desync FW request submitted to commissioners.", embeds: [], components: [backRow()] as any });
}

async function handleDashedReport(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const commish = await commissionerMention(interaction);
  const result = await db.execute(sql`
    insert into gameday_commissioner_requests (
      guild_id, season_id, week_index, matchup_key, request_type,
      requested_by, opponent_discord_id, reason, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, 'dashed_report',
      ${ctx.userId}, ${ctx.opponentId}, 'Opponent allegedly dashed without commissioner approval.', 'pending'
    ) returning id
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: number }>;
  const requestId = Number(rows[0]?.id ?? 0);
  await postToGamedayChannel(interaction, ctx, `${commish}\n🏃 **Opponent Dashed Reported**\n<@${ctx.userId}> reported that <@${ctx.opponentId}> dashed without approval.\nCommissioners may confirm or deny the report in /gameday → Commissioner Review.\nRequest #${requestId}`);
  await respond(interaction, { content: "✅ Dashed report submitted to commissioners.", embeds: [], components: [backRow()] as any });
}

async function handleConnectionIssue(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const commish = await commissionerMention(interaction);
  const msg = await postToGamedayChannel(interaction, ctx, `${commish}\n📡 **Connection Issue Reported**\nConnection dropped between <@${ctx.awayDiscordId}> and <@${ctx.homeDiscordId}>. Both users should prepare to search again.\n\nReact with 🇫 if requesting a Fair Sim instead.\nReact with 🇼 if requesting a Force Win instead of searching and playing again.`);
  const sent = msg as any;
  await sent?.react?.("🇫").catch(() => null);
  await sent?.react?.("🇼").catch(() => null);
  await db.execute(sql`
    insert into gameday_issue_reports (
      guild_id, season_id, week_index, matchup_key, issue_type,
      requested_by, opponent_discord_id, status, message_id, details
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, 'connection_issue',
      ${ctx.userId}, ${ctx.opponentId}, 'pending', ${sent?.id ?? null}, 'Connection issue reaction prompt posted.'
    )
  `);
  await respond(interaction, { content: "✅ Connection issue posted in the game channel.", embeds: [], components: [backRow()] as any });
}

async function handleMarkComplete(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  const existing = await oneOf<any>(sql`
    select *
    from gameday_completion_confirmations
    where guild_id = ${ctx.guildId}
      and season_id = ${ctx.season.id}
      and week_index = ${ctx.weekIndex}
      and matchup_key = ${ctx.matchupKey}
      and status = 'pending'
    limit 1
  `);

  if (existing && existing.requested_by !== ctx.userId) {
    await db.execute(sql`
      update gameday_completion_confirmations
      set status = 'confirmed', confirmed_by = ${ctx.userId}, confirmed_at = now(), updated_at = now()
      where id = ${existing.id}
    `);
    await db.execute(sql`
      update game_schedules
      set status = 'completed_pending_import', finished_at = coalesce(finished_at, now()), updated_at = now()
      where guild_id = ${ctx.guildId}
        and season_id = ${ctx.season.id}
        and week_index = ${ctx.weekIndex}
        and ((away_discord_id = ${ctx.awayDiscordId} and home_discord_id = ${ctx.homeDiscordId}) or (away_discord_id = ${ctx.homeDiscordId} and home_discord_id = ${ctx.awayDiscordId}))
    `);
    await db.execute(sql`
      update rec_league_games
      set status = 'completed_pending_import', updated_at = now()
      where guild_id = ${ctx.guildId}
        and legacy_season_id = ${ctx.season.id}
        and week_number = ${ctx.weekIndex}
        and ((away_discord_id = ${ctx.awayDiscordId} and home_discord_id = ${ctx.homeDiscordId}) or (away_discord_id = ${ctx.homeDiscordId} and home_discord_id = ${ctx.awayDiscordId}))
    `);
    await postToGamedayChannel(interaction, ctx, `✅ **Game End Confirmed**\n<@${ctx.userId}> confirmed the game ended. Scores/winner will be updated by MCA import.`);
    await respond(interaction, { content: "✅ Game completion confirmed. Awaiting import for scores and winner.", embeds: [], components: [backRow()] as any });
    return;
  }

  if (existing && existing.requested_by === ctx.userId) {
    await respond(interaction, { content: "⏳ You already marked this game complete. Waiting for your opponent to confirm the game ended.", embeds: [], components: [backRow()] as any });
    return;
  }

  await db.execute(sql`
    insert into gameday_completion_confirmations (
      guild_id, season_id, week_index, matchup_key, requested_by, opponent_discord_id, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, ${ctx.userId}, ${ctx.opponentId}, 'pending'
    )
  `);
  await dmUser(interaction, ctx.opponentId, `✅ <@${ctx.userId}> marked your game complete. Open /gameday → Game Queue and click Mark Complete to confirm the game ended. Scores and winner will come from import.`);
  await postToGamedayChannel(interaction, ctx, `✅ **Game Completion Confirmation Requested**\n<@${ctx.userId}> marked the game complete. Waiting on <@${ctx.opponentId}> to confirm the game ended. Scores and winner will come from import.`);
  await respond(interaction, { content: "✅ Completion confirmation requested from your opponent.", embeds: [], components: [backRow()] as any });
}

async function showCpuStreamModal(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder().setCustomId("gd_modal_cpu_stream").setTitle("Report CPU Stream");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("stream_url").setLabel("Stream URL").setStyle(TextInputStyle.Short).setMaxLength(300).setRequired(true)));
  await interaction.showModal(modal);
}

async function handleCpuStreamModal(interaction: ModalSubmitInteraction, ctx: GamedayContext): Promise<void> {
  const streamUrl = interaction.fields.getTextInputValue("stream_url").trim();
  if (!validUrl(streamUrl)) return interaction.reply({ ephemeral: true, content: "❌ Use a valid http:// or https:// stream URL." });
  await db.execute(sql`
    insert into gameday_cpu_actions (guild_id, season_id, week_index, user_discord_id, user_team_name, cpu_team_name, schedule_id, cpu_stream_link)
    values (${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.userId}, ${ctx.userTeamName ?? null}, ${ctx.cpuTeamName ?? null}, ${ctx.scheduleId ?? null}, ${streamUrl})
    on conflict (guild_id, season_id, week_index, user_discord_id)
    do update set cpu_stream_link = excluded.cpu_stream_link, updated_at = now()
  `);
  await postToGamedayChannel(interaction, ctx, `📺 **CPU Stream Reported**\n<@${ctx.userId}> vs CPU ${ctx.cpuTeamName ?? "opponent"}\n${streamUrl}`);
  await respond(interaction, { content: "✅ CPU stream reported.", embeds: [], components: [backRow()] as any });
}

async function handleCpuFw(interaction: ButtonInteraction, ctx: GamedayContext): Promise<void> {
  await db.execute(sql`
    insert into gameday_cpu_actions (guild_id, season_id, week_index, user_discord_id, user_team_name, cpu_team_name, schedule_id, fw_requested, fw_status)
    values (${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.userId}, ${ctx.userTeamName ?? null}, ${ctx.cpuTeamName ?? null}, ${ctx.scheduleId ?? null}, true, 'pending')
    on conflict (guild_id, season_id, week_index, user_discord_id)
    do update set fw_requested = true, fw_status = 'pending', updated_at = now()
  `);
  await db.execute(sql`
    insert into gameday_commissioner_requests (
      guild_id, season_id, week_index, matchup_key, request_type,
      requested_by, opponent_discord_id, reason, status
    ) values (
      ${ctx.guildId}, ${ctx.season.id}, ${ctx.weekIndex}, ${ctx.matchupKey}, 'force_win',
      ${ctx.userId}, null, ${`CPU force win requested for ${ctx.userTeamName ?? "user team"} vs ${ctx.cpuTeamName ?? "CPU"}.`}, 'pending'
    )
  `);
  await postToGamedayChannel(interaction, ctx, `🏳️ **CPU Force Win Requested**\n<@${ctx.userId}> vs CPU ${ctx.cpuTeamName ?? "opponent"}. Commissioner review required.`);
  await respond(interaction, { content: "✅ CPU force-win request logged.", embeds: [], components: [backRow()] as any });
}

export async function openGamedayDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const ctx = await resolveGamedayContext(interaction);
  if (!ctx) {
    if (isCommissionerMember(interaction)) {
      await renderCommissionerOnlyDashboard(interaction);
    }
    return;
  }
  await renderDashboard(interaction, ctx);
}

export async function handleGamedayInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("gd_")) return false;
  await ensureGamedaySchema();

  const parts = interaction.customId.split(":");
  const action = parts[0]!;
  const id = parts[1] ? Number(parts[1]) : null;

  if (interaction.isButton()) {
    if (action === "gd_commish_review") {
      if (!isCommissionerMember(interaction)) {
        await interaction.reply({ ephemeral: true, content: "❌ Commissioner access required." });
        return true;
      }
      await renderCommissionerGamedayReview(interaction as any);
      return true;
    }
    if (action === "gd_offer_counter" && id != null) return void (await showCounterModal(interaction, id)), true;
    if (action === "gd_offer_reject" && id != null) return void (await showRejectModal(interaction, id)), true;
    if (action === "gd_score_dispute" && id != null) return void (await showDisputeModal(interaction, id)), true;
    if (action === "gd_mark_begun") return void (await showMarkBegunModal(interaction)), true;
    if (action === "gd_submit_final") return void (await showFinalModal(interaction)), true;
    if (action === "gd_message_opponent") return void (await showOpponentMessageModal(interaction)), true;
    if (action === "gd_sched_note") return void (await showNoteModal(interaction)), true;
    if (action.startsWith("gd_assist_")) return void (await showAssistModal(interaction, action.replace("gd_assist_", ""))), true;
    if (action === "gd_cpu_stream") return void (await showCpuStreamModal(interaction)), true;
  }

  const ctx = await resolveGamedayContext(interaction);
  if (!ctx) return true;

  if (interaction.isStringSelectMenu()) {
    if (action === "gd_sched_tz") {
      const tz = interaction.values[0] ?? "CST";
      if (isValidTz(tz)) patchDraft(ctx, { tz });
      await showDaySelect(interaction, ctx);
      return true;
    }
    if (action === "gd_sched_day") {
      patchDraft(ctx, { dayIso: interaction.values[0] });
      await showTimeSelect(interaction, ctx);
      return true;
    }
    if (action === "gd_sched_time") {
      patchDraft(ctx, { time: interaction.values[0] });
      await showOfferConfirm(interaction, ctx);
      return true;
    }
    if (action === "gd_pending_select") return void (await showPendingOfferDetail(interaction, ctx)), true;
    if (action === "gd_manage_select") return void (await showSentOfferDetail(interaction, ctx)), true;
    if (action === "gd_desync_choice") return void (await handleDesyncChoice(interaction, ctx)), true;
  }

  if (interaction.isModalSubmit()) {
    if (action === "gd_modal_offer_note") {
      patchDraft(ctx, { notes: interaction.fields.getTextInputValue("notes").trim() || undefined });
      await respond(interaction, { content: "✅ Note saved.", embeds: [], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gd_offer_confirm").setLabel("Continue").setStyle(ButtonStyle.Success))] as any });
      return true;
    }
    if (action === "gd_modal_counter" && id != null) {
      const proposedFor = interaction.fields.getTextInputValue("proposed_for").trim();
      const proposedTz = interaction.fields.getTextInputValue("proposed_tz").trim().toUpperCase();
      const notes = interaction.fields.getTextInputValue("notes").trim() || null;
      const newId = await counterOffer(ctx, id, proposedFor, proposedTz, notes);
      if (!newId) return void (await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." })), true;
      await dmUser(interaction, ctx.opponentId, `🔁 <@${ctx.userId}> countered with **${proposedFor} ${proposedTz}** for ${ctx.awayTeamName} @ ${ctx.homeTeamName}.`);
      await respond(interaction, { content: `✅ Counter offer #${newId} sent.`, embeds: [], components: [backRow()] as any });
      return true;
    }
    if (action === "gd_modal_reject" && id != null) {
      const reason = interaction.fields.getTextInputValue("reason").trim();
      const offer = await rejectOffer(ctx, id, reason);
      if (!offer) return void (await interaction.reply({ ephemeral: true, content: "❌ Offer not found or no longer pending." })), true;
      await dmUser(interaction, offer.proposer_discord_id, `❌ Your scheduling offer was rejected by <@${ctx.userId}>.\n\n**Reason:** ${reason}`);
      await respond(interaction, { content: "✅ Offer rejected and proposer notified.", embeds: [], components: [backRow()] as any });
      return true;
    }
    if (action === "gd_modal_mark_begun") return void (await handleMarkBegunModal(interaction, ctx)), true;
    if (action === "gd_modal_submit_final") return void (await handleFinalModal(interaction, ctx)), true;
    if (action === "gd_modal_score_dispute" && id != null) {
      const reason = interaction.fields.getTextInputValue("reason").trim();
      const score = await disputeScore(ctx, id, reason);
      if (!score) return void (await interaction.reply({ ephemeral: true, content: "❌ Score submission not found or no longer pending." })), true;
      await postToGamedayChannel(interaction, ctx, `⚠️ **Final Score Disputed**\nScore #${score.id} disputed by <@${ctx.userId}>. Commissioner review required.`);
      await respond(interaction, { content: "✅ Dispute submitted for commissioner review.", embeds: [], components: [backRow()] as any });
      return true;
    }
    if (action === "gd_modal_message_opponent") return void (await handleOpponentMessageModal(interaction, ctx)), true;
    if (action === "gd_modal_assist") return void (await handleAssistModal(interaction, ctx, parts[1] ?? "violation")), true;
    if (action === "gd_modal_desync_fw") return void (await handleDesyncFwModal(interaction, ctx)), true;
    if (action === "gd_modal_cpu_stream") return void (await handleCpuStreamModal(interaction, ctx)), true;
  }

  if (!interaction.isButton()) return true;
  switch (action) {
    case "gd_refresh": await renderDashboard(interaction, ctx); break;
    case "gd_schedule": await showScheduleHub(interaction, ctx); break;
    case "gd_offer_new": scheduleDrafts.set(draftKey(ctx), {}); await showTimezoneSelect(interaction, ctx); break;
    case "gd_sched_back_day": await showDaySelect(interaction, ctx); break;
    case "gd_sched_back_time": await showTimeSelect(interaction, ctx); break;
    case "gd_sched_time_page": await showTimeSelect(interaction, ctx, Number(parts[1] ?? 0)); break;
    case "gd_offer_confirm": await sendOffer(interaction, ctx); break;
    case "gd_pending": await showPendingOffers(interaction, ctx); break;
    case "gd_manage_offers": await showSentOffers(interaction, ctx); break;
    case "gd_offer_accept": {
      if (id == null) break;
      const offer = await acceptOffer(interaction, ctx, id);
      await respond(interaction, offer ? { content: "✅ Offer accepted and posted.", embeds: [], components: [backRow()] as any } : { content: "❌ Offer not found or no longer pending.", embeds: [], components: [] });
      break;
    }
    case "gd_offer_delete": {
      if (id == null) break;
      const offer = await cancelOffer(ctx, id);
      if (offer) await dmUser(interaction, offer.recipient_discord_id, `🗑️ <@${ctx.userId}> cancelled scheduling offer #${offer.id}.`);
      await respond(interaction, offer ? { content: "✅ Offer cancelled.", embeds: [], components: [backRow()] as any } : { content: "❌ Offer not found or no longer pending.", embeds: [], components: [] });
      break;
    }
    case "gd_queue": await showQueue(interaction, ctx); break;
    case "gd_mark_begun": await showMarkBegunModal(interaction); break;
    case "gd_message_opponent": await showOpponentMessageModal(interaction); break;
    case "gd_checkin": await handleCheckIn(interaction, ctx); break;
    case "gd_checkin_fw_request": {
      if (id == null) break;
      await handleCheckinForceWinDecision(interaction, ctx, "request", id);
      break;
    }
    case "gd_checkin_fw_decline": {
      if (id == null) break;
      await handleCheckinForceWinDecision(interaction, ctx, "decline", id);
      break;
    }
    case "gd_mark_complete": await handleMarkComplete(interaction, ctx); break;
    case "gd_report_desync": await showDesyncSelect(interaction, ctx); break;
    case "gd_report_dasher": await handleDashedReport(interaction, ctx); break;
    case "gd_report_connection": await handleConnectionIssue(interaction, ctx); break;
    case "gd_commish_review": {
      if (!isCommissionerMember(interaction)) {
        await interaction.reply({ ephemeral: true, content: "❌ Commissioner access required." });
        break;
      }
      await renderCommissionerGamedayReview(interaction as any);
      break;
    }
    case "gd_assist": await showAssist(interaction, ctx); break;
    case "gd_press": await handleAcPressOpen(interaction as any); break;
    case "gd_rivalries": await handleAcRivalries(interaction as any); break;
    case "gd_cpu_fw": {
      if (!(interaction as any).deferred && !(interaction as any).replied) {
        await interaction.deferUpdate().catch(() => null);
      }
      await handleCpuFw(interaction, ctx);
      break;
    }
    default:
      await interaction.reply({ ephemeral: true, content: "❌ Unknown gameday action. Reopen `/gameday` and try again." });
  }
  return true;
}
