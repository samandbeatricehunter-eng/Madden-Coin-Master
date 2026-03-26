import { pgTable, text, integer, boolean, timestamp, serial, pgEnum, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const purchaseTypeEnum = pgEnum("purchase_type", [
  "legend",
  "attribute",
  "dev_up",
  "age_reset",
  "custom_player_gold",
  "custom_player_silver",
  "custom_player_bronze",
]);

export const purchaseStatusEnum = pgEnum("purchase_status", [
  "pending",
  "approved",
  "refunded",
]);

export const customPlayerTierEnum = pgEnum("custom_player_tier", [
  "gold",
  "silver",
  "bronze",
]);

export const usersTable = pgTable("economy_users", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull().unique(),
  discordUsername: text("discord_username").notNull(),
  team: text("team").unique(),
  balance: integer("balance").notNull().default(0),
  totalLegendPurchases: integer("total_legend_purchases").notNull().default(0),
  // All-time tracking for milestone payouts
  allTimeSuperbowlWins: integer("all_time_superbowl_wins").notNull().default(0),
  allTimeH2HWins: integer("all_time_h2h_wins").notNull().default(0),
  allTimeH2HLosses: integer("all_time_h2h_losses").notNull().default(0),
  // Which win milestone has been awarded: 0=none, 1=5W, 2=12W, 3=25W, 4=50W
  milestoneTierAwarded: integer("milestone_tier_awarded").notNull().default(0),
  // Playoff seeding for current season (set by admin when advancing to wildcard)
  playoffSeed: integer("playoff_seed"),         // 1–7 within their conference; null = not in playoffs
  playoffConference: text("playoff_conference"), // "NFC" | "AFC" | null
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const seasonsTable = pgTable("seasons", {
  id: serial("id").primaryKey(),
  seasonNumber: integer("season_number").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  // Per-season overrides — null means use the default from constants.ts
  coreAttrCostOverride: integer("core_attr_cost_override"),
  coreAttrCapOverride: integer("core_attr_cap_override"),
  nonCoreAttrCostOverride: integer("non_core_attr_cost_override"),
  nonCoreAttrCapOverride: integer("non_core_attr_cap_override"),
  devUpsCapOverride: integer("dev_ups_cap_override"),
  devUpsCostOverride: integer("dev_ups_cost_override"),
  ageResetsCapOverride: integer("age_resets_cap_override"),
  ageResetsCostOverride: integer("age_resets_cost_override"),
  currentWeek: text("current_week").notNull().default("1"),
});

export const legendsTable = pgTable("legends", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  position: text("position").notNull(),
  description: text("description"),
  cost: integer("cost").notNull().default(1000),
  isAvailable: boolean("is_available").notNull().default(true),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const purchasesTable = pgTable("purchases", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  seasonId: integer("season_id").notNull(),
  purchaseType: purchaseTypeEnum("purchase_type").notNull(),
  status: purchaseStatusEnum("status").notNull().default("pending"),
  cost: integer("cost").notNull(),
  legendId: integer("legend_id"),
  playerName: text("player_name"),
  playerPosition: text("player_position"),
  attributeName: text("attribute_name"),
  customPlayerTier: customPlayerTierEnum("custom_player_tier"),
  discordMessageId: text("discord_message_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
  draftTrackerMessageId: text("draft_tracker_message_id"),
});

export const inventoryTable = pgTable("inventory", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  seasonId: integer("season_id").notNull(),
  purchaseId: integer("purchase_id").notNull(),
  itemType: purchaseTypeEnum("item_type").notNull(),
  legendId: integer("legend_id"),
  legendName: text("legend_name"),
  playerName: text("player_name"),
  playerPosition: text("player_position"),
  attributeName: text("attribute_name"),
  customPlayerTier: customPlayerTierEnum("custom_player_tier"),
  notes: text("notes"),
  // "current" = bought this season, not yet rolled over
  // "permanent" = carried over from a past season, counts toward the 4-legend vault cap
  legendCategory: text("legend_category").notNull().default("current"),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const seasonStatsTable = pgTable("season_stats", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  seasonId: integer("season_id").notNull(),
  coreAttrPurchased: integer("core_attr_purchased").notNull().default(0),
  nonCoreAttrPurchased: integer("non_core_attr_purchased").notNull().default(0),
  devUpsPurchased: integer("dev_ups_purchased").notNull().default(0),
  ageResetsPurchased: integer("age_resets_purchased").notNull().default(0),
  legendsPurchasedThisSeason: integer("legends_purchased_this_season").notNull().default(0),
});

export const gameTypeEnum = pgEnum("game_type", ["regular_season", "playoff", "superbowl"]);

export const userRecordsTable = pgTable("user_records", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  discordUsername: text("discord_username").notNull(),
  team: text("team"),
  seasonId: integer("season_id").notNull(),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  pointDifferential: integer("point_differential").notNull().default(0),
  // Separate playoff / superbowl tracking (still counted in wins/losses above)
  playoffWins: integer("playoff_wins").notNull().default(0),
  playoffLosses: integer("playoff_losses").notNull().default(0),
  superbowlWins: integer("superbowl_wins").notNull().default(0),
  superbowlLosses: integer("superbowl_losses").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Individual game log for /recentH2H
export const gameLogTable = pgTable("game_log", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  seasonId: integer("season_id").notNull(),
  result: text("result").notNull(), // "win" | "loss"
  pointSpread: integer("point_spread").notNull(),
  opponentLabel: text("opponent_label"), // team name or free text
  gameType: gameTypeEnum("game_type").notNull().default("regular_season"),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
});

export const rulesTable = pgTable("rules", {
  section: text("section").primaryKey(),
  rules: json("rules").notNull().$type<string[]>(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

export const payoutRequestsTable = pgTable("payout_requests", {
  id: serial("id").primaryKey(),
  requesterId: text("requester_id").notNull(),
  requesterTeam: text("requester_team"),
  opponentId: text("opponent_id"),
  opponentTeam: text("opponent_team"),
  requesterScore: integer("requester_score"),
  opponentScore: integer("opponent_score"),
  gameType: text("game_type").notNull(), // "h2h" | "cpu"
  week: text("week"), // "1"-"18" | "wildcard" | "divisional" | "conference" | "superbowl" | "offseason"
  status: text("status").notNull().default("pending"), // "pending" | "approved" | "denied" | "tied"
  interviewClaimed: boolean("interview_claimed").notNull().default(false),
  denialReason: text("denial_reason"),
  discordMessageId: text("discord_message_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: text("resolved_by"),
});

export const interviewRequestsTable = pgTable("interview_requests", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  payoutRequestId: integer("payout_request_id").notNull(),
  week: text("week"), // mirrors the linked payout request's week
  status: text("status").notNull().default("pending"), // "pending" | "approved" | "denied"
  question1: text("question_1"),
  question2: text("question_2"),
  question3: text("question_3"),
  answer1: text("answer_1"),
  answer2: text("answer_2"),
  answer3: text("answer_3"),
  denialReason: text("denial_reason"),
  discordMessageId: text("discord_message_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: text("resolved_by"),
});

export const txTypeEnum = pgEnum("tx_type", [
  "purchase",
  "purchase_refund",
  "addcoins",
  "removecoins",
  "sendcoins_sent",
  "sendcoins_received",
  "season_adjustment",
  "setbalance",
]);

export const coinTransactionsTable = pgTable("coin_transactions", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  amount: integer("amount").notNull(),
  type: txTypeEnum("type").notNull(),
  description: text("description").notNull(),
  relatedUserId: text("related_user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const wagersTable = pgTable("wagers", {
  id: serial("id").primaryKey(),
  challengerId: text("challenger_id").notNull(),
  challengerUsername: text("challenger_username").notNull(),
  opponentId: text("opponent_id").notNull(),
  opponentUsername: text("opponent_username").notNull(),
  amount: integer("amount").notNull(),
  pot: integer("pot").notNull(),
  teamFor: text("team_for").notNull(),
  teamAgainst: text("team_against").notNull(),
  // pending | active | completed | refused | cancelled
  status: text("status").notNull().default("pending"),
  winnerId: text("winner_id"),
  commissionerMessageId: text("commissioner_message_id"),
  challengeMessageId: text("challenge_message_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: text("resolved_by"),
});

export const insertUserRecordSchema = createInsertSchema(userRecordsTable).omit({ id: true });
export type UserRecord = typeof userRecordsTable.$inferSelect;
export type InsertUserRecord = z.infer<typeof insertUserRecordSchema>;

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertLegendSchema = createInsertSchema(legendsTable).omit({ id: true, addedAt: true });
export const insertPurchaseSchema = createInsertSchema(purchasesTable).omit({ id: true, createdAt: true });
export const insertInventorySchema = createInsertSchema(inventoryTable).omit({ id: true, addedAt: true });
export const insertSeasonStatsSchema = createInsertSchema(seasonStatsTable).omit({ id: true });
export const insertSeasonSchema = createInsertSchema(seasonsTable).omit({ id: true, startedAt: true });

export type User = typeof usersTable.$inferSelect;
export type Legend = typeof legendsTable.$inferSelect;
export type Purchase = typeof purchasesTable.$inferSelect;
export type Inventory = typeof inventoryTable.$inferSelect;
export type SeasonStats = typeof seasonStatsTable.$inferSelect;
export type Season = typeof seasonsTable.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertLegend = z.infer<typeof insertLegendSchema>;
export type InsertPurchase = z.infer<typeof insertPurchaseSchema>;
export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type InsertSeasonStats = z.infer<typeof insertSeasonStatsSchema>;
