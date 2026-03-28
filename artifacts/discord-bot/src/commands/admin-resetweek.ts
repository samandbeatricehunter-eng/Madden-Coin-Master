import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { payoutRequestsTable, interviewRequestsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { isAdminUser } from "../lib/db-helpers.js";
import { WEEK_SEQUENCE, weekLabel } from "./advanceweek.js";

export const data = new SlashCommandBuilder()
  .setName("admin-resetweek")
  .setDescription("Admin: clear all score reports and interviews for a specific week so members can resubmit")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("week")
      .setDescription("Which week to reset?")
      .setRequired(true)
      .addChoices(
        ...WEEK_SEQUENCE.map(w => ({ name: weekLabel(w), value: w }))
      )
  )
  .addBooleanOption(opt =>
    opt.setName("confirm")
      .setDescription("Set to True to confirm deletion — this cannot be undone")
      .setRequired(true)
  );

async function checkAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAdminUser(interaction.user.id);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!(await checkAdmin(interaction))) {
    return interaction.editReply({ content: "❌ You do not have permission to use this command." });
  }

  const week    = interaction.options.getString("week", true);
  const confirm = interaction.options.getBoolean("confirm", true);
  const label   = weekLabel(week);

  // ── Fetch what exists for this week ─────────────────────────────────────────
  const payouts = await db.select({
    id:     payoutRequestsTable.id,
    status: payoutRequestsTable.status,
    gameType: payoutRequestsTable.gameType,
    requesterTeam: payoutRequestsTable.requesterTeam,
    opponentTeam: payoutRequestsTable.opponentTeam,
  })
    .from(payoutRequestsTable)
    .where(eq(payoutRequestsTable.week, week));

  const interviews = await db.select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
    .from(interviewRequestsTable)
    .where(eq(interviewRequestsTable.week, week));

  const pending  = payouts.filter(p => p.status === "pending");
  const approved = payouts.filter(p => p.status === "approved");
  const denied   = payouts.filter(p => p.status === "denied");

  // ── Preview mode (confirm not set) ──────────────────────────────────────────
  if (!confirm) {
    const lines = [
      `**Week:** ${label}`,
      `**Score reports found:** ${payouts.length} total`,
      `  • Pending: ${pending.length}`,
      `  • Approved: ${approved.length}${approved.length > 0 ? " ⚠️ (coins already paid — will be deleted but coins are NOT reversed)" : ""}`,
      `  • Denied: ${denied.length}`,
      `**Interview requests:** ${interviews.length}`,
      ``,
      `Run this command again with \`confirm: True\` to delete all records for **${label}** and allow members to resubmit.`,
    ];

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle(`🔍 Reset Preview — ${label}`)
          .setDescription(lines.join("\n"))
          .setTimestamp(),
      ],
    });
  }

  // ── Nothing to delete ───────────────────────────────────────────────────────
  if (payouts.length === 0 && interviews.length === 0) {
    return interaction.editReply({
      content: `ℹ️ No score reports or interviews found for **${label}**. Nothing to reset.`,
    });
  }

  // ── Delete interviews for this week first ───────────────────────────────────
  const deletedInterviews = interviews.length > 0
    ? await db.delete(interviewRequestsTable).where(eq(interviewRequestsTable.week, week)).returning({ id: interviewRequestsTable.id })
    : [];

  // ── Delete all payout requests for this week ────────────────────────────────
  const deletedPayouts = payouts.length > 0
    ? await db.delete(payoutRequestsTable).where(eq(payoutRequestsTable.week, week)).returning({ id: payoutRequestsTable.id })
    : [];

  // ── Summary ─────────────────────────────────────────────────────────────────
  const warningLines: string[] = [];
  if (approved.length > 0) {
    warningLines.push(
      `⚠️ **${approved.length} approved game(s) were deleted.** Coins already paid for those games are NOT reversed — members keep their earnings.`,
    );
  }

  const lines = [
    `**Week reset:** ${label}`,
    `**Score reports deleted:** ${deletedPayouts.length} (${pending.length} pending, ${approved.length} approved, ${denied.length} denied)`,
    `**Interviews deleted:** ${deletedInterviews.length}`,
    ``,
    `All members can now resubmit their scores for **${label}**.`,
  ];

  if (warningLines.length > 0) {
    lines.push("", ...warningLines);
  }

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(approved.length > 0 ? Colors.Orange : Colors.Green)
        .setTitle(`✅ ${label} Reset Complete`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Reset by ${interaction.user.username}` })
        .setTimestamp(),
    ],
  });
}
