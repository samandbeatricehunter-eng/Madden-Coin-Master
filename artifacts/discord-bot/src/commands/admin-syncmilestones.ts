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
  .setDescription("Admin: sync win/loss counters and issue any missing milestone bonuses")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  // ── Optional manual override for a single player ─────────────────────────
  .addUserOption(o => o
    .setName("user")
    .setDescription("Target one player only (leave blank to sync all players)")
    .setRequired(false))
  .addIntegerOption(o => o
    .setName("wins")
    .setDescription("Correct this player's all-time H2H wins to this exact number")
    .setRequired(false)
    .setMinValue(0))
  .addIntegerOption(o => o
    .setName("losses")
    .setDescription("Correct this player's all-time H2H losses to this exact number")
    .setRequired(false)
    .setMinValue(0));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser   = interaction.options.getUser("user");
  const manualWins   = interaction.options.getInteger("wins");
  const manualLosses = interaction.options.getInteger("losses");

  // ── MANUAL SINGLE-USER OVERRIDE ───────────────────────────────────────────
  if (targetUser) {
    if (manualWins === null && manualLosses === null) {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Red)
          .setDescription("❌ When targeting a single user, provide **wins**, **losses**, or both.")],
      });
    }

    const userRow = await db.select().from(usersTable)
      .where(eq(usersTable.discordId, targetUser.id)).limit(1);

    if (!userRow[0]) {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Red)
          .setDescription(`❌ <@${targetUser.id}> is not registered in the league system.`)],
      });
    }

    const currentTier   = userRow[0].milestoneTierAwarded ?? 0;
    const currentWins   = userRow[0].allTimeH2HWins ?? 0;
    const currentLosses = userRow[0].allTimeH2HLosses ?? 0;
    const teamLabel     = userRow[0].team ?? userRow[0].discordUsername;

    const effectiveWins = manualWins ?? currentWins;
    const owedMilestones = [...H2H_MILESTONES]
      .reverse() // ascending: tier 1 → 4
      .filter(m => effectiveWins >= m.wins && currentTier < m.tier);

    const changes: string[] = [];

    await db.transaction(async (tx) => {
      // 1. Correct wins if provided
      if (manualWins !== null) {
        await tx.update(usersTable)
          .set({ allTimeH2HWins: manualWins, updatedAt: new Date() })
          .where(eq(usersTable.discordId, targetUser.id));
        changes.push(`📊 **All-time wins** corrected: ${currentWins} → **${manualWins}**`);
      }

      // 2. Correct losses if provided
      if (manualLosses !== null) {
        await tx.update(usersTable)
          .set({ allTimeH2HLosses: manualLosses, updatedAt: new Date() })
          .where(eq(usersTable.discordId, targetUser.id));
        changes.push(`📊 **All-time losses** corrected: ${currentLosses} → **${manualLosses}**`);
      }

      // 3. Award each owed milestone in order (based on effective wins)
      let newTier = currentTier;
      for (const m of owedMilestones) {
        await tx.update(usersTable)
          .set({ balance: sql`${usersTable.balance} + ${m.bonus}`, updatedAt: new Date() })
          .where(eq(usersTable.discordId, targetUser.id));
        await tx.insert(coinTransactionsTable).values({
          discordId:     targetUser.id,
          amount:        m.bonus,
          type:          "addcoins",
          description:   `Career milestone: ${m.label} (manual admin sync)`,
          relatedUserId: null,
        });
        changes.push(`🎯 **${m.label}** → +${m.bonus} coins`);
        newTier = m.tier;
      }

      // 4. Update milestone tier
      if (newTier !== currentTier) {
        await tx.update(usersTable)
          .set({ milestoneTierAwarded: newTier, updatedAt: new Date() })
          .where(eq(usersTable.discordId, targetUser.id));
        changes.push(`🏆 **Milestone tier**: ${currentTier} → ${newTier}`);
      }
    });

    if (owedMilestones.length === 0 && manualWins !== null) {
      changes.push(`✅ No new milestones owed at ${effectiveWins} wins (already tier ${currentTier})`);
    }

    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`✅ Record Corrected — ${teamLabel}`)
        .setDescription(changes.join("\n"))
        .setTimestamp()],
    });
  }

  // ── BULK SYNC (all users) ─────────────────────────────────────────────────
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
    // Use whichever is higher: DB-tracked wins or user_records sum
    const recordsWins = totalsMap.get(user.discordId) ?? 0;
    const trackedWins = user.allTimeH2HWins ?? 0;
    const trueWins    = Math.max(recordsWins, trackedWins);
    const currentTier = user.milestoneTierAwarded ?? 0;
    const teamLabel   = user.team ?? user.discordUsername;

    const owedMilestones = [...H2H_MILESTONES]
      .reverse()
      .filter(m => trueWins >= m.wins && currentTier < m.tier);

    const needsBackfill = trueWins !== trackedWins;
    const needsBonus    = owedMilestones.length > 0;

    if (!needsBackfill && !needsBonus) {
      noChangeLines.push(`✅ **${teamLabel}** — ${trueWins}W, tier ${currentTier}`);
      continue;
    }

    await db.transaction(async (tx) => {
      if (needsBackfill) {
        await tx.update(usersTable)
          .set({ allTimeH2HWins: trueWins, updatedAt: new Date() })
          .where(eq(usersTable.discordId, user.discordId));
        backfillLines.push(`🔧 **${teamLabel}** wins: ${trackedWins} → **${trueWins}**`);
      }

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
        bonusLines.push(`🎯 **${teamLabel}** — **${m.label}** → +${m.bonus} coins`);
        newTier = m.tier;
      }

      if (newTier > currentTier) {
        await tx.update(usersTable)
          .set({ milestoneTierAwarded: newTier, updatedAt: new Date() })
          .where(eq(usersTable.discordId, user.discordId));
      }
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("🔧 Milestone Sync Complete")
    .setColor(Colors.Orange)
    .setTimestamp();

  if (backfillLines.length > 0) {
    embed.addFields({ name: `Win Counter Corrections (${backfillLines.length})`, value: backfillLines.join("\n").slice(0, 1024) });
  }
  if (bonusLines.length > 0) {
    embed.addFields({ name: `Milestone Bonuses Issued (${bonusLines.length})`, value: bonusLines.join("\n").slice(0, 1024) });
  } else {
    embed.addFields({ name: "Milestone Bonuses", value: "✅ No missing bonuses found" });
  }

  const sample = noChangeLines.slice(0, 10).join("\n").slice(0, 1024);
  embed.addFields({
    name: `Already Correct (${noChangeLines.length})`,
    value: (sample || "—") + (noChangeLines.length > 10 ? `\n…and ${noChangeLines.length - 10} more` : ""),
  });

  await interaction.editReply({ embeds: [embed] });
}
