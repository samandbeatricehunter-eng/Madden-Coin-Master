import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, coinTransactionsTable,
  inventoryTable, purchasesTable, interviewRequestsTable,
  seasonStatsTable, userSavingsTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { getOrCreateActiveSeason, computeStreak } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

const MILESTONE_LABELS: Record<number, string> = {
  0: "None",
  1: "5 wins (+100 🪙)",
  2: "12 wins (+250 🪙)",
  3: "25 wins (+500 🪙)",
  4: "50 wins (+1000 🪙)",
};

export const data = new SlashCommandBuilder()
  .setName("userstats")
  .setDescription("View stats, coins, and inventory for any league member")
  .addUserOption(o =>
    o.setName("user")
      .setDescription("League member to look up — leave blank for yourself")
      .setRequired(false),
  );

async function getSavings(discordId: string): Promise<number> {
  const row = await db.select({ balance: userSavingsTable.balance })
    .from(userSavingsTable)
    .where(eq(userSavingsTable.discordId, discordId))
    .limit(1);
  return row[0]?.balance ?? 0;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const target  = interaction.options.getUser("user") ?? interaction.user;
  const isSelf  = target.id === interaction.user.id;
  const season  = await getOrCreateActiveSeason();
  const weekDisplay = weekLabel((season as any).currentWeek ?? "1");

  // ── Core user record ──────────────────────────────────────────────────────
  const userRows = await db.select().from(usersTable)
    .where(eq(usersTable.discordId, target.id)).limit(1);
  const user = userRows[0];

  if (!user) {
    await interaction.editReply({
      content: isSelf
        ? "❌ You don't have a record in the economy system yet. Ask a commissioner to add you."
        : `❌ <@${target.id}> has no record in the economy system yet.`,
    });
    return;
  }

  // ── Parallel batch 1: records + savings + streaks ─────────────────────────
  const [recordRows, allTimeRows, savingsBalance, overallStreak, h2hStreak] = await Promise.all([
    db.select().from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, target.id), eq(userRecordsTable.seasonId, season.id)))
      .limit(1),

    db.select({
      totalWins:          sql<string>`COALESCE(SUM(${userRecordsTable.wins}), 0)`,
      totalLosses:        sql<string>`COALESCE(SUM(${userRecordsTable.losses}), 0)`,
      totalPlayoffWins:   sql<string>`COALESCE(SUM(${userRecordsTable.playoffWins}), 0)`,
      totalPlayoffLosses: sql<string>`COALESCE(SUM(${userRecordsTable.playoffLosses}), 0)`,
    }).from(userRecordsTable)
      .where(eq(userRecordsTable.discordId, target.id)),

    getSavings(target.id),
    computeStreak(target.id, false),
    computeStreak(target.id, true),
  ]);

  // ── Parallel batch 2: inventory + purchases + transactions + interviews ───
  const [inventory, seasonStatsRows, seasonPurchases, transactions, interviews] = await Promise.all([
    db.select().from(inventoryTable)
      .where(and(eq(inventoryTable.discordId, target.id), eq(inventoryTable.seasonId, season.id))),

    db.select().from(seasonStatsTable)
      .where(and(eq(seasonStatsTable.discordId, target.id), eq(seasonStatsTable.seasonId, season.id)))
      .limit(1),

    db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.discordId, target.id), eq(purchasesTable.seasonId, season.id)))
      .orderBy(desc(purchasesTable.createdAt))
      .limit(20),

    db.select().from(coinTransactionsTable)
      .where(eq(coinTransactionsTable.discordId, target.id))
      .orderBy(desc(coinTransactionsTable.createdAt))
      .limit(10),

    db.select({
      id:     interviewRequestsTable.id,
      week:   interviewRequestsTable.week,
      status: interviewRequestsTable.status,
    }).from(interviewRequestsTable)
      .where(eq(interviewRequestsTable.discordId, target.id))
      .orderBy(desc(interviewRequestsTable.createdAt))
      .limit(5),
  ]);

  const record      = recordRows[0];
  const seasonStats = seasonStatsRows[0];

  const allTimeH2HW     = parseInt(allTimeRows[0]?.totalWins ?? "0", 10);
  const allTimeH2HL     = parseInt(allTimeRows[0]?.totalLosses ?? "0", 10);
  const allTimePlayoffW = parseInt(allTimeRows[0]?.totalPlayoffWins ?? "0", 10);
  const allTimePlayoffL = parseInt(allTimeRows[0]?.totalPlayoffLosses ?? "0", 10);

  const currentLegends   = inventory.filter(i => i.itemType === "legend" && i.legendCategory === "current");
  const permanentLegends = inventory.filter(i => i.itemType === "legend" && i.legendCategory === "permanent");
  const customs          = inventory.filter(i =>
    ["custom_player_gold", "custom_player_silver", "custom_player_bronze"].includes(i.itemType),
  );

  const coreAttrUsed    = seasonStats?.coreAttrPurchased    ?? 0;
  const nonCoreAttrUsed = seasonStats?.nonCoreAttrPurchased ?? 0;
  const devUpsUsed      = seasonStats?.devUpsPurchased      ?? 0;
  const ageResetsUsed   = seasonStats?.ageResetsPurchased   ?? 0;
  const pendingCount    = seasonPurchases.filter(p => p.status === "pending").length;

  // ── Build embeds ──────────────────────────────────────────────────────────

  const totalCoins  = user.balance + savingsBalance;

  // Embed 1: Overview
  const overviewEmbed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📊 ${isSelf ? "My Stats" : "Player Stats"} — ${user.team ?? target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "Discord",               value: `<@${target.id}>`,                              inline: true },
      { name: "Team",                  value: user.team ?? "*Not set*",                        inline: true },
      { name: "📅 Current Week",       value: weekDisplay,                                     inline: true },
      { name: "💰 Wallet",             value: `**${user.balance.toLocaleString()} coins**`,   inline: true },
      { name: "🏦 Savings",            value: `**${savingsBalance.toLocaleString()} coins**`, inline: true },
      { name: "💎 Total",              value: `**${totalCoins.toLocaleString()} coins**`,     inline: true },
      { name: "🏆 Legends (all-time)", value: `${user.totalLegendPurchases}`,                 inline: true },
    )
    .setFooter({ text: isSelf ? "Only you can see this message" : `Viewed by ${interaction.user.username}` });

  // Embed 2: Records & Milestones
  const wins    = record?.wins ?? 0;
  const losses  = record?.losses ?? 0;
  const pd      = record?.pointDifferential ?? 0;
  const pWins   = record?.playoffWins ?? 0;
  const pLosses = record?.playoffLosses ?? 0;
  const allTimeSB      = user.allTimeSuperbowlWins ?? 0;
  const milestoneLabel = MILESTONE_LABELS[user.milestoneTierAwarded ?? 0] ?? "None";

  const playoffSeed = (user as any).playoffSeed;
  const conf        = (user as any).playoffConference;
  const seedStr     = playoffSeed
    ? `${conf} Seed #${playoffSeed} (${playoffSeed <= 4 ? "Top 4" : "Wildcard"})`
    : "*Not seeded*";

  const fmtStreak = (s: { result: "win" | "loss" | null; count: number }) => {
    if (!s.result) return "*No games yet*";
    const icon = s.result === "win" ? "🔥" : "❄️";
    return `${icon} **${s.count}-game ${s.result === "win" ? "WIN" : "LOSS"} streak**`;
  };

  const statsEmbed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🏈 Season Record & Milestones")
    .addFields(
      { name: "Season Record",            value: `**${wins}W – ${losses}L** (PD: ${pd > 0 ? "+" : ""}${pd})`, inline: true },
      { name: "This Season Playoffs",    value: `${pWins}W – ${pLosses}L`, inline: true },
      { name: "\u200b",                  value: "\u200b", inline: true },
      { name: "📈 Overall Streak",       value: fmtStreak(overallStreak), inline: true },
      { name: "⚔️ H2H-Only Streak",     value: fmtStreak(h2hStreak), inline: true },
      { name: "\u200b",                  value: "\u200b", inline: true },
      { name: "All-Time H2H Wins",       value: `**${allTimeH2HW}**`, inline: true },
      { name: "All-Time H2H Losses",     value: `**${allTimeH2HL}**`, inline: true },
      { name: "\u200b",                  value: "\u200b", inline: true },
      { name: "All-Time Playoff Wins",   value: `**${allTimePlayoffW}**`, inline: true },
      { name: "All-Time Playoff Losses", value: `**${allTimePlayoffL}**`, inline: true },
      { name: "All-Time SB Wins",        value: `**${allTimeSB}**`, inline: true },
      { name: "Highest Win Milestone",   value: milestoneLabel, inline: true },
      { name: "Playoff Seed",            value: seedStr, inline: true },
    );

  // Embed 3: Inventory
  const fmtLegend = (arr: typeof currentLegends) =>
    arr.length > 0
      ? arr.map(l => `• **${l.legendName ?? l.playerName ?? "?"}** (${l.playerPosition ?? "?"})`).join("\n")
      : "*None*";
  const customStr = customs.length > 0
    ? customs.map(c => `• **${c.playerName ?? "?"}** — ${c.customPlayerTier?.toUpperCase() ?? "?"}`).join("\n")
    : "*None*";

  const inventoryEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🎒 Season Inventory & Purchases")
    .addFields(
      { name: `⚡ Current Season Legends (${currentLegends.length})`,  value: fmtLegend(currentLegends)   },
      { name: `🔒 Permanent Vault (${permanentLegends.length}/4)`,     value: fmtLegend(permanentLegends) },
      { name: `Custom Players (${customs.length})`,                    value: customStr },
      { name: "Core Attr Pts Used",     value: `${coreAttrUsed}`,    inline: true },
      { name: "Non-Core Attr Pts Used", value: `${nonCoreAttrUsed}`, inline: true },
      { name: "\u200b",                 value: "\u200b",             inline: true },
      { name: "Dev Upgrades Used",      value: `${devUpsUsed}`,      inline: true },
      { name: "Age Resets Used",        value: `${ageResetsUsed}`,   inline: true },
      { name: "\u200b",                 value: "\u200b",             inline: true },
      { name: "Pending Purchases",      value: `${pendingCount}`,    inline: true },
    );

  // Embed 4: Recent Activity
  const txLines = transactions.length > 0
    ? transactions.map(tx => {
        const sign = tx.amount >= 0 ? "+" : "";
        const date = tx.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return `\`${date}\` ${sign}${tx.amount} — ${tx.description.slice(0, 60)}`;
      }).join("\n")
    : "*No transactions yet*";

  const interviewLines = interviews.length > 0
    ? interviews.map(iv => {
        const icon = iv.status === "approved" ? "✅" : iv.status === "denied" ? "❌" : "⏳";
        return `${icon} Interview #${iv.id} — ${weekLabel(iv.week ?? "?")} — **${iv.status}**`;
      }).join("\n")
    : "*None*";

  const activityEmbed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("📋 Recent Activity")
    .addFields(
      { name: "Last 10 Transactions", value: txLines },
      { name: "Recent Interviews",    value: interviewLines },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [overviewEmbed, statsEmbed, inventoryEmbed, activityEmbed] });
}
