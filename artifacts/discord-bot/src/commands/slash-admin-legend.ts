import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminLegend      from "./admin-legend.js";
import * as adminLegendVault from "./admin-legendvault.js";

export const data = new SlashCommandBuilder()
  .setName("admin_legend")
  .setDescription("Manage legends and user legend vaults")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("add")
    .setDescription("Add a new legend to the store")
    .addStringOption(o => o.setName("name").setDescription("Legend name").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("Player position").setRequired(true))
    .addStringOption(o => o.setName("description").setDescription("Optional description").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("list_all")
    .setDescription("View all legends — store, current-season owned, and permanent vaults")
  )
  .addSubcommand(s => s
    .setName("edit")
    .setDescription("Edit a legend's details")
    .addIntegerOption(o => o.setName("id").setDescription("Legend ID").setRequired(true))
    .addStringOption(o => o.setName("name").setDescription("New name").setRequired(false))
    .addStringOption(o => o.setName("position").setDescription("New position").setRequired(false))
    .addStringOption(o => o.setName("description").setDescription("New description").setRequired(false))
    .addBooleanOption(o => o.setName("available").setDescription("Set availability").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("add_to_user_vault")
    .setDescription("Add a legend directly to a user's permanent vault (retroactive / commissioner use)")
    .addUserOption(o => o.setName("user").setDescription("User to receive the legend").setRequired(true))
    .addStringOption(o => o.setName("legend_name").setDescription("Name of the legend (e.g. Jerry Rice)").setRequired(true))
    .addStringOption(o => o.setName("position").setDescription("Position (e.g. WR, QB, CB)").setRequired(true))
    .addStringOption(o => o.setName("description").setDescription("Optional description for the store entry").setRequired(false))
  )
  .addSubcommand(s => s
    .setName("move_in_inventory")
    .setDescription("Move a legend between current-season and permanent inventory categories")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption(o => o.setName("item_id").setDescription("Inventory item ID (see list_all)").setRequired(true).setMinValue(1))
    .addStringOption(o => o
      .setName("direction")
      .setDescription("Which way to move the legend")
      .setRequired(true)
      .addChoices(
        { name: "current → permanent (make it permanent)",   value: "to_permanent" },
        { name: "permanent → current (return to season use)", value: "to_current"   },
      )
    )
  )
  .addSubcommand(s => s
    .setName("remove_from_inventory")
    .setDescription("Remove a legend inventory item by its ID")
    .addIntegerOption(o => o.setName("item_id").setDescription("Inventory item ID").setRequired(true).setMinValue(1))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const sub = interaction.options.getSubcommand();
  if (sub === "add" || sub === "list_all" || sub === "edit") return adminLegend.execute(interaction);
  if (sub === "add_to_user_vault" || sub === "move_in_inventory" || sub === "remove_from_inventory")
    return adminLegendVault.execute(interaction);
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(`❌ Unknown subcommand: \`${sub}\``);
  return;
}
