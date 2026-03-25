import {
  Interaction, ButtonInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { purchasesTable, inventoryTable, legendsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { addBalance, logTransaction } from "../lib/db-helpers.js";

export const name = "interactionCreate";

export async function execute(interaction: Interaction) {
  if (interaction.isAutocomplete()) {
    const client = interaction.client as any;
    const command = client.commands?.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      console.error("Autocomplete error:", err);
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const client = interaction.client as any;
    const command = client.commands?.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Error executing command ${interaction.commandName}:`, err);
      const errorMsg = { content: "An error occurred while executing that command.", ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMsg).catch(() => {});
      } else {
        await interaction.reply(errorMsg).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton()) {
    await handleButton(interaction);
  }
}

async function handleButton(interaction: ButtonInteraction) {
  const [action, purchaseIdStr, userId, purchaseType] = interaction.customId.split(":");
  const purchaseId = parseInt(purchaseIdStr ?? "0", 10);

  if (action === "approve_purchase") {
    await interaction.deferUpdate();

    // Get purchase
    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];

    if (!purchase) {
      await interaction.followUp({ content: "❌ Purchase not found.", ephemeral: true });
      return;
    }

    if (purchase.status === "approved") {
      await interaction.followUp({ content: "⚠️ This purchase has already been approved.", ephemeral: true });
      return;
    }

    if (purchase.status === "refunded") {
      await interaction.followUp({ content: "⚠️ This purchase was already refunded.", ephemeral: true });
      return;
    }

    // Mark as approved
    await db.update(purchasesTable)
      .set({ status: "approved", approvedAt: new Date() })
      .where(eq(purchasesTable.id, purchaseId));

    // If legend: add to inventory and mark legend as unavailable
    if (purchaseType === "legend" && purchase.legendId) {
      // Add to inventory
      await db.insert(inventoryTable).values({
        discordId: userId!,
        seasonId: purchase.seasonId,
        purchaseId: purchase.id,
        itemType: "legend",
        legendId: purchase.legendId,
        legendName: purchase.playerName,
        playerPosition: purchase.playerPosition,
      });

      // Remove from store
      await db.update(legendsTable)
        .set({ isAvailable: false })
        .where(eq(legendsTable.id, purchase.legendId));
    }

    // Update the commissioner message to show approved state
    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Applied In-Game")
      .setDescription(`Purchase **#${purchaseId}** has been applied in-game.\n\nApproved by: ${interaction.user.toString()}`)
      .setTimestamp();

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approved_done`)
        .setLabel("✅ Applied")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
    );

    await interaction.editReply({ embeds: [approvedEmbed], components: [disabledRow] });

    // Notify the user via DM
    try {
      const user = await interaction.client.users.fetch(userId!);
      let notifyMessage = "";
      if (purchaseType === "legend") {
        notifyMessage = `🏆 Your legend **${purchase.playerName}** has been added to the draft pool! Check your inventory with \`/inventory\`.`;
      } else if (purchaseType === "attribute") {
        notifyMessage = `⚡ Your **${purchase.attributeName}** attribute upgrade has been applied in-game!`;
      } else if (purchaseType === "dev_up") {
        notifyMessage = `📈 Your dev upgrade for **${purchase.playerName}** has been applied in-game!`;
      } else if (purchaseType === "age_reset") {
        notifyMessage = `🔄 Your age reset for **${purchase.playerName}** has been applied in-game!`;
      } else if (purchaseType?.startsWith("custom_player")) {
        notifyMessage = `🎨 Your custom player **${purchase.playerName}** has been applied in-game!`;
      }
      await user.send(`✅ **Purchase #${purchaseId} Approved!**\n${notifyMessage}`).catch(() => {});
    } catch (_) {}
  }

  if (action === "refund_purchase") {
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];

    if (!purchase) {
      await interaction.followUp({ content: "❌ Purchase not found.", ephemeral: true });
      return;
    }

    if (purchase.status === "refunded") {
      await interaction.followUp({ content: "⚠️ This purchase was already refunded.", ephemeral: true });
      return;
    }

    // Mark as refunded
    await db.update(purchasesTable)
      .set({ status: "refunded" })
      .where(eq(purchasesTable.id, purchaseId));

    // Refund coins
    await addBalance(userId!, purchase.cost);
    await logTransaction(userId!, purchase.cost, "purchase_refund", `Refund: ${purchase.purchaseType.replace(/_/g, " ")}${purchase.playerName ? ` — ${purchase.playerName}` : ""}`, interaction.user.id);

    // If legend: decrement total legend purchases
    if (purchaseType === "legend") {
      await db.update(usersTable)
        .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, userId!));
    }

    // Remove from inventory if present
    await db.delete(inventoryTable)
      .where(and(eq(inventoryTable.purchaseId, purchaseId), eq(inventoryTable.discordId, userId!)));

    // Update commissioner message
    const refundedEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("🔄 Purchase Refunded")
      .setDescription(`Purchase **#${purchaseId}** has been refunded. **${purchase.cost.toLocaleString()} coins** returned.\n\nRefunded by: ${interaction.user.toString()}`)
      .setTimestamp();

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`refunded_done`)
        .setLabel("🔄 Refunded")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
    );

    await interaction.editReply({ embeds: [refundedEmbed], components: [disabledRow] });

    // Notify user via DM
    try {
      const user = await interaction.client.users.fetch(userId!);
      await user.send(`🔄 **Purchase #${purchaseId} Refunded**\n**${purchase.cost.toLocaleString()} coins** have been returned to your balance.`).catch(() => {});
    } catch (_) {}
  }
}
