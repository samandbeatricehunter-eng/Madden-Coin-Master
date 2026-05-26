// Commissioner Gameday Review Dashboard scaffold.
// Wire this into:
// /menu -> Commissioner's Office -> Gameday Review

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

export async function renderCommissionerGamedayReview(interaction: any, guildId: string) {
  const [
    fwRequests,
    fsRequests,
    violations,
    disputedFinals,
    delayRequests,
    payoutHistory,
  ] = await Promise.all([
    countByType(guildId, "force_win"),
    countByType(guildId, "fair_sim"),
    countByType(guildId, "violation"),
    countDisputedFinals(guildId),
    countByType(guildId, "advance_delay"),
    countRecentPayouts(guildId),
  ]);

  const embed = new EmbedBuilder()
    .setColor(Colors.DarkBlue)
    .setTitle("🎮 Commissioner Gameday Review")
    .setDescription(
      [
        `⚖️ Force Win Requests: **${fwRequests}**`,
        `🧾 Fair Sim Requests: **${fsRequests}**`,
        `🚫 Violations: **${violations}**`,
        `🏁 Disputed Finals: **${disputedFinals}**`,
        `⏰ Delay Requests: **${delayRequests}**`,
        `💰 Recent Auto-Payouts: **${payoutHistory}**`,
      ].join("\n"),
    );

  const menu = new StringSelectMenuBuilder()
    .setCustomId("comm_gameday_review_select")
    .setPlaceholder("Select review category")
    .addOptions([
      new StringSelectMenuOptionBuilder()
        .setLabel("Force Win Requests")
        .setValue("force_win"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Fair Sim Requests")
        .setValue("fair_sim"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Violations")
        .setValue("violation"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Disputed Finals")
        .setValue("disputed_finals"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Advance Delay Requests")
        .setValue("advance_delay"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Auto-Payout History")
        .setValue("payout_history"),
    ]);

  await interaction.reply({
    ephemeral: true,
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
  });
}

async function countByType(guildId: string, type: string): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count
    from gameday_commissioner_requests
    where guild_id = ${guildId}
      and request_type = ${type}
      and status = 'pending'
  `);

  return Number((result as any).rows?.[0]?.count ?? 0);
}

async function countDisputedFinals(guildId: string): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count
    from gameday_score_submissions
    where guild_id = ${guildId}
      and status = 'disputed'
  `);

  return Number((result as any).rows?.[0]?.count ?? 0);
}

async function countRecentPayouts(guildId: string): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count
    from economy_transactions
    where guild_id = ${guildId}
      and created_at >= now() - interval '7 days'
      and (
        reason ilike '%stream%'
        or reason ilike '%highlight%'
      )
  `);

  return Number((result as any).rows?.[0]?.count ?? 0);
}
