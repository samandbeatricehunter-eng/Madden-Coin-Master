/**
 * Shared helper — fetches user stats and appends them as fields on an existing
 * EmbedBuilder. Used by both the /actions hub initial reply and the ac_hub
 * back-to-hub handler so both always show the player's live data.
 */
import { EmbedBuilder } from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, userSavingsTable, userRecordsTable, globalUserRecordsTable,
  seasonsTable, coinTransactionsTable, inventoryTable,
  playerEaIdsTable, customPlayersTable,
} from "@workspace/db";
import { eq, and, desc, ne } from "drizzle-orm";
import { getSeasonStats } from "./db-helpers.js";
import type { ServerSettings } from "./server-settings.js";

type User   = typeof usersTable.$inferSelect;
type Season = typeof seasonsTable.$inferSelect;
type SeasonRules = { coreAttrCap: number; nonCoreAttrCap: number; devUpsCap: number; ageResetsCap: number; [k: string]: unknown };

/**
 * Fetches all secondary stats rows and appends them as embed fields.
 * Mutates and returns the passed embed for chaining.
 */
export async function appendUserStatsFields(
  embed: EmbedBuilder,
  uid: string,
  gid: string,
  user: User,
  season: Season,
  settings: ServerSettings,
  rules: SeasonRules,
  avatarUrl: string,
): Promise<EmbedBuilder> {
  const [savingsRow, recordRow, seasonStatsRow, globalRecord, eaIds, lastTxns] = await Promise.all([
    db.select({ balance: userSavingsTable.balance })
      .from(userSavingsTable).where(eq(userSavingsTable.discordId, uid)).limit(1).then(r => r[0]),
    db.select().from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, uid), eq(userRecordsTable.seasonId, season.id)))
      .limit(1).then(r => r[0]),
    getSeasonStats(uid, season.id),
    db.select({ wins: globalUserRecordsTable.wins, losses: globalUserRecordsTable.losses })
      .from(globalUserRecordsTable).where(eq(globalUserRecordsTable.discordId, uid)).limit(1).then(r => r[0]),
    db.select({ eaId: playerEaIdsTable.eaId, console: playerEaIdsTable.console, slot: playerEaIdsTable.slot })
      .from(playerEaIdsTable).where(eq(playerEaIdsTable.discordId, uid)).orderBy(playerEaIdsTable.slot),
    db.select({ amount: coinTransactionsTable.amount, description: coinTransactionsTable.description, createdAt: coinTransactionsTable.createdAt })
      .from(coinTransactionsTable)
      .where(and(eq(coinTransactionsTable.discordId, uid), eq(coinTransactionsTable.guildId, gid)))
      .orderBy(desc(coinTransactionsTable.createdAt)).limit(10),
  ]);

  // Legends scoped to this guild via seasonId → seasonsTable.guildId join
  const legendRows = await db.select({
    legendName:     inventoryTable.legendName,
    legendCategory: inventoryTable.legendCategory,
  })
    .from(inventoryTable)
    .innerJoin(seasonsTable, eq(inventoryTable.seasonId, seasonsTable.id))
    .where(and(
      eq(inventoryTable.itemType, "legend"),
      eq(seasonsTable.guildId, gid),
      eq(inventoryTable.discordId, uid),
    ));

  const customPlayerRows = await db.select({
    firstName: customPlayersTable.firstName, lastName: customPlayersTable.lastName,
    position:  customPlayersTable.position,  packageTier: customPlayersTable.packageTier,
  }).from(customPlayersTable)
    .where(and(eq(customPlayersTable.discordId, uid), ne(customPlayersTable.status, "refunded")));

  const savings = savingsRow?.balance ?? 0;
  const total   = user.balance + savings;
  const ssW     = recordRow?.wins          ?? 0;
  const ssL     = recordRow?.losses        ?? 0;
  const atW     = globalRecord?.wins       ?? 0;
  const atL     = globalRecord?.losses     ?? 0;
  const sbW     = recordRow?.superbowlWins ?? 0;

  embed
    .setThumbnail(avatarUrl)
    .addFields(
      { name: "💰 Balance",       value: `Wallet: **${user.balance.toLocaleString()}**\nSavings: **${savings.toLocaleString()}**\nTotal: **${total.toLocaleString()}**`, inline: true },
      { name: "📊 Season Record", value: `${ssW}W-${ssL}L`, inline: true },
      { name: "🏆 All-Time",      value: `${atW}W-${atL}L | ${sbW} SB${sbW !== 1 ? "s" : ""}`, inline: true },
    );

  if (eaIds.length) {
    embed.addFields({ name: "🎮 EA IDs", value: eaIds.map(e => `${e.console.toUpperCase()}: **${e.eaId}**`).join("\n"), inline: false });
  }

  if (seasonStatsRow) {
    const { coreAttrPurchased, nonCoreAttrPurchased, devUpsPurchased, ageResetsPurchased } = seasonStatsRow;
    const ecoOn   = settings.coinEconomy;
    const attrOn  = ecoOn && settings.attributeUpgradesEnabled;
    const devOn   = ecoOn && settings.devUpgradesEnabled;
    const ageOn   = ecoOn && settings.ageResetsEnabled;

    const coreFmt    = attrOn ? `${coreAttrPurchased ?? 0} (${rules.coreAttrCap})`    : `${coreAttrPurchased ?? 0} (n/a)`;
    const nonCoreFmt = attrOn ? `${nonCoreAttrPurchased ?? 0} (${rules.nonCoreAttrCap})` : `${nonCoreAttrPurchased ?? 0} (n/a)`;
    const devFmt     = devOn  ? `${devUpsPurchased ?? 0} (${rules.devUpsCap})`         : `${devUpsPurchased ?? 0} (n/a)`;
    const ageFmt     = ageOn  ? `${ageResetsPurchased ?? 0} (${rules.ageResetsCap})`   : `${ageResetsPurchased ?? 0} (n/a)`;

    embed.addFields({
      name:   "🛒 This Season's Purchases",
      value:  `Core: ${coreFmt} | Non-Core: ${nonCoreFmt} | Dev Ups: ${devFmt} | Age Resets: ${ageFmt}`,
      inline: false,
    });
  }

  const vaultLegends   = legendRows.filter(l => l.legendCategory === "permanent");
  const currentLegends = legendRows.filter(l => l.legendCategory !== "permanent");
  if (legendRows.length) {
    const parts: string[] = [];
    if (currentLegends.length) parts.push(`Season: ${currentLegends.map(l => l.legendName).join(", ")}`);
    if (vaultLegends.length)   parts.push(`Vault: ${vaultLegends.map(l => l.legendName).join(", ")}`);
    embed.addFields({ name: "🏅 Legends", value: parts.join("\n"), inline: false });
  }

  if (customPlayerRows.length) {
    embed.addFields({
      name:   "⚡ Custom Players",
      value:  customPlayerRows.map(p => `${p.firstName} ${p.lastName} (${p.position}) — ${p.packageTier}`).join("\n"),
      inline: false,
    });
  }

  if (lastTxns.length) {
    const txLines = lastTxns.map(t => {
      const sign = t.amount >= 0 ? "+" : "";
      const ts   = `<t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:d>`;
      return `${ts} **${sign}${t.amount.toLocaleString()}** — ${t.description}`;
    });
    embed.addFields({ name: "📋 Last 10 Transactions", value: txLines.join("\n"), inline: false });
  }

  embed.setTimestamp();
  return embed;
}
