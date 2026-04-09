import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminAddCoins            from "./admin-addcoins.js";
import * as adminRemoveCoins         from "./admin-removecoins.js";
import * as adminTransactions        from "./admin-transactions.js";
import * as adminReverseTransaction  from "./admin-reverse-transaction.js";
import * as adminLinkTeam            from "./admin-linkteam.js";
import * as adminClearteam           from "./admin-clearteam.js";
import * as adminSetUser             from "./admin-setuser.js";
import * as adminSetAdmin            from "./admin-setadmin.js";
import * as adminFixPlayerNames      from "./admin-fixplayernames.js";
import * as adminUserStats           from "./admin-userstats.js";
import * as adminListUserTeams       from "./admin-listuserteams.js";
import * as adminResetUpgrades       from "./admin-resetupgrades.js";
import { executeAddNewUser, autocompleteAddNewUser }     from "./admin-team.js";
import { executeDeleteMember, autocompleteDeleteMember } from "./admin-team.js";
import * as adminSeason              from "./admin-season.js";
import * as adminPlayoffs            from "./admin-playoffs.js";
import * as setweek                  from "./setweek.js";
import * as advanceweek              from "./advanceweek.js";
import * as adminResetWeek           from "./admin-resetweek.js";
import * as endofseasonpayout        from "./endofseasonpayout.js";
import * as adminResendPayouts       from "./admin-resend-payouts.js";
import * as postFullSeasonSchedule   from "./admin-postfullseasonschedule.js";
import * as adminRules               from "./admin-rules.js";
import * as adminSetPayouts          from "./admin-setpayouts.js";
import * as adminSetMilestoneTier    from "./admin-setmilestonetier.js";
import * as adminSetStatTier         from "./admin-set-stat-tiers.js";
import * as adminStatTiers           from "./admin-stat-tiers.js";
import * as adminCustomPlayerSettings from "./admin-customplayersettings.js";
import * as adminCustomArchetypes    from "./admin-customarchetypes.js";
import * as adminLegend              from "./admin-legend.js";
import * as adminLegendVault         from "./admin-legendvault.js";
import * as adminInventory           from "./admin-inventory.js";
import * as adminFullSync            from "./admin-fullsync.js";
import * as adminSyncMilestones      from "./admin-syncmilestones.js";
import * as adminManualScore         from "./admin-manualscore.js";
import * as adminCorrectPayout       from "./admin-correctpayout.js";
import * as adminResendArticle       from "./admin-resendarticle.js";
import * as adminGotw                from "./admin-gotw.js";
import * as adminPotw                from "./admin-potw.js";
import * as adminServer              from "./adminserver.js";
import * as adminCatchup             from "./admin-catchup.js";
import * as adminRollbackFranchise   from "./admin-rollback-franchise.js";
import { PAYOUT_KEYS }               from "../lib/payout-config.js";
import { STAT_CATEGORY_CHOICES }     from "../lib/stat-categories.js";
import { ALL_POSITIONS }             from "../lib/custom-player-helpers.js";

const WEEK_CHOICES = [
  { name: "Week 1",       value: "1"  },  { name: "Week 2",       value: "2"  },
  { name: "Week 3",       value: "3"  },  { name: "Week 4",       value: "4"  },
  { name: "Week 5",       value: "5"  },  { name: "Week 6",       value: "6"  },
  { name: "Week 7",       value: "7"  },  { name: "Week 8",       value: "8"  },
  { name: "Week 9",       value: "9"  },  { name: "Week 10",      value: "10" },
  { name: "Week 11",      value: "11" },  { name: "Week 12",      value: "12" },
  { name: "Week 13",      value: "13" },  { name: "Week 14",      value: "14" },
  { name: "Week 15",      value: "15" },  { name: "Week 16",      value: "16" },
  { name: "Week 17",      value: "17" },  { name: "Week 18",      value: "18" },
  { name: "Wildcard",     value: "wildcard"   },
  { name: "Divisional",   value: "divisional" },
  { name: "Conference",   value: "conference" },
  { name: "Super Bowl",   value: "superbowl"  },
  { name: "Offseason",    value: "offseason"  },
];

export const data = new SlashCommandBuilder()
  .setName("admin")
  .setDescription("Commissioner & admin tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  // ── coins ──────────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("coins")
    .setDescription("Manage member coin balances")
    .addSubcommand(s => s
      .setName("add_coins")
      .setDescription("Add coins to up to 32 users at once")
      .addStringOption(o => o.setName("users").setDescription("@mentions or space/comma-separated list").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Coins to add to each user").setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName("reason").setDescription("Optional reason shown to each user").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("remove_coins")
      .setDescription("Remove coins from a user's balance")
      .addUserOption(o => o.setName("user").setDescription("User to remove coins from").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Amount to remove").setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName("reason").setDescription("Optional reason").setRequired(false))
      .addBooleanOption(o => o.setName("allow_negative").setDescription("Allow balance to go negative?").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("transactions")
      .setDescription("View last 10 transactions for a user")
      .addStringOption(o => o.setName("team").setDescription("NFL team name").setRequired(false).setAutocomplete(true))
      .addUserOption(o => o.setName("user").setDescription("Discord user (alternative to team)").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("reverse_transaction")
      .setDescription("Reverse a coin transaction by ID")
      .addIntegerOption(o => o.setName("transaction_id").setDescription("Transaction ID from log").setRequired(true).setMinValue(1))
      .addIntegerOption(o => o.setName("purchase_id").setDescription("Purchase # to also reverse inventory/legend").setRequired(false).setMinValue(1))
      .addStringOption(o => o.setName("reason").setDescription("Reason for the reversal").setRequired(false).setMaxLength(200))
    )
  )

  // ── player ─────────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("player")
    .setDescription("Manage players and team assignments")
    .addSubcommand(s => s
      .setName("set")
      .setDescription("Assign a team to an existing player (does NOT wipe balance or records)")
      .addUserOption(o => o.setName("user").setDescription("Discord user to assign").setRequired(true))
      .addStringOption(o => o.setName("team").setDescription("NFL team name").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(s => s
      .setName("view")
      .setDescription("Show all current player → team assignments")
    )
    .addSubcommand(s => s
      .setName("clear")
      .setDescription("Unlink a user from their team and clear their season W/L records")
      .addStringOption(o => o.setName("team").setDescription("NFL team to unlink").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(s => s
      .setName("add")
      .setDescription("Add a new user to a team slot (clears old owner's data)")
      .addUserOption(o => o.setName("user").setDescription("New Discord member joining this team").setRequired(true))
      .addStringOption(o => o.setName("team").setDescription("NFL team name").setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName("starting_balance").setDescription("Starting coin balance (default: 0)").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("delete")
      .setDescription("Permanently delete all data for a team/user")
      .addStringOption(o => o.setName("team").setDescription("NFL team name (or use @user)").setRequired(false).setAutocomplete(true))
      .addUserOption(o => o.setName("user").setDescription("Discord user (used if no team provided)").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("set_user")
      .setDescription("Manually set any stat for a user")
      .addStringOption(o => o.setName("team").setDescription("NFL team name").setRequired(false).setAutocomplete(true))
      .addUserOption(o => o.setName("user").setDescription("Discord user (alternative to team)").setRequired(false))
      .addIntegerOption(o => o.setName("coins").setDescription("Set coin balance").setRequired(false).setMinValue(0))
      .addIntegerOption(o => o.setName("legend_total").setDescription("Set all-time legend purchase count").setRequired(false).setMinValue(0))
      .addIntegerOption(o => o.setName("wins").setDescription("Set current season regular season wins").setRequired(false).setMinValue(0))
      .addIntegerOption(o => o.setName("losses").setDescription("Set current season regular season losses").setRequired(false).setMinValue(0))
      .addIntegerOption(o => o.setName("point_differential").setDescription("Set current season point differential").setRequired(false))
      .addIntegerOption(o => o.setName("playoff_wins").setDescription("Set current season playoff wins").setRequired(false).setMinValue(0))
      .addIntegerOption(o => o.setName("playoff_losses").setDescription("Set current season playoff losses").setRequired(false).setMinValue(0))
    )
    .addSubcommand(s => s
      .setName("grant")
      .setDescription("Grant bot-admin status to a user")
      .addUserOption(o => o.setName("user").setDescription("User to grant admin status").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("revoke")
      .setDescription("Revoke bot-admin status from a user")
      .addUserOption(o => o.setName("user").setDescription("User to revoke admin status from").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("list")
      .setDescription("List all current bot admins")
    )
    .addSubcommand(s => s
      .setName("fix_names")
      .setDescription("Backfill missing player names in stat leaders from roster data")
    )
    .addSubcommand(s => s
      .setName("view_stats")
      .setDescription("View full stats, coins, and inventory for any user")
      .addUserOption(o => o.setName("user").setDescription("The user to look up").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("list_teams")
      .setDescription("List all active users and their linked teams")
    )
    .addSubcommand(s => s
      .setName("reset_upgrades")
      .setDescription("Reset a user's upgrade counts for the current season")
      .addUserOption(o => o.setName("user").setDescription("The user to reset").setRequired(true))
      .addStringOption(o => o.setName("type").setDescription("Which upgrades to reset?").setRequired(true)
        .addChoices(
          { name: "All upgrades (attributes, dev ups, age resets)", value: "all"           },
          { name: "Core attributes only",                           value: "core_attr"     },
          { name: "Non-core attributes only",                       value: "non_core_attr" },
          { name: "All attributes (core + non-core)",               value: "attributes"    },
          { name: "Dev Upgrades only",                              value: "dev_ups"       },
          { name: "Age Resets only",                                value: "age_resets"    },
        )
      )
    )
  )

  // ── season ─────────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("season")
    .setDescription("Season & schedule management")
    .addSubcommand(s => s
      .setName("new")
      .setDescription("Advance to the next season (subject to franchise season limit)")
    )
    .addSubcommand(s => s
      .setName("set")
      .setDescription("Jump directly to a specific season number (1–50)")
      .addIntegerOption(o => o.setName("number").setDescription("Season number to activate").setRequired(true).setMinValue(1).setMaxValue(50))
    )
    .addSubcommand(s => s
      .setName("franchise_limit")
      .setDescription("Set the maximum number of seasons allowed in this franchise (1–50)")
      .addIntegerOption(o => o.setName("limit").setDescription("Max seasons (1–50)").setRequired(true).setMinValue(1).setMaxValue(50))
    )
    .addSubcommand(s => s
      .setName("franchise_reset")
      .setDescription("⚠️ END-OF-FRANCHISE RESET: returns all legends to store, resets all coins, restarts at Season 1")
      .addBooleanOption(o => o.setName("confirm").setDescription("Set to True to confirm this irreversible action").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("status")
      .setDescription("View current season info")
    )
    .addSubcommand(s => s
      .setName("override")
      .setDescription("Set attribute rule overrides for the current season")
      .addIntegerOption(o => o.setName("core_attr_cost").setDescription("Cost per core attribute point (default: 25)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("core_attr_cap").setDescription("Max core attribute points this season (default: 16)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("non_core_attr_cost").setDescription("Cost per non-core attribute point (default: 10)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("non_core_attr_cap").setDescription("Max non-core attribute points this season (default: 32)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("dev_ups_cap").setDescription("Max dev upgrades per season (default: 2)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("dev_ups_cost").setDescription("Coin cost per dev upgrade (default: 250)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("age_resets_cap").setDescription("Max age resets per season (default: 2)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("age_resets_cost").setDescription("Coin cost per age reset (default: 250)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("legend_cost").setDescription("Coin cost per legend (default: 1000)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("custom_gold_cost").setDescription("Coin cost for a Gold custom player (default: 300)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("custom_silver_cost").setDescription("Coin cost for a Silver custom player (default: 200)").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("custom_bronze_cost").setDescription("Coin cost for a Bronze custom player (default: 100)").setRequired(false).setMinValue(1))
      .addBooleanOption(o => o.setName("clear").setDescription("Set to True to clear ALL overrides and restore defaults").setRequired(false))
    )
    .addSubcommand(s => {
      let sub = s
        .setName("core_attrs")
        .setDescription("Set which attributes count as Core this season (1–10)")
        .addStringOption(o => o.setName("attr1").setDescription("Core attribute #1 (required — at least one)").setRequired(true).setAutocomplete(true));
      for (let i = 2; i <= 10; i++) {
        sub = sub.addStringOption(o => o.setName(`attr${i}`).setDescription(`Core attribute #${i}`).setRequired(false).setAutocomplete(true));
      }
      return sub.addBooleanOption(o => o.setName("reset").setDescription("Set to True to restore default core attribute list").setRequired(false));
    })
    .addSubcommand(s => s
      .setName("nfc_seeds")
      .setDescription("Register NFC playoff seeds 1–7 (seeds 1–4 get top-4 playoff payout rate)")
      .addUserOption(o => o.setName("seed1").setDescription("NFC seed #1").setRequired(true))
      .addUserOption(o => o.setName("seed2").setDescription("NFC seed #2").setRequired(true))
      .addUserOption(o => o.setName("seed3").setDescription("NFC seed #3").setRequired(true))
      .addUserOption(o => o.setName("seed4").setDescription("NFC seed #4").setRequired(true))
      .addUserOption(o => o.setName("seed5").setDescription("NFC seed #5 (wildcard)").setRequired(false))
      .addUserOption(o => o.setName("seed6").setDescription("NFC seed #6 (wildcard)").setRequired(false))
      .addUserOption(o => o.setName("seed7").setDescription("NFC seed #7 (wildcard)").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("afc_seeds")
      .setDescription("Register AFC playoff seeds 1–7 (seeds 1–4 get top-4 playoff payout rate)")
      .addUserOption(o => o.setName("seed1").setDescription("AFC seed #1").setRequired(true))
      .addUserOption(o => o.setName("seed2").setDescription("AFC seed #2").setRequired(true))
      .addUserOption(o => o.setName("seed3").setDescription("AFC seed #3").setRequired(true))
      .addUserOption(o => o.setName("seed4").setDescription("AFC seed #4").setRequired(true))
      .addUserOption(o => o.setName("seed5").setDescription("AFC seed #5 (wildcard)").setRequired(false))
      .addUserOption(o => o.setName("seed6").setDescription("AFC seed #6 (wildcard)").setRequired(false))
      .addUserOption(o => o.setName("seed7").setDescription("AFC seed #7 (wildcard)").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("division_bonus")
      .setDescription(`Award division winner bonus (run at season end)`)
      .addUserOption(o => o.setName("winner1").setDescription("Division winner").setRequired(true))
      .addUserOption(o => o.setName("winner2").setDescription("Division winner").setRequired(false))
      .addUserOption(o => o.setName("winner3").setDescription("Division winner").setRequired(false))
      .addUserOption(o => o.setName("winner4").setDescription("Division winner").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("set_week")
      .setDescription("Manually set the current league week without server changes")
      .addStringOption(o => o.setName("week").setDescription("The week to set").setRequired(true).addChoices(...WEEK_CHOICES))
    )
    .addSubcommand(s => s
      .setName("advance_week")
      .setDescription("Advance or set the current league week")
      .addStringOption(o => o.setName("week").setDescription("The week to set (leave blank to auto-advance)").setRequired(false).addChoices(...WEEK_CHOICES))
    )
    .addSubcommand(s => s
      .setName("reset_week")
      .setDescription("Clear franchise game records and interviews for a week so members can re-qualify")
      .addStringOption(o => o.setName("week").setDescription("Which week to reset?").setRequired(true).addChoices(...WEEK_CHOICES))
      .addBooleanOption(o => o.setName("confirm").setDescription("Set to True to confirm deletion — cannot be undone").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("end_of_season")
      .setDescription("Calculate end-of-season tier payouts and post to commissioner log")
      .addUserOption(o => o.setName("user").setDescription("The Discord user (team owner) to pay out").setRequired(true))
      .addNumberOption(o => o.setName("off_pass_yds").setDescription("Passing Yards (season total)").setRequired(false))
      .addNumberOption(o => o.setName("off_rush_yds").setDescription("Rushing Yards (season total)").setRequired(false))
      .addNumberOption(o => o.setName("off_pts_per_game").setDescription("Points Per Game (PPG, e.g. 31.5)").setRequired(false))
      .addNumberOption(o => o.setName("off_redzone_pct").setDescription("Offensive Red Zone % (e.g. 72.4)").setRequired(false))
      .addNumberOption(o => o.setName("def_pass_yds").setDescription("Passing Yards Allowed (season total)").setRequired(false))
      .addNumberOption(o => o.setName("def_rush_yds").setDescription("Rushing Yards Allowed (season total)").setRequired(false))
      .addNumberOption(o => o.setName("def_pts_allowed").setDescription("Total Points Allowed").setRequired(false))
      .addNumberOption(o => o.setName("def_sacks").setDescription("Defensive Sacks (season total)").setRequired(false))
      .addNumberOption(o => o.setName("def_ints").setDescription("Defensive Interceptions (season total)").setRequired(false))
      .addNumberOption(o => o.setName("def_fumbles_rec").setDescription("Recovered Fumbles (season total)").setRequired(false))
      .addNumberOption(o => o.setName("def_redzone_pct").setDescription("Defensive Red Zone % Allowed (e.g. 48.2)").setRequired(false))
      .addBooleanOption(o => o.setName("rb_ypc_bonus").setDescription("RB qualified: 7.0+ YPC with 100+ carries?").setRequired(false))
      .addBooleanOption(o => o.setName("qb_ypa_bonus").setDescription("QB qualified: 8.5+ YPA with 150+ attempts?").setRequired(false))
      .addBooleanOption(o => o.setName("db_int_bonus").setDescription("DB qualified: individual player with 8+ INTs?").setRequired(false))
      .addIntegerOption(o => o.setName("award_count").setDescription("Number of in-game award winners on this team").setRequired(false).setMinValue(0).setMaxValue(20))
      .addBooleanOption(o => o.setName("missed_playoffs").setDescription("Did this user-controlled team miss the playoffs?").setRequired(false))
      .addBooleanOption(o => o.setName("dry_run").setDescription("Preview without posting to commissioner (default: false)").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("resend_payouts")
      .setDescription("Scan stream/highlight channels for missed payouts and issue them")
      .addStringOption(o => o.setName("type").setDescription("Which payout type to recover (default: both)").setRequired(false)
        .addChoices(
          { name: "Streams only",    value: "stream"    },
          { name: "Highlights only", value: "highlight" },
          { name: "Both",            value: "both"      },
        )
      )
    )
    .addSubcommand(s => s
      .setName("post_schedule")
      .setDescription("Post the full 18-week season schedule to the schedule channel")
    )
    .addSubcommand(s => s
      .setName("rollback")
      .setDescription("Reverse all data written by a franchise import after a given timestamp")
      .addStringOption(o => o.setName("since").setDescription("ISO timestamp of when the bad import started (e.g. 2026-03-31T19:00:00)").setRequired(true))
      .addBooleanOption(o => o.setName("dry_run").setDescription("Preview without making changes — default: TRUE").setRequired(false))
    )
  )

  // ── rules ──────────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("rules")
    .setDescription("Manage league rules")
    .addSubcommand(s => s
      .setName("new_section")
      .setDescription("Create a new custom rules section")
      .addStringOption(o => o.setName("key").setDescription("Internal key (lowercase, underscores — e.g. overtime_rules)").setRequired(true))
      .addStringOption(o => o.setName("title").setDescription("Display title shown in embeds (e.g. ⏱️ Overtime Rules)").setRequired(true))
      .addIntegerOption(o => o.setName("color").setDescription("Embed color (default: Blue)").setRequired(false)
        .addChoices(
          { name: "Blue",   value: 0x3498db }, { name: "Green",  value: 0x57f287 },
          { name: "Gold",   value: 0xfee75c }, { name: "Red",    value: 0xed4245 },
          { name: "Purple", value: 0xa855f7 }, { name: "Orange", value: 0xeb6f31 },
          { name: "Pink",   value: 0xff73fa }, { name: "Teal",   value: 0x1abc9c },
        )
      )
    )
    .addSubcommand(s => s
      .setName("list")
      .setDescription("List all rules in a section with their numbers")
      .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(s => s
      .setName("set")
      .setDescription("Edit a specific rule by its number")
      .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName("rule_number").setDescription("Rule number to edit (see /admin rules list)").setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName("text").setDescription("New text for this rule").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("add")
      .setDescription("Append a new rule to a section")
      .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName("text").setDescription("Text for the new rule").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("remove")
      .setDescription("Remove a rule by its number from a section")
      .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName("rule_number").setDescription("Rule number to remove (see /admin rules list)").setRequired(true).setMinValue(1))
    )
    .addSubcommand(s => s
      .setName("reset")
      .setDescription("Reset a built-in section to defaults, or clear all rules in a custom section")
      .addStringOption(o => o.setName("section").setDescription("Which section?").setRequired(true).setAutocomplete(true))
    )
  )

  // ── store ──────────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("store")
    .setDescription("Economy payouts, stat tiers, and custom player settings")
    .addSubcommand(s => s
      .setName("payouts_view")
      .setDescription("Show ALL current economy values (payouts, bonuses, store prices)")
    )
    .addSubcommand(s => s
      .setName("payouts_set")
      .setDescription("Update a specific payout or bonus amount")
      .addStringOption(o => o.setName("reward").setDescription("Which value to update").setRequired(true)
        .addChoices(
          { name: "🎮 Game — H2H win (both players played)",               value: PAYOUT_KEYS.H2H_WIN         },
          { name: "🎮 Game — H2H loss (both players played)",              value: PAYOUT_KEYS.H2H_LOSS        },
          { name: "🤖 Game — CPU/force win (one-sided or simmed game)",    value: PAYOUT_KEYS.CPU_WIN         },
          { name: "🏅 Season bonus — in-game award winner (per team)",     value: PAYOUT_KEYS.AWARD_WIN_BONUS },
          { name: "📊 Season PR bonus — #1 ranked player",                 value: PAYOUT_KEYS.SEASON_PR_1     },
          { name: "📊 Season PR bonus — #2 ranked player",                 value: PAYOUT_KEYS.SEASON_PR_2     },
          { name: "📊 Season PR bonus — #3–6 ranked players",              value: PAYOUT_KEYS.SEASON_PR_3_6   },
          { name: "📊 Season PR bonus — #7–8 ranked players",              value: PAYOUT_KEYS.SEASON_PR_7_8   },
          { name: "📊 Season PR bonus — #9–10 ranked players",             value: PAYOUT_KEYS.SEASON_PR_9_10  },
          { name: "🎮 GOTY award — coins per winner",                      value: PAYOUT_KEYS.GOTY_WINNER     },
          { name: "🏃 EOS bonus — top RB qualifying YPC (coins)",           value: PAYOUT_KEYS.EOS_RB_YPC_BONUS    },
          { name: "🏈 EOS bonus — top QB qualifying YPA (coins)",           value: PAYOUT_KEYS.EOS_QB_YPA_BONUS    },
          { name: "🛡️ EOS bonus — DB individual player 8+ INTs",           value: PAYOUT_KEYS.EOS_DB_INT_BONUS    },
          { name: "😔 EOS consolation — missed playoffs (user team)",       value: PAYOUT_KEYS.EOS_MISSED_PLAYOFFS },
          { name: "🏈 EOS QB YPA — minimum pass attempts to qualify",       value: PAYOUT_KEYS.EOS_QB_MIN_ATT      },
          { name: "🏃 EOS RB YPC — minimum rush attempts to qualify",       value: PAYOUT_KEYS.EOS_RB_MIN_ATT      },
        )
      )
      .addIntegerOption(o => o.setName("amount").setDescription("New coin amount (0 or more)").setRequired(true).setMinValue(0).setMaxValue(10000))
    )
    .addSubcommand(s => s
      .setName("set_milestone_tier")
      .setDescription("Manually set a user's career milestone tier (does not adjust coins)")
      .addUserOption(o => o.setName("user").setDescription("The user whose milestone tier to set").setRequired(true))
      .addIntegerOption(o => o.setName("tier").setDescription("The milestone tier to assign").setRequired(true)
        .addChoices(
          { name: "0 — None (no milestone awarded yet)",  value: 0 },
          { name: "1 — 5 All-Time Wins  (+100 coins)",   value: 1 },
          { name: "2 — 12 All-Time Wins (+250 coins)",   value: 2 },
          { name: "3 — 25 All-Time Wins (+500 coins)",   value: 3 },
          { name: "4 — 50 All-Time Wins (+1000 coins)",  value: 4 },
        )
      )
    )
    .addSubcommand(s => s
      .setName("set_stat_tier")
      .setDescription("Set a single tier threshold/payout for an end-of-season stat bonus category")
      .addStringOption(o => o.setName("category").setDescription("Stat category to configure").setRequired(true).addChoices(...STAT_CATEGORY_CHOICES))
      .addIntegerOption(o => o.setName("tier").setDescription("Tier number (1 = lowest, 4 = best payout)").setRequired(true).setMinValue(1).setMaxValue(4))
      .addIntegerOption(o => o.setName("threshold").setDescription("Qualifying value (min for higher-is-better, max for lower-is-better)").setRequired(true))
      .addIntegerOption(o => o.setName("payout").setDescription("Coin payout for reaching this tier").setRequired(true).setMinValue(0))
      .addIntegerOption(o => o.setName("min_attempts").setDescription("Minimum attempts required to qualify").setRequired(false).setMinValue(0))
    )
    .addSubcommand(s => s
      .setName("view_stat_tiers")
      .setDescription("View all end-of-season stat tier configs for the active season")
    )
    .addSubcommand(s => s
      .setName("settings_view")
      .setDescription("View current custom player package settings (points and cost per tier)")
    )
    .addSubcommand(s => s
      .setName("settings_set")
      .setDescription("Update a custom player package's creation points and/or coin cost")
      .addStringOption(o => o.setName("package").setDescription("Package tier to update").setRequired(true)
        .addChoices(
          { name: "Bronze",      value: "bronze" },
          { name: "Silver",      value: "silver" },
          { name: "Gold",        value: "gold"   },
          { name: "K/P Default", value: "kp"     },
        )
      )
      .addIntegerOption(o => o.setName("points").setDescription("New creation point budget").setRequired(false).setMinValue(1))
      .addIntegerOption(o => o.setName("cost").setDescription("New coin cost").setRequired(false).setMinValue(0))
    )
  )

  // ── archetypes ────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("archetypes")
    .setDescription("Manage custom player archetypes")
    .addSubcommand(s => s
      .setName("list")
      .setDescription("List all archetypes (optionally filter by position)")
      .addStringOption(o => o.setName("position").setDescription("Filter by position").setRequired(false)
        .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p })))
      )
    )
    .addSubcommand(s => s
      .setName("seed_defaults")
      .setDescription("Seed all positions with default Madden-style archetypes")
      .addBooleanOption(o => o.setName("overwrite").setDescription("Overwrite archetypes that already exist? (default: false)").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("add")
      .setDescription("Add or replace an archetype (JSON format: {\"Speed\":70,...})")
      .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true).addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
      .addStringOption(o => o.setName("name").setDescription("Archetype name").setRequired(true))
      .addStringOption(o => o.setName("attributes").setDescription('JSON object: {"Speed":70,"Acceleration":72,...}').setRequired(true))
    )
    .addSubcommand(s => s
      .setName("remove")
      .setDescription("Deactivate an archetype")
      .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true).addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
      .addStringOption(o => o.setName("name").setDescription("Archetype name to deactivate").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("restore")
      .setDescription("Re-activate a deactivated archetype")
      .addStringOption(o => o.setName("position").setDescription("Position").setRequired(true).addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p }))))
      .addStringOption(o => o.setName("name").setDescription("Archetype name").setRequired(true))
    )
  )

  // ── legend ─────────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("legend")
    .setDescription("Manage legends and legend vaults")
    .addSubcommand(s => s
      .setName("add")
      .setDescription("Add a new legend to the store")
      .addStringOption(o => o.setName("name").setDescription("Legend name").setRequired(true))
      .addStringOption(o => o.setName("position").setDescription("Player position").setRequired(true))
      .addStringOption(o => o.setName("description").setDescription("Optional description").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("list")
      .setDescription("View all legends — store, current-season owned, and permanent vaults")
    )
    .addSubcommand(s => s
      .setName("edit")
      .setDescription("Edit a legend's details")
      .addIntegerOption(o => o.setName("id").setDescription("Legend ID").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("New name").setRequired(false))
      .addStringOption(o => o.setName("position").setDescription("New position").setRequired(false))
      .addStringOption(o => o.setName("description").setDescription("New description").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("vault_add")
      .setDescription("Add a legend directly to a user's permanent vault (retroactive / commissioner use)")
      .addUserOption(o => o.setName("user").setDescription("User to receive the legend").setRequired(true))
      .addStringOption(o => o.setName("legend_name").setDescription("Name of the legend (e.g. Jerry Rice)").setRequired(true))
      .addStringOption(o => o.setName("position").setDescription("Position (e.g. WR, QB, CB)").setRequired(true))
      .addStringOption(o => o.setName("description").setDescription("Optional description for the store entry").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("vault_view")
      .setDescription("View all legend inventory for a user (shows item IDs)")
      .addUserOption(o => o.setName("user").setDescription("User to inspect").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("vault_move")
      .setDescription("Move a legend between current and permanent categories")
      .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
      .addIntegerOption(o => o.setName("item_id").setDescription("Inventory item ID (see /admin legend vaultView)").setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName("to").setDescription("Target category").setRequired(true)
        .addChoices({ name: "Current Season", value: "current" }, { name: "Permanent Vault", value: "permanent" })
      )
    )
    .addSubcommand(s => s
      .setName("vault_remove")
      .setDescription("Remove a legend inventory item by its ID")
      .addIntegerOption(o => o.setName("item_id").setDescription("Inventory item ID (see /admin legend vaultView)").setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName("reason").setDescription("Optional reason").setRequired(false))
    )
  )

  // ── inventory ──────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("inventory")
    .setDescription("Manage user inventory items")
    .addSubcommand(s => s
      .setName("view")
      .setDescription("View all inventory items for a user (shows item IDs)")
      .addUserOption(o => o.setName("user").setDescription("User whose inventory to view").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("remove")
      .setDescription("Remove an inventory item by its ID")
      .addIntegerOption(o => o.setName("item_id").setDescription("The item ID (see /admin inventory view)").setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName("reason").setDescription("Optional reason for removal").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("move")
      .setDescription("Transfer an inventory item to a different user")
      .addIntegerOption(o => o.setName("item_id").setDescription("The item ID (see /admin inventory view)").setRequired(true).setMinValue(1))
      .addUserOption(o => o.setName("to_user").setDescription("User who will receive the item").setRequired(true))
    )
  )

  // ── tools ──────────────────────────────────────────────────────────────────
  .addSubcommandGroup(g => g
    .setName("tools")
    .setDescription("System and diagnostic tools")
    .addSubcommand(s => s
      .setName("full_sync")
      .setDescription("Full sync: auto-link teams, process stored games, award missed payouts & milestones")
    )
    .addSubcommand(s => s
      .setName("sync_milestones")
      .setDescription("Sync win/loss counters and issue any missing milestone bonuses")
      .addUserOption(o => o.setName("user").setDescription("Target one player only (leave blank to sync all)").setRequired(false))
      .addIntegerOption(o => o.setName("wins").setDescription("Correct this player's all-time H2H wins to this exact number").setRequired(false).setMinValue(0))
      .addIntegerOption(o => o.setName("losses").setDescription("Correct this player's all-time H2H losses to this exact number").setRequired(false).setMinValue(0))
    )
    .addSubcommand(s => s
      .setName("manual_score")
      .setDescription("Manually record a game result when MCA is unavailable")
      .addUserOption(o => o.setName("homeuser").setDescription("Discord user who played the HOME team").setRequired(true))
      .addIntegerOption(o => o.setName("homescore").setDescription("Home team final score").setRequired(true).setMinValue(0))
      .addIntegerOption(o => o.setName("awayscore").setDescription("Away team final score").setRequired(true).setMinValue(0))
      .addIntegerOption(o => o.setName("week").setDescription("Week number (1–18)").setRequired(true).setMinValue(1).setMaxValue(18))
      .addUserOption(o => o.setName("awayuser").setDescription("Discord user who played the AWAY team").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("correct_payout")
      .setDescription("Retroactively fix a game's payout type and correct coins/records")
      .addIntegerOption(o => o.setName("week").setDescription("Week number (1–18)").setRequired(true).setMinValue(1).setMaxValue(18))
      .addUserOption(o => o.setName("homeuser").setDescription("Player who controlled the HOME team").setRequired(true))
      .addUserOption(o => o.setName("awayuser").setDescription("Player who controlled the AWAY team").setRequired(true))
      .addStringOption(o => o.setName("type").setDescription("The CORRECT payout type for this game").setRequired(true)
        .addChoices(
          { name: "H2H (both played)",          value: "h2h"       },
          { name: "CPU/Force (one-sided)",       value: "cpu"       },
          { name: "Disputed (no payout)",        value: "disputed"  },
          { name: "Bye (no payout)",             value: "bye"       },
        )
      )
      .addStringOption(o => o.setName("winner").setDescription("Who won — required when type is h2h or cpu").setRequired(false)
        .addChoices({ name: "Home team won", value: "home" }, { name: "Away team won", value: "away" })
      )
      .addIntegerOption(o => o.setName("pointdiff").setDescription("Point differential (winning score − losing score) — required for h2h").setRequired(false).setMinValue(1))
      .addStringOption(o => o.setName("gameid").setDescription("Override: paste the exact game ID if auto-lookup fails").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("resend_article")
      .setDescription("Regenerate and repost a weekly article for any week")
      .addIntegerOption(o => o.setName("week").setDescription("Which week to write about (1–18)").setRequired(true).setMinValue(1).setMaxValue(18))
      .addStringOption(o => o.setName("mode").setDescription("recap = post-game article | preview = pre-game hype (default: recap)").setRequired(false)
        .addChoices({ name: "Recap",   value: "recap"   }, { name: "Preview", value: "preview" })
      )
      .addStringOption(o => o.setName("upcoming").setDescription('(Recap only) Label for the next week, e.g. "Week 11" or "Wildcard"').setRequired(false))
      .addBooleanOption(o => o.setName("ping_everyone").setDescription("Ping @everyone when posting? (default: true)").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("gotw")
      .setDescription("Award GOTW correct-guess bonuses in bulk")
      .addUserOption(o => o.setName("user1").setDescription("Correct guesser").setRequired(true))
      .addUserOption(o => o.setName("user2").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user3").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user4").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user5").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user6").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user7").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user8").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user9").setDescription("Correct guesser").setRequired(false))
      .addUserOption(o => o.setName("user10").setDescription("Correct guesser").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("potw")
      .setDescription("Award Player of the Week bonus — 1 to 4 players")
      .addUserOption(o => o.setName("player1").setDescription("POTW recipient").setRequired(true))
      .addUserOption(o => o.setName("player2").setDescription("POTW recipient").setRequired(false))
      .addUserOption(o => o.setName("player3").setDescription("POTW recipient").setRequired(false))
      .addUserOption(o => o.setName("player4").setDescription("POTW recipient").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("settings")
      .setDescription("Toggle server features on/off (coin economy, store items, wagers, trade block)")
    )
    .addSubcommand(s => s
      .setName("on")
      .setDescription("Enable catchup mode — clears all season stats and disables payouts during MCA imports")
    )
    .addSubcommand(s => s
      .setName("off")
      .setDescription("Disable catchup mode — MCA imports resume normal payouts and notifications")
    )
    .addSubcommand(s => s
      .setName("status")
      .setDescription("Check whether catchup mode is currently active")
    )
  );

// ── Execute router ─────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const group = interaction.options.getSubcommandGroup(true);
  const sub   = interaction.options.getSubcommand(true);

  // ── coins ──────────────────────────────────────────────────────────────────
  if (group === "coins") {
    if (sub === "add_coins")           return adminAddCoins.execute(interaction);
    if (sub === "remove_coins")        return adminRemoveCoins.execute(interaction);
    if (sub === "transactions")       return adminTransactions.execute(interaction);
    if (sub === "reverse_transaction") return adminReverseTransaction.execute(interaction);
  }

  // ── player ─────────────────────────────────────────────────────────────────
  if (group === "player") {
    if (sub === "set" || sub === "view") return adminLinkTeam.execute(interaction);
    if (sub === "clear")                 return adminClearteam.execute(interaction);
    if (sub === "add")                   return executeAddNewUser(interaction);
    if (sub === "delete")                return executeDeleteMember(interaction);
    if (sub === "set_user")               return adminSetUser.execute(interaction);
    if (sub === "grant" || sub === "revoke" || sub === "list") return adminSetAdmin.execute(interaction);
    if (sub === "fix_names")              return adminFixPlayerNames.execute(interaction);
    if (sub === "view_stats")             return adminUserStats.execute(interaction);
    if (sub === "list_teams")             return adminListUserTeams.execute(interaction);
    if (sub === "reset_upgrades")         return adminResetUpgrades.execute(interaction);
  }

  // ── season ─────────────────────────────────────────────────────────────────
  if (group === "season") {
    if (["new","set","franchise_limit","franchise_reset","status","override","core_attrs"].includes(sub))
      return adminSeason.execute(interaction);
    if (sub === "nfc_seeds" || sub === "afc_seeds" || sub === "division_bonus")
      return adminPlayoffs.execute(interaction);
    if (sub === "set_week")      return setweek.execute(interaction);
    if (sub === "advance_week")  return advanceweek.execute(interaction);
    if (sub === "reset_week")    return adminResetWeek.execute(interaction);
    if (sub === "end_of_season")  return endofseasonpayout.execute(interaction);
    if (sub === "resend_payouts") return adminResendPayouts.execute(interaction);
    if (sub === "post_schedule") return postFullSeasonSchedule.execute(interaction);
    if (sub === "rollback")     return adminRollbackFranchise.execute(interaction);
  }

  // ── rules ──────────────────────────────────────────────────────────────────
  if (group === "rules") {
    return adminRules.execute(interaction);
  }

  // ── store ──────────────────────────────────────────────────────────────────
  if (group === "store") {
    if (sub === "payouts_view" || sub === "payouts_set") return adminSetPayouts.execute(interaction);
    if (sub === "set_milestone_tier")                    return adminSetMilestoneTier.execute(interaction);
    if (sub === "set_stat_tier")                         return adminSetStatTier.execute(interaction);
    if (sub === "view_stat_tiers")                       return adminStatTiers.execute(interaction);
    if (sub === "settings_view" || sub === "settings_set") return adminCustomPlayerSettings.execute(interaction);
  }

  // ── archetypes ─────────────────────────────────────────────────────────────
  if (group === "archetypes") {
    return adminCustomArchetypes.execute(interaction);
  }

  // ── legend ─────────────────────────────────────────────────────────────────
  if (group === "legend") {
    if (sub === "add" || sub === "list" || sub === "edit") return adminLegend.execute(interaction);
    if (sub === "vault_add" || sub === "vault_view" || sub === "vault_move" || sub === "vault_remove")
      return adminLegendVault.execute(interaction);
  }

  // ── inventory ──────────────────────────────────────────────────────────────
  if (group === "inventory") {
    return adminInventory.execute(interaction);
  }

  // ── tools ──────────────────────────────────────────────────────────────────
  if (group === "tools") {
    if (sub === "full_sync")       return adminFullSync.execute(interaction);
    if (sub === "sync_milestones") return adminSyncMilestones.execute(interaction);
    if (sub === "manual_score")    return adminManualScore.execute(interaction);
    if (sub === "correct_payout")  return adminCorrectPayout.execute(interaction);
    if (sub === "resend_article")  return adminResendArticle.execute(interaction);
    if (sub === "gotw")           return adminGotw.execute(interaction);
    if (sub === "potw")           return adminPotw.execute(interaction);
    if (sub === "settings")       return adminServer.execute(interaction);
    if (sub === "on" || sub === "off" || sub === "status") return adminCatchup.execute(interaction);
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(`❌ Unknown subcommand: \`${group} ${sub}\``);
  return;
}

// ── Autocomplete router ────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const group = interaction.options.getSubcommandGroup();
    const sub   = interaction.options.getSubcommand();

    if (group === "rules") return adminRules.autocomplete(interaction);

    if (group === "season" && sub === "core_attrs") return adminSeason.autocomplete(interaction);

    if (group === "player") {
      if (sub === "set" || sub === "view") return adminLinkTeam.autocomplete(interaction);
      if (sub === "clear")   return adminClearteam.autocomplete(interaction);
      if (sub === "set_user") return adminSetUser.autocomplete(interaction);
      if (sub === "add")     return autocompleteAddNewUser(interaction);
      if (sub === "delete")  return autocompleteDeleteMember(interaction);
    }

    if (group === "coins") {
      if (sub === "transactions") {
        const focused = interaction.options.getFocused().toLowerCase();
        const { NFL_TEAMS } = await import("../lib/constants.js");
        const choices = NFL_TEAMS.filter((t: string) => t.toLowerCase().startsWith(focused)).slice(0, 25)
          .map((t: string) => ({ name: t, value: t }));
        await interaction.respond(choices);
        return;
      }
    }

    // archetypes group: no autocomplete options

    await interaction.respond([]).catch(() => {});
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}
