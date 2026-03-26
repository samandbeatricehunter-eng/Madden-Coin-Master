import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, coinTransactionsTable,
  inventoryTable, purchasesTable, interviewRequestsTable,
} from "@workspace/db";
import { eq, and, desc, isNotNull, sql } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

const MILESTONE_LABELS: Record<number, string> = {
  0: "None",
  1: "5 wins (+100 🪙)",
  2: "12 wins (+250 🪙)",
  3: "25 wins (+500 🪙)",
  4: "50 wins (+1000 🪙)",
};

export const data = new SlashCommandBuilder()
  .setName("admin-userstats")
  .setDescription("View full stats, coins, and inventory for any user (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o =>
    o.setName("user").setDescription("The user to look up").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member       = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const target  = interaction.options.getUser("user", true);
  const season  = await getOrCreateActiveSeason();
  const weekDisplay = weekLabel((season as any).currentWeek ?? "1");

  // ── Core user record ──────────────────────────────────────────────────────
  const userRows = await db.select().from(usersTable).where(eq(usersTable.discordId, target.id)).limit(1);
  const user = userRows[0];

  if (!user) {
    await interaction.editReply({ content: `❌ <@${target.id}> has no record in the economy system yet.` });
    return;
  }

  // ── Season record ─────────────────────────────────────────────────────────
  const recordRows = await db.select().from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, target.id), eq(userRecordsTable.seasonId, season.id)))
    .limit(1);
  const record = recordRows[0];

  // ── All-time totals (sum across every season) ─────────────────────────────
  const allTimeRows = await db.select({
    totalWins:          sql<string>`COALESCE(SUM(${userRecordsTable.wins}), 0)`,
    totalLosses:        sql<string>`COALESCE(SUM(${userRecordsTable.losses}), 0)`,
    totalPlayoffWins:   sql<string>`COALESCE(SUM(${userRecordsTable.playoffWins}), 0)`,
    totalPlayoffLosses: sql<string>`COALESCE(SUM(${userRecordsTable.playoffLosses}), 0)`,
  }).from(userRecordsTable)
    .where(eq(userRecordsTable.discordId, target.id));
  const allTimeH2HW     = parseInt(allTimeRows[0]?.totalWins ?? "0", 10);
  const allTimeH2HL     = parseInt(allTimeRows[0]?.totalLosses ?? "0", 10);
  const allTimePlayoffW = parseInt(allTimeRows[0]?.totalPlayoffWins ?? "0", 10);
  const allTimePlayoffL = parseInt(allTimeRows[0]?.totalPlayoffLosses ?? "0", 10);

  // ── Inventory (this season) ───────────────────────────────────────────────
  const inventory = await db.select().from(inventoryTable)
    .where(and(eq(inventoryTable.discordId, target.id), eq(inventoryTable.seasonId, season.id)));

  // ── Legend vault: current season + permanent ──────────────────────────────
  const currentLegends   = inventory.filter(i => i.itemType === "legend" && i.legendCategory === "current");
  const permanentLegends = await db.select().from(inventoryTable)
    .where(and(
      eq(inventoryTable.discordId, target.id),
      eq(inventoryTable.itemType, "legend"),
      sql`${inventoryTable.legendCategory} = 'permanent'`,
    ));

  // ── Pending purchases (this season) ──────────────────────────────────────
  const pendingPurchases = await db.select().from(purchasesTable)
    .where(and(eq(purchasesTable.discordId, target.id), eq(purchasesTable.seasonId, season.id)))
    .orderBy(desc(purchasesTable.createdAt))
    .limit(20);

  // ── Last 10 transactions ──────────────────────────────────────────────────
  const transactions = await db.select().from(coinTransactionsTable)
    .where(eq(coinTransactionsTable.discordId, target.id))
    .orderBy(desc(coinTransactionsTable.createdAt))
    .limit(10);

  // ── Interview history this season ─────────────────────────────────────────
  const interviews = await db.select({
    id:     interviewRequestsTable.id,
    week:   interviewRequestsTable.week,
    status: interviewRequestsTable.status,
  }).from(interviewRequestsTable)
    .where(eq(interviewRequestsTable.discordId, target.id))
    .orderBy(desc(interviewRequestsTable.createdAt))
    .limit(5);

  // ── Build embeds ──────────────────────────────────────────────────────────

  // Embed 1: Overview
  const overviewEmbed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📊 User Stats — ${user.team ?? target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "Discord",       value: `<@${target.id}>`,                                  inline: true },
      { name: "Team",          value: user.team ?? "*Not set*",                            inline: true },
      { name: "Admin",         value: user.isAdmin ? "✅ Yes" : "No",                     inline: true },
      { name: "💰 Balance",    value: `**${user.balance.toLocaleString()} coins**`,       inline: true },
      { name: "📅 Current Week", value: weekDisplay,                                      inline: true },
      { name: "🏆 Legend Purchases (all-time)", value: `${user.totalLegendPurchases}`,   inline: true },
    )
    .setFooter({ text: `User ID: ${target.id}` });

  // Embed 2: Records & Milestones
  const wins        = record?.wins ?? 0;
  const losses      = record?.losses ?? 0;
  const pd          = record?.pointDifferential ?? 0;
  const pWins       = record?.playoffWins ?? 0;
  const pLosses     = record?.playoffLosses ?? 0;
  const allTimeSB      = user.allTimeSuperbowlWins ?? 0;
  const milestoneLabel = MILESTONE_LABELS[user.milestoneTierAwarded ?? 0] ?? "None";

  const playoffSeed = (user as any).playoffSeed;
  const conf        = (user as any).playoffConference;
  const seedStr     = playoffSeed
    ? `${conf} Seed #${playoffSeed} (${playoffSeed <= 4 ? "Top 4 — +75/win" : "Wildcard — +100/win"})`
    : "*Not seeded*";

  const statsEmbed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("🏈 Season Record & Milestones")
    .addFields(
      { name: "Season Record",            value: `**${wins}W – ${losses}L** (PD: ${pd > 0 ? "+" : ""}${pd})`, inline: true },
      { name: "This Season Playoffs",    value: `${pWins}W – ${pLosses}L`, inline: true },
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
  const customs  = inventory.filter(i =>
    ["custom_player_gold", "custom_player_silver", "custom_player_bronze"].includes(i.itemType)
  );
  const attrs   = pendingPurchases.filter(p => p.purchaseType === "attribute" && p.status === "approved");
  const devUps  = pendingPurchases.filter(p => p.purchaseType === "dev_up" && p.status === "approved");
  const ageRes  = pendingPurchases.filter(p => p.purchaseType === "age_reset" && p.status === "approved");
  const pendingCount = pendingPurchases.filter(p => p.status === "pending").length;

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
      { name: `⚡ Current Season Legends (${currentLegends.length})`,         value: fmtLegend(currentLegends)   },
      { name: `🔒 Permanent Vault (${permanentLegends.length}/4)`,            value: fmtLegend(permanentLegends) },
      { name: `Custom Players (${customs.length})`,                           value: customStr },
      { name: "Attribute Upgrades Approved", value: `${attrs.length}`,   inline: true },
      { name: "Dev Upgrades Approved",       value: `${devUps.length}`,  inline: true },
      { name: "Age Resets Approved",         value: `${ageRes.length}`,  inline: true },
      { name: "Pending Purchases",           value: `${pendingCount}`,   inline: true },
    );

  // Embed 4: Recent Transactions + Interviews
  const txLines = transactions.length > 0
    ? transactions.map(tx => {
        const sign   = tx.amount >= 0 ? "+" : "";
        const date   = tx.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
