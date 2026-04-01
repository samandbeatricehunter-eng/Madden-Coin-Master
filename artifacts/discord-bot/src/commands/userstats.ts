import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, coinTransactionsTable,
  inventoryTable, purchasesTable, interviewRequestsTable, seasonStatsTable,
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
  .setDescription("View your own stats, coins, and inventory (only visible to you)");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const season      = await getOrCreateActiveSeason();
  const weekDisplay = weekLabel((season as any).currentWeek ?? "1");

  // ── Core user record ──────────────────────────────────────────────────────
  const userRows = await db.select().from(usersTable)
    .where(eq(usersTable.discordId, interaction.user.id)).limit(1);
  const user = userRows[0];

  if (!user) {
    await interaction.editReply({ content: "❌ You don't have a record in the economy system yet. Ask a commissioner to add you." });
    return;
  }

  // ── Season record ─────────────────────────────────────────────────────────
  const recordRows = await db.select().from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, interaction.user.id), eq(userRecordsTable.seasonId, season.id)))
    .limit(1);
  const record = recordRows[0];

  // ── All-time totals (sum across every season) ─────────────────────────────
  const allTimeRows = await db.select({
    totalWins:         sql<string>`COALESCE(SUM(${userRecordsTable.wins}), 0)`,
    totalLosses:       sql<string>`COALESCE(SUM(${userRecordsTable.losses}), 0)`,
    totalPlayoffWins:  sql<string>`COALESCE(SUM(${userRecordsTable.playoffWins}), 0)`,
    totalPlayoffLosses:sql<string>`COALESCE(SUM(${userRecordsTable.playoffLosses}), 0)`,
  }).from(userRecordsTable)
    .where(eq(userRecordsTable.discordId, interaction.user.id));
  const allTimeH2HW     = parseInt(allTimeRows[0]?.totalWins ?? "0", 10);
  const allTimeH2HL     = parseInt(allTimeRows[0]?.totalLosses ?? "0", 10);
  const allTimePlayoffW = parseInt(allTimeRows[0]?.totalPlayoffWins ?? "0", 10);
  const allTimePlayoffL = parseInt(allTimeRows[0]?.totalPlayoffLosses ?? "0", 10);

  // ── Streaks ────────────────────────────────────────────────────────────────
  const [overallStreak, h2hStreak] = await Promise.all([
    computeStreak(interaction.user.id, false),
    computeStreak(interaction.user.id, true),
  ]);

  // ── Inventory (this season, non-legend items only) ───────────────────────
  const inventory = await db.select().from(inventoryTable)
    .where(and(eq(inventoryTable.discordId, interaction.user.id), eq(inventoryTable.seasonId, season.id)));

  // ── Legend vault: current season + permanent ──────────────────────────────
  const currentLegends = inventory.filter(i => i.itemType === "legend" && i.legendCategory === "current");
  const permanentLegends = await db.select().from(inventoryTable)
    .where(and(
      eq(inventoryTable.discordId, interaction.user.id),
      eq(inventoryTable.itemType, "legend"),
      sql`${inventoryTable.legendCategory} = 'permanent'`,
    ));

  // ── Purchases (this season, approved) ────────────────────────────────────
  const seasonPurchases = await db.select().from(purchasesTable)
    .where(and(eq(purchasesTable.discordId, interaction.user.id), eq(purchasesTable.seasonId, season.id)))
    .orderBy(desc(purchasesTable.createdAt))
    .limit(20);

  // ── Last 10 transactions ──────────────────────────────────────────────────
  const transactions = await db.select().from(coinTransactionsTable)
    .where(eq(coinTransactionsTable.discordId, interaction.user.id))
    .orderBy(desc(coinTransactionsTable.createdAt))
    .limit(10);

  // ── Interview history ─────────────────────────────────────────────────────
  const interviews = await db.select({
    id:     interviewRequestsTable.id,
    week:   interviewRequestsTable.week,
    status: interviewRequestsTable.status,
  }).from(interviewRequestsTable)
    .where(eq(interviewRequestsTable.discordId, interaction.user.id))
    .orderBy(desc(interviewRequestsTable.createdAt))
    .limit(5);

  // ── Build embeds ──────────────────────────────────────────────────────────

  // Embed 1: Overview
  const overviewEmbed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📊 My Stats — ${user.team ?? interaction.user.username}`)
    .setThumbnail(interaction.user.displayAvatarURL())
    .addFields(
      { name: "Team",               value: user.team ?? "*Not set*",                          inline: true },
      { name: "💰 Balance",         value: `**${user.balance.toLocaleString()} coins**`,     inline: true },
      { name: "📅 Current Week",    value: weekDisplay,                                       inline: true },
      { name: "🏆 Legends (all-time)", value: `${user.totalLegendPurchases}`,                inline: true },
    )
    .setFooter({ text: "Only you can see this message" });

  // Embed 2: Records & Milestones
  const wins      = record?.wins ?? 0;
  const losses    = record?.losses ?? 0;
  const pd        = record?.pointDifferential ?? 0;
  const pWins     = record?.playoffWins ?? 0;
  const pLosses   = record?.playoffLosses ?? 0;
  const allTimeSB = user.allTimeSuperbowlWins ?? 0;
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
      { name: "Highest Win Milestone", value: milestoneLabel, inline: true },
      { name: "Playoff Seed",          value: seedStr, inline: true },
    );

  // Embed 3: Inventory
  const customs  = inventory.filter(i =>
    ["custom_player_gold", "custom_player_silver", "custom_player_bronze"].includes(i.itemType)
  );
  // ── Season upgrade counts — source of truth includes admin overrides ──────
  const seasonStatsRows = await db.select().from(seasonStatsTable)
    .where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)))
    .limit(1);
  const seasonStats = seasonStatsRows[0];
  const coreAttrUsed    = seasonStats?.coreAttrPurchased    ?? 0;
  const nonCoreAttrUsed = seasonStats?.nonCoreAttrPurchased ?? 0;
  const devUpsUsed      = seasonStats?.devUpsPurchased      ?? 0;
  const ageResetsUsed   = seasonStats?.ageResetsPurchased   ?? 0;
  const pendingCount = seasonPurchases.filter(p => p.status === "pending").length;

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
      { name: `⚡ Current Season Legends (${currentLegends.length})`,                             value: fmtLegend(currentLegends)   },
      { name: `🔒 Permanent Vault (${permanentLegends.length}/4)`, value: fmtLegend(permanentLegends) },
      { name: `Custom Players (${customs.length})`, value: customStr },
      { name: "Core Attr Pts Used",    value: `${coreAttrUsed}`,    inline: true },
      { name: "Non-Core Attr Pts Used",value: `${nonCoreAttrUsed}`, inline: true },
      { name: "\u200b",               value: "\u200b",             inline: true },
      { name: "Dev Upgrades",         value: `${devUpsUsed}`,      inline: true },
      { name: "Age Resets",           value: `${ageResetsUsed}`,   inline: true },
      { name: "\u200b",               value: "\u200b",             inline: true },
      { name: "Pending Purchases",   value: `${pendingCount}`,  inline: true },
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
