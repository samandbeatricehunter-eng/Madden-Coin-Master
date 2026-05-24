import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable, seasonsTable, coinTransactionsTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import {
  addBalance, logTransaction, isAdminUser,
  getGuildChannel, CHANNEL_KEYS,
} from "../../lib/db/db-helpers.js";

// ── Mirror exactly the milestones used in admin-manualscore + full-sync-engine
const WIN_MILESTONES = [
  { tier: 1, wins:  5, bonus:  100, label:  "5 All-Time H2H Wins" },
  { tier: 2, wins: 12, bonus:  250, label: "12 All-Time H2H Wins" },
  { tier: 3, wins: 25, bonus:  500, label: "25 All-Time H2H Wins" },
  { tier: 4, wins: 50, bonus: 1000, label: "50 All-Time H2H Wins" },
] as const;

export const data = new SlashCommandBuilder()
  .setName("admin-milestone-audit")
  .setDescription("Commissioner: retroactively check & pay any owed win-milestone bonuses for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!(await isAdminUser(interaction.user.id, interaction.guildId!))) {
    await interaction.editReply({ content: "❌ Commissioner access required." });
    return;
  }

  const guildId = interaction.guildId!;

  // ── 1. Load all registered users in this guild ─────────────────────────────
  const guildUsers = await db.select({
    discordId:            usersTable.discordId,
    team:                 usersTable.team,
    milestoneTierAwarded: usersTable.milestoneTierAwarded,
  })
    .from(usersTable)
    .where(eq(usersTable.guildId, guildId));

  if (guildUsers.length === 0) {
    await interaction.editReply({ content: "❌ No registered users found for this server." });
    return;
  }

  // ── 2. Compute guild-scoped win totals for every user in one query ──────────
  // Joins user_records → seasons to scope wins to THIS guild only.
  const winTotals = await db.select({
    discordId:  userRecordsTable.discordId,
    totalWins:  sql<string>`COALESCE(SUM(${userRecordsTable.wins}), 0)`,
  })
    .from(userRecordsTable)
    .innerJoin(seasonsTable, eq(userRecordsTable.seasonId, seasonsTable.id))
    .where(eq(seasonsTable.guildId, guildId))
    .groupBy(userRecordsTable.discordId);

  const winMap = new Map(winTotals.map(r => [r.discordId, parseInt(r.totalWins, 10)]));

  // ── 3. Audit each user ──────────────────────────────────────────────────────
  const paid:    string[] = [];   // lines that were actually paid out
  const correct: string[] = [];   // users already at correct tier
  const skipped: string[] = [];   // users with no wins yet

  for (const user of guildUsers) {
    const totalWins   = winMap.get(user.discordId) ?? 0;
    const currentTier = user.milestoneTierAwarded ?? 0;

    // Which tiers should this user have?
    const correctTier = WIN_MILESTONES.filter(m => totalWins >= m.wins).reduce(
      (max, m) => (m.tier > max ? m.tier : max), 0,
    );

    if (totalWins === 0) {
      skipped.push(`<@${user.discordId}> — 0 wins`);
      continue;
    }

    if (currentTier >= correctTier) {
      correct.push(`<@${user.discordId}> — ${totalWins}W, tier ${currentTier} ✅`);
      continue;
    }

    // There is a gap — check the last 10 transactions for milestone payments
    const recentTxns = await db.select({
      description: coinTransactionsTable.description,
    })
      .from(coinTransactionsTable)
      .where(and(
        eq(coinTransactionsTable.discordId, user.discordId),
        eq(coinTransactionsTable.guildId, guildId),
      ))
      .orderBy(desc(coinTransactionsTable.createdAt))
      .limit(10);

    const paidDescriptions = new Set(recentTxns.map(t => t.description ?? ""));

    // Pay any owed milestone tiers that aren't already in the last 10 transactions
    const owedMilestones = WIN_MILESTONES.filter(
      m => totalWins >= m.wins && currentTier < m.tier,
    );

    let highestNewTier = currentTier;
    const userPaidLines: string[] = [];

    for (const m of owedMilestones) {
      const expectedDesc = `Career milestone: ${m.label}`;

      if (paidDescriptions.has(expectedDesc)) {
        // Found a matching transaction — assume it was already paid, skip
        // but still advance the tier tracker so we don't re-pay lower tiers
        if (m.tier > highestNewTier) highestNewTier = m.tier;
        continue;
      }

      // Not found in last 10 txns → issue the payout
      await addBalance(user.discordId, m.bonus, guildId);
      await logTransaction(user.discordId, m.bonus, "addcoins", expectedDesc, guildId);
      userPaidLines.push(`Tier ${m.tier} — ${m.label}: **+${m.bonus.toLocaleString()} coins**`);

      if (m.tier > highestNewTier) highestNewTier = m.tier;
    }

    // Update milestoneTierAwarded if it changed
    if (highestNewTier > currentTier) {
      await db.update(usersTable)
        .set({ milestoneTierAwarded: highestNewTier, updatedAt: new Date() })
        .where(and(eq(usersTable.discordId, user.discordId), eq(usersTable.guildId, guildId)));
    }

    if (userPaidLines.length > 0) {
      const teamLabel = user.team ? ` (${user.team})` : "";
      paid.push(`<@${user.discordId}>${teamLabel} | ${totalWins}W\n  └ ${userPaidLines.join("\n  └ ")}`);
    } else {
      // Gap existed but all milestone txns were found — advance the tier record only
      correct.push(`<@${user.discordId}> — ${totalWins}W, tier corrected to ${highestNewTier} (txns found)`);
    }
  }

  // ── 4. Build reply embed ────────────────────────────────────────────────────
  const paidBlock    = paid.length    > 0 ? paid.join("\n\n")   : "*None — no outstanding payouts found.*";
  const correctBlock = correct.length > 0 ? correct.slice(0, 15).join("\n") + (correct.length > 15 ? `\n…and ${correct.length - 15} more` : "") : "*None*";

  const replyEmbed = new EmbedBuilder()
    .setColor(paid.length > 0 ? Colors.Gold : Colors.Green)
    .setTitle("🎯 Milestone Audit Complete")
    .addFields(
      { name: `💸 Payouts Issued (${paid.length})`, value: paidBlock },
      { name: `✅ Already Correct (${correct.length})`, value: correctBlock },
    )
    .setFooter({ text: `${skipped.length} user(s) had 0 wins and were skipped` })
    .setTimestamp();

  await interaction.editReply({ embeds: [replyEmbed] });

  // ── 5. Log to commissioner channel ─────────────────────────────────────────
  if (paid.length === 0) return;

  try {
    const commChannelId =
      await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER_LOG)
      ?? await getGuildChannel(guildId, CHANNEL_KEYS.COMMISSIONER)
      ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]
      ?? "";

    const commChannel = commChannelId
      ? await interaction.client.channels.fetch(commChannelId).catch(() => null)
      : null;

    if (commChannel instanceof TextChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🎯 Retroactive Milestone Audit — Payouts Issued")
        .setDescription(
          paid.map((p, i) => `**${i + 1}.** ${p}`).join("\n\n").slice(0, 4000),
        )
        .addFields(
          { name: "Audited By",  value: `<@${interaction.user.id}>`, inline: true },
          { name: "Total Paid",  value: `${paid.length} user(s)`,     inline: true },
        )
        .setTimestamp();

      await commChannel.send({ embeds: [logEmbed] });
    }
  } catch (err) {
    console.error("Milestone audit: failed to post to commissioner channel:", err);
  }
}
