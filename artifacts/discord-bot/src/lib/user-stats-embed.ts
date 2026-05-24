/**
 * Shared helper — fetches user stats and builds three paginated EmbedBuilders.
 * Page 1: Identity (avatar, balance, EA IDs)
 * Page 2: Records (this season, guild all-time, global)
 * Page 3: Purchases & History (season caps, legends, custom players, last 10 txns)
 *
 * Also exports buildProfileNavRow() for the pagination button row.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
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

function fmtDiff(pd: number): string {
  return pd >= 0 ? `+${pd.toLocaleString()}` : `${pd.toLocaleString()}`;
}

/** Three paginated EmbedBuilders for a user's profile. */
export async function buildUserProfilePages(
  uid: string,
  gid: string,
  user: User,
  season: Season,
  settings: ServerSettings,
  rules: SeasonRules,
  avatarUrl: string,
  displayName: string,
): Promise<EmbedBuilder[]> {
  const [savingsRow, recordRow, seasonStatsRow, globalRecord, eaIds, lastTxns] = await Promise.all([
    db.select({ balance: userSavingsTable.balance })
      .from(userSavingsTable).where(eq(userSavingsTable.discordId, uid)).limit(1).then(r => r[0]),
    db.select().from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, uid), eq(userRecordsTable.seasonId, season.id)))
      .limit(1).then(r => r[0]),
    getSeasonStats(uid, season.id),
    db.select({
      wins: globalUserRecordsTable.wins,
      losses: globalUserRecordsTable.losses,
      pointDifferential: globalUserRecordsTable.pointDifferential,
    }).from(globalUserRecordsTable).where(eq(globalUserRecordsTable.discordId, uid)).limit(1).then(r => r[0]),
    db.select({ eaId: playerEaIdsTable.eaId, console: playerEaIdsTable.console, slot: playerEaIdsTable.slot })
      .from(playerEaIdsTable).where(eq(playerEaIdsTable.discordId, uid)).orderBy(playerEaIdsTable.slot),
    db.select({ amount: coinTransactionsTable.amount, description: coinTransactionsTable.description, createdAt: coinTransactionsTable.createdAt })
      .from(coinTransactionsTable)
      .where(and(eq(coinTransactionsTable.discordId, uid), eq(coinTransactionsTable.guildId, gid)))
      .orderBy(desc(coinTransactionsTable.createdAt)).limit(10),
  ]);

  // All season records across all seasons (for global + guild all-time aggregation)
  const allUserSeasonRecords = await db.select({
    seasonId:          userRecordsTable.seasonId,
    wins:              userRecordsTable.wins,
    losses:            userRecordsTable.losses,
    pointDifferential: userRecordsTable.pointDifferential,
    playoffWins:       userRecordsTable.playoffWins,
    playoffLosses:     userRecordsTable.playoffLosses,
    superbowlWins:     userRecordsTable.superbowlWins,
    superbowlLosses:   userRecordsTable.superbowlLosses,
  }).from(userRecordsTable).where(eq(userRecordsTable.discordId, uid));

  const guildSeasonIds = (await db.select({ id: seasonsTable.id }).from(seasonsTable)
    .where(eq(seasonsTable.guildId, gid))).map(s => s.id);
  const guildSeasonIdSet = new Set(guildSeasonIds);

  let globalPW = 0, globalPL = 0, globalSW = 0, globalSL = 0;
  let guildW = 0, guildL = 0, guildPD = 0, guildPW = 0, guildPL = 0, guildSW = 0, guildSL = 0;
  for (const r of allUserSeasonRecords) {
    globalPW += r.playoffWins;
    globalPL += r.playoffLosses;
    globalSW += r.superbowlWins;
    globalSL += r.superbowlLosses;
    if (guildSeasonIdSet.has(r.seasonId)) {
      guildW  += r.wins;
      guildL  += r.losses;
      guildPD += r.pointDifferential;
      guildPW += r.playoffWins;
      guildPL += r.playoffLosses;
      guildSW += r.superbowlWins;
      guildSL += r.superbowlLosses;
    }
  }

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
    .innerJoin(seasonsTable, eq(customPlayersTable.seasonId, seasonsTable.id))
    .where(and(
      eq(customPlayersTable.discordId, uid),
      eq(seasonsTable.guildId, gid),
      ne(customPlayersTable.status, "refunded"),
    ));

  // ── Computed values ──────────────────────────────────────────────────────────
  const savings = savingsRow?.balance ?? 0;
  const total   = user.balance + savings;

  const ssW   = recordRow?.wins              ?? 0;
  const ssL   = recordRow?.losses            ?? 0;
  const ssPD  = recordRow?.pointDifferential ?? 0;
  const ssPOW = recordRow?.playoffWins       ?? 0;
  const ssPOL = recordRow?.playoffLosses     ?? 0;
  const ssSBW = recordRow?.superbowlWins     ?? 0;
  const ssSBL = recordRow?.superbowlLosses   ?? 0;

  const glbW  = globalRecord?.wins              ?? 0;
  const glbL  = globalRecord?.losses            ?? 0;
  const glbPD = globalRecord?.pointDifferential ?? 0;

  // Season record — reg-season only on line 1, PO/SB if applicable
  const ssLines: string[] = [`${ssW}W-${ssL}L  PD: ${fmtDiff(ssPD)}`];
  if (ssPOW + ssPOL > 0) ssLines.push(`PO: ${ssPOW}W-${ssPOL}L`);
  if (ssSBW + ssSBL > 0) ssLines.push(`🏆 SB: ${ssSBW}W-${ssSBL}L`);

  // Guild all-time
  const guildLines: string[] = [`${guildW}W-${guildL}L  PD: ${fmtDiff(guildPD)}`];
  if (guildPW + guildPL > 0) guildLines.push(`PO: ${guildPW}W-${guildPL}L`);
  if (guildSW + guildSL > 0) guildLines.push(`🏆 SB: ${guildSW}W-${guildSL}L`);

  // Global cross-guild (reg-season from globalUserRecordsTable, PO/SB from all userRecords)
  const glbLines: string[] = [`${glbW}W-${glbL}L  PD: ${fmtDiff(glbPD)}`];
  if (globalPW + globalPL > 0) glbLines.push(`PO: ${globalPW}W-${globalPL}L`);
  if (globalSW + globalSL > 0) glbLines.push(`🏆 SB: ${globalSW}W-${globalSL}L`);

  const baseColor = 0x5865F2;
  const teamName  = user.team ?? "No Team";
  const footer    = `Season ${season.seasonNumber} · ${displayName}`;

  // ── Page 1: Identity ────────────────────────────────────────────────────────
  const p1 = new EmbedBuilder()
    .setColor(baseColor)
    .setTitle(`👤 ${displayName}`)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: "🏈 NFL Team",   value: teamName,    inline: true },
      { name: "🛡️ Admin",      value: user.isAdmin ? "Yes" : "No", inline: true },
      { name: "\u200B",         value: "\u200B",    inline: true },
      { name: "💰 Wallet",     value: `**${user.balance.toLocaleString()}** coins`,  inline: true },
      { name: "🏦 Savings",    value: `**${savings.toLocaleString()}** coins`,       inline: true },
      { name: "💎 Total",      value: `**${total.toLocaleString()}** coins`,         inline: true },
    )
    .setFooter({ text: `${footer} · Page 1/3` })
    .setTimestamp();

  if (eaIds.length) {
    p1.addFields({ name: "🎮 EA IDs", value: eaIds.map(e => `${e.console.toUpperCase()}: **${e.eaId}**`).join("\n"), inline: false });
  }

  // ── Page 2: Records ─────────────────────────────────────────────────────────
  const p2 = new EmbedBuilder()
    .setColor(baseColor)
    .setTitle(`📊 ${displayName} — Records`)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: `📅 Season ${season.seasonNumber} Record`, value: ssLines.join("\n"),    inline: false },
      { name: "🏆 Guild All-Time",                       value: guildLines.join("\n"), inline: false },
      { name: "🌐 Global (All Leagues)",                 value: glbLines.join("\n"),   inline: false },
    )
    .setFooter({ text: `${footer} · Page 2/3` })
    .setTimestamp();

  // ── Page 3: Purchases & History ─────────────────────────────────────────────
  const p3 = new EmbedBuilder()
    .setColor(baseColor)
    .setTitle(`🛒 ${displayName} — Purchases & History`)
    .setThumbnail(avatarUrl)
    .setFooter({ text: `${footer} · Page 3/3` })
    .setTimestamp();

  if (seasonStatsRow) {
    const { devUpsPurchased, ageResetsPurchased } = seasonStatsRow;
    const ecoOn  = settings.coinEconomy;
    const devOn  = ecoOn && settings.devUpgradesEnabled;
    const ageOn  = ecoOn && settings.ageResetsEnabled;

    const devFmt = devOn ? `${devUpsPurchased ?? 0}/${rules.devUpsCap}`       : `${devUpsPurchased ?? 0} (n/a)`;
    const ageFmt = ageOn ? `${ageResetsPurchased ?? 0}/${rules.ageResetsCap}` : `${ageResetsPurchased ?? 0} (n/a)`;

    p3.addFields({
      name:   `🛒 Season ${season.seasonNumber} Purchases`,
      value:  `Dev Ups: **${devFmt}** | Age Resets: **${ageFmt}**`,
      inline: false,
    });
  }

  const vaultLegends   = legendRows.filter(l => l.legendCategory === "permanent");
  const currentLegends = legendRows.filter(l => l.legendCategory !== "permanent");
  if (legendRows.length) {
    const parts: string[] = [];
    if (currentLegends.length) parts.push(`Season: ${currentLegends.map(l => l.legendName).join(", ")}`);
    if (vaultLegends.length)   parts.push(`Vault: ${vaultLegends.map(l => l.legendName).join(", ")}`);
    p3.addFields({ name: "🏅 Legends", value: parts.join("\n"), inline: false });
  }

  if (customPlayerRows.length) {
    p3.addFields({
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
    p3.addFields({ name: "📋 Last 10 Transactions", value: txLines.join("\n"), inline: false });
  }

  // If page 3 has no fields yet, add a placeholder
  if (!seasonStatsRow && !legendRows.length && !customPlayerRows.length && !lastTxns.length) {
    p3.setDescription("*No purchase history or transactions found for this server.*");
  }

  return [p1, p2, p3];
}

/** Standalone "purchases & history" embed for the Economy & Social menu page.
 *  Mirrors page 3 of buildUserProfilePages but self-contained. */
export async function buildTransactionsEmbed(
  uid: string,
  gid: string,
  season: Season,
  settings: ServerSettings,
  rules: SeasonRules,
  avatarUrl: string,
  displayName: string,
): Promise<EmbedBuilder> {
  const [seasonStatsRow, legendRows, customPlayerRows, lastTxns] = await Promise.all([
    getSeasonStats(uid, season.id),
    db.select({
      legendName:     inventoryTable.legendName,
      legendCategory: inventoryTable.legendCategory,
    })
      .from(inventoryTable)
      .innerJoin(seasonsTable, eq(inventoryTable.seasonId, seasonsTable.id))
      .where(and(
        eq(inventoryTable.itemType, "legend"),
        eq(seasonsTable.guildId, gid),
        eq(inventoryTable.discordId, uid),
      )),
    db.select({
      firstName: customPlayersTable.firstName, lastName: customPlayersTable.lastName,
      position:  customPlayersTable.position,  packageTier: customPlayersTable.packageTier,
    }).from(customPlayersTable)
      .innerJoin(seasonsTable, eq(customPlayersTable.seasonId, seasonsTable.id))
      .where(and(
        eq(customPlayersTable.discordId, uid),
        eq(seasonsTable.guildId, gid),
        ne(customPlayersTable.status, "refunded"),
      )),
    db.select({ amount: coinTransactionsTable.amount, description: coinTransactionsTable.description, createdAt: coinTransactionsTable.createdAt })
      .from(coinTransactionsTable)
      .where(and(eq(coinTransactionsTable.discordId, uid), eq(coinTransactionsTable.guildId, gid)))
      .orderBy(desc(coinTransactionsTable.createdAt)).limit(10),
  ]);

  const footer = `Season ${season.seasonNumber} · ${displayName}`;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🛒 ${displayName} — Purchases & History`)
    .setThumbnail(avatarUrl)
    .setFooter({ text: footer })
    .setTimestamp();

  if (seasonStatsRow) {
    const { devUpsPurchased, ageResetsPurchased } = seasonStatsRow;
    const ecoOn = settings.coinEconomy;
    const devOn = ecoOn && settings.devUpgradesEnabled;
    const ageOn = ecoOn && settings.ageResetsEnabled;
    const devFmt = devOn ? `${devUpsPurchased ?? 0}/${rules.devUpsCap}`       : `${devUpsPurchased ?? 0} (n/a)`;
    const ageFmt = ageOn ? `${ageResetsPurchased ?? 0}/${rules.ageResetsCap}` : `${ageResetsPurchased ?? 0} (n/a)`;
    embed.addFields({
      name:   `🛒 Season ${season.seasonNumber} Purchases`,
      value:  `Dev Ups: **${devFmt}** | Age Resets: **${ageFmt}**`,
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

  if (!seasonStatsRow && !legendRows.length && !customPlayerRows.length && !lastTxns.length) {
    embed.setDescription("*No purchase history or transactions found for this server.*");
  }

  return embed;
}

/** Navigation button row for the 3-page user profile. */
export function buildProfileNavRow(page: 1 | 2 | 3): ActionRowBuilder<ButtonBuilder> {
  const prevId = page === 3 ? "ac_profile_p2" : "ac_profile_p1";
  const nextId = page === 1 ? "ac_profile_p2" : "ac_profile_p3";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId("ac_profile_page_label")
      .setLabel(`Page ${page}/3`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(nextId)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 3),
  );
}

/** Single-button row to return from profile pages back to the main /menu hub. */
export function buildProfileBackRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ac_hub")
      .setLabel("🔙 Back to Menu")
      .setStyle(ButtonStyle.Primary),
  );
}
