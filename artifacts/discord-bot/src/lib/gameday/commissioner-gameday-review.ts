import {
  ActionRowBuilder,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

type ReviewKind =
  | "force_win"
  | "fair_sim"
  | "violation"
  | "dashed_report"
  | "desync_retry"
  | "connection_issue"
  | "advance_delay"
  | "accepted_schedule"
  | "disputed_finals" // legacy only; no longer exposed in /gameday review
  | "payout_history"
  | "schedule_attempts"
  | "analytics";

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    force_win: "Force Win Requests",
    fair_sim: "Fair Sim Requests",
    violation: "Violations",
    dashed_report: "Dashed Reports",
    desync_retry: "Desync Retry Requests",
    connection_issue: "Connection Issue Reports",
    advance_delay: "Advance Delay Requests",
    accepted_schedule: "Accepted Scheduled Times",
    payout_history: "Stream/Highlight Auto-Payout History",
    schedule_attempts: "Schedule Attempts",
    analytics: "Gameday Analytics",
  };
  return labels[kind] ?? kind;
}

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

async function respondReview(interaction: ButtonInteraction | StringSelectMenuInteraction, payload: any): Promise<void> {
  const safePayload = { ...payload };
  if ((interaction as any).deferred || (interaction as any).replied) {
    await (interaction as any).editReply(safePayload).catch(async () => {
      await (interaction as any).followUp({ ...safePayload, ephemeral: true }).catch(() => null);
    });
    return;
  }

  await (interaction as any).update(safePayload).catch(async () => {
    if (!(interaction as any).deferred && !(interaction as any).replied) {
      await (interaction as any).reply({ ...safePayload, ephemeral: true }).catch(() => null);
      return;
    }
    await (interaction as any).editReply(safePayload).catch(async () => {
      await (interaction as any).followUp({ ...safePayload, ephemeral: true }).catch(() => null);
    });
  });
}

async function acknowledgeReviewInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  if ((interaction as any).deferred || (interaction as any).replied) return;
  await (interaction as any).deferUpdate().catch(() => null);
}


type Cached<T> = { value: T; expiresAt: number };
const REVIEW_TTL_MS = 60_000;
const reviewCache = new Map<string, Cached<any>>();

function getReviewCached<T>(key: string): T | null {
  const hit = reviewCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    reviewCache.delete(key);
    return null;
  }
  return hit.value as T;
}

function setReviewCached<T>(key: string, value: T, ttl = REVIEW_TTL_MS): T {
  reviewCache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

export function invalidateCommissionerReviewCache(guildId?: string): void {
  if (!guildId) {
    reviewCache.clear();
    return;
  }
  for (const key of reviewCache.keys()) {
    if (key.startsWith(`${guildId}:`)) reviewCache.delete(key);
  }
}

async function loadReviewCounts(guildId: string) {
  const cacheKey = `${guildId}:review_counts`;
  const cached = getReviewCached<any>(cacheKey);
  if (cached) return cached;

  const [requestRows, acceptedRows, payoutRows, scheduleRows] = await Promise.all([
    rowsOf<{ request_type: string; count: number }>(sql`
      select request_type, count(*)::int as count
      from gameday_commissioner_requests
      where guild_id = ${guildId}
        and status = 'pending'
      group by request_type
    `),
    rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from game_schedules
      where guild_id = ${guildId}
        and scheduled_at is not null
        and status in ('scheduled','accepted','started')
    `),
    rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from pending_channel_payouts
      where guild_id = ${guildId}
        and type in ('stream','highlight')
        and status = 'approved'
        and created_at >= now() - interval '7 days'
    `),
    rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from gameday_schedule_offers
      where guild_id = ${guildId}
        and created_at >= now() - interval '7 days'
    `),
  ]);

  const byType = new Map(requestRows.map((r) => [r.request_type, Number(r.count ?? 0)]));
  const result = {
    fw: (byType.get('force_win') ?? 0) + (byType.get('checkin_force_win') ?? 0),
    fs: byType.get('fair_sim') ?? 0,
    violations: byType.get('violation') ?? 0,
    dashed: byType.get('dashed_report') ?? 0,
    desync: byType.get('desync_retry') ?? 0,
    connection: byType.get('connection_issue') ?? 0,
    delays: byType.get('advance_delay') ?? 0,
    acceptedSchedules: Number(acceptedRows[0]?.count ?? 0),
    payouts: Number(payoutRows[0]?.count ?? 0),
    schedules: Number(scheduleRows[0]?.count ?? 0),
  };

  return setReviewCached(cacheKey, result);
}

async function countPending(guildId: string, type: string): Promise<number> {
  const rows = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from gameday_commissioner_requests
    where guild_id = ${guildId}
      and (
        request_type = ${type}
        or (${type} = 'force_win' and request_type = 'checkin_force_win')
      )
      and status = 'pending'
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countDisputed(guildId: string): Promise<number> {
  const rows = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from gameday_score_submissions
    where guild_id = ${guildId}
      and status = 'disputed'
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countPayouts(guildId: string): Promise<number> {
  const rows = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from pending_channel_payouts
    where guild_id = ${guildId}
      and type in ('stream','highlight')
      and status = 'approved'
      and created_at >= now() - interval '7 days'
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countScheduleAttempts(guildId: string): Promise<number> {
  const rows = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from gameday_schedule_offers
    where guild_id = ${guildId}
      and created_at >= now() - interval '7 days'
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countAcceptedScheduledGames(guildId: string): Promise<number> {
  const rows = await rowsOf<{ count: number }>(sql`
    select count(*)::int as count
    from game_schedules
    where guild_id = ${guildId}
      and scheduled_at is not null
      and status in ('scheduled','accepted','started')
  `);
  return Number(rows[0]?.count ?? 0);
}

export async function renderCommissionerGamedayReview(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;

  const { fw, fs, violations, dashed, desync, connection, delays, acceptedSchedules, payouts, schedules } = await loadReviewCounts(guildId);

  const embed = new EmbedBuilder()
    .setColor(Colors.DarkBlue)
    .setTitle("🎮 Commissioner Gameday Review")
    .setDescription(
      [
        `🏳️ Force Win Requests: **${fw}**`,
        `⚖️ Fair Sim Requests: **${fs}**`,
        `🚫 Violations: **${violations}**`,
        `🏃 Dashed Reports: **${dashed}**`,
        `⚠️ Desync Retry Requests: **${desync}**`,
        `📡 Connection Issue Reports: **${connection}**`,
        `⏰ Advance Delay Requests: **${delays}**`,
        `✅ Accepted Scheduled Times: **${acceptedSchedules}**`,
        `🗓️ Schedule Attempts: **${schedules}**`,
        `💰 Recent Auto-Payouts: **${payouts}**`,
      ].join("\n"),
    );

  const menu = new StringSelectMenuBuilder()
    .setCustomId("gdrev_cat")
    .setPlaceholder("Select a gameday review category…")
    .addOptions([
      new StringSelectMenuOptionBuilder().setLabel(`Force Win Requests (${fw})`).setValue("force_win").setEmoji("🏳️"),
      new StringSelectMenuOptionBuilder().setLabel(`Fair Sim Requests (${fs})`).setValue("fair_sim").setEmoji("⚖️"),
      new StringSelectMenuOptionBuilder().setLabel(`Violations (${violations})`).setValue("violation").setEmoji("🚫"),
      new StringSelectMenuOptionBuilder().setLabel(`Dashed Reports (${dashed})`).setValue("dashed_report").setEmoji("🏃"),
      new StringSelectMenuOptionBuilder().setLabel(`Desync Retry (${desync})`).setValue("desync_retry").setEmoji("⚠️"),
      new StringSelectMenuOptionBuilder().setLabel(`Connection Issues (${connection})`).setValue("connection_issue").setEmoji("📡"),
      new StringSelectMenuOptionBuilder().setLabel(`Advance Delay Requests (${delays})`).setValue("advance_delay").setEmoji("⏰"),
      new StringSelectMenuOptionBuilder().setLabel(`Accepted Scheduled Times (${acceptedSchedules})`).setValue("accepted_schedule").setEmoji("✅"),
      new StringSelectMenuOptionBuilder().setLabel(`Schedule Attempts (${schedules})`).setValue("schedule_attempts").setEmoji("🗓️"),
      new StringSelectMenuOptionBuilder().setLabel(`Auto-Payout History (${payouts})`).setValue("payout_history").setEmoji("💰"),
      new StringSelectMenuOptionBuilder().setLabel("Gameday Analytics").setValue("analytics").setEmoji("📊"),
    ]);

  const payload = {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
      new ActionRowBuilder<any>().addComponents(
        new ButtonBuilder().setCustomId("ao_hub_back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };

  if ((interaction as any).deferred || (interaction as any).replied) {
    await (interaction as any).editReply(payload).catch(async () => {
      await (interaction as any).followUp({ ...payload, ephemeral: true }).catch(() => null);
    });
  } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await (interaction as any).update(payload).catch(async () => {
      if (!(interaction as any).deferred && !(interaction as any).replied) {
        await (interaction as any).reply({ ...payload, ephemeral: true }).catch(() => null);
      }
    });
  }
}

export async function renderReviewCategory(interaction: StringSelectMenuInteraction | ButtonInteraction, kind: ReviewKind, page = 0) {
  const guildId = interaction.guildId!;
  const pageSize = 5;
  const offset = page * pageSize;

  let rows: any[] = [];
  let total = 0;

  if (["force_win", "fair_sim", "violation", "dashed_report", "desync_retry", "connection_issue", "advance_delay"].includes(kind)) {
    const countRows = await rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from gameday_commissioner_requests
      where guild_id = ${guildId}
        and (
          request_type = ${kind}
          or (${kind} = 'force_win' and request_type = 'checkin_force_win')
        )
        and status = 'pending'
    `);
    total = Number(countRows[0]?.count ?? 0);
    rows = await rowsOf(sql`
      select *
      from gameday_commissioner_requests
      where guild_id = ${guildId}
        and (
          request_type = ${kind}
          or (${kind} = 'force_win' and request_type = 'checkin_force_win')
        )
        and status = 'pending'
      order by created_at desc
      limit ${pageSize}
      offset ${offset}
    `);
  } else if (kind === "accepted_schedule") {
    const countRows = await rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from game_schedules
      where guild_id = ${guildId}
        and scheduled_at is not null
        and status in ('scheduled','accepted','started')
    `);
    total = Number(countRows[0]?.count ?? 0);
    rows = await rowsOf(sql`
      select id, guild_id, season_id, week_index,
             away_discord_id, home_discord_id,
             away_team_name, home_team_name,
             status, scheduled_at, scheduled_tz, channel_id,
             updated_at
      from game_schedules
      where guild_id = ${guildId}
        and scheduled_at is not null
        and status in ('scheduled','accepted','started')
      order by scheduled_at asc, updated_at desc
      limit ${pageSize}
      offset ${offset}
    `);
  } else if (kind === "disputed_finals") {
    const countRows = await rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from gameday_score_submissions
      where guild_id = ${guildId}
        and status = 'disputed'
    `);
    total = Number(countRows[0]?.count ?? 0);
    rows = await rowsOf(sql`
      select *
      from gameday_score_submissions
      where guild_id = ${guildId}
        and status = 'disputed'
      order by updated_at desc
      limit ${pageSize}
      offset ${offset}
    `);
  } else if (kind === "schedule_attempts") {
    const countRows = await rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from gameday_schedule_offers
      where guild_id = ${guildId}
        `);
    total = Number(countRows[0]?.count ?? 0);
    rows = await rowsOf(sql`
      select *
      from gameday_schedule_offers
      where guild_id = ${guildId}
        order by created_at desc
      limit ${pageSize}
      offset ${offset}
    `);
  } else if (kind === "analytics") {
    const analyticsRows = await rowsOf<any>(sql`
      with fw as (
        select requested_by as discord_id, count(*)::int as fw_requests
        from gameday_commissioner_requests
        where guild_id = ${guildId} and request_type = 'force_win'
        group by requested_by
      ),
      disputes as (
        select submitted_by as discord_id, count(*)::int as disputed_finals
        from gameday_score_submissions
        where guild_id = ${guildId} and status = 'disputed'
        group by submitted_by
      ),
      offers as (
        select proposer_discord_id as discord_id, count(*)::int as offers_sent
        from gameday_schedule_offers
        where guild_id = ${guildId}
        group by proposer_discord_id
      )
      select coalesce(fw.discord_id, disputes.discord_id, offers.discord_id) as discord_id,
             coalesce(fw.fw_requests, 0) as fw_requests,
             coalesce(disputes.disputed_finals, 0) as disputed_finals,
             coalesce(offers.offers_sent, 0) as offers_sent
      from fw
      full outer join disputes on disputes.discord_id = fw.discord_id
      full outer join offers on offers.discord_id = coalesce(fw.discord_id, disputes.discord_id)
      order by fw_requests desc, disputed_finals desc, offers_sent desc
      limit 10
    `);
    rows = analyticsRows;
    total = analyticsRows.length;
  } else if (kind === "payout_history") {
    const countRows = await rowsOf<{ count: number }>(sql`
      select count(*)::int as count
      from pending_channel_payouts
      where guild_id = ${guildId}
        and type in ('stream','highlight')
        and status = 'approved'
        and created_at >= now() - interval '7 days'
    `);
    total = Number(countRows[0]?.count ?? 0);
    rows = await rowsOf(sql`
      select *
      from pending_channel_payouts
      where guild_id = ${guildId}
        and type in ('stream','highlight')
        and status = 'approved'
        and created_at >= now() - interval '7 days'
      order by created_at desc
      limit ${pageSize}
      offset ${offset}
    `);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const desc = rows.length
    ? rows.map((r, i) => formatReviewRow(kind, r, offset + i + 1)).join("\n\n").slice(0, 3900)
    : "_No items in this category._";

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`🎮 ${kindLabel(kind)}`)
    .setDescription(desc)
    .setFooter({ text: `Page ${page + 1}/${totalPages}` });

  const components: any[] = [];

  if (rows.length && ["force_win", "fair_sim", "violation", "dashed_report", "desync_retry", "connection_issue", "advance_delay", "accepted_schedule"].includes(kind)) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`gdrev_item:${kind}`)
      .setPlaceholder("Select an item to resolve…")
      .addOptions(rows.slice(0, 25).map((r) =>
        new StringSelectMenuOptionBuilder()
          .setLabel((kind === "accepted_schedule" ? `Week ${Number(r.week_index ?? 0) + 1} · ${r.away_team_name ?? "Away"} @ ${r.home_team_name ?? "Home"}` : `#${r.id} · ${kindLabel(kind)}`).slice(0, 100))
          .setDescription((kind === "accepted_schedule" ? `${r.status ?? "scheduled"} · ${r.scheduled_at ? new Date(r.scheduled_at).toLocaleString() : "No time"}` : (r.reason ?? r.dispute_reason ?? r.status ?? "Review item")).slice(0, 100))
          .setValue(String(r.id)),
      ));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`gdrev_page:${kind}:${page - 1}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`gdrev_page:${kind}:${page + 1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      new ButtonBuilder().setCustomId("gdrev_home").setLabel("← Review Home").setStyle(ButtonStyle.Secondary),
    ),
  );

  await respondReview(interaction, { embeds: [embed], components });
}

function formatReviewRow(kind: string, r: any, n: number): string {
  if (kind === "accepted_schedule") {
    const ts = r.scheduled_at ? Math.floor(new Date(r.scheduled_at).getTime() / 1000) : null;
    const time = ts ? `<t:${ts}:f> (<t:${ts}:R>)` : `${r.scheduled_at ?? "Unknown"} ${r.scheduled_tz ?? ""}`;
    const channel = r.channel_id ? `
Channel: <#${r.channel_id}>` : "";
    return `**${n}. Week ${Number(r.week_index ?? 0) + 1} — ${r.status}**
<@${r.away_discord_id}> (${r.away_team_name ?? "Away"}) @ <@${r.home_discord_id}> (${r.home_team_name ?? "Home"})
Accepted Time: **${time}**${channel}`;
  }
  if (kind === "disputed_finals") {
    return `**${n}. Score Dispute #${r.id}**\n<@${r.away_discord_id}> @ <@${r.home_discord_id}>\nScore: **${r.away_team_name} ${r.away_score} — ${r.home_team_name} ${r.home_score}**\nReason: ${r.dispute_reason ?? "_No reason_"}`;
  }
  if (kind === "schedule_attempts") {
    return `**${n}. Offer #${r.id} — ${r.status}**\n<@${r.away_discord_id}> @ <@${r.home_discord_id}>\nProposed: **${r.proposed_for} ${r.proposed_tz ?? ""}**\nFrom <@${r.proposer_discord_id}> to <@${r.recipient_discord_id}>`;
  }
  if (kind === "payout_history") {
    return `**${n}. ${String(r.type).toUpperCase()} payout #${r.id}**\n<@${r.discord_id}> — **${r.amount} coins**\nWeek: ${r.week} · Status: ${r.status}`;
  }
  if (kind === "analytics") {
    return `**${n}. <@${r.discord_id}>**\nFW Requests: **${r.fw_requests}** · Offers Sent: **${r.offers_sent}**`;
  }
  return `**${n}. ${kindLabel(kind)} #${r.id}**\nRequested by: <@${r.requested_by}>${r.opponent_discord_id ? ` vs <@${r.opponent_discord_id}>` : ""}\nReason: ${r.reason ?? "_No reason_"}`;
}

export async function renderReviewDetail(interaction: StringSelectMenuInteraction, kind: ReviewKind, id: number) {
  const guildId = interaction.guildId!;
  let rows: any[] = [];

  if (kind === "disputed_finals") {
    rows = await rowsOf(sql`
      select *
      from gameday_score_submissions
      where id = ${id}
        and guild_id = ${guildId}
      limit 1
    `);
  } else if (kind === "accepted_schedule") {
    rows = await rowsOf(sql`
      select id, guild_id, season_id, week_index,
             away_discord_id, home_discord_id, away_team_name, home_team_name,
             status, scheduled_at, scheduled_tz, channel_id, reschedule_pending_offer_id, updated_at
      from game_schedules
      where id = ${id}
        and guild_id = ${guildId}
      limit 1
    `);
  } else {
    rows = await rowsOf(sql`
      select *
      from gameday_commissioner_requests
      where id = ${id}
        and guild_id = ${guildId}
      limit 1
    `);
  }

  const item = rows[0];
  if (!item) {
    await respondReview(interaction, { content: "Item not found.", embeds: [], components: [] });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🎮 Review ${kindLabel(kind)} #${id}`)
    .setDescription(formatReviewRow(kind, item, 1));

  const row = new ActionRowBuilder<ButtonBuilder>();

  if (kind === "force_win") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`gdrev_resolve:${kind}:${id}:approve`).setLabel("✅ Approve FW").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gdrev_resolve:${kind}:${id}:deny`).setLabel("❌ Deny FW").setStyle(ButtonStyle.Danger),
    );
  } else if (kind === "fair_sim") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`gdrev_resolve:${kind}:${id}:approve`).setLabel("✅ Approve FS").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gdrev_resolve:${kind}:${id}:deny`).setLabel("❌ Deny FS").setStyle(ButtonStyle.Danger),
    );
  } else if (kind === "disputed_finals") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`gdrev_resolve:${kind}:${id}:approve_score`).setLabel("✅ Uphold Score").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gdrev_resolve:${kind}:${id}:void_score`).setLabel("❌ Void Score").setStyle(ButtonStyle.Danger),
    );
  } else if (kind === "accepted_schedule") {
    row.addComponents(
      new ButtonBuilder().setCustomId(`gdrs_edit:${id}`).setLabel("🔁 Request Reschedule").setStyle(ButtonStyle.Primary),
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId(`gdrev_resolve:${kind}:${id}:resolve`).setLabel("✅ Resolve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gdrev_resolve:${kind}:${id}:deny`).setLabel("❌ Deny/Close").setStyle(ButtonStyle.Danger),
    );
  }

  row.addComponents(new ButtonBuilder().setCustomId(`gdrev_page:${kind}:0`).setLabel("← Back").setStyle(ButtonStyle.Secondary));
  await respondReview(interaction, { embeds: [embed], components: [row] });
}

export async function resolveReviewItem(interaction: ButtonInteraction, kind: ReviewKind, id: number, action: string) {
  const guildId = interaction.guildId!;
  const channel = interaction.channel?.isTextBased() ? interaction.channel : null;

  if (kind === "disputed_finals") {
    const rows = await rowsOf<any>(sql`
      select *
      from gameday_score_submissions
      where id = ${id}
        and guild_id = ${guildId}
      limit 1
    `);
    const score = rows[0];
    if (!score) {
      await respondReview(interaction, { content: "Score dispute not found.", embeds: [], components: [] });
      return;
    }

    if (action === "approve_score") {
      await db.execute(sql`
        update gameday_score_submissions
        set status = 'approved_by_commissioner', updated_at = now()
        where id = ${id}
      `);
      await db.execute(sql`
        update game_schedules
        set away_score = ${score.away_score},
            home_score = ${score.home_score},
            winner_discord_id = ${score.winner_discord_id},
            status = 'completed_pending_import',
            finished_at = coalesce(finished_at, now()),
            updated_at = now()
        where guild_id = ${guildId}
          and season_id = ${score.season_id}
          and week_index = ${score.week_index}
          and (
               (away_discord_id = ${score.away_discord_id} and home_discord_id = ${score.home_discord_id})
            or (away_discord_id = ${score.home_discord_id} and home_discord_id = ${score.away_discord_id})
          )
      `);
      await channel?.send(`✅ **Score Dispute Resolved — Score Upheld**\n<@${score.away_discord_id}> @ <@${score.home_discord_id}>\nFinal: **${score.away_team_name} ${score.away_score} — ${score.home_team_name} ${score.home_score}**\nResolved by <@${interaction.user.id}>.`);
    } else {
      await db.execute(sql`
        update gameday_score_submissions
        set status = 'voided_by_commissioner', updated_at = now()
        where id = ${id}
      `);
      await channel?.send(`❌ **Score Submission Voided**\nDisputed final #${id} was voided by <@${interaction.user.id}>. Users should resubmit or await commissioner ruling.`);
    }

    await respondReview(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Green).setDescription("Resolved.")], components: [] });
    return;
  }

  const rows = await rowsOf<any>(sql`
    select *
    from gameday_commissioner_requests
    where id = ${id}
      and guild_id = ${guildId}
    limit 1
  `);
  const req = rows[0];
  if (!req) {
    await respondReview(interaction, { content: "Request not found.", embeds: [], components: [] });
    return;
  }

  if (kind === "dashed_report") {
    const approved = action === "approve" || action === "resolve";
    const newStatus = approved ? "approved" : "denied";
    await db.execute(sql`
      update gameday_commissioner_requests
      set status = ${newStatus}, updated_at = now()
      where id = ${id}
    `);
    if (approved) {
      await db.execute(sql`
        update game_schedules
        set status = 'completed_pending_import',
            winner_discord_id = ${req.requested_by},
            finished_at = coalesce(finished_at, now()),
            updated_at = now()
        where guild_id = ${guildId}
          and season_id = ${req.season_id}
          and week_index = ${req.week_index}
          and ((away_discord_id = ${req.requested_by} and home_discord_id = ${req.opponent_discord_id}) or (away_discord_id = ${req.opponent_discord_id} and home_discord_id = ${req.requested_by}))
      `);
      await channel?.send(`🏃 **Dashed Report Confirmed**
<@${req.opponent_discord_id}> dashed in fear. <@${req.requested_by}> is recorded as the winner pending import reconciliation.
Confirmed by <@${interaction.user.id}>.`);
    } else {
      await channel?.send(`❌ **Dashed Report Denied**
Dashed report #${id} was denied by <@${interaction.user.id}>.`);
    }
    await respondReview(interaction, { embeds: [new EmbedBuilder().setColor(Colors.Green).setDescription("Resolved.")], components: [] });
    return;
  }

  const approved = ["approve", "approve_score", "resolve"].includes(action);
  const newStatus = approved ? "approved" : "denied";

  await db.execute(sql`
    update gameday_commissioner_requests
    set status = ${newStatus}, updated_at = now()
    where id = ${id}
  `);

  if (kind === "force_win" && approved) {
    await db.execute(sql`
      update game_schedules
      set winner_discord_id = ${req.requested_by},
          status = 'force_win',
          finished_at = coalesce(finished_at, now()),
          updated_at = now()
      where guild_id = ${guildId}
        and season_id = ${req.season_id}
        and week_index = ${req.week_index}
        and (
             away_discord_id = ${req.requested_by}
          or home_discord_id = ${req.requested_by}
          or away_discord_id = ${req.opponent_discord_id}
          or home_discord_id = ${req.opponent_discord_id}
        )
    `);
  }

  if (kind === "fair_sim" && approved) {
    await db.execute(sql`
      update game_schedules
      set status = 'fair_sim',
          updated_at = now()
      where guild_id = ${guildId}
        and season_id = ${req.season_id}
        and week_index = ${req.week_index}
        and (
             away_discord_id = ${req.requested_by}
          or home_discord_id = ${req.requested_by}
          or away_discord_id = ${req.opponent_discord_id}
          or home_discord_id = ${req.opponent_discord_id}
        )
    `);
  }

  const title = approved ? "✅ Approved/Resolved" : "❌ Denied/Closed";
  await channel?.send(
    `${title}: **${kindLabel(kind)} #${id}**\n` +
    `Requested by <@${req.requested_by}>${req.opponent_discord_id ? ` vs <@${req.opponent_discord_id}>` : ""}\n` +
    `Resolved by <@${interaction.user.id}>.`,
  );

  for (const uid of [req.requested_by, req.opponent_discord_id].filter(Boolean)) {
    const member = await interaction.guild?.members.fetch(uid).catch(() => null);
    await member?.send(`${title}: ${kindLabel(kind)} #${id} has been handled by commissioners.`).catch(() => null);
  }

  await respondReview(interaction, { embeds: [new EmbedBuilder().setColor(approved ? Colors.Green : Colors.Red).setDescription(`${title}. Public notice posted.`)], components: [] });
}

export async function handleCommissionerGamedayReviewInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("gdrev_")) return false;

  await acknowledgeReviewInteraction(interaction);

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "gdrev_cat") {
      await renderReviewCategory(interaction, interaction.values[0] as ReviewKind, 0);
      return true;
    }
    if (interaction.customId.startsWith("gdrev_item:")) {
      const kind = interaction.customId.split(":")[1] as ReviewKind;
      await renderReviewDetail(interaction, kind, Number(interaction.values[0]));
      return true;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === "gdrev_home") {
      await renderCommissionerGamedayReview(interaction);
      return true;
    }
    if (interaction.customId.startsWith("gdrev_page:")) {
      const [, , kind, pageRaw] = interaction.customId.split(":");
      await renderReviewCategory(interaction, kind as ReviewKind, Math.max(0, Number(pageRaw ?? 0)));
      return true;
    }
    if (interaction.customId.startsWith("gdrev_resolve:")) {
      const [, , kind, idRaw, action] = interaction.customId.split(":");
      await resolveReviewItem(interaction, kind as ReviewKind, Number(idRaw), action ?? "resolve");
      return true;
    }
  }

  return true;
}
