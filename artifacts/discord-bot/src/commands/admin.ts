import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminAddCoins            from "./admin-addcoins.js";
import * as adminRemoveCoins         from "./admin-removecoins.js";
import * as adminReverseTransaction  from "./admin-reverse-transaction.js";
import * as adminLinkTeam            from "./admin-linkteam.js";
import * as adminClearteam           from "./admin-clearteam.js";
import * as adminSetUser             from "./admin-setuser.js";
import * as adminSetAdmin            from "./admin-setadmin.js";
import * as adminFixPlayerNames      from "./admin-fixplayernames.js";
import * as adminSetPayouts          from "./admin-setpayouts.js";
import * as adminSetMilestoneTier    from "./admin-setmilestonetier.js";
import * as adminSetStatTier         from "./admin-set-stat-tiers.js";
import * as adminStatTiers           from "./admin-stat-tiers.js";
import * as adminCustomPlayerSettings from "./admin-customplayersettings.js";
import * as adminCustomArchetypes    from "./admin-customarchetypes.js";
import * as adminGotw                from "./admin-gotw.js";
import * as adminPotw                from "./admin-potw.js";
import * as adminServer              from "./adminserver.js";
import * as adminDeleteUser         from "./admin-deleteuser.js";
import { executeFranchiseLimit, executeFranchiseReset } from "./admin-season.js";
import { PAYOUT_KEYS }               from "../lib/payout-config.js";
import { STAT_CATEGORY_CHOICES }     from "../lib/stat-categories.js";
import { ALL_POSITIONS }             from "../lib/custom-player-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin")
  .setDescription("Commissioner & admin tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  // ── coins ──────────────────────────────────────────────────────────────────
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
    .setName("reverse_transaction_by_id")
    .setDescription("Reverse a coin transaction by ID (and optionally its store purchase)")
    .addIntegerOption(o => o.setName("transaction_id").setDescription("Transaction ID from the commissioner log").setRequired(true).setMinValue(1))
    .addIntegerOption(o => o.setName("purchase_id").setDescription("Purchase # to also reverse inventory/legend").setRequired(false).setMinValue(1))
    .addStringOption(o => o.setName("reason").setDescription("Reason for the reversal").setRequired(false).setMaxLength(200))
  )

  // ── player / team management ───────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("set_user_team")
    .setDescription("Assign a team to an existing player (does NOT wipe balance or records)")
    .addUserOption(o => o.setName("user").setDescription("Discord user to assign").setRequired(true))
    .addStringOption(o => o.setName("team").setDescription("NFL team name").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand(s => s
    .setName("view_all_user_teams")
    .setDescription("Show all current player → team assignments")
  )
  .addSubcommand(s => s
    .setName("clear_user_team")
    .setDescription("Remove a user's team assignment (keeps balance and records)")
    .addUserOption(o => o.setName("user").setDescription("User whose team to clear").setRequired(false))
    .addStringOption(o => o.setName("team").setDescription("Team name (alternative to user)").setRequired(false).setAutocomplete(true))
  )

  // ── set user stats ─────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("set_user_stats")
    .setDescription("Directly set any stat for a user (coins, wins, losses, upgrade counts, etc.)")
    .addStringOption(o => o.setName("team").setDescription("NFL team name").setRequired(false).setAutocomplete(true))
    .addUserOption(o => o.setName("user").setDescription("Discord user (alternative to team)").setRequired(false))
    .addIntegerOption(o => o.setName("coins").setDescription("Set coin balance to this amount").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("legend_total").setDescription("Set all-time legend purchase count").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("wins").setDescription("Set current season regular season wins").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("losses").setDescription("Set current season regular season losses").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("point_differential").setDescription("Set current season point differential").setRequired(false))
    .addIntegerOption(o => o.setName("playoff_wins").setDescription("Set current season playoff wins").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("playoff_losses").setDescription("Set current season playoff losses").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("superbowl_wins").setDescription("Set current season Super Bowl wins").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("superbowl_losses").setDescription("Set current season Super Bowl losses").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("all_time_sb_wins").setDescription("Set all-time Super Bowl wins (for bonus tier tracking)").setRequired(false).setMinValue(0))
    .addBooleanOption(o => o.setName("milestones_already_paid").setDescription("Have H2H win milestone bonuses already been paid before this bot?").setRequired(false))
    .addIntegerOption(o => o.setName("core_attr_used").setDescription("Set core attribute points purchased this season").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("non_core_attr_used").setDescription("Set non-core attribute points purchased this season").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("dev_ups_used").setDescription("Set dev upgrades purchased this season").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("age_resets_used").setDescription("Set age resets purchased this season").setRequired(false).setMinValue(0))
  )

  // ── admin role management ──────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("set_admin_role")
    .setDescription("Grant bot-admin status to a user")
    .addUserOption(o => o.setName("user").setDescription("User to grant admin status").setRequired(true))
  )
  .addSubcommand(s => s
    .setName("revoke_admin_role")
    .setDescription("Revoke bot-admin status from a user")
    .addUserOption(o => o.setName("user").setDescription("User to revoke admin status from").setRequired(true))
  )
  .addSubcommand(s => s
    .setName("list_administrators")
    .setDescription("List all current bot admins")
  )
  .addSubcommand(s => s
    .setName("resync_player_names")
    .setDescription("Re-sync all player display names from Discord")
  )

  // ── payout settings ────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("view_payout_settings")
    .setDescription("Show ALL current economy values (payouts, bonuses, store prices)")
  )
  .addSubcommand(s => s
    .setName("set_payout_amounts")
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
        { name: "🏈 EOS QB YPA — minimum pass attempts to qualify",                  value: PAYOUT_KEYS.EOS_QB_MIN_ATT   },
        { name: "🏃 EOS RB YPC — minimum rush carries to qualify",                  value: PAYOUT_KEYS.EOS_RB_MIN_ATT   },
        { name: "📐 EOS QB YPA threshold — min YPA×10 (e.g. 85 = 8.5 YPA)",        value: PAYOUT_KEYS.EOS_QB_MIN_YPA   },
        { name: "📐 EOS RB YPC threshold — min YPC×10 (e.g. 70 = 7.0 YPC)",        value: PAYOUT_KEYS.EOS_RB_MIN_YPC   },
        { name: "🛡️ EOS DB INT threshold — min individual player INTs to qualify",  value: PAYOUT_KEYS.EOS_DB_MIN_INTS  },
      )
    )
    .addIntegerOption(o => o.setName("amount").setDescription("New value (coins, attempts, or threshold)").setRequired(true).setMinValue(0))
  )

  // ── milestone & EOS tier settings ─────────────────────────────────────────
  .addSubcommand(s => s
    .setName("set_user_milestone_tier")
    .setDescription("Manually set a user's career milestone tier (does not adjust coins)")
    .addUserOption(o => o.setName("user").setDescription("The user whose milestone tier to set").setRequired(true))
    .addIntegerOption(o => o.setName("tier").setDescription("The milestone tier to assign").setRequired(true).setMinValue(0))
  )
  .addSubcommand(s => s
    .setName("view_eos_payout_settings")
    .setDescription("View all end-of-season stat tier thresholds and payouts")
  )
  .addSubcommand(s => s
    .setName("set_eos_payout_settings")
    .setDescription("Set a single tier threshold/payout for an end-of-season stat bonus category")
    .addStringOption(o => o.setName("category").setDescription("Stat category to configure").setRequired(true).addChoices(...STAT_CATEGORY_CHOICES))
    .addIntegerOption(o => o.setName("tier").setDescription("Tier number (1 = lowest, 4 = best payout)").setRequired(true).setMinValue(1).setMaxValue(4))
    .addIntegerOption(o => o.setName("threshold").setDescription("Qualifying value (min for higher-is-better, max for lower-is-better)").setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName("payout").setDescription("Coin payout for reaching this tier").setRequired(true).setMinValue(0))
    .addIntegerOption(o => o.setName("season_id").setDescription("Season ID (defaults to active season)").setRequired(false).setMinValue(1))
  )

  // ── custom player settings ─────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("view_custom_player_settings")
    .setDescription("View current custom player package settings (points and cost per tier)")
  )
  .addSubcommand(s => s
    .setName("set_custom_player_settings")
    .setDescription("Update a custom player package's creation points and/or coin cost")
    .addStringOption(o => o.setName("package").setDescription("Package tier to update").setRequired(true)
      .addChoices(
        { name: "Gold",       value: "gold"   },
        { name: "Silver",     value: "silver" },
        { name: "Bronze",     value: "bronze" },
        { name: "K/P Default", value: "kp"   },
      )
    )
    .addIntegerOption(o => o.setName("points").setDescription("Creation points").setRequired(false).setMinValue(1).setMaxValue(500))
    .addIntegerOption(o => o.setName("cost").setDescription("Coin cost").setRequired(false).setMinValue(0).setMaxValue(9999))
  )

  // ── archetypes ─────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("edit_archetype")
    .setDescription("Edit default attribute values for a player archetype (opens interactive menu)")
    .addStringOption(o => o.setName("position").setDescription("Player position").setRequired(true)
      .addChoices(ALL_POSITIONS.map(p => ({ name: p, value: p })))
    )
    .addStringOption(o => o.setName("archetype").setDescription("Archetype name (e.g. Scrambler, Field General)").setRequired(true).setAutocomplete(true))
  )

  // ── payouts ────────────────────────────────────────────────────────────────
  .addSubcommand(s => {
    s.setName("payout_gotw")
      .setDescription("Award GOTW correct-guess bonuses in bulk (up to 24 users, or use 'all' to pay everyone)")
      .addBooleanOption(o =>
        o.setName("all")
          .setDescription("Pay every registered member currently linked to a team")
          .setRequired(false)
      );
    for (let i = 1; i <= 24; i++) {
      s.addUserOption(o =>
        o.setName(`user${i}`)
          .setDescription("Correct guesser")
          .setRequired(false)
      );
    }
    return s;
  })
  .addSubcommand(s => s
    .setName("payout_potw")
    .setDescription("Award Player of the Week bonus — 1 to 4 players")
    .addUserOption(o => o.setName("player1").setDescription("POTW recipient").setRequired(true))
    .addUserOption(o => o.setName("player2").setDescription("POTW recipient").setRequired(false))
    .addUserOption(o => o.setName("player3").setDescription("POTW recipient").setRequired(false))
    .addUserOption(o => o.setName("player4").setDescription("POTW recipient").setRequired(false))
  )

  // ── server settings ────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("server_bot_settings")
    .setDescription("Toggle server features on/off (coin economy, store items, wagers, trade block)")
  )
  .addSubcommand(s => s
    .setName("server_franchise_limit")
    .setDescription("Set the maximum number of seasons allowed in this franchise (1–50)")
    .addIntegerOption(o => o
      .setName("limit")
      .setDescription("Max seasons (1–50)")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(50)
    )
  )
  .addSubcommand(s => s
    .setName("server_franchise_reset")
    .setDescription("⚠️ END-OF-FRANCHISE RESET: returns all legends to store, resets all coins, restarts at Season 1")
    .addBooleanOption(o => o
      .setName("confirm")
      .setDescription("Set to True to confirm this irreversible action")
      .setRequired(true)
    )
  )

  // ── user management ─────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("user_delete")
    .setDescription("Permanently delete a user and their data (all categories on by default)")
    .addUserOption(o => o.setName("user").setDescription("The user to delete").setRequired(true))
    .addBooleanOption(o => o.setName("confirm").setDescription("Set to True to confirm permanent deletion").setRequired(false))
    .addBooleanOption(o => o.setName("del_economy").setDescription("Delete savings, inventory, season limits, transactions & purchases (default: true)").setRequired(false))
    .addBooleanOption(o => o.setName("del_records").setDescription("Delete season records, H2H records & game log (default: true)").setRequired(false))
    .addBooleanOption(o => o.setName("del_wagers").setDescription("Delete wagers (default: true)").setRequired(false))
    .addBooleanOption(o => o.setName("del_trade_listings").setDescription("Delete trade block listings & ISO posts (default: true)").setRequired(false))
    .addBooleanOption(o => o.setName("del_payout_data").setDescription("Delete payout requests, channel payouts & pending EOS payouts (default: true)").setRequired(false))
    .addBooleanOption(o => o.setName("del_interviews").setDescription("Delete interview requests (default: true)").setRequired(false))
    .addBooleanOption(o => o.setName("del_franchise_data").setDescription("Delete franchise MCA mapping, team stats & player stats (default: true)").setRequired(false))
    .addBooleanOption(o => o.setName("del_custom_players").setDescription("Delete custom player builds (default: true)").setRequired(false))
    .addUserOption(o => o.setName("transfer_to").setDescription("Transfer legends & applied custom players to this user instead of deleting them").setRequired(false))
  );

// ── Execute router ─────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const sub = interaction.options.getSubcommand(true);

  if (sub === "add_coins")                return adminAddCoins.execute(interaction);
  if (sub === "remove_coins")             return adminRemoveCoins.execute(interaction);
  if (sub === "reverse_transaction_by_id") return adminReverseTransaction.execute(interaction);

  if (sub === "set_user_team" || sub === "view_all_user_teams")
    return adminLinkTeam.execute(interaction);
  if (sub === "clear_user_team")          return adminClearteam.execute(interaction);
  if (sub === "set_user_stats")           return adminSetUser.execute(interaction);

  if (sub === "set_admin_role" || sub === "revoke_admin_role" || sub === "list_administrators")
    return adminSetAdmin.execute(interaction);
  if (sub === "resync_player_names")      return adminFixPlayerNames.execute(interaction);

  if (sub === "view_payout_settings")     return adminSetPayouts.execute(interaction);
  if (sub === "set_payout_amounts")       return adminSetPayouts.execute(interaction);
  if (sub === "set_user_milestone_tier")  return adminSetMilestoneTier.execute(interaction);
  if (sub === "view_eos_payout_settings") return adminStatTiers.execute(interaction);
  if (sub === "set_eos_payout_settings")  return adminSetStatTier.execute(interaction);

  if (sub === "view_custom_player_settings" || sub === "set_custom_player_settings")
    return adminCustomPlayerSettings.execute(interaction);
  if (sub === "edit_archetype")           return adminCustomArchetypes.execute(interaction);

  if (sub === "payout_gotw")              return adminGotw.execute(interaction);
  if (sub === "payout_potw")              return adminPotw.execute(interaction);
  if (sub === "server_bot_settings")      return adminServer.execute(interaction);
  if (sub === "server_franchise_limit")   return executeFranchiseLimit(interaction);
  if (sub === "server_franchise_reset")   return executeFranchiseReset(interaction);
  if (sub === "user_delete")              return adminDeleteUser.execute(interaction);

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(`❌ Unknown subcommand: \`${sub}\``);
  return;
}

// ── Autocomplete router ────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const sub = interaction.options.getSubcommand();

    if (sub === "set_user_team" || sub === "view_all_user_teams")
      return adminLinkTeam.autocomplete(interaction);
    if (sub === "clear_user_team")         return adminClearteam.autocomplete(interaction);
    if (sub === "set_user_stats")          return adminSetUser.autocomplete(interaction);

    await interaction.respond([]).catch(() => {});
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}
