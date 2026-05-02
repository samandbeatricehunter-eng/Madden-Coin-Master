/**
 * Madden-native tables — scoped purely by eaLeagueId.
 * No Discord guild IDs anywhere. Used by the mobile app.
 */
import {
  pgTable, text, integer, boolean, timestamp, serial, json, uniqueIndex, real,
} from "drizzle-orm/pg-core";

// ── App users (mobile app only, no Discord) ───────────────────────────────────
export const appUsersTable = pgTable("app_users", {
  gamertag:    text("gamertag").primaryKey(),         // lowercase, canonical
  displayName: text("display_name").notNull().default(""),
  platform:    text("platform").notNull().default(""), // ps5 | xbs | pc
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

// ── App user ↔ league links ───────────────────────────────────────────────────
export const appUserLeagueLinksTable = pgTable("app_user_league_links", {
  id:          serial("id").primaryKey(),
  gamertag:    text("gamertag").notNull(),
  eaLeagueId:  integer("ea_league_id").notNull(),
  teamId:      integer("team_id"),                    // null until leagueteams import resolves it
  linkedAt:    timestamp("linked_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("app_user_league_links_idx").on(t.gamertag, t.eaLeagueId),
}));

// ── Leagues ───────────────────────────────────────────────────────────────────
export const mcaLeaguesTable = pgTable("mca_leagues", {
  eaLeagueId:  integer("ea_league_id").primaryKey(),
  leagueName:  text("league_name").notNull().default(""),
  platform:    text("platform").notNull().default("pc"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

// ── Seasons ───────────────────────────────────────────────────────────────────
export const mcaSeasonsTable = pgTable("mca_seasons", {
  id:           serial("id").primaryKey(),
  eaLeagueId:   integer("ea_league_id").notNull(),
  seasonNumber: integer("season_number").notNull(),
  isActive:     boolean("is_active").notNull().default(true),
  currentWeek:  text("current_week").notNull().default("1"),
  startedAt:    timestamp("started_at").notNull().defaultNow(),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_seasons_league_season_idx").on(t.eaLeagueId, t.seasonNumber),
}));

// ── Teams ─────────────────────────────────────────────────────────────────────
export const mcaTeamsTable = pgTable("mca_teams", {
  id:             serial("id").primaryKey(),
  eaSeasonId:     integer("ea_season_id").notNull(),
  eaLeagueId:     integer("ea_league_id").notNull(),
  teamId:         integer("team_id").notNull(),
  fullName:       text("full_name").notNull().default(""),
  nickName:       text("nick_name").notNull().default(""),
  abbrName:       text("abbr_name"),
  conference:     text("conference"),
  divName:        text("div_name"),
  userName:       text("user_name").notNull().default("CPU"),
  isHuman:        boolean("is_human").notNull().default(false),
  offScheme:      text("off_scheme"),
  defScheme:      text("def_scheme"),
  ovrRating:      integer("ovr_rating"),
  primaryColor:   integer("primary_color"),
  secondaryColor: integer("secondary_color"),
  logoId:         integer("logo_id"),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_teams_season_team_idx").on(t.eaSeasonId, t.teamId),
}));

// ── Rosters ───────────────────────────────────────────────────────────────────
export const mcaRostersTable = pgTable("mca_rosters", {
  id:                serial("id").primaryKey(),
  eaSeasonId:        integer("ea_season_id").notNull(),
  eaLeagueId:        integer("ea_league_id").notNull(),
  teamId:            integer("team_id").notNull(),
  teamName:          text("team_name").notNull().default(""),
  playerId:          integer("player_id").notNull(),
  firstName:         text("first_name").notNull().default(""),
  lastName:          text("last_name").notNull().default(""),
  position:          text("position").notNull().default(""),
  overall:           integer("overall").notNull().default(0),
  devTrait:          integer("dev_trait").notNull().default(0),
  age:               integer("age"),
  jerseyNum:         integer("jersey_num"),
  contractYearsLeft: integer("contract_years_left"),
  archetypeAbbrev:   text("archetype_abbrev"),
  xpTotal:           integer("xp_total"),
  attributes:        json("attributes"),
  abilities:         json("abilities"),
  portraitUrl:       text("portrait_url"),
  importedAt:        timestamp("imported_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_rosters_player_season_idx").on(t.eaSeasonId, t.teamId, t.playerId),
}));

// ── Team season stats / standings ─────────────────────────────────────────────
export const mcaTeamStatsTable = pgTable("mca_team_stats", {
  id:             serial("id").primaryKey(),
  eaSeasonId:     integer("ea_season_id").notNull(),
  eaLeagueId:     integer("ea_league_id").notNull(),
  teamId:         integer("team_id").notNull(),
  teamName:       text("team_name").notNull().default(""),
  wins:           integer("wins").notNull().default(0),
  losses:         integer("losses").notNull().default(0),
  ties:           integer("ties").notNull().default(0),
  ptsFor:         integer("pts_for").notNull().default(0),
  ptsAgainst:     integer("pts_against").notNull().default(0),
  offYds:         integer("off_yds").notNull().default(0),
  offPassYds:     integer("off_pass_yds").notNull().default(0),
  offRushYds:     integer("off_rush_yds").notNull().default(0),
  offTDs:         integer("off_tds").notNull().default(0),
  offPtsPerGame:  real("off_pts_per_game").notNull().default(0),
  defPassYds:     integer("def_pass_yds").notNull().default(0),
  defRushYds:     integer("def_rush_yds").notNull().default(0),
  defTDs:         integer("def_tds").notNull().default(0),
  teamSacks:      integer("team_sacks").notNull().default(0),
  teamInts:       integer("team_ints").notNull().default(0),
  defFumblesRec:  integer("def_fumbles_rec").notNull().default(0),
  offRedZonePct:  real("off_redzone_pct").notNull().default(0),
  defRedZonePct:  real("def_redzone_pct").notNull().default(0),
  tOTakeaways:    integer("to_takeaways").notNull().default(0),
  tOGiveaways:    integer("to_giveaways").notNull().default(0),
  turnoverDiff:   integer("turnover_diff").notNull().default(0),
  homeWins:       integer("home_wins").notNull().default(0),
  homeLosses:     integer("home_losses").notNull().default(0),
  awayWins:       integer("away_wins").notNull().default(0),
  awayLosses:     integer("away_losses").notNull().default(0),
  confWins:       integer("conf_wins").notNull().default(0),
  confLosses:     integer("conf_losses").notNull().default(0),
  divWins:        integer("div_wins").notNull().default(0),
  divLosses:      integer("div_losses").notNull().default(0),
  seed:           integer("seed"),
  rank:           integer("rank"),
  playoffStatus:  text("playoff_status"),
  winPct:         real("win_pct").notNull().default(0),
  netPts:         integer("net_pts").notNull().default(0),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_team_stats_season_team_idx").on(t.eaSeasonId, t.teamId),
}));

// ── Per-week team stats (raw, one row per team per week) ──────────────────────
export const mcaTeamWeekStatsTable = pgTable("mca_team_week_stats", {
  id:            serial("id").primaryKey(),
  eaSeasonId:    integer("ea_season_id").notNull(),
  eaLeagueId:    integer("ea_league_id").notNull(),
  weekType:      text("week_type").notNull(),
  weekNum:       integer("week_num").notNull(),
  teamId:        integer("team_id").notNull(),
  teamName:      text("team_name").notNull().default(""),
  offPassYds:    integer("off_pass_yds").notNull().default(0),
  offRushYds:    integer("off_rush_yds").notNull().default(0),
  offYds:        integer("off_yds").notNull().default(0),
  offTDs:        integer("off_tds").notNull().default(0),
  defPassYds:    integer("def_pass_yds").notNull().default(0),
  defRushYds:    integer("def_rush_yds").notNull().default(0),
  defTDs:        integer("def_tds").notNull().default(0),
  teamSacks:     integer("team_sacks").notNull().default(0),
  teamInts:      integer("team_ints").notNull().default(0),
  defFumblesRec: integer("def_fumbles_rec").notNull().default(0),
  turnoverDiff:  integer("turnover_diff").notNull().default(0),
  tOTakeaways:   integer("to_takeaways").notNull().default(0),
  tOGiveaways:   integer("to_giveaways").notNull().default(0),
  rawJson:       json("raw_json"),
  processedAt:   timestamp("processed_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_team_week_stats_idx").on(t.eaSeasonId, t.weekType, t.weekNum, t.teamId),
}));

// ── Schedule ──────────────────────────────────────────────────────────────────
export const mcaSchedulesTable = pgTable("mca_schedules", {
  id:           serial("id").primaryKey(),
  eaSeasonId:   integer("ea_season_id").notNull(),
  eaLeagueId:   integer("ea_league_id").notNull(),
  weekIndex:    integer("week_index").notNull(),
  weekType:     text("week_type").notNull().default("reg"),
  homeTeamId:   integer("home_team_id").notNull(),
  awayTeamId:   integer("away_team_id").notNull(),
  homeTeamName: text("home_team_name").notNull().default(""),
  awayTeamName: text("away_team_name").notNull().default(""),
  homeScore:    integer("home_score"),
  awayScore:    integer("away_score"),
  status:       integer("status").notNull().default(0),
}, (t) => ({
  uniq: uniqueIndex("mca_schedules_idx").on(t.eaSeasonId, t.weekIndex, t.homeTeamId, t.awayTeamId),
}));

// ── Player season stats (accumulated from week rows) ──────────────────────────
export const mcaPlayerStatsTable = pgTable("mca_player_stats", {
  id:              serial("id").primaryKey(),
  eaSeasonId:      integer("ea_season_id").notNull(),
  eaLeagueId:      integer("ea_league_id").notNull(),
  playerId:        integer("player_id").notNull(),
  teamId:          integer("team_id").notNull(),
  teamName:        text("team_name").notNull().default(""),
  firstName:       text("first_name").notNull().default(""),
  lastName:        text("last_name").notNull().default(""),
  position:        text("position").notNull().default(""),
  // passing
  passYds:         integer("pass_yds").notNull().default(0),
  passTDs:         integer("pass_tds").notNull().default(0),
  passAtt:         integer("pass_att").notNull().default(0),
  passComp:        integer("pass_comp").notNull().default(0),
  passInts:        integer("pass_ints").notNull().default(0),
  timesSacked:     integer("times_sacked").notNull().default(0),
  passLongest:     integer("pass_longest").notNull().default(0),
  passPts:         real("pass_pts").notNull().default(0),
  passerRating:    real("passer_rating").notNull().default(0),
  passCompPct:     real("pass_comp_pct").notNull().default(0),
  passYdsPerAtt:   real("pass_yds_per_att").notNull().default(0),
  passYdsPerGame:  real("pass_yds_per_game").notNull().default(0),
  // rushing
  rushYds:         integer("rush_yds").notNull().default(0),
  rushTDs:         integer("rush_tds").notNull().default(0),
  rushAtt:         integer("rush_att").notNull().default(0),
  rushLongest:     integer("rush_longest").notNull().default(0),
  fumbles:         integer("fumbles").notNull().default(0),
  rush20PlusYds:   integer("rush_20plus_yds").notNull().default(0),
  rushBrokenTackles: integer("rush_broken_tackles").notNull().default(0),
  rushYdsAfterContact: integer("rush_yds_after_contact").notNull().default(0),
  rushPts:         real("rush_pts").notNull().default(0),
  rushToPct:       real("rush_to_pct").notNull().default(0),
  rushYdsPerAtt:   real("rush_yds_per_att").notNull().default(0),
  rushYdsPerGame:  real("rush_yds_per_game").notNull().default(0),
  // receiving
  recYds:          integer("rec_yds").notNull().default(0),
  recTDs:          integer("rec_tds").notNull().default(0),
  recRec:          integer("rec_rec").notNull().default(0),
  recDrops:        integer("rec_drops").notNull().default(0),
  recLongest:      integer("rec_longest").notNull().default(0),
  recPts:          real("rec_pts").notNull().default(0),
  recYdsAfterCatch: integer("rec_yds_after_catch").notNull().default(0),
  recCatchPct:     real("rec_catch_pct").notNull().default(0),
  recToPct:        real("rec_to_pct").notNull().default(0),
  recYacPerCatch:  real("rec_yac_per_catch").notNull().default(0),
  recYdsPerCatch:  real("rec_yds_per_catch").notNull().default(0),
  recYdsPerGame:   real("rec_yds_per_game").notNull().default(0),
  // defense
  sacks:           real("sacks").notNull().default(0),
  defInts:         integer("def_ints").notNull().default(0),
  totalTackles:    integer("total_tackles").notNull().default(0),
  tackleSolo:      integer("tackle_solo").notNull().default(0),
  tackleAssist:    integer("tackle_assist").notNull().default(0),
  defFumblesRec:   integer("def_fumbles_rec").notNull().default(0),
  forcedFumbles:   integer("forced_fumbles").notNull().default(0),
  tacklesForLoss:  integer("tackles_for_loss").notNull().default(0),
  defTDs:          integer("def_tds").notNull().default(0),
  defCatchAllowed: integer("def_catch_allowed").notNull().default(0),
  defDeflections:  integer("def_deflections").notNull().default(0),
  defIntReturnYds: integer("def_int_return_yds").notNull().default(0),
  defPts:          real("def_pts").notNull().default(0),
  defSafeties:     integer("def_safeties").notNull().default(0),
  // kicking
  fgMade:          integer("fg_made").notNull().default(0),
  fgAtt:           integer("fg_att").notNull().default(0),
  fgLong:          integer("fg_long").notNull().default(0),
  xpMade:          integer("xp_made").notNull().default(0),
  xpAtt:           integer("xp_att").notNull().default(0),
  fg50PlusAtt:     integer("fg_50plus_att").notNull().default(0),
  fg50PlusMade:    integer("fg_50plus_made").notNull().default(0),
  kickPts:         real("kick_pts").notNull().default(0),
  kickoffAtt:      integer("kickoff_att").notNull().default(0),
  kickoffTBs:      integer("kickoff_tbs").notNull().default(0),
  fgCompPct:       real("fg_comp_pct").notNull().default(0),
  xpCompPct:       real("xp_comp_pct").notNull().default(0),
  // punting
  puntAtt:         integer("punt_att").notNull().default(0),
  puntYds:         integer("punt_yds").notNull().default(0),
  puntLong:        integer("punt_long").notNull().default(0),
  puntIn20:        integer("punt_in_20").notNull().default(0),
  puntTouchbacks:  integer("punt_touchbacks").notNull().default(0),
  puntNetYds:      integer("punt_net_yds").notNull().default(0),
  puntsBlocked:    integer("punts_blocked").notNull().default(0),
  puntNetYdsPerAtt: real("punt_net_yds_per_att").notNull().default(0),
  // kick return
  krAtt:           integer("kr_att").notNull().default(0),
  krYds:           integer("kr_yds").notNull().default(0),
  krTDs:           integer("kr_tds").notNull().default(0),
  // punt return
  prAtt:           integer("pr_att").notNull().default(0),
  prYds:           integer("pr_yds").notNull().default(0),
  prTDs:           integer("pr_tds").notNull().default(0),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_player_stats_idx").on(t.eaSeasonId, t.playerId, t.teamId),
}));

// ── Per-week player stats (raw, one row per player per week per stat type) ─────
export const mcaPlayerWeekStatsTable = pgTable("mca_player_week_stats", {
  id:          serial("id").primaryKey(),
  eaSeasonId:  integer("ea_season_id").notNull(),
  eaLeagueId:  integer("ea_league_id").notNull(),
  weekType:    text("week_type").notNull(),
  weekNum:     integer("week_num").notNull(),
  statType:    text("stat_type").notNull(),
  playerId:    integer("player_id").notNull(),
  teamId:      integer("team_id").notNull(),
  teamName:    text("team_name").notNull().default(""),
  firstName:   text("first_name").notNull().default(""),
  lastName:    text("last_name").notNull().default(""),
  position:    text("position").notNull().default(""),
  // passing
  passYds:     integer("pass_yds").notNull().default(0),
  passTDs:     integer("pass_tds").notNull().default(0),
  passAtt:     integer("pass_att").notNull().default(0),
  passComp:    integer("pass_comp").notNull().default(0),
  passInts:    integer("pass_ints").notNull().default(0),
  timesSacked: integer("times_sacked").notNull().default(0),
  passerRating: real("passer_rating").notNull().default(0),
  // rushing
  rushYds:     integer("rush_yds").notNull().default(0),
  rushTDs:     integer("rush_tds").notNull().default(0),
  rushAtt:     integer("rush_att").notNull().default(0),
  fumbles:     integer("fumbles").notNull().default(0),
  // receiving
  recYds:      integer("rec_yds").notNull().default(0),
  recTDs:      integer("rec_tds").notNull().default(0),
  recRec:      integer("rec_rec").notNull().default(0),
  recDrops:    integer("rec_drops").notNull().default(0),
  // defense
  sacks:       real("sacks").notNull().default(0),
  defInts:     integer("def_ints").notNull().default(0),
  totalTackles: integer("total_tackles").notNull().default(0),
  forcedFumbles: integer("forced_fumbles").notNull().default(0),
  defTDs:      integer("def_tds").notNull().default(0),
  // kicking
  fgMade:      integer("fg_made").notNull().default(0),
  fgAtt:       integer("fg_att").notNull().default(0),
  xpMade:      integer("xp_made").notNull().default(0),
  xpAtt:       integer("xp_att").notNull().default(0),
  // punting
  puntAtt:     integer("punt_att").notNull().default(0),
  puntYds:     integer("punt_yds").notNull().default(0),
  // returns
  krYds:       integer("kr_yds").notNull().default(0),
  krTDs:       integer("kr_tds").notNull().default(0),
  prYds:       integer("pr_yds").notNull().default(0),
  prTDs:       integer("pr_tds").notNull().default(0),
  rawJson:     json("raw_json"),               // full EA payload row — never loses a field
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_player_week_stats_idx").on(
    t.eaSeasonId, t.weekType, t.weekNum, t.statType, t.playerId,
  ),
}));

// ── Processed week markers (dedup guard for accumulation) ─────────────────────
export const mcaWeekProcessedTable = pgTable("mca_week_processed", {
  id:          serial("id").primaryKey(),
  eaSeasonId:  integer("ea_season_id").notNull(),
  weekType:    text("week_type").notNull(),
  weekNum:     integer("week_num").notNull(),
  statType:    text("stat_type").notNull(),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_week_processed_idx").on(t.eaSeasonId, t.weekType, t.weekNum, t.statType),
}));

// ── Draft picks ───────────────────────────────────────────────────────────────
export const mcaDraftPicksTable = pgTable("mca_draft_picks", {
  id:               serial("id").primaryKey(),
  eaSeasonId:       integer("ea_season_id").notNull(),
  eaLeagueId:       integer("ea_league_id").notNull(),
  teamId:           integer("team_id").notNull(),
  teamName:         text("team_name").notNull().default(""),
  draftYear:        integer("draft_year").notNull(),
  round:            integer("round").notNull(),
  pickNum:          integer("pick_num").notNull().default(0),
  originalTeamId:   integer("original_team_id"),
  originalTeamName: text("original_team_name"),
  importedAt:       timestamp("imported_at").notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("mca_draft_picks_idx").on(t.eaSeasonId, t.teamId, t.draftYear, t.round, t.pickNum),
}));
