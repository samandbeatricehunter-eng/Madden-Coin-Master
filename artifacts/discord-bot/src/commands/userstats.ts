import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userRecordsTable, coinTransactionsTable,
  inventoryTable, purchasesTable, interviewRequestsTable,
  seasonStatsTable, userSavingsTable,
  customPlayersTable, seasonsTable,
} from "@workspace/db";
import { eq, and, desc, sql, ne, inArray, or, isNull } from "drizzle-orm";
import { getOrCreateActiveSeason, computeStreak } from "../lib/db-helpers.js";
import { LIMITS } from "../lib/constants.js";
import { weekLabel } from "./advanceweek.js";
import { requireMcaEnabled, getServerSettings } from "../lib/server-settings.js";

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
  if (!await requireMcaEnabled(interaction)) return;

  const target  = interaction.options.getUser("user") ?? interaction.user;
  const isSelf  = target.id === interaction.user.id;
  const season  = await getOrCreateActiveSeason(interaction.guildId!);
  const weekDisplay = weekLabel((season as any).currentWeek ?? "1");

  // ── Core user record ──────────────────────────────────────────────────────
  const userRows = await db.select().from(usersTable)
    .where(and(eq(usersTable.discordId, target.id), eq(usersTable.guildId, interaction.guildId!))).limit(1);
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
  const [recordRows, allTimeRows, savingsBalance, overallStreak] = await Promise.all([
    db.select().from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, target.id), eq(userRecordsTable.seasonId, season.id)))
      .limit(1),

    // All-time records scoped to THIS guild by joining through seasons
    db.select({
      totalWins:          sql<string>`COALESCE(SUM(${userRecordsTable.wins}), 0)`,
      totalLosses:        sql<string>`COALESCE(SUM(${userRecordsTable.losses}), 0)`,
      totalPlayoffWins:   sql<string>`COALESCE(SUM(${userRecordsTable.playoffWins}), 0)`,
      totalPlayoffLosses: sql<string>`COALESCE(SUM(${userRecordsTable.playoffLosses}), 0)`,
    }).from(userRecordsTable)
      .innerJoin(seasonsTable, eq(userRecordsTable.seasonId, seasonsTable.id))
      .where(and(
        eq(userRecordsTable.discordId, target.id),
        eq(seasonsTable.guildId, interaction.guildId!),
      )),

    getSavings(target.id),
    computeStreak(target.id, false, interaction.guildId!),
  ]);

  // Build the team-aware WHERE clause for permanent vault items.
  // Permanent items are stamped with the franchise team name so they survive user changes.
  // Rows that pre-date the team column fall back to discordId matching.
  const teamName = user.team ?? null;
  const permOwnerWhere = teamName
    ? or(
        eq(inventoryTable.team, teamName),
        and(isNull(inventoryTable.team), eq(inventoryTable.discordId, target.id)),
      )
    : eq(inventoryTable.discordId, target.id);

  const guildId = interaction.guildId!;

  // Subquery: season IDs that belong to THIS guild — used to scope permanent
  // inventory items so cross-server data never leaks in.
  const guildSeasonIds = db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.guildId, guildId));

  // ── Parallel batch 2: inventory + purchases + transactions + interviews + customs + settings ─
  const [inventory, seasonStatsRows, seasonPurchases, transactions, interviews, customPlayers, permCustomPlayers, permanentLegendsFromVault, guildSettings] = await Promise.all([
    // Current-season non-permanent items only (dev ups, age resets, attributes, this season's legends/customs).
    // Legend/custom-player entries are stamped with the team name at creation time so they follow the
    // franchise across ownership changes. Fall back to discordId for older rows that pre-date that stamp.
    db.select().from(inventoryTable)
      .where(and(
        teamName
          ? or(eq(inventoryTable.team, teamName), and(isNull(inventoryTable.team), eq(inventoryTable.discordId, target.id)))
          : eq(inventoryTable.discordId, target.id),
        eq(inventoryTable.seasonId, season.id),
        or(isNull(inventoryTable.legendCategory), sql`${inventoryTable.legendCategory} != 'permanent'`),
      )),

    db.select().from(seasonStatsTable)
      .where(and(eq(seasonStatsTable.discordId, target.id), eq(seasonStatsTable.seasonId, season.id)))
      .limit(1),

    db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.discordId, target.id), eq(purchasesTable.seasonId, season.id)))
      .orderBy(desc(purchasesTable.createdAt))
      .limit(20),

    db.select().from(coinTransactionsTable)
      .where(and(
        eq(coinTransactionsTable.discordId, target.id),
        eq(coinTransactionsTable.guildId, interaction.guildId!),
      ))
      .orderBy(desc(coinTransactionsTable.createdAt))
      .limit(10),

    db.select({
      id:     interviewRequestsTable.id,
      week:   interviewRequestsTable.week,
      status: interviewRequestsTable.status,
    }).from(interviewRequestsTable)
      .where(and(
        eq(interviewRequestsTable.discordId, target.id),
        eq(interviewRequestsTable.guildId, interaction.guildId!),
      ))
      .orderBy(desc(interviewRequestsTable.createdAt))
      .limit(5),

    // Current season custom players — use team-based lookup when user has a team so inventory
    // follows the franchise. Fall back to discordId for rows created before team stamping.
    db.select({
      id:           customPlayersTable.id,
      firstName:    customPlayersTable.firstName,
      lastName:     customPlayersTable.lastName,
      position:     customPlayersTable.position,
      archetypeName: customPlayersTable.archetypeName,
      devTrait:     customPlayersTable.devTrait,
      packageTier:  customPlayersTable.packageTier,
      status:       customPlayersTable.status,
    }).from(customPlayersTable)
      .where(and(
        teamName
          ? or(eq(customPlayersTable.teamName, teamName), and(isNull(customPlayersTable.teamName), eq(customPlayersTable.discordId, target.id)))
          : eq(customPlayersTable.discordId, target.id),
        eq(customPlayersTable.seasonId, season.id),
      ))
      .orderBy(desc(customPlayersTable.createdAt)),

    // Permanent custom players — scoped to this guild's seasons to prevent cross-server leaks.
    db.select({
      id:             inventoryTable.id,
      playerName:     inventoryTable.playerName,
      playerPosition: inventoryTable.playerPosition,
      notes:          inventoryTable.notes,
      itemType:       inventoryTable.itemType,
    }).from(inventoryTable)
      .where(and(
        permOwnerWhere,
        inArray(inventoryTable.itemType, ["custom_player_gold", "custom_player_silver", "custom_player_bronze"]),
        sql`${inventoryTable.legendCategory} = 'permanent'`,
        inArray(inventoryTable.seasonId, guildSeasonIds),
      )),

    // Permanent legends — scoped to this guild's seasons to prevent cross-server leaks.
    // Also picks up legend rows from prior seasons whose legendCategory is null (missed by old rollover logic).
    db.select().from(inventoryTable)
      .where(and(
        permOwnerWhere,
        eq(inventoryTable.itemType, "legend"),
        inArray(inventoryTable.seasonId, guildSeasonIds),
        or(
          sql`${inventoryTable.legendCategory} = 'permanent'`,
          and(isNull(inventoryTable.legendCategory), sql`${inventoryTable.seasonId} != ${season.id}`),
        ),
      )),

    // Guild feature settings — determines which embed sections to render.
    getServerSettings(guildId),
  ]);

  const record      = recordRows[0];
  const seasonStats = seasonStatsRows[0];

  const allTimeH2HW     = parseInt(allTimeRows[0]?.totalWins ?? "0", 10);
  const allTimeH2HL     = parseInt(allTimeRows[0]?.totalLosses ?? "0", 10);
  const allTimePlayoffW = parseInt(allTimeRows[0]?.totalPlayoffWins ?? "0", 10);
  const allTimePlayoffL = parseInt(allTimeRows[0]?.totalPlayoffLosses ?? "0", 10);

  // inventory only contains non-permanent items now — all legend rows here are current-season
  const currentLegends   = inventory.filter(i => i.itemType === "legend");
  const permanentLegends = permanentLegendsFromVault;

  // Custom players for this season (season inventory)
  const activeCustoms = (customPlayers ?? []).filter(cp => cp.status !== "refunded");
  const refundedCount = (customPlayers ?? []).filter(cp => cp.status === "refunded").length;

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
      { name: "🎮 EA ID",             value: user.eaId ?? "*Not set*",                         inline: true },
      { name: "📅 Current Week",       value: weekDisplay,                                     inline: true },
      { name: "💰 Wallet",             value: `**${user.balance.toLocaleString()} coins**`,   inline: true },
      { name: "🏦 Savings",            value: `**${savingsBalance.toLocaleString()} coins**`, inline: true },
      { name: "💎 Total",              value: `**${totalCoins.toLocaleString()} coins**`,     inline: true },
      { name: "🏆 Legends (all-time)", value: `${user.totalLegendPurchases}`,                 inline: true },
    )
    .setFooter({ text: isSelf ? "Only you can see this message" : `Viewed by ${interaction.user.username}` });

  // Embed 2: Records & Milestones
  const wins   = record?.wins ?? 0;
  const losses = record?.losses ?? 0;
  const pd     = record?.pointDifferential ?? 0;
  const allTimeSB      = user.allTimeSuperbowlWins   ?? 0;
  const allTimeSBL     = user.allTimeSuperbowlLosses ?? 0;
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
      { name: "📈 Overall Streak",       value: fmtStreak(overallStreak), inline: true },
      { name: "\u200b",                  value: "\u200b", inline: true },
      { name: "All-Time H2H Wins",       value: `**${allTimeH2HW}**`, inline: true },
      { name: "All-Time H2H Losses",     value: `**${allTimeH2HL}**`, inline: true },
      { name: "\u200b",                  value: "\u200b", inline: true },
      { name: "All-Time Playoff Wins",   value: `**${allTimePlayoffW}**`, inline: true },
      { name: "All-Time Playoff Losses", value: `**${allTimePlayoffL}**`, inline: true },
      { name: "All-Time SB Wins",        value: `**${allTimeSB}**`,  inline: true },
      { name: "All-Time SB Losses",      value: `**${allTimeSBL}**`, inline: true },
      { name: "Highest Win Milestone",   value: milestoneLabel, inline: true },
      { name: "Playoff Seed",            value: seedStr, inline: true },
    );

  // Embed 3: Inventory
  const fmtLegend = (arr: typeof currentLegends) =>
    arr.length > 0
      ? arr.map(l => `• **${l.legendName ?? l.playerName ?? "?"}** (${l.playerPosition ?? "?"})`).join("\n")
      : "*None*";

  // Custom player display helpers
  const statusIcon = (s: string) => s === "applied" ? "✅" : s === "refunded" ? "♻️" : "⏳";
  const traitLabel = (t: string) =>
    t === "superstar" ? "Superstar" : t === "star" ? "Star" : "Normal";

  // Pending legend purchases count toward the cap immediately (before commissioner approval)
  const pendingLegendCount = (seasonPurchases ?? []).filter(
    p => p.purchaseType === "legend" && p.status === "pending",
  ).length;

  // Combined season inventory slots: applied legends + pending legend requests + active custom players
  const cap         = LIMITS.maxLegendsPlusCustomPlayers;
  const combined    = currentLegends.length + pendingLegendCount + activeCustoms.length;
  const cpSlotStr   = `${combined} / ${cap} season inventory slots used`;

  // Season inventory: custom players purchased this season (pre-draft)
  const seasonCustomStr = activeCustoms.length > 0
    ? activeCustoms.map(cp =>
        `${statusIcon(cp.status)} **${cp.firstName} ${cp.lastName}**, ${cp.position}, ${traitLabel(cp.devTrait)}`
      ).join("\n")
    : "*None this season*";

  // Permanent custom players: rolled over from past seasons
  const permCustomStr = (permCustomPlayers ?? []).length > 0
    ? (permCustomPlayers ?? []).map(p => {
        // Extract dev trait from notes: "Dev: superstar | Archetype: ... | Tier: ..."
        const devMatch = p.notes?.match(/Dev:\s*(\w+)/i);
        const trait    = devMatch ? traitLabel(devMatch[1]!.toLowerCase()) : "";
        return `• **${p.playerName ?? "?"}**, ${p.playerPosition ?? "?"}, ${trait}`;
      }).join("\n")
    : "*None*";

  const legendsOn = guildSettings.legendsEnabled;
  const customsOn  = guildSettings.customSuperstarsEnabled;

  const inventoryFields: { name: string; value: string; inline?: boolean }[] = [];

  if (legendsOn) {
    inventoryFields.push(
      { name: `⚡ Season Legends (${currentLegends.length})`,             value: fmtLegend(currentLegends)   },
      { name: `🔒 Permanent Legend Vault (${permanentLegends.length}/4)`, value: fmtLegend(permanentLegends) },
    );
  }

  if (customsOn) {
    inventoryFields.push(
      {
        name:  `🏈 Season Custom Players (${cpSlotStr}${refundedCount > 0 ? `, ${refundedCount} refunded` : ""})`,
        value: seasonCustomStr,
      },
      {
        name:  `🗃️ Permanent Custom Players (${(permCustomPlayers ?? []).length})`,
        value: permCustomStr,
      },
    );
  }

  inventoryFields.push(
    { name: "Core Attr Pts Used",     value: `${coreAttrUsed}`,    inline: true },
    { name: "Non-Core Attr Pts Used", value: `${nonCoreAttrUsed}`, inline: true },
    { name: "\u200b",                 value: "\u200b",             inline: true },
    { name: "Dev Upgrades Used",      value: `${devUpsUsed}`,      inline: true },
    { name: "Age Resets Used",        value: `${ageResetsUsed}`,   inline: true },
    { name: "\u200b",                 value: "\u200b",             inline: true },
    { name: "Pending Purchases",      value: `${pendingCount}`,    inline: true },
  );

  const inventoryEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🎒 Season Inventory & Purchases")
    .addFields(...inventoryFields);

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
