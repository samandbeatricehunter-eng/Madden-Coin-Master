/**
 * In-channel game scheduling state machine.
 *
 * Custom-id prefix: `gs_`. Routed from events/interactionCreate.ts.
 *
 * Flow surface (per private game channel):
 *   • Header row (always present in pinned header msg):
 *       [Schedule Game / Cancel Schedule / Reschedule] · [Request Fair Sim] · [Request Force Win]
 *   • Schedule click → ephemeral picker (day / 30-min time / tz dropdowns) → Confirm
 *   • Confirm posts public proposal in channel tagging opponent w/ Accept · Counter · Decline+FairSim
 *   • Reminders + Begin/Finish flows live in game-reminders.ts (this file owns the buttons).
 */

import {
  ButtonInteraction, StringSelectMenuInteraction, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder, Colors, TextChannel, GuildMember, Client,
  Message, MessageFlags,
} from "discord.js";
import { db } from "@workspace/db";
import {
  gameSchedulesTable, gameScheduleProposalsTable,
  gameStatusConfirmationsTable, gameReminderLogTable, gotwHistoryTable, gotwVotesTable,
  coinTransactionsTable, usersTable,
} from "@workspace/db";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { isAdminUser, addBalance, logTransaction, PRIMARY_GUILD_ID } from "../db/db-helpers.js";
import { getServerSettings } from "../db/server-settings.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";
import {
  formatAllZones, formatAllZonesInline, discordTimestampLong,
  nextAdvanceDeadline, buildDateInTz, LEAGUE_TZS, type LeagueTz,
} from "../discord/timezones.js";

export const COMMISSIONER_ROLE_NAME = "Commissioner";

// ── Auth ───────────────────────────────────────────────────────────────────────
async function isCommish(member: GuildMember | null, guildId: string, discordId: string): Promise<boolean> {
  if (!member) return false;
  if (member.roles.cache.some((r) => r.name.toLowerCase() === COMMISSIONER_ROLE_NAME.toLowerCase())) return true;
  if (await isAdminUser(discordId, guildId)) return true;
  return false;
}

async function loadSchedule(scheduleId: number) {
  const [row] = await db.select().from(gameSchedulesTable).where(eq(gameSchedulesTable.id, scheduleId)).limit(1);
  return row ?? null;
}

// ── In-memory ephemeral picker state ──────────────────────────────────────────
type PickerKey = `${string}:${number}`; // userId:scheduleId
type PickerState = { day: number | null; minute: number | null; tz: LeagueTz | null };
const pickers = new Map<PickerKey, PickerState>();
function pkey(userId: string, sid: number): PickerKey { return `${userId}:${sid}` as PickerKey; }
function getPicker(userId: string, sid: number): PickerState {
  const k = pkey(userId, sid);
  const cur = pickers.get(k) ?? { day: null, minute: null, tz: null };
  pickers.set(k, cur);
  return cur;
}

// ── Header builder (used by admin-operations on channel-create + after each action) ──
export function buildHeaderEmbed(sched: typeof gameSchedulesTable.$inferSelect, deadlineAt: Date): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`🏈 ${sched.awayTeamName} @ ${sched.homeTeamName}`)
    .addFields(
      { name: "Players", value: `<@${sched.awayDiscordId}>  vs  <@${sched.homeDiscordId}>` },
      { name: "⏰ Next Advance Deadline", value: formatAllZones(deadlineAt) },
    )
    .setFooter({ text: "Games must be scheduled to start at least 1 hour before the deadline." });

  if (sched.status === "confirmed" && sched.scheduledAt) {
    e.addFields({ name: "✅ Scheduled For", value: formatAllZones(sched.scheduledAt) });
    e.setColor(Colors.Green);
  } else if (sched.status === "started") {
    e.addFields({ name: "▶️ Game In Progress", value: sched.startedAt ? discordTimestampLong(sched.startedAt) : "Started" });
    e.setColor(Colors.Gold);
  } else if (sched.status === "finished") {
    e.addFields({
      name: "🏁 Final",
      value: sched.winnerDiscordId
        ? `Winner: <@${sched.winnerDiscordId}>`
        : "Both players confirmed finished.",
    });
    e.setColor(Colors.Greyple);
  } else if (sched.status === "fair_sim" || sched.status === "auto_fair_sim") {
    e.addFields({ name: "⚖️ Fair Sim", value: sched.status === "auto_fair_sim" ? "Auto Fair Sim (no-show after 2 hrs)" : "Fair Sim requested & approved." });
    e.setColor(Colors.Orange);
  } else if (sched.status === "force_win") {
    e.addFields({ name: "🏳️ Force Win", value: sched.winnerDiscordId ? `Winner: <@${sched.winnerDiscordId}>` : "Force Win awarded." });
    e.setColor(Colors.Red);
  }

  return e;
}

export function buildHeaderRow(sched: typeof gameSchedulesTable.$inferSelect): ActionRowBuilder<ButtonBuilder> {
  const sid = sched.id;
  const isLocked = ["finished", "fair_sim", "auto_fair_sim", "force_win", "completed_imported"].includes(sched.status);
  const scheduleBtn = new ButtonBuilder()
    .setCustomId(`gs_schedule:${sid}`)
    .setStyle(sched.status === "confirmed" || sched.status === "started" ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setLabel(
      sched.status === "pending"   ? "🗓️ Cancel Schedule" :
      sched.status === "confirmed" ? "🔁 Reschedule"      :
                                     "🗓️ Schedule Game"
    )
    .setDisabled(isLocked);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    scheduleBtn,
    new ButtonBuilder().setCustomId(`gs_fairsim:${sid}`).setLabel("⚖️ Request Fair Sim").setStyle(ButtonStyle.Secondary).setDisabled(isLocked),
    new ButtonBuilder().setCustomId(`gs_forcewin:${sid}`).setLabel("🏳️ Request Force Win").setStyle(ButtonStyle.Secondary).setDisabled(isLocked),
    new ButtonBuilder().setCustomId(`gs_mark_done:${sid}`).setLabel("✅ Mark Completed").setStyle(ButtonStyle.Success).setDisabled(isLocked),
  );
}

async function refreshHeader(client: Client, sched: typeof gameSchedulesTable.$inferSelect): Promise<void> {
  if (!sched.headerMessageId) return;
  try {
    const ch = await client.channels.fetch(sched.channelId).catch(() => null);
    if (!ch?.isTextBased()) return;
    const msg = await (ch as TextChannel).messages.fetch(sched.headerMessageId).catch(() => null);
    if (!msg) return;
    const settings = await getServerSettings(sched.guildId);
    const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
    await msg.edit({ embeds: [buildHeaderEmbed(sched, deadline)], components: [buildHeaderRow(sched)] });
  } catch (err) {
    console.error("[gs] refreshHeader failed:", err);
  }
}

// ── Allowed-day options based on advance deadline ─────────────────────────────
function dayOptions(deadlineAt: Date, periodHours: number): StringSelectMenuOptionBuilder[] {
  // Allow up to floor((deadline - 1h - now) / 24h) days, capped at 7 (Discord limit is 25, but UX-wise stop at 7).
  const maxMs = deadlineAt.getTime() - 60 * 60 * 1000 - Date.now();
  if (maxMs <= 0) return [];
  const maxDays = Math.min(7, Math.floor(maxMs / (24 * 60 * 60 * 1000)) + 1);
  const out: StringSelectMenuOptionBuilder[] = [];
  for (let d = 0; d < Math.max(1, maxDays); d++) {
    // Label is the date in CST for the picker user (CST chosen as canonical league time).
    const sample = buildDateInTz(d, 12 * 60, "CST"); // noon-CST sample for label
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric",
    }).format(sample);
    out.push(new StringSelectMenuOptionBuilder().setLabel(d === 0 ? `Today — ${label}` : d === 1 ? `Tomorrow — ${label}` : label).setValue(String(d)));
  }
  void periodHours;
  return out;
}

function timeOptions(): StringSelectMenuOptionBuilder[] {
  // 30-min slots from 6:00 PM to 11:30 PM (12 slots → fits in one select; expand if needed).
  // Discord caps select options at 25. To cover full evening + late-night we expose 4 PM → 1 AM.
  const out: StringSelectMenuOptionBuilder[] = [];
  for (let m = 16 * 60; m <= 25 * 60; m += 30) {
    const hr = Math.floor(m / 60) % 24;
    const mn = m % 60;
    const hour12 = ((hr + 11) % 12) + 1;
    const ampm = hr < 12 ? "AM" : "PM";
    const norm = m % (24 * 60); // wrap past midnight for next-day-early-am slots
    out.push(new StringSelectMenuOptionBuilder()
      .setLabel(`${hour12}:${mn.toString().padStart(2, "0")} ${ampm}`)
      .setValue(String(norm)));
  }
  return out;
}

function tzOptions(): StringSelectMenuOptionBuilder[] {
  return LEAGUE_TZS.map((z) => new StringSelectMenuOptionBuilder().setLabel(`${z.code} (${z.label})`).setValue(z.code));
}

function pickerComponents(sid: number, state: PickerState, dayOpts: StringSelectMenuOptionBuilder[]) {
  const setDefaultByValue = (opts: StringSelectMenuOptionBuilder[], val: string | null) =>
    opts.map((o) => {
      const data = (o as any).data as { value?: string };
      const isDefault = val != null && data.value === val;
      return new StringSelectMenuOptionBuilder()
        .setLabel((o as any).data.label as string)
        .setValue(data.value as string)
        .setDefault(isDefault);
    });

  const daySel = new StringSelectMenuBuilder()
    .setCustomId(`gs_pick_day:${sid}`)
    .setPlaceholder(dayOpts.length === 0 ? "❌ No days left before advance" : "📅 Pick a day")
    .addOptions(dayOpts.length === 0 ? [new StringSelectMenuOptionBuilder().setLabel("No availability").setValue("none")] : setDefaultByValue(dayOpts, state.day == null ? null : String(state.day)))
    .setDisabled(dayOpts.length === 0);

  const timeSel = new StringSelectMenuBuilder()
    .setCustomId(`gs_pick_time:${sid}`)
    .setPlaceholder("🕒 Pick a time (CST/local — shown in all 4 zones on confirm)")
    .addOptions(setDefaultByValue(timeOptions(), state.minute == null ? null : String(state.minute)));

  const tzSel = new StringSelectMenuBuilder()
    .setCustomId(`gs_pick_tz:${sid}`)
    .setPlaceholder("🌐 Pick the time zone your time is in")
    .addOptions(setDefaultByValue(tzOptions(), state.tz));

  const ready = state.day != null && state.minute != null && state.tz != null;

  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gs_sched_confirm:${sid}`).setLabel("✅ Send Proposal").setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId(`gs_sched_cancel:${sid}`).setLabel("✖ Cancel").setStyle(ButtonStyle.Secondary),
  );

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(daySel),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(timeSel),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(tzSel),
    btnRow,
  ];
}

// ── Idempotency guard ─────────────────────────────────────────────────────────
// Discord's gateway can redeliver the same interaction event on shard
// reconnects / brief network blips. Without dedup, one user click can run the
// handler multiple times — which for channel-posting actions like Force Win
// means several duplicate posts in the game channel. interaction.id is unique
// per click, so a short-lived Set of recently-seen ids drops redeliveries.
const RECENT_GS_INTERACTIONS = new Set<string>();
const GS_DEDUP_TTL_MS = 5 * 60 * 1000;

function markGsInteractionSeen(interactionId: string): boolean {
  if (RECENT_GS_INTERACTIONS.has(interactionId)) return false;
  RECENT_GS_INTERACTIONS.add(interactionId);
  setTimeout(() => RECENT_GS_INTERACTIONS.delete(interactionId), GS_DEDUP_TTL_MS).unref?.();
  return true;
}

// ── Top-level dispatcher (called from interactionCreate.ts) ───────────────────
export async function handleGsInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith("gs_")) return false;

  // Drop redelivered duplicate events for the same click.
  if (!markGsInteractionSeen(interaction.id)) return true;

  const [action, sidStr] = id.split(":");
  const sid = parseInt(sidStr ?? "0", 10);
  if (!sid && action !== "gs_sched_cancel") return true;

  // ── Strict participant-only gate ───────────────────────────────────────────
  // EVERY button in a private game channel may ONLY be clicked by the two
  // players in the matchup. Admins and Commissioners are explicitly NOT
  // allowed — including the Fair Sim / Force Win approval buttons, which the
  // opponent of the requester must approve themselves.
  //
  // Exceptions (no gate needed):
  //   gs_pick_*               — ephemeral picker only the opener can see.
  //   gs_sched_confirm/cancel — same ephemeral picker.
  //
  // For proposal-keyed actions (gs_accept / gs_counter / gs_decline /
  // gs_req_approve / gs_req_reject) the custom_id carries a PROPOSAL id, not a
  // schedule id, so we resolve via the proposal first.
  const EPHEMERAL_PICKER = new Set(["gs_pick_day", "gs_pick_time", "gs_pick_tz", "gs_sched_confirm", "gs_sched_cancel"]);
  const PROPOSAL_KEYED   = new Set(["gs_accept", "gs_counter", "gs_decline", "gs_req_approve", "gs_req_reject"]);

  if (!EPHEMERAL_PICKER.has(action)) {
    let gateSched: typeof gameSchedulesTable.$inferSelect | null = null;
    if (PROPOSAL_KEYED.has(action)) {
      const [p] = await db.select().from(gameScheduleProposalsTable).where(eq(gameScheduleProposalsTable.id, sid)).limit(1);
      if (p) gateSched = await loadSchedule(p.scheduleId);
    } else {
      gateSched = await loadSchedule(sid);
    }
    if (!gateSched) {
      await interaction.reply({ content: "❌ Schedule not found.", ephemeral: true }).catch(() => {});
      return true;
    }
    const uid = interaction.user.id;
    if (uid !== gateSched.awayDiscordId && uid !== gateSched.homeDiscordId) {
      await interaction.reply({
        content: "🚫 Only the two players in this matchup can use these buttons.",
        ephemeral: true,
      }).catch(() => {});
      return true;
    }
  }

  try {
    if (interaction.isButton()) {
      if (action === "gs_schedule")        return await handleScheduleClick(interaction, sid);
      if (action === "gs_sched_confirm")   return await handleSchedConfirm(interaction, sid);
      if (action === "gs_sched_cancel")    { await interaction.update({ content: "Cancelled.", embeds: [], components: [] }).catch(() => {}); return true; }
      if (action === "gs_accept")          return await handleAccept(interaction, sid);
      if (action === "gs_counter")         return await handleCounter(interaction, sid);
      if (action === "gs_decline")         return await handleDeclineFairSim(interaction, sid);
      if (action === "gs_fairsim")         return await handleFairSimRequest(interaction, sid);
      if (action === "gs_forcewin")        return await handleForceWinRequest(interaction, sid);
      if (action === "gs_req_approve")     return await handleReqApprove(interaction, sid);
      if (action === "gs_req_reject")      return await handleReqReject(interaction, sid);
      if (action === "gs_begun")           return await handleBegun(interaction, sid);
      if (action === "gs_finished")        return await handleFinished(interaction, sid);
      if (action === "gs_mark_done")       return await handleMarkDone(interaction, sid);
    }
    if (interaction.isStringSelectMenu()) {
      if (action === "gs_pick_day"  || action === "gs_pick_time" || action === "gs_pick_tz")
        return await handlePickChange(interaction, sid);
      if (action === "gs_winner")    return await handleWinnerSelect(interaction, sid);
    }
  } catch (err) {
    console.error("[gs] handler error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Error: ${err instanceof Error ? err.message : String(err)}`, ephemeral: true }).catch(() => {});
    }
  }
  return true;
}

// ── Schedule button → open picker ─────────────────────────────────────────────
async function handleScheduleClick(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "❌ Schedule not found.", ephemeral: true }); return true; }
  const uid = interaction.user.id;
  const member = interaction.member as GuildMember | null;

  // Participant-only is already enforced by the dispatcher gate, but keep a
  // defense-in-depth check here in case this is called from another path.
  if (uid !== sched.awayDiscordId && uid !== sched.homeDiscordId) {
    await interaction.reply({
      content: "🚫 You're not scheduled to play in this game. Do not touch these buttons.",
      ephemeral: true,
    });
    return true;
  }
  void member;

  // If there's a pending proposal owned by the clicker, treat as CANCEL.
  if (sched.status === "pending") {
    const [open] = await db.select().from(gameScheduleProposalsTable)
      .where(and(eq(gameScheduleProposalsTable.scheduleId, sid), eq(gameScheduleProposalsTable.status, "pending")))
      .limit(1);
    if (open?.proposerId === uid) {
      await db.update(gameScheduleProposalsTable).set({ status: "cancelled" }).where(eq(gameScheduleProposalsTable.id, open.id));
      await db.update(gameSchedulesTable).set({ status: sched.scheduledAt ? "confirmed" : "unscheduled", updatedAt: new Date() }).where(eq(gameSchedulesTable.id, sid));
      const updated = (await loadSchedule(sid))!;
      await refreshHeader(interaction.client, updated);
      // delete the proposal message if any
      if (open.messageId) {
        const ch = await interaction.client.channels.fetch(sched.channelId).catch(() => null);
        if (ch?.isTextBased()) {
          await (ch as TextChannel).messages.delete(open.messageId).catch(() => {});
        }
      }
      await interaction.reply({ content: "✅ Pending proposal cancelled.", ephemeral: true });
      return true;
    }
  }

  const settings = await getServerSettings(sched.guildId);
  const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
  const dayOpts  = dayOptions(deadline, settings.advancePeriodHours);

  pickers.delete(pkey(uid, sid));
  const state = getPicker(uid, sid);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🗓️ Schedule This Game")
    .setDescription(
      "Pick the **day**, **start time**, and **time zone** your time is in.\n" +
      "All three must be selected before you can send the proposal.\n\n" +
      `**Advance deadline** (must land ≥1 hr before):\n${formatAllZones(deadline)}`,
    );

  await interaction.reply({
    embeds: [embed],
    components: pickerComponents(sid, state, dayOpts),
    ephemeral: true,
  });
  return true;
}

async function handlePickChange(interaction: StringSelectMenuInteraction, sid: number): Promise<boolean> {
  const uid = interaction.user.id;
  const state = getPicker(uid, sid);
  const val = interaction.values[0]!;
  const action = interaction.customId.split(":")[0];
  if (action === "gs_pick_day")  state.day    = parseInt(val, 10);
  if (action === "gs_pick_time") state.minute = parseInt(val, 10);
  if (action === "gs_pick_tz")   state.tz     = val as LeagueTz;

  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.update({ content: "Schedule disappeared.", components: [], embeds: [] }); return true; }
  const settings = await getServerSettings(sched.guildId);
  const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
  const dayOpts  = dayOptions(deadline, settings.advancePeriodHours);

  await interaction.update({ components: pickerComponents(sid, state, dayOpts) });
  return true;
}

async function handleSchedConfirm(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  const uid = interaction.user.id;
  const state = pickers.get(pkey(uid, sid));
  if (!state || state.day == null || state.minute == null || !state.tz) {
    await interaction.reply({ content: "❌ Pick all three values first.", ephemeral: true });
    return true;
  }
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule disappeared.", ephemeral: true }); return true; }

  const proposedAt = buildDateInTz(state.day, state.minute, state.tz);
  const settings = await getServerSettings(sched.guildId);
  const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);

  if (proposedAt.getTime() > deadline.getTime() - 60 * 60 * 1000) {
    await interaction.reply({
      content:
        "❌ That time is within 1 hour of the next advance deadline.\n" +
        `Deadline: ${formatAllZonesInline(deadline)}`,
      ephemeral: true,
    });
    return true;
  }
  if (proposedAt.getTime() < Date.now() + 5 * 60 * 1000) {
    await interaction.reply({ content: "❌ Pick a time at least 5 minutes from now.", ephemeral: true });
    return true;
  }

  // Cancel any prior open proposal for this schedule
  await db.update(gameScheduleProposalsTable)
    .set({ status: "cancelled" })
    .where(and(eq(gameScheduleProposalsTable.scheduleId, sid), eq(gameScheduleProposalsTable.status, "pending")));

  const [proposal] = await db.insert(gameScheduleProposalsTable).values({
    scheduleId: sid, proposerId: uid, proposedAt, tz: state.tz, status: "pending",
  }).returning();
  pickers.delete(pkey(uid, sid));

  const opponentId = uid === sched.awayDiscordId ? sched.homeDiscordId : sched.awayDiscordId;

  const proposalEmbed = new EmbedBuilder()
    .setColor(Colors.Yellow)
    .setTitle("🗓️ Schedule Proposal")
    .setDescription(`<@${uid}> proposes the following start time:\n\n${formatAllZones(proposedAt)}\n\n<@${opponentId}> — what do you want to do?`)
    .setFooter({ text: `Proposed in ${state.tz}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gs_accept:${proposal!.id}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gs_counter:${proposal!.id}`).setLabel("🔁 Counter").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gs_decline:${proposal!.id}`).setLabel("❌ Decline → Fair Sim").setStyle(ButtonStyle.Danger),
  );

  const ch = (await interaction.client.channels.fetch(sched.channelId)) as TextChannel;
  const msg = await ch.send({ content: `<@${opponentId}>`, embeds: [proposalEmbed], components: [row] });

  await db.update(gameScheduleProposalsTable).set({ messageId: msg.id }).where(eq(gameScheduleProposalsTable.id, proposal!.id));
  await db.update(gameSchedulesTable).set({ status: "pending", updatedAt: new Date() }).where(eq(gameSchedulesTable.id, sid));
  await refreshHeader(interaction.client, (await loadSchedule(sid))!);

  await interaction.update({ content: "✅ Proposal sent.", embeds: [], components: [] });
  return true;
}

// ── Accept / Counter / Decline ───────────────────────────────────────────────
async function loadProposal(propId: number) {
  const [p] = await db.select().from(gameScheduleProposalsTable).where(eq(gameScheduleProposalsTable.id, propId)).limit(1);
  return p ?? null;
}

async function assertOpponent(interaction: ButtonInteraction, sched: typeof gameSchedulesTable.$inferSelect, expectedOpponentOf: string): Promise<boolean> {
  const opp = expectedOpponentOf === sched.awayDiscordId ? sched.homeDiscordId : sched.awayDiscordId;
  if (interaction.user.id !== opp) {
    await interaction.reply({ content: "❌ Only the opponent can respond to this proposal.", ephemeral: true });
    return false;
  }
  return true;
}

/** Delete the original proposal message in the channel so the Accept/Counter/Reject
 *  embed disappears entirely once it's been resolved. Best-effort — silently
 *  swallows fetch/delete failures (e.g. message already gone). */
async function deleteProposalMessage(interaction: ButtonInteraction, sched: typeof gameSchedulesTable.$inferSelect, messageId: string | null) {
  if (!messageId) return;
  const ch = await interaction.client.channels.fetch(sched.channelId).catch(() => null);
  if (ch?.isTextBased()) {
    await (ch as TextChannel).messages.delete(messageId).catch(() => {});
  }
}

async function handleAccept(interaction: ButtonInteraction, propId: number): Promise<boolean> {
  const prop = await loadProposal(propId);
  if (!prop || prop.status !== "pending") { await interaction.reply({ content: "That proposal is no longer pending.", ephemeral: true }); return true; }
  const sched = await loadSchedule(prop.scheduleId);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  if (!(await assertOpponent(interaction, sched, prop.proposerId))) return true;

  // Atomic claim — only the first click of Accept flips pending→accepted and
  // gets to run the side-effects (channel post + state mutation). A racing
  // second click sees zero rows updated and exits without posting again.
  const claimed = await db.update(gameScheduleProposalsTable)
    .set({ status: "accepted" })
    .where(and(eq(gameScheduleProposalsTable.id, propId), eq(gameScheduleProposalsTable.status, "pending")))
    .returning({ id: gameScheduleProposalsTable.id });
  if (claimed.length === 0) {
    await interaction.reply({ content: "That proposal was already resolved.", ephemeral: true }).catch(() => {});
    return true;
  }

  // Whenever scheduledAt changes (new schedule or reschedule) we MUST clear
  // the per-schedule reminder log so the next cycle's T-30/T0/T+20/T+60/T+120
  // actually fire — the dedup table is keyed only on (scheduleId, kind).
  await db.delete(gameReminderLogTable).where(eq(gameReminderLogTable.scheduleId, prop.scheduleId));
  // Also clear any stale begun/finished confirmations from a prior cycle.
  await db.delete(gameStatusConfirmationsTable).where(eq(gameStatusConfirmationsTable.scheduleId, prop.scheduleId));
  await db.update(gameSchedulesTable)
    .set({ status: "confirmed", scheduledAt: prop.proposedAt, scheduledTz: prop.tz, startedAt: null, finishedAt: null, winnerDiscordId: null, updatedAt: new Date() })
    .where(eq(gameSchedulesTable.id, prop.scheduleId));

  // Cancel any OTHER still-pending proposals on the same schedule (a stale
  // counter from earlier in the back-and-forth) and wipe their embeds too.
  const otherPending = await db.select().from(gameScheduleProposalsTable)
    .where(and(
      eq(gameScheduleProposalsTable.scheduleId, prop.scheduleId),
      eq(gameScheduleProposalsTable.status, "pending"),
    ));
  for (const op of otherPending) {
    await db.update(gameScheduleProposalsTable).set({ status: "cancelled" }).where(eq(gameScheduleProposalsTable.id, op.id));
    await deleteProposalMessage(interaction, sched, op.messageId);
  }

  // Remove the resolved proposal embed from the channel and ack the click.
  // Doing the ack BEFORE the channel send avoids the rare ordering where
  // Discord re-delivers the interaction on a slow ack and a second handler
  // invocation slips past the atomic claim window.
  await interaction.update({ embeds: [], components: [], content: "✅ Accepted." }).catch(() => {});
  await deleteProposalMessage(interaction, sched, prop.messageId);

  const confirmEmbed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Game Scheduled")
    .setDescription(`<@${sched.awayDiscordId}> vs <@${sched.homeDiscordId}>\n\n${formatAllZones(prop.proposedAt)}\n\n${discordTimestampLong(prop.proposedAt)}`);
  await (interaction.channel as TextChannel).send({ embeds: [confirmEmbed] }).catch(() => {});

  await refreshHeader(interaction.client, (await loadSchedule(prop.scheduleId))!);
  return true;
}

async function handleCounter(interaction: ButtonInteraction, propId: number): Promise<boolean> {
  const prop = await loadProposal(propId);
  if (!prop || prop.status !== "pending") { await interaction.reply({ content: "That proposal is no longer pending.", ephemeral: true }); return true; }
  const sched = await loadSchedule(prop.scheduleId);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  if (!(await assertOpponent(interaction, sched, prop.proposerId))) return true;

  await db.update(gameScheduleProposalsTable).set({ status: "countered" }).where(eq(gameScheduleProposalsTable.id, propId));
  // Remove the prior Accept/Counter/Reject embed entirely so the channel
  // doesn't pile up with stale proposals as both players counter back and forth.
  await interaction.update({ embeds: [], components: [], content: "🔁 Countering…" }).catch(() => {});
  await deleteProposalMessage(interaction, sched, prop.messageId);

  // Re-open the picker for the counter-er (the opponent of the original proposer)
  const uid = interaction.user.id;
  pickers.delete(pkey(uid, prop.scheduleId));
  const state = getPicker(uid, prop.scheduleId);

  const settings = await getServerSettings(sched.guildId);
  const deadline = nextAdvanceDeadline(settings.lastAdvanceAt, settings.advancePeriodHours);
  const dayOpts  = dayOptions(deadline, settings.advancePeriodHours);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("🔁 Counter Proposal")
    .setDescription(`Pick your counter time. Advance deadline:\n${formatAllZones(deadline)}`);

  await interaction.followUp({ embeds: [embed], components: pickerComponents(prop.scheduleId, state, dayOpts), ephemeral: true });
  return true;
}

async function handleDeclineFairSim(interaction: ButtonInteraction, propId: number): Promise<boolean> {
  const prop = await loadProposal(propId);
  if (!prop || prop.status !== "pending") { await interaction.reply({ content: "That proposal is no longer pending.", ephemeral: true }); return true; }
  const sched = await loadSchedule(prop.scheduleId);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  if (!(await assertOpponent(interaction, sched, prop.proposerId))) return true;

  await db.update(gameScheduleProposalsTable).set({ status: "declined" }).where(eq(gameScheduleProposalsTable.id, propId));
  await db.delete(gameReminderLogTable).where(eq(gameReminderLogTable.scheduleId, prop.scheduleId));
  await db.delete(gameStatusConfirmationsTable).where(eq(gameStatusConfirmationsTable.scheduleId, prop.scheduleId));
  await db.update(gameSchedulesTable).set({ status: "unscheduled", scheduledAt: null, startedAt: null, finishedAt: null, updatedAt: new Date() }).where(eq(gameSchedulesTable.id, prop.scheduleId));

  await interaction.update({ embeds: [], components: [], content: "❌ Declined." }).catch(() => {});
  await deleteProposalMessage(interaction, sched, prop.messageId);
  await postFairSimRequest(interaction, sched, interaction.user.id, "Proposal declined — auto-requested Fair Sim.");
  await refreshHeader(interaction.client, (await loadSchedule(prop.scheduleId))!);
  return true;
}

// ── Fair Sim / Force Win request flows ────────────────────────────────────────
async function postFairSimRequest(
  interaction: ButtonInteraction, sched: typeof gameSchedulesTable.$inferSelect,
  requesterId: string, note: string,
): Promise<void> {
  const opponentId = requesterId === sched.awayDiscordId ? sched.homeDiscordId : sched.awayDiscordId;
  const embed = new EmbedBuilder().setColor(Colors.Orange)
    .setTitle("⚖️ Fair Sim Requested")
    .setDescription(`<@${requesterId}> requested a Fair Sim.\n*${note}*\n\n<@${opponentId}> — approve or reject?`);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gs_req_approve:${sched.id}|fairsim|${requesterId}`).setLabel("✅ Approve Fair Sim").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gs_req_reject:${sched.id}|fairsim|${requesterId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
  );
  await (interaction.channel as TextChannel).send({ content: `<@${opponentId}>`, embeds: [embed], components: [row] });
}

async function handleFairSimRequest(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  const uid = interaction.user.id;
  if (uid !== sched.awayDiscordId && uid !== sched.homeDiscordId) {
    await interaction.reply({ content: "❌ Only the two players can request Fair Sim.", ephemeral: true });
    return true;
  }
  await postFairSimRequest(interaction, sched, uid, "Manual request from the in-channel button.");
  await interaction.reply({ content: "✅ Fair Sim request posted in channel.", ephemeral: true });
  return true;
}

async function handleForceWinRequest(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  const uid = interaction.user.id;
  if (uid !== sched.awayDiscordId && uid !== sched.homeDiscordId) {
    await interaction.reply({ content: "❌ Only the two players can request Force Win.", ephemeral: true });
    return true;
  }
  const opponentId = uid === sched.awayDiscordId ? sched.homeDiscordId : sched.awayDiscordId;
  const embed = new EmbedBuilder().setColor(Colors.Red)
    .setTitle("🏳️ Force Win Requested")
    .setDescription(`<@${uid}> requests a **Force Win**.\n<@${opponentId}> — approve or reject?`);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gs_req_approve:${sid}|forcewin|${uid}`).setLabel("✅ Approve Force Win").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gs_req_reject:${sid}|forcewin|${uid}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
  );
  await (interaction.channel as TextChannel).send({ content: `<@${opponentId}>`, embeds: [embed], components: [row] });
  await interaction.reply({ content: "✅ Force Win request posted in channel.", ephemeral: true });
  return true;
}

async function tagCommissioner(ch: TextChannel, body: string): Promise<void> {
  const guild = ch.guild;
  const role = guild.roles.cache.find((r) => r.name.toLowerCase() === COMMISSIONER_ROLE_NAME.toLowerCase());
  await ch.send(role ? `<@&${role.id}>\n${body}` : body);
}

async function handleReqApprove(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  // customId tail: gs_req_approve:<sid>|<kind>|<requesterId>
  const tail = interaction.customId.split(":")[1] ?? "";
  const [, kind, requesterId] = tail.split("|");
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }

  // Authorize: opponent of the requester, OR a commissioner who is NOT the
  // requester themselves (prevents self-approval even for elevated users).
  const opponentId = requesterId === sched.awayDiscordId ? sched.homeDiscordId : sched.awayDiscordId;
  const isOpponent = interaction.user.id === opponentId;
  const isElevated = await isCommish(interaction.member as GuildMember | null, sched.guildId, interaction.user.id);
  if (!isOpponent && !(isElevated && interaction.user.id !== requesterId)) {
    const reason = interaction.user.id === requesterId
      ? "❌ You can't approve your own request."
      : "❌ Only the opponent (or a commissioner) can approve.";
    await interaction.reply({ content: reason, ephemeral: true });
    return true;
  }

  if (kind === "fairsim") {
    await db.update(gameSchedulesTable).set({ status: "fair_sim", updatedAt: new Date() }).where(eq(gameSchedulesTable.id, sid));
  } else if (kind === "forcewin") {
    await db.update(gameSchedulesTable).set({ status: "force_win", winnerDiscordId: requesterId, updatedAt: new Date() }).where(eq(gameSchedulesTable.id, sid));
  }

  await interaction.update({ components: [] });
  await tagCommissioner(
    interaction.channel as TextChannel,
    `✅ **${kind === "fairsim" ? "Fair Sim" : "Force Win"} approved** by <@${interaction.user.id}> for <@${sched.awayDiscordId}> vs <@${sched.homeDiscordId}>.${kind === "forcewin" ? `\nDeclared winner: <@${requesterId}>.` : ""}`,
  );
  await refreshHeader(interaction.client, (await loadSchedule(sid))!);
  return true;
}

async function handleReqReject(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  const tail = interaction.customId.split(":")[1] ?? "";
  const [, kind, requesterId] = tail.split("|");
  // Symmetric with handleReqApprove: opponent OR a non-requester commissioner.
  const opponentId = requesterId === sched.awayDiscordId ? sched.homeDiscordId : sched.awayDiscordId;
  const isOpponent = interaction.user.id === opponentId;
  const isElevated = await isCommish(interaction.member as GuildMember | null, sched.guildId, interaction.user.id);
  if (!isOpponent && !(isElevated && interaction.user.id !== requesterId)) {
    const reason = interaction.user.id === requesterId
      ? "❌ You can't reject your own request."
      : "❌ Only the opponent (or a commissioner) can reject.";
    await interaction.reply({ content: reason, ephemeral: true });
    return true;
  }
  await interaction.update({ components: [] });
  await (interaction.channel as TextChannel).send(`❌ ${kind === "fairsim" ? "Fair Sim" : "Force Win"} request **rejected** by <@${interaction.user.id}>.`);
  return true;
}

// ── Begin / Finish confirmations (buttons posted by game-reminders T0 message) ──
async function handleBegun(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  const uid = interaction.user.id;
  // Strict participant-only — matches the dispatcher gate. Commish/admin do
  // NOT bypass; if a stuck game needs an override, escalate via Commissioner's
  // Office, not by clicking buttons in someone else's channel.
  if (uid !== sched.awayDiscordId && uid !== sched.homeDiscordId) {
    await interaction.reply({ content: "🚫 Only the two players in this matchup can confirm.", ephemeral: true });
    return true;
  }
  await db.insert(gameStatusConfirmationsTable).values({ scheduleId: sid, discordId: uid, kind: "begun" }).onConflictDoNothing();

  const confirms = await db.select().from(gameStatusConfirmationsTable)
    .where(and(eq(gameStatusConfirmationsTable.scheduleId, sid), eq(gameStatusConfirmationsTable.kind, "begun")));
  const ids = new Set(confirms.map((c) => c.discordId));
  const both = ids.has(sched.awayDiscordId) && ids.has(sched.homeDiscordId);

  if (both) {
    // Conditional update — only the first call that sees a non-`started`
    // status actually flips it and posts the "Game started" side-effects.
    // Prevents duplicate posts when both players (or a commish + player)
    // click within the same tick.
    const flipped = await db.update(gameSchedulesTable)
      .set({ status: "started", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(gameSchedulesTable.id, sid), inArray(gameSchedulesTable.status, ["confirmed", "auto_fair_sim", "pending", "unscheduled"])))
      .returning({ id: gameSchedulesTable.id });
    if (flipped.length > 0) {
      await (interaction.channel as TextChannel).send({
        content: `▶️ **Game started** — confirmed by both <@${sched.awayDiscordId}> and <@${sched.homeDiscordId}>.\n\nWhen the game finishes, both players click **Confirm Game Finished** below.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`gs_finished:${sid}`).setLabel("🏁 Confirm Game Finished").setStyle(ButtonStyle.Primary),
        )],
      });
      await tagCommissioner(interaction.channel as TextChannel, `▶️ **Game started:** <@${sched.awayDiscordId}> vs <@${sched.homeDiscordId}>`);
      await refreshHeader(interaction.client, (await loadSchedule(sid))!);
    }
  }

  await interaction.reply({
    content: both ? "✅ Game marked started." : "✅ You confirmed start. Waiting on opponent.",
    ephemeral: true,
  });
  return true;
}

async function handleFinished(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  const uid = interaction.user.id;
  // Strict participant-only — same policy as handleBegun.
  if (uid !== sched.awayDiscordId && uid !== sched.homeDiscordId) {
    await interaction.reply({ content: "🚫 Only the two players in this matchup can confirm.", ephemeral: true });
    return true;
  }
  await db.insert(gameStatusConfirmationsTable).values({ scheduleId: sid, discordId: uid, kind: "finished" }).onConflictDoNothing();

  const confirms = await db.select().from(gameStatusConfirmationsTable)
    .where(and(eq(gameStatusConfirmationsTable.scheduleId, sid), eq(gameStatusConfirmationsTable.kind, "finished")));
  const ids = new Set(confirms.map((c) => c.discordId));
  const both = ids.has(sched.awayDiscordId) && ids.has(sched.homeDiscordId);

  if (both) {
    // Ask the confirming player to pick winner (any of the two players can pick).
    const sel = new StringSelectMenuBuilder()
      .setCustomId(`gs_winner:${sid}`)
      .setPlaceholder("🏆 Pick the winner")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel(`${sched.awayTeamName} (away)`).setValue(sched.awayDiscordId),
        new StringSelectMenuOptionBuilder().setLabel(`${sched.homeTeamName} (home)`).setValue(sched.homeDiscordId),
      );
    await (interaction.channel as TextChannel).send({
      content: `🏁 **Game finished** — both players confirmed.\nA player or commissioner: select the winner below to settle GOTW payouts.`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
    });
  }

  await interaction.reply({
    content: both ? "✅ Both finished. Pick the winner above." : "✅ You confirmed finished. Waiting on opponent.",
    ephemeral: true,
  });
  return true;
}

// ── "Mark Completed" fallback (commish / bot-admin / either player) ──────────
// Use this when players forgot to schedule / confirm Begun & Finished but the
// game was actually played. Opens an ephemeral winner picker; selecting a
// winner flips status=finished, settles GOTW, and refreshes the header.
// Includes a "No Contest" option that closes the schedule without picking a
// winner (handy if both players agreed to drop the game entirely).
async function handleMarkDone(interaction: ButtonInteraction, sid: number): Promise<boolean> {
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  const uid = interaction.user.id;
  const isPlayer = uid === sched.awayDiscordId || uid === sched.homeDiscordId;
  const isElevated = await isCommish(interaction.member as GuildMember | null, sched.guildId, uid);
  if (!isPlayer && !isElevated) {
    await interaction.reply({ content: "❌ Only the two players or a commissioner can mark this completed.", ephemeral: true });
    return true;
  }

  const sel = new StringSelectMenuBuilder()
    .setCustomId(`gs_winner:${sid}`)
    .setPlaceholder("🏆 Pick the winner (or No Contest)")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel(`${sched.awayTeamName} (away) wins`).setValue(sched.awayDiscordId),
      new StringSelectMenuOptionBuilder().setLabel(`${sched.homeTeamName} (home) wins`).setValue(sched.homeDiscordId),
      new StringSelectMenuOptionBuilder().setLabel("No Contest — close without a winner").setValue("__nocontest__"),
    );
  await interaction.reply({
    content: `✅ Mark this matchup completed.\nPicking a winner will settle GOTW payouts immediately. "No Contest" just closes the schedule.`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
    ephemeral: true,
  });
  return true;
}

async function handleWinnerSelect(interaction: StringSelectMenuInteraction, sid: number): Promise<boolean> {
  const sched = await loadSchedule(sid);
  if (!sched) { await interaction.reply({ content: "Schedule missing.", ephemeral: true }); return true; }
  const winnerId = interaction.values[0]!;
  const uid = interaction.user.id;
  // Strict participant-only — matches the dispatcher gate and the begun/finished policy.
  if (uid !== sched.awayDiscordId && uid !== sched.homeDiscordId) {
    await interaction.reply({ content: "🚫 Only the two players in this matchup can pick the winner.", ephemeral: true });
    return true;
  }
  if (sched.status === "finished" && sched.winnerDiscordId) {
    await interaction.reply({ content: "Already settled.", ephemeral: true });
    return true;
  }

  // "No Contest" path — close the schedule with no winner, no GOTW settlement.
  if (winnerId === "__nocontest__") {
    await db.update(gameSchedulesTable).set({
      status: "finished", winnerDiscordId: null, finishedAt: new Date(), updatedAt: new Date(),
    }).where(eq(gameSchedulesTable.id, sid));
    await interaction.update({ components: [], content: "✅ Marked completed (No Contest)." }).catch(() => {});
    await tagCommissioner(
      interaction.channel as TextChannel,
      `🏁 **Matchup closed — No Contest** by <@${uid}> for <@${sched.awayDiscordId}> vs <@${sched.homeDiscordId}>.\n_No GOTW payouts settled._`,
    );
    await refreshHeader(interaction.client, (await loadSchedule(sid))!);
    return true;
  }

  await db.update(gameSchedulesTable).set({
    status: "finished", winnerDiscordId: winnerId, finishedAt: new Date(), updatedAt: new Date(),
  }).where(eq(gameSchedulesTable.id, sid));

  // Settle GOTW for THIS matchup (if this game is the GOTW)
  const settled = await settleGotwForGame(interaction.client, sched, winnerId);

  // Rivalry bonus — paid per-side, each player only earns if the OPPONENT is
  // currently in THEIR personal top-4 rivalries (i.e. opponent has 3+ prior
  // H2H games and ranks among the top 4). Dynamically imported to keep the
  // scheduling handler free of an extra hard dependency on the rivalries
  // module.
  const rivalryBonusNotes = await settleRivalryBonus(sched).catch(() => null);

  await interaction.update({ components: [] }).catch(() => {});
  await tagCommissioner(
    interaction.channel as TextChannel,
    `🏁 **Final** — Winner: <@${winnerId}>.\n${settled ? settled : "_(not a GOTW match)_"}` +
    (rivalryBonusNotes ? `\n${rivalryBonusNotes}` : "") +
    `\n*Imported score will reconcile this when the franchise ZIP is processed.*`,
  );
  await refreshHeader(interaction.client, (await loadSchedule(sid))!);
  return true;
}

/**
 * Per-side rivalry-game bonus. Each player earns the RIVALRY_GAME_BONUS coin
 * payout only if the OTHER player is currently in their top-4 rivalries —
 * matching the product rule "users should only get paid the 20 coins if that
 * week's matchup is one of their top 4 rivalries". Returns a human-readable
 * note for the commissioner tag, or null if nobody qualified.
 */
async function settleRivalryBonus(
  sched: typeof gameSchedulesTable.$inferSelect,
): Promise<string | null> {
  if (!sched.awayDiscordId || !sched.homeDiscordId) return null;
  const { isOpponentTopRival } = await import("../economy/rivalries.js");
  const bonus = await getPayoutValue(PAYOUT_KEYS.RIVALRY_GAME_BONUS, sched.guildId);
  const sides: Array<{ a: string; b: string }> = [
    { a: sched.awayDiscordId, b: sched.homeDiscordId },
    { a: sched.homeDiscordId, b: sched.awayDiscordId },
  ];
  const paid: string[] = [];
  for (const { a, b } of sides) {
    const qualifies = await isOpponentTopRival(sched.guildId, a, b, 4);
    if (!qualifies) continue;
    await addBalance(a, bonus, sched.guildId);
    await logTransaction(a, bonus, "addcoins",
      `Rivalry game bonus vs <@${b}> (Week ${sched.weekIndex + 1})`, sched.guildId, "auto");
    paid.push(`<@${a}>`);
  }
  if (paid.length === 0) return null;
  return `⚔️ **Rivalry bonus** — +${bonus} coins to ${paid.join(", ")} (opponent is in top-4 rivals).`;
}

// ── Settle GOTW payouts when a GOTW game finishes ─────────────────────────────
export async function settleGotwForGame(
  client: Client,
  sched: typeof gameSchedulesTable.$inferSelect,
  winnerDiscordId: string,
): Promise<string | null> {
  // Find a gotw_history row matching season + week + the two players
  const histRows = await db.select().from(gotwHistoryTable)
    .where(and(eq(gotwHistoryTable.seasonId, sched.seasonId), eq(gotwHistoryTable.weekIndex, sched.weekIndex)));
  const hist = histRows.find((h) =>
    (h.discordId1 === sched.awayDiscordId && h.discordId2 === sched.homeDiscordId) ||
    (h.discordId1 === sched.homeDiscordId && h.discordId2 === sched.awayDiscordId),
  );
  if (!hist) return null;
  if (hist.payoutIssuedAt) return `GOTW: payout already issued at ${hist.payoutIssuedAt.toISOString()}.`;

  // Atomic claim — conditional UPDATE that only succeeds when payoutIssuedAt
  // is still NULL. Two simultaneous winner selections would both pass the
  // read-side `if (hist.payoutIssuedAt)` check above; this guarantees only
  // ONE of them advances to the payout loop, eliminating double-payment.
  // Filter on matchupIndex so each playoff matchup settles independently.
  const claimed = await db.update(gotwHistoryTable)
    .set({ payoutIssuedAt: new Date() })
    .where(and(
      eq(gotwHistoryTable.seasonId,     sched.seasonId),
      eq(gotwHistoryTable.weekIndex,    sched.weekIndex),
      eq(gotwHistoryTable.matchupIndex, hist.matchupIndex),
      isNull(gotwHistoryTable.payoutIssuedAt),
    ))
    .returning({ id: gotwHistoryTable.id });
  if (claimed.length === 0) {
    return `GOTW: payout already settled by a concurrent action.`;
  }

  const votes = await db.select().from(gotwVotesTable).where(and(
    eq(gotwVotesTable.seasonId,     sched.seasonId),
    eq(gotwVotesTable.weekIndex,    sched.weekIndex),
    eq(gotwVotesTable.matchupIndex, hist.matchupIndex),
  ));
  const correct = votes.filter((v) => v.votedForDiscordId === winnerDiscordId);
  const bonus   = await getPayoutValue(PAYOUT_KEYS.GOTW_REGULAR_BONUS, sched.guildId);

  for (const v of correct) {
    await addBalance(v.voterId, bonus, sched.guildId);
    await logTransaction(v.voterId, bonus, "addcoins", `GOTW correct guess — Week ${sched.weekIndex + 1}`, sched.guildId, "auto");
    try {
      const u = await client.users.fetch(v.voterId).catch(() => null);
      await u?.send(`🏈 GOTW correct! +${bonus} coins for Week ${sched.weekIndex + 1}.`).catch(() => {});
    } catch { /* ignore */ }
  }

  return `GOTW: paid **${correct.length}** voter(s) **${bonus}** coin(s) each.`;
}

// Exported for game-reminders.ts so the T0 message can post the begin buttons.
export function buildBeginRow(sid: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gs_begun:${sid}`).setLabel("▶️ Confirm Game Begun").setStyle(ButtonStyle.Primary),
  );
}

// Used by the channel-create flow.
export async function ensureScheduleRow(values: typeof gameSchedulesTable.$inferInsert): Promise<typeof gameSchedulesTable.$inferSelect> {
  const existing = await db.select().from(gameSchedulesTable).where(eq(gameSchedulesTable.channelId, values.channelId)).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db.insert(gameSchedulesTable).values(values).returning();
  return row!;
}

// Re-exports the menu uses
export { Message, MessageFlags, PRIMARY_GUILD_ID, eq, gameSchedulesTable, gotwVotesTable, coinTransactionsTable, usersTable };
