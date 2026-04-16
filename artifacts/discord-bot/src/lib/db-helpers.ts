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
  WELCOME:        "welcome",
  ANNOUNCEMENTS:  "announcements",
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
  league_info:   { title: "📋 League Info",                    color: 0xffd700 },
  sportsmanship: { title: "🤝 User Expectations",              color: 0x57f287 },
  activity:      { title: "📅 Scheduling & Server Activity",   color: 0x5865f2 },
  settings:      { title: "⚙️ Settings",                       color: 0xfee75c },
  "4th_down":    { title: "4️⃣ 4th Down Rules",                color: 0xeb6f31 },
  trade_policy:  { title: "🔄 Trade Policy",                   color: 0xa855f7 },
  off_season:    { title: "🏖️ Off-Season Rules",               color: 0xff73fa },
};

export const DEFAULT_RULES: Record<string, string[]> = {
  league_info: [
    "League Name: [Enter your in-game Madden league name here] | Password: [Enter your league password here]",
  ],
  sportsmanship: [
    "Treat all league members with respect at all times.",
    "No trash talk that crosses into personal attacks — keep it competitive, not personal. Personal attacks may result in removal from the league or any punishment per Commissioner discretion.",
    "Users in a H2H game can concede any time in the 4th Quarter if they're losing and their opponent agrees to the concede. Rage quitting or intentionally disconnecting to avoid a loss is not tolerated and consequences for violating this rule are per Commissioner discretion.",
    "Do not exploit glitches, cheese plays, or any mechanics considered unsportsmanlike by the league. Obvious Cheese/Spam will not be tolerated and is considered as follows: No hovering over the Center on defense to cause blocking glitches; No nano-blitzing; No loop blitzing; No stacking players in the box; Using a Mug formation is acceptable as long as you aren't shifting the backers around to exploit blocking; If a safety is blitzing or your formation alignment calls for it, you may have all defenders near the line of scrimmage.",
    "Disputes must be brought to a commissioner — do not handle conflicts in public channels.",
    "Any member found to be acting in bad faith may be removed from the league.",
    "Stat Padding against the CPU (point spread of 35+; 6+ TDs for any player; Any excessively record-breaking performance) will be flagged by the bot and could result in consequences, per commissioner discretion.",
    "Stat Padding against a H2H opponent would be a spread of 35+ against NON-Divisional opponents and a point spread of 42+ against Divisional opponents. Player stats are not relevant for stat padding in a H2H as long as the final spread is within the boundaries. Violations could result in consequences, per commissioner discretion.",
    "All Stat-Padding occurrences are judged on a case-by-case basis.",
    "Users are REQUIRED to rush a minimum of 3 players on EVERY defensive down.",
  ],
  activity: [
    "All games must be completed by the weekly deadline set by the commissioner.",
    "Users must be reachable and responsive — check in at least every 12-24 hours during the season. When scheduling your weekly game, if one user reaches out to schedule and receives no reply from their opponent before 6 PM CST of that same day, then the result is a Force Win for the user who attempted to schedule. We all have lives outside of this server, so expecting an opponent to respond to a last minute game request when they reached out hours earlier is not acceptable.",
    "Users who fail to notify a Commissioner of an intended absence from the league may be kicked due to inactivity. A commissioner may try to reach out to Users who have been unresponsive and if a deadline is set for communication, a Commissioner is within their right to kick a user who fails to check in by the set deadline.",
    "Users who need an extended leave can request to be put on Auto-Pilot. Failure to return by their set date, without reaching out to a Commissioner if something changes, may result in removal from the league for inactivity.",
    "Active Checks may occur from time to time and users should be prepared for removal if they fail to check in.",
    "If both users in a H2H fail to attempt scheduling or agree on a time for their game before advance, the result will be a Fair Sim.",
    "If you cannot play your game on time, notify your opponent AND a commissioner as early as possible. If both parties agreed to a time previously and one party misses the time or changes their mind without their opponent agreeing to a new one, the result will be a Force Win for the other party. If a time is agreed on and both parties fail to make the time, the result will be a Fair Sim.",
    "If you've set a time with your opponent and they show up on time and message you to play, there is a 1 hour window from that timestamp for you to respond and attempt to reschedule if needed. If you fail to respond, they receive the Force Win. If you respond and try to reschedule but they cannot, then they will still receive the FW for showing up during the original timeframe both parties agreed upon.",
    "No vague 'some time later tonight' scheduling attempts will be accepted. If you try to schedule your game this way, your opponent is within their right to request a FW if you don't settle on an exact time to play.",
    "One User streaming in a H2H will provide a payout bonus to each user involved in the game. Posting up to 2 highlights after the game will provide a payout bonus per highlight to the provider.",
    "It is recommended that Users either Livestream their games to ensure fair play or save replays of violations to ensure visual proof is available for confirmation by the Commissioner. He said/She said won't be accepted as proof of violation. It is also recommended for users to save the VOD if twitch streaming.",
    "Streaming is required by at least one user in a GOTW H2H. Failure to do so will forfeit the GOTW bonus as well as any future chance at hosting a GOTW for that season.",
    "Streaming is only required in the playoffs or GOTW — the home team is required to stream unless the away team agrees to stream instead. In a regular season game, if neither user streams you simply don't receive the streaming bonus; if one user streams, both players receive the bonus.",
    "In the post season, highlights can be posted for any game by any team and will still receive the max payout of 20 per highlight, up to 2 per week. Teams that do not make the playoffs may still benefit from this bonus.",
  ],
  settings: [
    "Skill Level = ALL MADDEN; Game Style = Simulation; Kick Meter = Classic; Quarter Length = 8 Minutes; Accelerated Clock = On; Min Play Clock Time = 20 Seconds; Offensive Play Cooldown/Limit = 8-Play Cooldown; Defensive Play Call Cooldown/Limit = Off",
    "Season Experience = Full Control - All Manual; Auto Progress Players = Off; Ability Weekly Recap = Off; Tutorial Pop-Ups = Off",
    "Team Setting Overrides: Ball Hawk = OFF; Heat Seeker = OFF; Switch Assist = Keep Individual; Controlled Player Art = Keep Individual",
    "Commissioner Settings: Trade Deadline = OFF; Trade Type = Very Hard; Salary Cap = On; Free Agent Motivation = Very High; Practice Squad Stealing = On; Relocation Setting = DISABLED; Practice Injury = OFF; Injury = On; Pre Existing Injury = OFF; Prospect Storylines = On; Draft Presentation = Limited; Draft Timer = ON; Free Agent Negotiations Stage 1 = 3; Stage 2 = 5; Stage 3 = Unlimited; Pre Order Bonus = Off",
    "League Type Settings: Coach Firing = OFF; Career Clock = ON",
    "Dev Trait Management: Break Out Scenarios = On; Development Trait Regression = On; Desired X-Factor Dev Players = 60; Desired Super Star Dev Players = 85; Desired Star Dev Players = 430; Super Star Abilities = On; Ability Edit Controls = Everyone; Player Trait Edit Controls = Commissioner",
    "Roster Settings: Minimum Roster Size = 46; In-Season Player Movement Limit = Unlimited; Player OVR Cut Restriction = 90 Overall; Offseason Player Cut Limit = Unlimited; Fill Roster = Off",
    "Wear & Tear Sliders: Tackle Impact Scale = 60; Catch Tackle Impact Scale = 70; Hitstick Tackle Impact Scale = 70; Cutstick Tackle Impact = 70; Defender Tackle Advantage Scale = 65; Sack Impact Scale = 64; Block Impact Scale = 50; Impact Block Impact Scale = 65; Per-Play Recovery = 25; Per-Timeout Recovery = 20; Per-Quarter Recovery = 25; Halftime Recovery = 50; Healing Reserve Pool Scale = 40; Week to Week Recovery = 25",
    "Gameplay Sliders — User: QB Accuracy = 40; Pass Blocking = 48; WR Catching = 46; Run Blocking = 30; Ball Security = 55; Reaction Time = 60; Interceptions = 45; Pass Coverage = 60; Tackling = 70 | CPU: QB Accuracy = 42; Pass Blocking = 60; WR Catching = 48; Run Blocking = 60; Ball Security = 50; Reaction Time = 60; Interceptions = 50; Pass Coverage = 60; Tackling = 75 | Special Teams: FG Power = 44; FG Accuracy = 38; Punt Power = 44; Punt Accuracy = 38; Kickoff Power = 60",
    "Game Options: Injuries = 23 (Or OFF); Physics Based Tackling Results = 42 (Main Menu Only); Fatigue = 80; Min Player Speed Threshold/Parity Scale = 85",
    "Precipitation Sliders: Catch Chance = 35; Pass Accuracy = 35; Pass Strength Scale = 35; Broken Tackle = 40; Kicking Accuracy = 50; Kicking Strength = 55; Slip Scale = 40; Movement Penalties = 35",
    "Penalties: Offsides = 70; False Start = 70; Holding = 51; Face Mask = 85; Defensive Pass Interference = 52; Offensive Pass Interference = On; Kick Catch Interference = On; Illegal Block in the Back = 51; Intentional Grounding = On; Roughing The Kicker = On; Illegal Contact = On",
    "XP Sliders: QB = 70; HB = 56; TE = 92; WR = 74; FB = 96; T = 102; G = 102; C = 104; Edge = 104; DT = 80; MLB = 112; OLB = 124; CB = 86; FS = 112; SS = 108; K = 86; P = 98",
    "Age Progression XP Rate Sliders: 20 = 80; 21 = 90; 22 = 100; 23 = 110; 24 = 120; 25 = 130; 26 = 130; 27 = 100; 28 = 100; 29 = 90; 30 = 80; 31 = 70; 32 = 60; 33 = 60; 34 = 50; 35+ = 100",
    "Offense Regression Rate Sliders: QB = 90; HB = 150; TE = 110; WR = 140; FB = 110; T = 130; G = 130; C = 120",
    "Defense Regression Rate Sliders: Edge = 120; DT = 130; MLB = 90; OLB = 100; CB = 120; FS = 90; SS = 100",
    "Special Team Regression Rate Sliders: K = 120; P = 120",
    "Age Regression Sliders: 26 = 90; 27 = 100; 28 = 100; 29 = 110; 30 = 120; 31 = 120; 32 = 130; 33 = 140; 34 = 120; 35+ = 90",
    "Draft Class Strength: All set to Weak. (If you want a higher overall league leave at Normal. You will get more 90-99 players. Keep in mind that TMP and MOR stat increases may create more 99 OVR by the end of the season.)",
    "Custom Coaches are a REQUIREMENT for User Teams — not an option. Failure to follow this rule will result in removal from the league.",
    "Any playbook that is default to the game may be used. Custom playbooks are not allowed.",
    "The League's advance policy is per Commissioner discretion and subject to change.",
    "Users can skip their CPU games and will receive a force win by default. This does not need to be requested in-server unless otherwise stated by a Commissioner.",
    "Users are limited to one attempt at each weekly game, unless the Commissioner is notified of extraordinary circumstances that would require more than one attempt. Any User caught violating this rule will be subject to disciplinary consequences.",
    "Player position swapping is only allowed if the position swap is logical. Requesting a position swap for a small, speedy WR to be moved to TE won't be approved. Position swap requests should be reasonable (e.g. strong HB to FB, over-sized WR to TE, any DB to any DB position, DL and OL shifts). Users can sub players in during games however they see fit.",
    "No coaching abilities are banned.",
  ],
  "4th_down": [
    "In H2H games, Users can only go for it when at midfield and beyond and 4th and 4 or less. The only exception to this rule is if a User is losing in the second half — they may go for it whenever in those circumstances.",
    "Repeatedly going for it on 4th down early in the game while blowing out an opponent is considered unsportsmanlike. This does not incur a penalty but it is frowned upon.",
    "Onside kicks are only allowed if you are losing in the second half or the game has gone to OT.",
    "Fake punts and fake field goals are always allowed.",
  ],
  trade_policy: [
    "Both Users must submit a trade through the /tradeblock command in-server, if activated, prior to submitting and accepting it in-game.",
    "CPU trades are per Commissioner discretion.",
    "Users can use their in-house currency, if it is an active feature, as an added trade mechanism when trading with other users.",
  ],
  off_season: [
    "If Economy is activated, purchase caps (attribute upgrades, dev ups, age resets, custom players) reset at the start of each new season.",
    "If Legends or Custom Players are active, all Draft purchases MUST be submitted by the end of the Wildcard playoff round. Failure to submit them before the deadline will void your purchases.",
    "Users are limited to drafting 1 Legend per draft and 1 Custom Player.",
    "Users are limited to 3 bids in the first two rounds of Free Agency and an unlimited amount in the final round. There will be no offer evaluations between round advances.",
    "Users are required to handle re-signing their players on their own time. There will be no extra efforts put in by Commissioners to re-obtain a player for you that you forgot to sign prior to the off-season.",
    "The speed at which the off-season is handled is per Commissioner discretion.",
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
