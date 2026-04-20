import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminReverseTransaction  from "./admin-reverse-transaction.js";
import * as adminLinkTeam            from "./admin-linkteam.js";
import * as adminClearteam           from "./admin-clearteam.js";
import * as adminSetUser             from "./admin-setuser.js";
import * as adminSetAdmin            from "./admin-setadmin.js";
import * as adminFixPlayerNames      from "./admin-fixplayernames.js";
import * as adminSetStatTier         from "./admin-set-stat-tiers.js";
import * as adminStatTiers           from "./admin-stat-tiers.js";
import * as adminCustomPlayerSettings from "./admin-customplayersettings.js";
import * as adminCustomArchetypes    from "./admin-customarchetypes.js";
import * as adminServer              from "./adminserver.js";
import * as adminDeleteUser         from "./admin-deleteuser.js";
import { executeFranchiseLimit, executeFranchiseReset } from "./admin-season.js";
import { STAT_CATEGORY_CHOICES }     from "../lib/stat-categories.js";
import { ALL_POSITIONS }             from "../lib/custom-player-helpers.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin")
  .setDescription("Commissioner & admin tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

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
    .addIntegerOption(o => o.setName("all_time_sb_losses").setDescription("Set all-time Super Bowl losses").setRequired(false).setMinValue(0))
    .addBooleanOption(o => o.setName("milestones_already_paid").setDescription("Have H2H win milestone bonuses already been paid before this bot?").setRequired(false))
    .addIntegerOption(o => o.setName("core_attr_used").setDescription("Set core attribute points purchased this season").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("non_core_attr_used").setDescription("Set non-core attribute points purchased this season").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("dev_ups_used").setDescription("Set dev upgrades purchased this season").setRequired(false).setMinValue(0))
    .addIntegerOption(o => o.setName("age_resets_used").setDescription("Set age resets purchased this season").setRequired(false).setMinValue(0))
    .addStringOption(o => o.setName("ea_id").setDescription("EA / PSN / Xbox gamertag to add or update").setRequired(false))
    .addStringOption(o => o.setName("ea_console").setDescription("Which console this EA ID is linked to").setRequired(false)
      .addChoices(
        { name: "🖥️ PC",   value: "pc"   },
        { name: "🔵 PS5",  value: "ps5"  },
        { name: "🟢 Xbox", value: "xbox" },
      )
    )
    .addIntegerOption(o => o.setName("ea_slot").setDescription("Slot to store this EA ID in (1 = primary, 2 = secondary, 3 = tertiary)").setRequired(false)
      .addChoices(
        { name: "Slot 1 (primary)",   value: 1 },
        { name: "Slot 2 (secondary)", value: 2 },
        { name: "Slot 3 (tertiary)",  value: 3 },
      )
    )
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

  if (sub === "reverse_transaction_by_id") return adminReverseTransaction.execute(interaction);

  if (sub === "set_user_team" || sub === "view_all_user_teams")
    return adminLinkTeam.execute(interaction);
  if (sub === "clear_user_team")          return adminClearteam.execute(interaction);
  if (sub === "set_user_stats")           return adminSetUser.execute(interaction);

  if (sub === "set_admin_role" || sub === "revoke_admin_role" || sub === "list_administrators")
    return adminSetAdmin.execute(interaction);
  if (sub === "resync_player_names")      return adminFixPlayerNames.execute(interaction);

  if (sub === "set_user_milestone_tier") {
    await interaction.deferReply({ ephemeral: true });
    const member = interaction.guild?.members.cache.get(interaction.user.id)
      ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
    const isDbAdmin = await isAdminUser(interaction.user.id, interaction.guildId!);
    if (!isDiscordAdmin && !isDbAdmin) {
      return interaction.editReply({ content: "❌ You don't have permission to use this command." });
    }
    const target = interaction.options.getUser("user", true);
    const tier = interaction.options.getInteger("tier", true);
    const rows = await db.select({ discordId: usersTable.discordId })
      .from(usersTable)
      .where(and(eq(usersTable.discordId, target.id), eq(usersTable.guildId, interaction.guildId!)));
    if (!rows.length) {
      return interaction.editReply({ content: `❌ <@${target.id}> is not registered in this server.` });
    }
    await db.update(usersTable)
      .set({ milestoneTierAwarded: tier })
      .where(and(eq(usersTable.discordId, target.id), eq(usersTable.guildId, interaction.guildId!)));
    return interaction.editReply({
      content: `✅ Set <@${target.id}>'s milestone tier to **Tier ${tier}** (coins unchanged).`,
    });
  }

  if (sub === "view_eos_payout_settings") return adminStatTiers.execute(interaction);
  if (sub === "set_eos_payout_settings")  return adminSetStatTier.execute(interaction);

  if (sub === "view_custom_player_settings" || sub === "set_custom_player_settings")
    return adminCustomPlayerSettings.execute(interaction);
  if (sub === "edit_archetype")           return adminCustomArchetypes.execute(interaction);

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
