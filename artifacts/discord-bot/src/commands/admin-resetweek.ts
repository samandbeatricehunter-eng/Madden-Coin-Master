import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseGameParticipantsTable, interviewRequestsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { WEEK_SEQUENCE, weekLabel } from "./advanceweek.js";

export const data = new SlashCommandBuilder()
  .setName("admin-resetweek")
  .setDescription("Admin: clear franchise game records and interviews for a specific week so members can re-qualify")
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

  const season = await getOrCreateActiveSeason();

  // ── Fetch what exists for this week ─────────────────────────────────────────
  const participants = await db.select({
    id:        franchiseGameParticipantsTable.id,
    discordId: franchiseGameParticipantsTable.discordId,
    gameType:  franchiseGameParticipantsTable.gameType,
  })
    .from(franchiseGameParticipantsTable)
    .where(and(
      eq(franchiseGameParticipantsTable.week, week),
      eq(franchiseGameParticipantsTable.seasonId, season.id),
    ));

  const interviews = await db.select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
    .from(interviewRequestsTable)
    .where(eq(interviewRequestsTable.week, week));

  // ── Preview mode (confirm not set) ──────────────────────────────────────────
  if (!confirm) {
    const h2hCount = participants.filter(p => p.gameType === "h2h").length;
    const cpuCount = participants.filter(p => p.gameType === "cpu").length;

    const lines = [
      `**Week:** ${label}`,
      `**Franchise game records:** ${participants.length} total`,
      `  • H2H participants: ${h2hCount}`,
      `  • CPU participants: ${cpuCount}`,
      `**Interview requests:** ${interviews.length}`,
      ``,
      `Run this command again with \`confirm: True\` to delete all records for **${label}** and allow members to re-qualify.`,
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
  if (participants.length === 0 && interviews.length === 0) {
    return interaction.editReply({
      content: `ℹ️ No franchise game records or interviews found for **${label}**. Nothing to reset.`,
    });
  }

  // ── Delete interviews for this week first ───────────────────────────────────
  const deletedInterviews = interviews.length > 0
    ? await db.delete(interviewRequestsTable).where(eq(interviewRequestsTable.week, week)).returning({ id: interviewRequestsTable.id })
    : [];

  // ── Delete franchise game participant records for this week ─────────────────
  const deletedParticipants = participants.length > 0
    ? await db.delete(franchiseGameParticipantsTable)
        .where(and(
          eq(franchiseGameParticipantsTable.week, week),
          eq(franchiseGameParticipantsTable.seasonId, season.id),
        ))
        .returning({ id: franchiseGameParticipantsTable.id })
    : [];

  // ── Summary ─────────────────────────────────────────────────────────────────
  const lines = [
    `**Week reset:** ${label}`,
    `**Franchise game records deleted:** ${deletedParticipants.length}`,
    `**Interviews deleted:** ${deletedInterviews.length}`,
    ``,
    `All members can now re-qualify for interviews after the next franchise update for **${label}**.`,
  ];

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`✅ ${label} Reset Complete`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Reset by ${interaction.user.username}` })
        .setTimestamp(),
    ],
  });
}
