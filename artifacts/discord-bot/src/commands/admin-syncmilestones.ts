import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, coinTransactionsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// Must mirror franchise-processor.ts constants exactly
const H2H_MILESTONES = [
  { tier: 4, wins: 50, bonus: 1000, label: "50 All-Time H2H Wins" },
  { tier: 3, wins: 25, bonus: 500,  label: "25 All-Time H2H Wins" },
  { tier: 2, wins: 12, bonus: 250,  label: "12 All-Time H2H Wins" },
  { tier: 1, wins:  5, bonus: 100,  label:  "5 All-Time H2H Wins" },
] as const;

export const data = new SlashCommandBuilder()
  .setName("admin-syncmilestones")
  .setDescription(
    "Admin: backfill all-time win counters from season records and issue any missing milestone bonuses",
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // ── Build true win totals from user_records across all seasons ────────────
  const allUsers = await db.select({
    discordId:            usersTable.discordId,
    discordUsername:      usersTable.discordUsername,
    team:                 usersTable.team,
    allTimeH2HWins:       usersTable.allTimeH2HWins,
    milestoneTierAwarded: usersTable.milestoneTierAwarded,
  }).from(usersTable);

  const recordTotals = await db.select({
    discordId:  userRecordsTable.discordId,
    totalWins:  sql<number>`COALESCE(SUM(${userRecordsTable.wins}), 0)`.as("total_wins"),
  }).from(userRecordsTable).groupBy(userRecordsTable.discordId);

  const totalsMap = new Map(recordTotals.map(r => [r.discordId, Number(r.totalWins)]));

  const backfillLines:  string[] = [];
  const bonusLines:     string[] = [];
  const noChangeLines:  string[] = [];

  for (const user of allUsers) {
    const trueWins    = totalsMap.get(user.discordId) ?? 0;
    const trackedWins = user.allTimeH2HWins ?? 0;
    const currentTier = user.milestoneTierAwarded ?? 0;
    const teamLabel   = user.team ?? user.discordUsername;

    // Determine which milestone tiers are owed (ascending order)
    const owedMilestones = [...H2H_MILESTONES]
      .reverse() // ascending: tier 1 → tier 4
      .filter(m => trueWins >= m.wins && currentTier < m.tier);

    const needsBackfill = trueWins !== trackedWins;
    const needsBonus    = owedMilestones.length > 0;

    if (!needsBackfill && !needsBonus) {
      noChangeLines.push(`✅ **${teamLabel}** — ${trueWins}W, tier ${currentTier} (no change)`);
      continue;
    }

    // ── Apply updates in a transaction ─────────────────────────────────────
    await db.transaction(async (tx) => {
      // 1. Backfill all_time_h2h_wins to match the true total
      if (needsBackfill) {
        await tx.update(usersTable)
          .set({ allTimeH2HWins: trueWins, updatedAt: new Date() })
          .where(eq(usersTable.discordId, user.discordId));
        backfillLines.push(
          `🔧 **${teamLabel}** wins: ${trackedWins} → **${trueWins}**`,
        );
      }

      // 2. Issue each owed milestone bonus
      let newTier = currentTier;
      for (const m of owedMilestones) {
        await tx.update(usersTable)
          .set({ balance: sql`${usersTable.balance} + ${m.bonus}`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, user.discordId));
        await tx.insert(coinTransactionsTable).values({
          discordId:     user.discordId,
          amount:        m.bonus,
          type:          "addcoins",
          description:   `Career milestone: ${m.label} (retroactive backfill)`,
          relatedUserId: null,
        });
        bonusLines.push(
          `🎯 **${teamLabel}** — **${m.label}** → +${m.bonus} coins`,
        );
        newTier = m.tier;
      }

      // 3. Update milestone tier if it changed
      if (newTier > currentTier) {
        await tx.update(usersTable)
          .set({ milestoneTierAwarded: newTier, updatedAt: new Date() })
          .where(eq(usersTable.discordId, user.discordId));
      }
    });
  }

  // ── Build reply embed ─────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle("🔧 Milestone Sync Complete")
    .setColor(Colors.Orange)
    .setTimestamp();

  if (backfillLines.length > 0) {
    embed.addFields({
      name: `Win Counter Corrections (${backfillLines.length})`,
      value: backfillLines.join("\n").slice(0, 1024),
    });
  }

  if (bonusLines.length > 0) {
    embed.addFields({
      name: `Milestone Bonuses Issued (${bonusLines.length})`,
      value: bonusLines.join("\n").slice(0, 1024),
    });
  } else {
    embed.addFields({
      name: "Milestone Bonuses",
      value: "✅ No missing bonuses found — all users up to date",
    });
  }

  embed.addFields({
    name: `Already Correct (${noChangeLines.length})`,
    value: noChangeLines.slice(0, 10).join("\n").slice(0, 1024) +
      (noChangeLines.length > 10 ? `\n…and ${noChangeLines.length - 10} more` : ""),
  });

  await interaction.editReply({ embeds: [embed] });
}
