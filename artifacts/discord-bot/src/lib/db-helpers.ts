import { db } from "@workspace/db";
import {
  usersTable, seasonsTable, seasonStatsTable, purchasesTable,
  inventoryTable, legendsTable, coinTransactionsTable, rulesTable, rulesSectionsTable,
  userRecordsTable, gameLogTable, customPlayersTable, franchiseRostersTable,
  globalUserRecordsTable, guildChannelsTable,
  type User, type Season, type SeasonStats,
} from "@workspace/db";
import { eq, and, sql, desc, ne } from "drizzle-orm";

// ── Primary guild ID for the original server (legacy / default) ──────────────
export const PRIMARY_GUILD_ID = "1476251181524189438";

// ── Channel keys used across the bot ─────────────────────────────────────────
export const CHANNEL_KEYS = {
  GENERAL:        "general",
  COMMISSIONER:   "commissioner",
  MATCHUPS:       "matchups",
  SCHEDULE:       "schedule",
  GOTW:           "gotw",
  LEAGUE_TWITTER: "league_twitter",
  HEADLINES:      "headlines",
  DRAFT_TRACKER:  "draft_tracker",
  PAYOUTS:        "payouts",
  VIOLATION_LOG:  "violation_log",
  GOTY:           "goty",
  TRANSACTIONS:   "transactions",
} as const;

// Hardcoded fallback IDs for the primary guild (backward compatibility).
// New guilds will always have their IDs stored by /initialize-server instead.
const PRIMARY_CHANNEL_FALLBACKS: Record<string, string> = {
  general:        "1476321282868908052",
  commissioner:   process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "",
  matchups:       "1478777175128932463",
  schedule:       "1478947361014288445",
  gotw:           "1485290029294289037",
  league_twitter: "1492213174697726033",
  headlines:      "1477717664804896899",
  draft_tracker:  "1485399096075358299",
  payouts:        "1486034589808853114",
  violation_log:  "1491529826060734524",
  goty:           "1485394206863392848",
  transactions:   "1493360346382209224",
};

/**
 * Look up a per-guild channel ID by key.
 * Checks the guild_channels table first; falls back to PRIMARY_CHANNEL_FALLBACKS
 * for any guild that hasn't been initialized yet (e.g. the original server).
 */
export async function getGuildChannel(guildId: string, key: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ channelId: guildChannelsTable.channelId })
      .from(guildChannelsTable)
      .where(and(eq(guildChannelsTable.guildId, guildId), eq(guildChannelsTable.channelKey, key)))
      .limit(1);
    if (row) return row.channelId;
  } catch {
    // DB unavailable — fall through to hardcoded fallback
  }
  return PRIMARY_CHANNEL_FALLBACKS[key] ?? null;
}

/**
 * Upsert a per-guild channel ID (called by /initialize-server after creating channels).
 */
export async function setGuildChannel(guildId: string, key: string, channelId: string): Promise<void> {
  await db.insert(guildChannelsTable)
    .values({ guildId, channelKey: key, channelId })
    .onConflictDoUpdate({
      target: [guildChannelsTable.guildId, guildChannelsTable.channelKey],
      set: { channelId, updatedAt: new Date() },
    });
}

// ── Default rules (seeds the DB if a section has never been set) ───────────────
export const SECTION_META: Record<string, { title: string; color: number }> = {
  league_info:   { title: "📋 League Info",          color: 0xffd700 },
  sportsmanship: { title: "🤝 Sportsmanship",        color: 0x57f287 },
  activity:      { title: "📅 Activity",              color: 0x5865f2 },
  settings:      { title: "⚙️ Settings",              color: 0xfee75c },
  "4th_down":    { title: "4️⃣ 4th Down Rules",       color: 0xeb6f31 },
  trade_policy:  { title: "🔄 Trade Policy",          color: 0xa855f7 },
  off_season:    { title: "🏖️ Off-Season Rules",      color: 0xff73fa },
};

export const DEFAULT_RULES: Record<string, string[]> = {
  league_info: [
    "League Name: [Enter your in-game Madden league name here] | Password: [Enter your league password here]",
  ],
  sportsmanship: [
    "Treat all league members with respect at all times.",
    "No trash talk that crosses into personal attacks — keep it competitive, not personal.",
    "Rage quitting or intentionally disconnecting to avoid a loss is not tolerated.",
    "Do not exploit glitches, cheese plays, or any mechanics considered unsportsmanlike by the league.",
    "Disputes must be brought to a commissioner — do not handle conflicts in public channels.",
    "Any member found to be acting in bad faith may be removed from the league.",
  ],
  activity: [
    "All games must be completed by the weekly deadline set by the commissioner.",
    "Members must be reachable and responsive — check in at least every 48 hours during the season.",
    "If you cannot play your game on time, notify your opponent AND a commissioner as early as possible.",
    "Two unexcused missed deadlines in a season may result in replacement.",
    "CPU games are not a substitute for playing your opponent — schedule your games.",
    "If a member goes inactive without notice, their team may be simmed or reassigned.",
  ],
  settings: [
    "The league plays on [difficulty] with [quarter length] minute quarters.",
    "Injuries are set to [on/off]. Fatigue is set to [on/off].",
    "Home team controls stadium and weather settings — no extreme conditions without mutual agreement.",
    "All games are played on the default playbook unless both players agree otherwise.",
    "No pausing the game excessively to slow down momentum or frustrate your opponent.",
    "Any settings disputes should be reported to a commissioner before the game is played.",
  ],
  "4th_down": [
    "Going for it on 4th down is allowed in all situations — no restrictions.",
    "However, repeatedly going for it on 4th down early in the game while blowing out an opponent is considered unsportsmanlike.",
    "Onside kicks are only allowed if you are trailing in the 4th quarter.",
    "Fake punts and fake field goals are always allowed.",
    "Use good judgment — if a commissioner rules a 4th down decision as poor sportsmanship, a warning may be issued.",
  ],
  trade_policy: [
    "All trades must be submitted to the commissioner for review before being accepted in-game.",
    "Trades suspected of being collusion (intentionally unbalanced to benefit one team) will be vetoed.",
    "The trade deadline is set each season by the commissioner — no trades after the deadline.",
    "CPU trades are not allowed without commissioner approval.",
    "A trade vetoed by the commissioner is final — do not attempt to re-submit the same trade.",
    "Both parties must confirm a trade in the league Discord before it is submitted in-game.",
  ],
  off_season: [
    "The draft order is determined by reverse standings (worst record picks first).",
    "Free agency begins after the draft — all signings must follow the salary cap rules.",
    "Salary cap penalties carry over from the previous season if applicable.",
    "Re-signing windows open before free agency — take advantage of these before your players hit the market.",
    "Fantasy draft rules apply if the league resets — all players are eligible regardless of previous team.",
    "Off-season coin purchases (attribute upgrades, dev ups, etc.) reset at the start of each new season.",
  ],
};

export async function getOrSeedRules(section: string, guildId: string): Promise<string[]> {
  const row = await db.select().from(rulesTable)
    .where(and(eq(rulesTable.guildId, guildId), eq(rulesTable.section, section)))
    .limit(1);
  if (row.length > 0) return row[0]!.rules;
  const defaults = DEFAULT_RULES[section] ?? [];
  await db.insert(rulesTable).values({ guildId, section, rules: defaults }).onConflictDoNothing();
  return defaults;
}

export async function setRules(section: string, rules: string[], updatedBy: string, guildId: string): Promise<void> {
  await db.insert(rulesTable)
    .values({ guildId, section, rules, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [rulesTable.guildId, rulesTable.section],
      set: { rules, updatedBy, updatedAt: new Date() },
    });
}

/** Returns all sections — built-in hardcoded ones merged with any custom ones stored in DB. */
export async function getAllSections(guildId: string): Promise<Record<string, { title: string; color: number }>> {
  const customRows = await db.select().from(rulesSectionsTable)
    .where(eq(rulesSectionsTable.guildId, guildId));
  const merged: Record<string, { title: string; color: number }> = { ...SECTION_META };
  for (const row of customRows) {
    merged[row.key] = { title: row.title, color: row.color };
  }
  return merged;
}

/** Create or update a custom section entry in the DB. */
export async function createSection(key: string, title: string, color = 0x3498db, guildId: string = PRIMARY_GUILD_ID): Promise<void> {
  await db.insert(rulesSectionsTable)
    .values({ guildId, key, title, color })
    .onConflictDoUpdate({ target: [rulesSectionsTable.guildId, rulesSectionsTable.key], set: { title, color } });
}

export async function isAdminUser(discordId: string, guildId: string): Promise<boolean> {
  const user = await db.select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
    .limit(1);
  return user[0]?.isAdmin ?? false;
}

export async function logTransaction(
  discordId: string,
  amount: number,
  type: "purchase" | "purchase_refund" | "addcoins" | "removecoins" | "sendcoins_sent" | "sendcoins_received" | "season_adjustment" | "setbalance" | "savings_deposit" | "savings_withdraw" | "savings_interest",
  description: string,
  guildId: string,
  relatedUserId?: string,
): Promise<void> {
  await db.insert(coinTransactionsTable).values({
    guildId,
    discordId,
    amount,
    type,
    description,
    relatedUserId: relatedUserId ?? null,
  });
}

export async function getOrCreateUser(discordId: string, discordUsername: string, guildId: string): Promise<User> {
  const existing = await db.select().from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
    .limit(1);
  if (existing.length > 0) {
    await db.update(usersTable)
      .set({ discordUsername, updatedAt: new Date() })
      .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)));
    return existing[0]!;
  }
  const [user] = await db.insert(usersTable).values({ discordId, guildId, discordUsername }).returning();
  return user!;
}

export async function getUserByDiscordId(discordId: string, guildId: string): Promise<User | null> {
  const rows = await db.select().from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getActiveSeason(guildId: string): Promise<Season | null> {
  const seasons = await db.select().from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);
  return seasons[0] ?? null;
}

export async function getOrCreateActiveSeason(guildId: string): Promise<Season> {
  const existing = await getActiveSeason(guildId);
  if (existing) return existing;
  const [season] = await db.insert(seasonsTable).values({ guildId, seasonNumber: 1, isActive: true }).returning();
  return season!;
}

/**
 * Returns the season ID to use for roster-dependent queries.
 * Uses the active season if it has roster rows; otherwise falls back to the
 * most recent season that does. This handles the common case where a new
 * season has been created but rosters haven't been re-imported from MCA yet.
 */
export async function getRosterSeasonId(guildId: string): Promise<number> {
  const season = await getOrCreateActiveSeason(guildId);

  // Check if the active season has any roster rows
  const [check] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(franchiseRostersTable)
    .where(eq(franchiseRostersTable.seasonId, season.id))
    .limit(1);
  if ((check?.n ?? 0) > 0) return season.id;

  // Fall back to the most recent season that has roster data — scoped to this guild
  const [fallback] = await db
    .select({ seasonId: franchiseRostersTable.seasonId })
    .from(franchiseRostersTable)
    .innerJoin(seasonsTable, eq(franchiseRostersTable.seasonId, seasonsTable.id))
    .where(eq(seasonsTable.guildId, guildId))
    .orderBy(desc(franchiseRostersTable.seasonId))
    .limit(1);
  return fallback?.seasonId ?? season.id;
}

export async function getSeasonStats(discordId: string, seasonId: number): Promise<SeasonStats> {
  const stats = await db.select().from(seasonStatsTable)
    .where(and(eq(seasonStatsTable.discordId, discordId), eq(seasonStatsTable.seasonId, seasonId)))
    .limit(1);
  if (stats.length > 0) return stats[0]!;
  const [newStats] = await db.insert(seasonStatsTable).values({ discordId, seasonId }).returning();
  return newStats!;
}

export async function getUserBalance(discordId: string, guildId: string): Promise<number> {
  const user = await db.select({ balance: usersTable.balance })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
    .limit(1);
  return user[0]?.balance ?? 0;
}

export async function deductBalance(discordId: string, amount: number, guildId: string): Promise<boolean> {
  const user = await db.select().from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
    .limit(1);
  if (!user[0] || user[0].balance < amount) return false;
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} - ${amount}`, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)));
  return true;
}

export async function addBalance(discordId: string, amount: number, guildId: string): Promise<void> {
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() })
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)));
}

export async function getInventoryCount(discordId: string, seasonId: number) {
  // Legends come from inventoryTable (approved/applied); custom players from customPlayersTable.
  // Pending legend purchases live in purchasesTable until a commissioner approves them — we must
  // count those too so the cap is enforced immediately on submission, not just after approval.
  const [items, cpRows, pendingLegendRows] = await Promise.all([
    db.select().from(inventoryTable)
      .where(and(eq(inventoryTable.discordId, discordId), eq(inventoryTable.seasonId, seasonId))),
    db.select({ id: customPlayersTable.id })
      .from(customPlayersTable)
      .where(and(
        eq(customPlayersTable.discordId, discordId),
        eq(customPlayersTable.seasonId, seasonId),
        ne(customPlayersTable.status, "refunded"),
      )),
    // Only "pending" — "approved" ones are already reflected in inventoryTable
    db.select({ id: purchasesTable.id })
      .from(purchasesTable)
      .where(and(
        eq(purchasesTable.discordId, discordId),
        eq(purchasesTable.seasonId, seasonId),
        eq(purchasesTable.purchaseType, "legend"),
        eq(purchasesTable.status, "pending"),
      )),
  ]);
  // Approved/applied legends from inventory (current season, not yet rolled to permanent vault)
  const appliedLegends = items.filter(i => i.itemType === "legend" && i.legendCategory === "current").length;
  // Plus pending legend purchases that haven't been approved yet
  const legends = appliedLegends + pendingLegendRows.length;
  // Count legacy custom_player inventory items + new-style customPlayersTable entries
  const legacyCustoms = items.filter(i =>
    (i.itemType === "custom_player_gold" || i.itemType === "custom_player_silver" || i.itemType === "custom_player_bronze")
    && i.legendCategory === "current"
  ).length;
  const customs = legacyCustoms + cpRows.length;
  return { legends, customs, total: items.length };
}

/**
 * Return the effective set of "core" attribute names for a given season.
 * If the season has a coreAttributesOverride, that list is used (1–10 attrs).
 * Otherwise the default CORE_ATTRIBUTES constant is returned.
 */
export function getCoreAttributes(season: { coreAttributesOverride?: string | null }): Set<string> {
  if (season.coreAttributesOverride) {
    try {
      const parsed = JSON.parse(season.coreAttributesOverride);
      if (Array.isArray(parsed) && parsed.length >= 1) return new Set(parsed as string[]);
    } catch {
      // fall through to default
    }
  }
  // Inline the defaults to avoid circular async import issues
  return new Set([
    "Speed", "Acceleration", "Change of Direction", "Agility", "Strength",
    "Jumping", "Throwing Power", "Awareness", "Stamina",
  ]);
}

export async function getSeasonRules(season: Season) {
  const { COSTS, LIMITS } = await import("./constants.js");
  return {
    coreAttrCost:    season.coreAttrCostOverride    ?? COSTS.core_attribute,
    coreAttrCap:     season.coreAttrCapOverride     ?? LIMITS.coreAttrPerSeason,
    nonCoreAttrCost: season.nonCoreAttrCostOverride ?? COSTS.non_core_attribute,
    nonCoreAttrCap:  season.nonCoreAttrCapOverride  ?? LIMITS.nonCoreAttrPerSeason,
    devUpsCap:        season.devUpsCapOverride        ?? LIMITS.devUpsPerSeason,
    devUpsCost:       season.devUpsCostOverride       ?? COSTS.dev_up,
    ageResetsCap:     season.ageResetsCapOverride     ?? LIMITS.ageResetsPerSeason,
    ageResetCost:     season.ageResetsCostOverride    ?? COSTS.age_reset,
    legendCost:       season.legendCostOverride       ?? COSTS.legend,
    customGoldCost:   season.customGoldCostOverride   ?? COSTS.custom_player_gold,
    customSilverCost: season.customSilverCostOverride ?? COSTS.custom_player_silver,
    customBronzeCost: season.customBronzeCostOverride ?? COSTS.custom_player_bronze,
  };
}

export async function upsertH2HRecord(
  discordId: string,
  seasonId: number,
  won: boolean,
  pointSpread: number,
): Promise<void> {
  const userInfo = await db.select({ discordUsername: usersTable.discordUsername, team: usersTable.team })
    .from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
  if (!userInfo[0]) return;

  const existing = await db.select({ id: userRecordsTable.id })
    .from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, seasonId)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userRecordsTable).set({
      wins:              won  ? sql`${userRecordsTable.wins}   + 1` : userRecordsTable.wins,
      losses:            !won ? sql`${userRecordsTable.losses} + 1` : userRecordsTable.losses,
      pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointSpread}`,
      updatedAt: new Date(),
    }).where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, seasonId)));
  } else {
    await db.insert(userRecordsTable).values({
      discordId,
      discordUsername: userInfo[0].discordUsername,
      team:            userInfo[0].team ?? null,
      seasonId,
      wins:              won ? 1 : 0,
      losses:            won ? 0 : 1,
      pointDifferential: pointSpread,
    });
  }
}

export async function appendGameLog(
  discordId: string,
  seasonId: number,
  result: "win" | "loss",
  pointSpread: number,
  opponentLabel: string,
  gameType: "regular_season" | "playoff" | "superbowl" = "regular_season",
): Promise<void> {
  await db.insert(gameLogTable).values({ discordId, seasonId, result, pointSpread, opponentLabel, gameType });
}

export async function getLegendPurchaseHistory(discordId: string) {
  const purchases = await db.select().from(purchasesTable)
    .where(and(
      eq(purchasesTable.discordId, discordId),
      eq(purchasesTable.purchaseType, "legend"),
    ));
  const approved = purchases.filter(p => p.status === "approved" || p.status === "pending");
  const refunded = purchases.filter(p => p.status === "refunded");
  return { total: approved.length, refunded: refunded.length, purchases };
}

/**
 * Normalize all positions to consolidated categories:
 *   OL — all offensive linemen (LT, LG, C, RG, RT)
 *   DL — all defensive linemen (LE, RE, DT, NT, DE, E)
 *   LB — all linebackers (LOLB, MLB, ROLB, OLB, ILB)
 *   DB — all defensive backs (CB, FS, SS, S, NCB)
 *
 * Safe to run on every startup — only updates rows that still have old names.
 */
export async function normalizeDefensivePositions(): Promise<void> {
  const OL_SET = ["LT", "LG", "C", "RG", "RT"];
  const DL_SET = ["LE", "RE", "DT", "NT", "DE", "E"];
  const LB_SET = ["LOLB", "MLB", "ROLB", "OLB", "ILB"];
  const DB_SET = ["CB", "FS", "SS", "S", "NCB"];

  const toSql = (vals: string[]) => vals.map(v => `'${v}'`).join(", ");

  for (const [newPos, oldSet] of [["OL", OL_SET], ["DL", DL_SET], ["LB", LB_SET], ["DB", DB_SET]] as const) {
    const inClause = toSql(oldSet);
    await db.execute(sql.raw(`UPDATE legends   SET position        = '${newPos}' WHERE position        IN (${inClause})`));
    await db.execute(sql.raw(`UPDATE inventory SET player_position = '${newPos}' WHERE player_position IN (${inClause})`));
    await db.execute(sql.raw(`UPDATE purchases SET player_position = '${newPos}' WHERE player_position IN (${inClause})`));
  }

  console.log("✅ Positions normalized (OL / DL / LB / DB)");
}

// ── Streak computation ─────────────────────────────────────────────────────────
// Returns the current consecutive W/L streak for a user within a guild.
// h2hOnly=true skips CPU games (detected by [CPU] prefix on opponentLabel).
// Orders by id DESC (not recordedAt) so batch-imported games within the same
// timestamp don't produce non-deterministic results.
export async function computeStreak(discordId: string, h2hOnly: boolean, guildId: string): Promise<{ result: "win" | "loss" | null; count: number }> {
  const rows = await db
    .select({ id: gameLogTable.id, result: gameLogTable.result, opponentLabel: gameLogTable.opponentLabel })
    .from(gameLogTable)
    .where(and(eq(gameLogTable.discordId, discordId), eq(gameLogTable.guildId, guildId)))
    .orderBy(desc(gameLogTable.id));

  const filtered = h2hOnly
    ? rows.filter(r => !r.opponentLabel?.startsWith("[CPU]"))
    : rows;

  if (filtered.length === 0) return { result: null, count: 0 };

  const firstResult = filtered[0]!.result as "win" | "loss";
  let count = 0;
  for (const row of filtered) {
    if (row.result === firstResult) count++;
    else break;
  }
  return { result: firstResult, count };
}

// ── Global cross-server W/L/tie record ────────────────────────────────────────
// Called from franchise-processor whenever any game result fires in any guild.
// Only H2H games count — CPU wins do not update the global record.
export async function upsertGlobalRecord(
  discordId: string,
  result: "win" | "loss" | "tie",
): Promise<void> {
  const incWins   = result === "win"  ? 1 : 0;
  const incLosses = result === "loss" ? 1 : 0;
  const incTies   = result === "tie"  ? 1 : 0;

  await db.insert(globalUserRecordsTable)
    .values({ discordId, wins: incWins, losses: incLosses, ties: incTies, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: globalUserRecordsTable.discordId,
      set: {
        wins:      sql`${globalUserRecordsTable.wins}   + ${incWins}`,
        losses:    sql`${globalUserRecordsTable.losses} + ${incLosses}`,
        ties:      sql`${globalUserRecordsTable.ties}   + ${incTies}`,
        updatedAt: new Date(),
      },
    });
}
