import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminSetAdmin            from "./admin-setadmin.js";
import * as adminFixPlayerNames      from "./admin-fixplayernames.js";
import * as adminCustomPlayerSettings from "./admin-customplayersettings.js";
import * as adminCustomArchetypes    from "./admin-customarchetypes.js";
import * as adminServer              from "./adminserver.js";
import { executeFranchiseLimit, executeFranchiseReset } from "./admin-season.js";
import { ALL_POSITIONS }             from "../lib/custom-player-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin")
  .setDescription("Commissioner & admin tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

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


  // ── custom player settings ─────────────────────────────────────────────────
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

  if (sub === "set_admin_role" || sub === "revoke_admin_role" || sub === "list_administrators")
    return adminSetAdmin.execute(interaction);
  if (sub === "resync_player_names")      return adminFixPlayerNames.execute(interaction);

  if (sub === "set_custom_player_settings")
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
