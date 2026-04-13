import { pgTable, text, integer, boolean, timestamp, serial, pgEnum, json, uniqueIndex, real } from "drizzle-orm/pg-core";
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
  allTimeSuperbowlWins:   integer("all_time_superbowl_wins").notNull().default(0),
  allTimeSuperbowlLosses: integer("all_time_superbowl_losses").notNull().default(0),
  allTimeH2HWins: integer("all_time_h2h_wins").notNull().default(0),
  allTimeH2HLosses: integer("all_time_h2h_losses").notNull().default(0),
  // Which win milestone has been awarded: 0=none, 1=5W, 2=12W, 3=25W, 4=50W
  milestoneTierAwarded: integer("milestone_tier_awarded").notNull().default(0),
  // Playoff seeding for current season (set by admin when advancing to wildcard)
  playoffSeed: integer("playoff_seed"),         // 1–7 within their conference; null = not in playoffs
  playoffConference: text("playoff_conference"), // "NFC" | "AFC" | null
  isAdmin: boolean("is_admin").notNull().default(false),
  botEscalationLevel: integer("bot_escalation_level").notNull().default(0), // persistent rudeness memory
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
  legendCostOverride: integer("legend_cost_override"),
  customGoldCostOverride: integer("custom_gold_cost_override"),
  customSilverCostOverride: integer("custom_silver_cost_override"),
  customBronzeCostOverride: integer("custom_bronze_cost_override"),
  currentWeek: text("current_week").notNull().default("1"),
  // JSON array of attribute names that count as "core" this season — null = use default from constants
  coreAttributesOverride: text("core_attributes_override"),
  // When true: MCA exports accumulate stats only — no payouts, no Discord notifications
  catchupMode: boolean("catchup_mode").notNull().default(false),
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
  // Franchise team name (e.g. "Cowboys") — set when item is promoted to permanent so
  // items follow the TEAM across ownership changes, not the individual Discord user.
  team: text("team"),
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
  ties: integer("ties").notNull().default(0),
  pointDifferential: integer("point_differential").notNull().default(0),
  // Separate playoff / superbowl tracking (still counted in wins/losses above)
  playoffWins: integer("playoff_wins").notNull().default(0),
  playoffLosses: integer("playoff_losses").notNull().default(0),
  superbowlWins: integer("superbowl_wins").notNull().default(0),
  superbowlLosses: integer("superbowl_losses").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniqPlayerSeason: uniqueIndex("user_records_discord_season_idx").on(t.discordId, t.seasonId),
}));

// Individual game log for /recentH2H
export const gameLogTable = pgTable("game_log", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  seasonId: integer("season_id").notNull(),
  result: text("result").notNull(), // "win" | "loss"
  pointSpread: integer("point_spread").notNull(),
  opponentLabel: text("opponent_label"),    // team name or free text
  opponentDiscordId: text("opponent_discord_id"), // null for CPU games; used by rollback to reverse matchup records
  gameType: gameTypeEnum("game_type").notNull().default("regular_season"),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
});

// ── All-time per-opponent H2H records ──────────────────────────────────────────
// Pair stored in canonical order: discordId1 < discordId2 (lexicographic).
// wins1 = wins for discordId1; wins2 = wins for discordId2.
export const h2hMatchupRecordsTable = pgTable("h2h_matchup_records", {
  id:         serial("id").primaryKey(),
  discordId1: text("discord_id_1").notNull(),
  discordId2: text("discord_id_2").notNull(),
  wins1:      integer("wins_1").notNull().default(0),
  wins2:      integer("wins_2").notNull().default(0),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniquePair: uniqueIndex("h2h_matchup_pair_idx").on(t.discordId1, t.discordId2),
}));

export const rulesTable = pgTable("rules", {
  section: text("section").primaryKey(),
  rules: json("rules").notNull().$type<string[]>(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

export const rulesSectionsTable = pgTable("rules_sections", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  color: integer("color").notNull().default(0x3498db),
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
  payoutRequestId: integer("payout_request_id"), // nullable — kept for backward compat; new interviews leave this null
  week: text("week"), // matches the active season's currentWeek when the interview was submitted
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
  "savings_deposit",
  "savings_withdraw",
  "savings_interest",
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

// ── Global savings account ─────────────────────────────────────────────────────
// One row per Discord user — keyed only by discordId so the balance is
// reachable from any guild/server the bot operates in. Users transfer coins
// in/out of their per-guild wallet via /savings deposit and /savings withdraw.
export const userSavingsTable = pgTable("user_savings", {
  discordId:  text("discord_id").primaryKey(),
  balance:    integer("balance").notNull().default(0),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
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

// Tracks Madden franchise game IDs that have already been processed (dedup)
export const franchiseProcessedGamesTable = pgTable("franchise_processed_games", {
  gameId:           text("game_id").primaryKey(),
  processedAt:      timestamp("processed_at").notNull().defaultNow(),
  // Payout metadata — populated by franchise-update, used by admin-correctpayout for precise reversal
  payoutType:       text("payout_type"),       // "h2h" | "cpu" | "none" | null (legacy rows)
  winnerDiscordId:  text("winner_discord_id"), // discordId of user who received win payout
  loserDiscordId:   text("loser_discord_id"),  // discordId of user who received loss payout (h2h only)
  winnerCoins:      integer("winner_coins"),   // coins awarded to winner
  loserCoins:       integer("loser_coins"),    // coins awarded to loser (0 for cpu)
  appliedPointDiff: integer("applied_point_diff"), // point spread used for H2H record delta
  // Milestone reversal metadata — set when a career milestone bonus fires for this game
  milestoneBonus:   integer("milestone_bonus"),    // bonus coins awarded (null if no milestone fired)
  milestonePrevTier: integer("milestone_prev_tier"), // milestoneTierAwarded value BEFORE this milestone
  // Lookup fields — allow admin-correctpayout to find this entry by season/week/teams
  seasonIdRef:   integer("season_id_ref"),
  weekIndexRef:  integer("week_index_ref"),
  homeTeamRef:   text("home_team_ref"),
  awayTeamRef:   text("away_team_ref"),
});

// Tracks which players have had a game processed via /franchiseupdate this week (interview eligibility)
export const franchiseGameParticipantsTable = pgTable("franchise_game_participants", {
  id:        serial("id").primaryKey(),
  seasonId:  integer("season_id").notNull(),
  week:      text("week").notNull(),
  discordId: text("discord_id").notNull(),
  gameType:  text("game_type").notNull(), // "h2h" | "cpu"
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  uniqueParticipant: uniqueIndex("franchise_game_participants_unique_idx")
    .on(t.seasonId, t.week, t.discordId),
}));

// Stores the full regular-season schedule from each franchise ZIP import
export const franchiseScheduleTable = pgTable("franchise_schedule", {
  id:           serial("id").primaryKey(),
  seasonId:     integer("season_id").notNull(),
  weekIndex:    integer("week_index").notNull(),
  homeTeamId:   integer("home_team_id").notNull(),
  awayTeamId:   integer("away_team_id").notNull(),
  homeTeamName: text("home_team_name").notNull(),
  awayTeamName: text("away_team_name").notNull(),
  homeScore:       integer("home_score"),
  awayScore:       integer("away_score"),
  status:          integer("status").notNull().default(0),
  processedGameId: text("processed_game_id"),  // gameId stored in franchise_processed_games for this game
  importedAt:      timestamp("imported_at").notNull().defaultNow(),
}, (t) => ({
  uniqueGame: uniqueIndex("franchise_schedule_unique_game_idx")
    .on(t.seasonId, t.weekIndex, t.homeTeamId, t.awayTeamId),
}));

// Stores player roster data imported from each franchise ZIP
export const franchiseRostersTable = pgTable("franchise_rosters", {
  id:        serial("id").primaryKey(),
  seasonId:  integer("season_id").notNull(),
  teamId:    integer("team_id").notNull(),
  teamName:  text("team_name").notNull(),
  discordId: text("discord_id"),                   // null if CPU team
  playerId:  integer("player_id").notNull(),
  firstName: text("first_name").notNull().default(""),
  lastName:  text("last_name").notNull().default(""),
  position:  text("position").notNull().default(""),
  overall:   integer("overall").notNull().default(0),
  devTrait:  integer("dev_trait").notNull().default(0),  // 0=Normal 1=Impact 2=Star 3=Superstar 4=X-Factor
  age:                integer("age"),
  jerseyNum:          integer("jersey_num"),
  contractYearsLeft:  integer("contract_years_left"),   // null = unknown; 1 = final year (contract year)
  attributes:         json("attributes"),               // Record<string, number> — all *Rating fields from MCA export
  importedAt: timestamp("imported_at").notNull().defaultNow(),
}, (t) => ({
  uniquePlayer: uniqueIndex("franchise_roster_player_season_idx")
    .on(t.seasonId, t.teamId, t.playerId),
}));

// ── Franchise draft picks (imported from MCA /draftpicks webhook) ─────────────
// Madden shows the next 3 draft classes on each team's roster. We store one row
// per pick: the team currently holding it + original owner if traded away.
export const franchiseDraftPicksTable = pgTable("franchise_draft_picks", {
  id:             serial("id").primaryKey(),
  seasonId:       integer("season_id").notNull(),
  teamId:         integer("team_id").notNull(),     // MCA teamId of current holder
  teamName:       text("team_name").notNull().default(""),
  discordId:      text("discord_id"),               // null if CPU team
  draftYear:      integer("draft_year").notNull(),  // calendar year of the draft (e.g. 2026)
  round:          integer("round").notNull(),        // 1-7
  pickNum:        integer("pick_num").notNull().default(0),   // overall pick# in round (0 = unknown)
  originalTeamId: integer("original_team_id"),      // MCA teamId of original owner (null = own pick)
  originalTeamName: text("original_team_name"),     // display name of original owner
  importedAt:     timestamp("imported_at").notNull().defaultNow(),
}, (t) => ({
  uniquePick: uniqueIndex("franchise_draft_picks_unique_idx")
    .on(t.seasonId, t.teamId, t.draftYear, t.round, t.pickNum),
}));

// ── End-of-season stat payout tier configuration ──────────────────────────────
// Each row defines one tier (1-4) for one stat category in a season.
// For "higher is better" stats (offense, def INTs): threshold = minimum value to qualify.
// For "lower is better" stats (def yards/pts/redzone): threshold = maximum value to qualify.
// Tier 4 always has the best payout; threshold ordering depends on direction.
export const seasonStatTierConfigsTable = pgTable("season_stat_tier_configs", {
  id:           serial("id").primaryKey(),
  seasonId:     integer("season_id").notNull(),
  statCategory: text("stat_category").notNull(),
  tier:         integer("tier").notNull(),          // 1 | 2 | 3 | 4
  threshold:    integer("threshold").notNull(),
  payout:       integer("payout").notNull(),         // coins
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniqueStatTier: uniqueIndex("season_stat_tier_unique_idx")
    .on(t.seasonId, t.statCategory, t.tier),
}));

// ── Team season stats (offense/defense yards — upserted each franchise ZIP import) ──
export const teamSeasonStatsTable = pgTable("team_season_stats", {
  id:         serial("id").primaryKey(),
  seasonId:   integer("season_id").notNull(),
  teamId:     integer("team_id").notNull(),
  discordId:  text("discord_id"),           // null if CPU team
  teamName:   text("team_name").notNull().default(""),
  offYds:     integer("off_yds").notNull().default(0),      // total offensive yards (pass + rush)
  offPassYds: integer("off_pass_yds").notNull().default(0), // offensive passing yards
  offRushYds: integer("off_rush_yds").notNull().default(0), // offensive rushing yards
  offTDs:     integer("off_tds").notNull().default(0),      // points scored (ptsFor fallback)
  offPtsPerGame: real("off_pts_per_game").notNull().default(0), // PPG from MCA (0 = not yet set)
  defPassYds: integer("def_pass_yds").notNull().default(0),
  defRushYds: integer("def_rush_yds").notNull().default(0),
  defTDs:     integer("def_tds").notNull().default(0),      // points allowed (ptsAgainst fallback)
  teamSacks:  integer("team_sacks").notNull().default(0),   // total sacks by this team's defense
  teamInts:   integer("team_ints").notNull().default(0),    // total INTs by this team's defense
  offRedZonePct: real("off_redzone_pct").notNull().default(0),  // offensive red zone % (0–100)
  defRedZonePct: real("def_redzone_pct").notNull().default(0),  // defensive red zone % allowed (0–100)
  defFumblesRec: integer("def_fumbles_rec").notNull().default(0), // fumbles recovered on defense
  turnoverDiff:  integer("turnover_diff").notNull().default(0),   // season turnover differential (+/-)
  wins:       integer("wins").notNull().default(0),
  losses:     integer("losses").notNull().default(0),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniqueTeam: uniqueIndex("team_season_stats_unique_idx").on(t.seasonId, t.teamId),
}));

// ── Player season stats (all stat categories — upserted each franchise ZIP import) ──
export const playerSeasonStatsTable = pgTable("player_season_stats", {
  id:           serial("id").primaryKey(),
  seasonId:     integer("season_id").notNull(),
  playerId:     integer("player_id").notNull(),
  teamId:       integer("team_id").notNull().default(-1),
  teamName:     text("team_name").notNull().default(""),
  discordId:    text("discord_id"),   // team owner's discord ID
  firstName:    text("first_name").notNull().default(""),
  lastName:     text("last_name").notNull().default(""),
  position:     text("position").notNull().default(""),
  passYds:      integer("pass_yds").notNull().default(0),
  passTDs:      integer("pass_tds").notNull().default(0),
  passAtt:      integer("pass_att").notNull().default(0),
  passComp:     integer("pass_comp").notNull().default(0),
  passInts:     integer("pass_ints").notNull().default(0),      // interceptions thrown (giveaways)
  timesSacked:  integer("times_sacked").notNull().default(0),   // times the QB was sacked
  rushYds:      integer("rush_yds").notNull().default(0),
  rushTDs:      integer("rush_tds").notNull().default(0),
  rushAtt:      integer("rush_att").notNull().default(0),
  fumbles:      integer("fumbles").notNull().default(0),         // total fumbles committed
  recYds:       integer("rec_yds").notNull().default(0),
  recTDs:       integer("rec_tds").notNull().default(0),
  recRec:       integer("rec_rec").notNull().default(0),
  sacks:          real("sacks").notNull().default(0),               // real: Madden tracks shared sacks as 0.5
  defInts:        integer("def_ints").notNull().default(0),
  totalTackles:   integer("total_tackles").notNull().default(0),
  tackleSolo:     integer("tackle_solo").notNull().default(0),
  tackleAssist:   integer("tackle_assist").notNull().default(0),
  defFumblesRec:  integer("def_fumbles_rec").notNull().default(0),    // fumbles recovered by this player
  forcedFumbles:  integer("forced_fumbles").notNull().default(0),     // forced fumbles by this player
  tacklesForLoss: real("tackles_for_loss").notNull().default(0),      // real: shared TFLs are 0.5
  defTDs:         integer("def_tds_scored").notNull().default(0),     // defensive/ST TDs scored
  // ── Kicking ──────────────────────────────────────────────────────────────────
  fgMade:         integer("fg_made").notNull().default(0),
  fgAtt:          integer("fg_att").notNull().default(0),
  fgLong:         integer("fg_long").notNull().default(0),
  xpMade:         integer("xp_made").notNull().default(0),
  xpAtt:          integer("xp_att").notNull().default(0),
  // ── Punting ──────────────────────────────────────────────────────────────────
  puntAtt:        integer("punt_att").notNull().default(0),
  puntYds:        integer("punt_yds").notNull().default(0),
  puntLong:       integer("punt_long").notNull().default(0),
  puntIn20:       integer("punt_in_20").notNull().default(0),
  puntTouchbacks: integer("punt_touchbacks").notNull().default(0),
  // ── Kick/Punt Returns ─────────────────────────────────────────────────────────
  krAtt:          integer("kr_att").notNull().default(0),
  krYds:          integer("kr_yds").notNull().default(0),
  krTDs:          integer("kr_tds").notNull().default(0),
  prAtt:          integer("pr_att").notNull().default(0),
  prYds:          integer("pr_yds").notNull().default(0),
  prTDs:          integer("pr_tds").notNull().default(0),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniquePlayer: uniqueIndex("player_season_stats_unique_idx").on(t.seasonId, t.playerId),
}));

// ── Tracks which (season, weekType, weekNum, statType) combos have been processed ──
// Prevents double-counting if MCA re-exports the same week's stats.
export const playerStatWeekProcessedTable = pgTable("player_stat_week_processed", {
  id:          serial("id").primaryKey(),
  seasonId:    integer("season_id").notNull(),
  weekType:    text("week_type").notNull(),   // "reg" | "post" | etc.
  weekNum:     integer("week_num").notNull(),
  statType:    text("stat_type").notNull(),   // "passing" | "rushing" | "receiving" | "defense"
  recordCount: integer("record_count").notNull().default(0),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (t) => ({
  uniqueWeek: uniqueIndex("player_stat_week_processed_unique_idx")
    .on(t.seasonId, t.weekType, t.weekNum, t.statType),
}));

// ── GOTW recommendation history (4-week cooldown tracking) ────────────────────
export const gotwHistoryTable = pgTable("gotw_history", {
  id:          serial("id").primaryKey(),
  seasonId:    integer("season_id").notNull(),
  weekIndex:   integer("week_index").notNull(),   // 0-based (week 1 = index 0)
  discordId1:  text("discord_id_1").notNull(),
  discordId2:  text("discord_id_2").notNull(),
  teamName1:   text("team_name_1").notNull(),
  teamName2:   text("team_name_2").notNull(),
  combinedScore: integer("combined_score").notNull().default(0), // stored as floor(score)
  announcementMessageId: text("announcement_message_id"),        // Discord message ID of @everyone post
  pollMessageId:         text("poll_message_id"),                // Discord message ID of the poll
  payoutIssuedAt: timestamp("payout_issued_at"),                 // set once GOTW voter payouts have been issued
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  uniqueWeek: uniqueIndex("gotw_history_week_idx").on(t.seasonId, t.weekIndex),
}));

// ── Playoff GOTW polls (one per matchup, multiple per week) ───────────────────
// Unlike gotwHistoryTable (one per week), each H2H playoff game gets its own row.
export const playoffGotwPollsTable = pgTable("playoff_gotw_polls", {
  id:             serial("id").primaryKey(),
  seasonId:       integer("season_id").notNull(),
  weekLabel:      text("week_label").notNull(),       // "wildcard" | "divisional" | "conference" | "superbowl"
  weekIndex:      integer("week_index").notNull(),    // 18=wildcard, 19=divisional, 20=conference, 22=superbowl
  matchupIndex:   integer("matchup_index").notNull(), // 0-based position within the week's games
  discordId1:     text("discord_id_1").notNull(),     // away team discord ID
  discordId2:     text("discord_id_2").notNull(),     // home team discord ID
  teamName1:      text("team_name_1").notNull(),      // away team name
  teamName2:      text("team_name_2").notNull(),      // home team name
  pollMessageId:  text("poll_message_id"),
  payoutIssuedAt: timestamp("payout_issued_at"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  uniqMatchup: uniqueIndex("playoff_gotw_polls_uniq").on(t.seasonId, t.weekIndex, t.matchupIndex),
}));

// ── Draft presence tracker ────────────────────────────────────────────────────
// One active session at a time per guild; presence rows track each user's status.
export const draftSessionsTable = pgTable("draft_sessions", {
  id:              serial("id").primaryKey(),
  guildId:         text("guild_id").notNull(),
  channelId:       text("channel_id").notNull(),
  messageId:       text("message_id"),          // embed/status message — edited in-place
  panelMessageId:  text("panel_message_id"),    // kept for compat; prefer panelMessageIds
  panelMessageIds: text("panel_message_ids"),   // JSON array of button-panel message IDs (multi-message support)
  isActive:        boolean("is_active").notNull().default(true),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
});

export const draftPresenceTable = pgTable("draft_presence", {
  id:        serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  discordId: text("discord_id").notNull(),
  teamName:  text("team_name"),
  isPresent: boolean("is_present").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("draft_presence_uniq").on(t.sessionId, t.discordId),
}));

// ── Game matchup channels (created per week by /advanceweek, deleted on next advance) ──
export const gameChannelsTable = pgTable("game_channels", {
  id:           serial("id").primaryKey(),
  seasonId:     integer("season_id").notNull(),
  weekIndex:    integer("week_index").notNull(),
  channelId:    text("channel_id").notNull(),
  awayTeamName: text("away_team_name").notNull().default(""),
  homeTeamName: text("home_team_name").notNull().default(""),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
});

// ── Trade Block: user-posted trade offers ──────────────────────────────────────
export const tradeBlockListingsTable = pgTable("trade_block_listings", {
  id:        serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  teamName:  text("team_name").notNull().default(""),
  seasonId:  integer("season_id").notNull(),
  items:     json("items").notNull().$type<Array<
    | { type: "player"; firstName: string; lastName: string; position: string; overall: number; devTrait: number; playerId: number }
    | { type: "pick";   description: string }
    | { type: "coins";  amount: number }
  >>(),
  notes:     text("notes"),        // what they're looking for in return
  messageId: text("message_id"),   // Discord message ID for deletion/editing
  channelId: text("channel_id"),
  status:    text("status").notNull().default("active"), // "active" | "removed"
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Trade Block ISO: user is seeking a specific asset type ────────────────────
export const tradeBlockISOTable = pgTable("trade_block_iso", {
  id:             serial("id").primaryKey(),
  discordId:      text("discord_id").notNull(),
  teamName:       text("team_name").notNull().default(""),
  seasonId:       integer("season_id").notNull(),
  seekingType:    text("seeking_type").notNull(),    // "player_position" | "draft_pick" | "coins" | "multi"
  seekingDetails: json("seeking_details").notNull().$type<{
    position?: string;    // legacy: player_position
    rounds?: string[];    // legacy: draft_pick
    amount?: number;      // legacy: coins
    positions?: string[];  // new: multi — e.g. ["QB","WR"]
    pickRounds?: string[]; // legacy multi — old free-text round list
    pickInfo?: {           // new structured pick request
      round: string;       // "any" | "1"-"7"
      qty?: number | null;
      year?: number | null;
    };
    wantsCoins?: boolean;  // new: multi
  }>(),
  offering: json("offering").notNull().$type<{
    // legacy free-text format
    players?: string;
    picks?: string;
    coins?: number;
    // new autocomplete items format
    items?: Array<
      | { type: "player"; firstName: string; lastName: string; position: string; overall: number; devTrait: number; playerId: number }
      | { type: "pick";   description: string }
      | { type: "coins";  amount: number }
    >;
  }>(),
  messageId: text("message_id"),
  channelId: text("channel_id"),
  status:    text("status").notNull().default("active"), // "active" | "removed"
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Completed trades (announced in general channel) ──────────────────────────
// Recorded when a user confirms a deal was reached on cancelling a trade block listing.
export const completedTradesTable = pgTable("completed_trades", {
  id:                serial("id").primaryKey(),
  seasonId:          integer("season_id").notNull(),
  listingId:         integer("listing_id"),                        // nullable — ISO or command-removed
  listingType:       text("listing_type").notNull().default("listing"), // "listing" | "iso"
  team1DiscordId:    text("team1_discord_id").notNull(),           // listing owner
  team1Name:         text("team1_name").notNull(),
  team2Name:         text("team2_name").notNull(),                 // other party (free text)
  whatTeam1Sent:     text("what_team1_sent").notNull(),
  whatTeam1Received: text("what_team1_received").notNull(),
  announcedAt:       timestamp("announced_at").notNull().defaultNow(),
  articledAt:        timestamp("articled_at"),  // set after the trade is first covered in a generated article
});

// ── MCA (Madden Companion App) team map ──────────────────────────────────────
// Populated by the /leagueteams webhook; used by /week scorer and /schedules handler.
// Gives us teamId → fullName, nickName, userName so we know who is human vs CPU
// and which Discord user controls each team, without needing the ZIP file.
export const franchiseMcaTeamsTable = pgTable("franchise_mca_teams", {
  id:        serial("id").primaryKey(),
  seasonId:  integer("season_id").notNull(),
  teamId:    integer("team_id").notNull(),
  fullName:  text("full_name").notNull(),      // "Las Vegas Raiders"
  nickName:  text("nick_name").notNull(),       // "Raiders"
  userName:  text("user_name").notNull(),       // Madden in-game username or "CPU"
  isHuman:   boolean("is_human").notNull().default(false),
  discordId: text("discord_id"),               // null if CPU team or no match
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniqueTeam: uniqueIndex("franchise_mca_teams_unique_idx").on(t.seasonId, t.teamId),
}));

// ── Configurable payout amounts (key → integer coin value) ───────────────────
export const payoutConfigTable = pgTable("payout_config", {
  key:         text("key").primaryKey(),
  value:       integer("value").notNull(),
  description: text("description").notNull().default(""),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
  updatedBy:   text("updated_by"),
});

// ── Pending polls awaiting expiry + result processing ─────────────────────────
export const pendingPollsTable = pgTable("pending_polls", {
  id:                  serial("id").primaryKey(),
  messageId:           text("message_id").notNull(),
  channelId:           text("channel_id").notNull(),
  pollType:            text("poll_type").notNull(),  // "goty" | "loudest" | "heart" | "best_worst" | "worst_worst"
  seasonId:            integer("season_id").notNull(),
  expiresAt:           timestamp("expires_at").notNull(),
  processed:           boolean("processed").notNull().default(false),
  processedAt:         timestamp("processed_at"),
  historicalChannelId: text("historical_channel_id"),  // historical records channel for that season
  metadata:            text("metadata"),               // JSON string for extra context
  createdAt:           timestamp("created_at").notNull().defaultNow(),
});

// ── Historical records channel created at wildcard time, per season ──────────
export const seasonHistoricalChannelsTable = pgTable("season_historical_channels", {
  seasonId:  integer("season_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Server feature settings (admin-toggleable per guild) ───────────────────────
export const serverSettingsTable = pgTable("server_settings", {
  id:                      serial("id").primaryKey(),
  guildId:                 text("guild_id").notNull().unique().default("global"),
  coinEconomy:             boolean("coin_economy").notNull().default(true),
  legendsEnabled:          boolean("legends_enabled").notNull().default(true),
  customSuperstarsEnabled: boolean("custom_superstars_enabled").notNull().default(true),
  attributeUpgradesEnabled: boolean("attribute_upgrades_enabled").notNull().default(true),
  devUpgradesEnabled:      boolean("dev_upgrades_enabled").notNull().default(true),
  ageResetsEnabled:        boolean("age_resets_enabled").notNull().default(true),
  wagerEnabled:            boolean("wager_enabled").notNull().default(true),
  tradeBlockEnabled:       boolean("trade_block_enabled").notNull().default(true),
  mcaImportEnabled:        boolean("mca_import_enabled").notNull().default(true),
  maxSeasons:              integer("max_seasons").notNull().default(10),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Pending end-of-season stat payouts (awaiting commissioner approval) ─────────
export const pendingEosPayoutsTable = pgTable("pending_eos_payouts", {
  id:           serial("id").primaryKey(),
  discordId:    text("discord_id").notNull(),
  teamName:     text("team_name"),
  seasonId:     integer("season_id").notNull(),
  statBreakdown: json("stat_breakdown").notNull().$type<Array<{
    label: string; statValue: number; unit: string; tier: number; coins: number;
  }>>(),
  totalCoins:              integer("total_coins").notNull(),
  status:                  text("status").notNull().default("pending"),
  commissionerMessageId:   text("commissioner_message_id"),
  approvedBy:              text("approved_by"),
  approvedAt:              timestamp("approved_at"),
  createdAt:               timestamp("created_at").notNull().defaultNow(),
});

export type ServerSettings = typeof serverSettingsTable.$inferSelect;

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

// ── Pending stream / highlight payouts (awaiting commissioner approval) ───────
export const pendingChannelPayoutsTable = pgTable("pending_channel_payouts", {
  id:                 serial("id").primaryKey(),
  type:               text("type").notNull(),            // "stream" | "highlight"
  discordId:          text("discord_id").notNull(),       // primary recipient (streamer / poster)
  amount:             integer("amount").notNull(),        // coins to award primary recipient
  opponentDiscordId:  text("opponent_discord_id"),        // H2H opponent (stream only; null for CPU)
  opponentAmount:     integer("opponent_amount"),         // coins to award opponent (stream only)
  opponentTeam:       text("opponent_team"),              // opponent team name for display
  channelId:          text("channel_id").notNull(),       // original channel (for reaction)
  messageId:          text("message_id").notNull(),       // original message (for reaction)
  guildId:            text("guild_id").notNull(),
  seasonId:           integer("season_id").notNull(),
  week:               text("week").notNull(),             // currentWeek at time of submission
  status:             text("status").notNull().default("pending"), // "pending" | "approved" | "denied"
  commMessageId:      text("comm_message_id"),            // commissioner log message ID
  resolvedAt:         timestamp("resolved_at"),
  resolvedBy:         text("resolved_by"),
  createdAt:          timestamp("created_at").notNull().defaultNow(),
});


// ── Stat Padding Violations (flagged by MCA, confirmed/denied by commissioner) ─
export const statPaddingViolationsTable = pgTable("stat_padding_violations", {
  id:              serial("id").primaryKey(),
  seasonId:        integer("season_id").notNull(),
  week:            text("week").notNull(),            // "Week 5", "Wild Card", etc.
  type:            text("type").notNull(),            // "h2h_blowout" | "cpu_score" | "player_stat"
  discordId:       text("discord_id"),               // team owner (nullable for unregistered teams)
  playerName:      text("player_name"),              // in-game player name (player_stat only)
  teamName:        text("team_name").notNull(),
  description:     text("description").notNull(),    // full human-readable violation text
  status:          text("status").notNull().default("pending"), // "pending" | "confirmed" | "denied"
  commMessageId:   text("comm_message_id"),          // commissioner channel message ID (for button edits)
  resolvedAt:      timestamp("resolved_at"),
  resolvedBy:      text("resolved_by"),              // discordId of the commissioner who acted
  createdAt:       timestamp("created_at").notNull().defaultNow(),
});

// ── Custom Archetypes ─────────────────────────────────────────────────────────
export const customArchetypesTable = pgTable("custom_archetypes", {
  id:         serial("id").primaryKey(),
  position:   text("position").notNull(),          // "QB", "RB", etc.
  name:       text("name").notNull(),              // archetype name
  attributes: json("attributes").notNull().$type<Record<string, number>>(),
  isActive:   boolean("is_active").notNull().default(true),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
});

// ── Custom Player Settings (Bronze/Silver/Gold points & costs) ────────────────
export const customPlayerSettingsTable = pgTable("custom_player_settings", {
  id:           serial("id").primaryKey(),
  bronzePoints: integer("bronze_points").notNull().default(35),
  silverPoints: integer("silver_points").notNull().default(70),
  goldPoints:   integer("gold_points").notNull().default(100),
  bronzeCost:   integer("bronze_cost").notNull().default(0),
  silverCost:   integer("silver_cost").notNull().default(0),
  goldCost:     integer("gold_cost").notNull().default(0),
  kpPoints:     integer("kp_points").notNull().default(50),
  kpCost:       integer("kp_cost").notNull().default(150),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
});

// ── Custom Players (submitted builds) ─────────────────────────────────────────
export const customPlayersTable = pgTable("custom_players", {
  id:                   serial("id").primaryKey(),
  discordId:            text("discord_id").notNull(),
  seasonId:             integer("season_id"),
  position:             text("position").notNull(),
  archetypeName:        text("archetype_name").notNull(),
  devTrait:             text("dev_trait").notNull().default("normal"),  // normal|star|superstar
  packageTier:          text("package_tier").notNull(),                 // bronze|silver|gold|kp
  creationPoints:       integer("creation_points").notNull().default(0),
  firstName:            text("first_name").notNull(),
  lastName:             text("last_name").notNull(),
  jerseyNumber:         integer("jersey_number").notNull(),
  college:              text("college").notNull(),
  dominantHand:         text("dominant_hand").notNull().default("right"),
  heightFt:             integer("height_ft").notNull(),
  heightIn:             integer("height_in").notNull(),
  weightLbs:            integer("weight_lbs").notNull(),
  attributes:           json("attributes").notNull().$type<Record<string, number>>(),
  throwingMotionStyle:  text("throwing_motion_style"),   // QB only — e.g. "Over the Top"
  throwingMotionNumber: integer("throwing_motion_number"), // QB only — 0–17 etc.
  appearanceHead:       text("appearance_head"),           // "any" or a numeric string
  totalCost:            integer("total_cost").notNull().default(0),
  status:               text("status").notNull().default("pending"),   // pending|applied|refunded
  commissionerMessageId: text("commissioner_message_id"),
  commissionerChannelId: text("commissioner_channel_id"),
  appliedAt:            timestamp("applied_at"),
  refundedAt:           timestamp("refunded_at"),
  refundReason:         text("refund_reason"),
  createdAt:            timestamp("created_at").notNull().defaultNow(),
});

// ── EA API direct connection (replaces MCA manual imports) ─────────────────────
export const eaConnectionsTable = pgTable("ea_connections", {
  id:           serial("id").primaryKey(),
  eaLeagueId:   integer("ea_league_id").notNull().unique(),
  leagueName:   text("league_name").notNull().default(""),
  blazeId:      text("blaze_id").notNull(),
  accessToken:  text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiry:       timestamp("expiry").notNull(),
  platform:     text("platform").notNull().default("pc"),
  connectedAt:  timestamp("connected_at").notNull().defaultNow(),
  connectedBy:  text("connected_by").notNull(),
});

// ── League Twitter — trade activity event log ─────────────────────────────────
// Written by trade block commands/interactions; only includes events from this
// season forward. Replaces querying stale completedTradesTable for AI context.
export const leagueTwitterTradeEventsTable = pgTable("league_twitter_trade_events", {
  id:        serial("id").primaryKey(),
  seasonId:  integer("season_id").notNull(),
  eventType: text("event_type").notNull(),   // "listing_posted" | "iso_posted" | "offer_sent" | "trade_completed" | "listing_removed" | "iso_removed"
  summary:   text("summary").notNull(),       // human-readable one-liner for AI context
  teamA:     text("team_a"),                  // primary team name
  teamB:     text("team_b"),                  // secondary team name (if applicable)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── League Twitter — matchup context cache (4-hour window) ───────────────────
// Written by weekly/playoff matchup runners; read by league-twitter context builder.
export const leagueTwitterMatchupCacheTable = pgTable("league_twitter_matchup_cache", {
  id:           serial("id").primaryKey(),
  seasonId:     integer("season_id").notNull(),
  weekLabel:    text("week_label").notNull(),     // e.g. "Week 12" or "Wild Card"
  matchupsText: text("matchups_text").notNull(),  // plain-text list of matchups for the AI
  postedAt:     timestamp("posted_at").notNull().defaultNow(),
});

// ── League Twitter — in-game EA news cache ───────────────────────────────────
// Populated by /admin_ea_export week (and news-only refresh).
// Each row is one news item from Madden's in-game CFM news feed.
export const leagueNewsTable = pgTable("league_news", {
  id:        serial("id").primaryKey(),
  seasonId:  integer("season_id").notNull(),
  eaNewsId:  text("ea_news_id"),                       // EA's own ID — used for upsert dedup
  headline:  text("headline").notNull(),
  body:      text("body"),
  category:  text("category"),                          // e.g. "GAME_RECAP", "PLAYER_NEWS" etc.
  weekIndex: integer("week_index"),                     // from EA if present, else null
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── Roster Transaction Log ────────────────────────────────────────────────────
// Populated by processTeamRoster when player moves teams, overall changes, or
// dev trait changes are detected relative to the previous roster snapshot.
// Posted to the configured TRANSACTIONS_CHANNEL_ID on Discord.
export const rosterTransactionsTable = pgTable("roster_transactions", {
  id:              serial("id").primaryKey(),
  seasonId:        integer("season_id").notNull(),
  detectedAt:      timestamp("detected_at").notNull().defaultNow(),
  weekNum:         integer("week_num"),
  transactionType: text("transaction_type").notNull(),  // 'team_change' | 'overall_change' | 'dev_change'
  playerId:        integer("player_id").notNull(),
  playerName:      text("player_name").notNull(),
  position:        text("position"),
  fromTeam:        text("from_team"),
  toTeam:          text("to_team"),
  fromValue:       text("from_value"),
  toValue:         text("to_value"),
  postedToChannel: boolean("posted_to_channel").notNull().default(false),
});

// ── League Twitter — AI-generated "reporter tweets" posted every 3 hours ────
export const leagueTwitterTable = pgTable("league_twitter_tweets", {
  id:           serial("id").primaryKey(),
  seasonId:     integer("season_id").notNull(),
  messageId:    text("message_id").notNull(),       // Discord message ID for reply mapping
  reporterName: text("reporter_name").notNull(),    // e.g. "Adam Shaffer"
  reporterHandle: text("reporter_handle").notNull(), // e.g. "@AdamShaffer"
  content:      text("content").notNull(),          // full tweet text
  postedAt:     timestamp("posted_at").notNull().defaultNow(),
});
