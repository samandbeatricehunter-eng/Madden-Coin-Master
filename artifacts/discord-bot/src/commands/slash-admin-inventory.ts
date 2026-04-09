import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import * as adminInventory from "./admin-inventory.js";

export const data = new SlashCommandBuilder()
  .setName("admin_inventory")
  .setDescription("Manage user inventory items")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(s => s
    .setName("view")
    .setDescription("View all inventory items for a user (shows item IDs)")
    .addUserOption(o => o.setName("user").setDescription("The user whose inventory to view").setRequired(true))
  )
  .addSubcommand(s => s
    .setName("remove")
    .setDescription("Remove an inventory item by its ID")
    .addUserOption(o => o.setName("user").setDescription("The user who owns the item").setRequired(true))
    .addIntegerOption(o => o.setName("item_id").setDescription("Inventory item ID (see view command)").setRequired(true).setMinValue(1))
  )
  .addSubcommand(s => s
    .setName("move")
    .setDescription("Transfer an inventory item from one user's inventory to another")
    .addUserOption(o => o.setName("from_user").setDescription("User to transfer from").setRequired(true))
    .addUserOption(o => o.setName("to_user").setDescription("User to transfer to").setRequired(true))
    .addIntegerOption(o => o.setName("item_id").setDescription("Inventory item ID to transfer").setRequired(true).setMinValue(1))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  return adminInventory.execute(interaction);
}
