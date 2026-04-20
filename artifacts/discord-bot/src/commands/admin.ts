import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminReverseTransaction  from "./admin-reverse-transaction.js";
import * as adminSetAdmin            from "./admin-setadmin.js";
import * as adminFixPlayerNames      from "./admin-fixplayernames.js";
import * as adminSetStatTier         from "./admin-set-stat-tiers.js";
import * as adminStatTiers           from "./admin-stat-tiers.js";
import * as adminCustomPlayerSettings from "./admin-customplayersettings.js";
import * as adminCustomArchetypes    from "./admin-customarchetypes.js";
import * as adminServer              from "./adminserver.js";
import { executeFranchiseLimit, executeFranchiseReset } from "./admin-season.js";
import { STAT_CATEGORY_CHOICES }     from "../lib/stat-categories.js";
import { ALL_POSITIONS }             from "../lib/custom-player-helpers.js";

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
  );

// ── Execute router ─────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const sub = interaction.options.getSubcommand(true);

  if (sub === "reverse_transaction_by_id") return adminReverseTransaction.execute(interaction);

  if (sub === "set_admin_role" || sub === "revoke_admin_role" || sub === "list_administrators")
    return adminSetAdmin.execute(interaction);
  if (sub === "resync_player_names")      return adminFixPlayerNames.execute(interaction);

  if (sub === "view_eos_payout_settings") return adminStatTiers.execute(interaction);
  if (sub === "set_eos_payout_settings")  return adminSetStatTier.execute(interaction);

  if (sub === "view_custom_player_settings" || sub === "set_custom_player_settings")
    return adminCustomPlayerSettings.execute(interaction);
  if (sub === "edit_archetype")           return adminCustomArchetypes.execute(interaction);

  if (sub === "server_bot_settings")      return adminServer.execute(interaction);
  if (sub === "server_franchise_limit")   return executeFranchiseLimit(interaction);
  if (sub === "server_franchise_reset")   return executeFranchiseReset(interaction);

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(`❌ Unknown subcommand: \`${sub}\``);
  return;
}

// ── Autocomplete router ────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const sub = interaction.options.getSubcommand();

    await interaction.respond([]).catch(() => {});
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}
