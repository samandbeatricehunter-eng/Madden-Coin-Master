/**
 * Per-game reminder scheduler.
 *
 * Ticks every 60s. For every `confirmed` schedule, sends dedup'd reminders:
 *   T-30 min  → "Game starts in 30 minutes — be ready."
 *   T0        → "Game starts now. Click Confirm Game Begun." (posts the begin button)
 *   T+20 min  → Re-ping if not begun.
 *   T+60 min  → Final re-ping if not begun.
 *   T+120 min → Tag Commissioner role, flip status → auto_fair_sim.
 *
 * Each reminder kind is recorded in `game_reminder_log` so we never re-fire.
 */

import { Client, TextChannel, EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { db } from "@workspace/db";
import { gameSchedulesTable, gameReminderLogTable, gameStatusConfirmationsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { buildBeginRow } from "../handlers/game-scheduling-handlers.js";
import { COMMISSIONER_ROLE_NAME } from "../handlers/game-scheduling-handlers.js";
import { formatAllZones } from "../discord/timezones.js";

const TICK_MS = 60 * 1000;

type ReminderKind = "t-30" | "t0" | "t+20" | "t+60" | "t+120";

const KIND_OFFSETS: Array<{ kind: ReminderKind; offsetMs: number; needsNotBegun: boolean }> = [
  { kind: "t-30",  offsetMs: -30 * 60_000, needsNotBegun: false },
  { kind: "t0",    offsetMs:           0,  needsNotBegun: false },
  { kind: "t+20",  offsetMs:  20 * 60_000, needsNotBegun: true  },
  { kind: "t+60",  offsetMs:  60 * 60_000, needsNotBegun: true  },
  { kind: "t+120", offsetMs: 120 * 60_000, needsNotBegun: true  },
];

export function startGameReminderScheduler(client: Client): void {
  // Wait 20s for the bot to fully connect, then tick every 60s.
  setTimeout(() => {
    void tick(client);
    setInterval(() => void tick(client), TICK_MS);
  }, 20_000);
}

async function tick(client: Client): Promise<void> {
  try {
  const now = Date.now();
  // Pull all schedules in a state where reminders are relevant.
  const schedules = await db.select().from(gameSchedulesTable)
    .where(inArray(gameSchedulesTable.status, ["confirmed", "started"]));

  for (const sched of schedules) {
    if (!sched.scheduledAt) continue;
    const startMs = sched.scheduledAt.getTime();

    // Has the game already been confirmed-begun by both players?
    const begunCount = await db.select().from(gameStatusConfirmationsTable)
      .where(and(eq(gameStatusConfirmationsTable.scheduleId, sched.id), eq(gameStatusConfirmationsTable.kind, "begun")));
    const begunDone = sched.status === "started" || begunCount.length >= 2;

    for (const k of KIND_OFFSETS) {
      const fireAt = startMs + k.offsetMs;
      if (now < fireAt) continue;
      if (k.needsNotBegun && begunDone) continue;

      // Atomic dedup: claim the log row FIRST via insert-on-conflict.
      // If another tick (or another bot instance) already claimed it, the
      // returning array is empty and we skip — guarantees a reminder fires
      // at most once even if the 60s tick overlaps with itself.
      const claimed = await db.insert(gameReminderLogTable)
        .values({ scheduleId: sched.id, kind: k.kind })
        .onConflictDoNothing()
        .returning({ id: gameReminderLogTable.id });
      if (claimed.length === 0) continue;

      try {
        await fireReminder(client, sched, k.kind);
      } catch (err) {
        console.error(`[game-reminders] failed to fire ${k.kind} for sched #${sched.id}:`, err);
      }
    }
  }
  } catch (err) {
    console.error("[game-reminders] tick error (connection or query failed):", err);
  }
}

async function fireReminder(
  client:  Client,
  sched:   typeof gameSchedulesTable.$inferSelect,
  kind:    ReminderKind,
): Promise<void> {
  const ch = await client.channels.fetch(sched.channelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const tc = ch as TextChannel;

  const ping = `<@${sched.awayDiscordId}> <@${sched.homeDiscordId}>`;

  if (kind === "t-30") {
    await tc.send({
      content: `${ping}\n⏰ **Reminder:** game starts in 30 minutes.\n${formatAllZones(sched.scheduledAt!)}`,
    });
    return;
  }

  if (kind === "t0") {
    const embed = new EmbedBuilder().setColor(Colors.Gold).setTitle("▶️ Game Time")
      .setDescription("Both players: when the game has actually started, click below to confirm.");
    await tc.send({
      content: `${ping}\n🚨 **Game time is now.**`,
      embeds:  [embed],
      components: [buildBeginRow(sched.id)],
    });
    return;
  }

  if (kind === "t+20") {
    await tc.send({
      content: `${ping}\n⚠️ It's been 20 minutes past start and the game hasn't been marked begun. Click **Confirm Game Begun** when you've started.`,
      components: [buildBeginRow(sched.id)],
    });
    return;
  }

  if (kind === "t+60") {
    await tc.send({
      content: `${ping}\n⚠️ **Final reminder:** 1 hour past scheduled start with no begin confirmation. Start now or this game will be auto-Fair-Sim'd at the 2-hour mark.`,
      components: [buildBeginRow(sched.id)],
    });
    return;
  }

  if (kind === "t+120") {
    const role = tc.guild.roles.cache.find((r) => r.name.toLowerCase() === COMMISSIONER_ROLE_NAME.toLowerCase());
    const commPing = role ? `<@&${role.id}>` : "**Commissioner**";
    await tc.send({
      content:
        `${commPing}\n🚩 **No-show: 2 hours past scheduled start.**\n` +
        `Players: <@${sched.awayDiscordId}> & <@${sched.homeDiscordId}>\n` +
        `Defaulting to **Fair Sim**.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`gs_begun:${sched.id}`).setLabel("Override: Mark Begun").setStyle(ButtonStyle.Secondary),
      )],
    });
    await db.update(gameSchedulesTable)
      .set({ status: "auto_fair_sim", updatedAt: new Date() })
      .where(eq(gameSchedulesTable.id, sched.id));
    return;
  }
}
