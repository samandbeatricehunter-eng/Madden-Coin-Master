import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  coinTransactionsTable, usersTable, purchasesTable,
  inventoryTable, legendsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logTransaction } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-reverse-transaction")
  .setDescription("Admin: reverse a coin transaction (and optionally its store purchase) by ID")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(o => o
    .setName("transaction_id")
    .setDescription("ID from the coin transaction log (shown in /admin-transactions or commissioner log footer)")
    .setRequired(true)
    .setMinValue(1),
  )
  .addIntegerOption(o => o
    .setName("purchase_id")
    .setDescription("If this was a store purchase, provide the Purchase # to also reverse inventory/legend")
    .setRequired(false)
    .setMinValue(1),
  )
  .addStringOption(o => o
    .setName("reason")
    .setDescription("Reason for the reversal (logged for audit trail)")
    .setRequired(false)
    .setMaxLength(200),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const transactionId = interaction.options.getInteger("transaction_id", true);
  const purchaseId    = interaction.options.getInteger("purchase_id", false);
  const reason        = interaction.options.getString("reason", false) ?? "No reason provided";

  // ── 1. Look up the transaction ───────────────────────────────────────────────
  const [tx] = await db
    .select()
    .from(coinTransactionsTable)
    .where(eq(coinTransactionsTable.id, transactionId))
    .limit(1);

  if (!tx) {
    await interaction.editReply(`❌ No transaction found with ID **#${transactionId}**.`);
    return;
  }

  // ── 2. Reverse the coin change ──────────────────────────────────────────────
  // If tx.amount was +200 (coins added), reversal deducts 200.
  // If tx.amount was -500 (coins deducted), reversal adds 500 back.
  const reversalAmount = -tx.amount;

  // Check that the user row exists
  const [userRow] = await db
    .select({ balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.discordId, tx.discordId))
    .limit(1);

  if (!userRow) {
    await interaction.editReply(`❌ User \`${tx.discordId}\` not found in the database.`);
    return;
  }

  // Guard against driving balance negative if we're deducting
  if (reversalAmount < 0 && userRow.balance + reversalAmount < 0) {
    await interaction.editReply(
      `⚠️ Cannot reverse this transaction — it would bring <@${tx.discordId}>'s balance below zero.\n` +
      `Current balance: **${userRow.balance.toLocaleString()} coins**\n` +
      `Reversal would deduct: **${Math.abs(reversalAmount).toLocaleString()} coins**\n\n` +
      `Use \`/admin-addcoins\` or \`/admin-setbalance\` to manually correct the balance instead.`,
    );
    return;
  }

  await db
    .update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${reversalAmount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, tx.discordId));

  await logTransaction(
    tx.discordId,
    reversalAmount,
    "purchase_refund",
    `Reversal of TX#${transactionId} (${tx.type}): "${tx.description}" — ${reason}`,
    interaction.user.id,
  );

  const resultLines: string[] = [
    `**Transaction reversed:** TX#${transactionId}`,
    `**User:** <@${tx.discordId}>`,
    `**Original amount:** ${tx.amount > 0 ? "+" : ""}${tx.amount.toLocaleString()} coins`,
    `**Reversal applied:** ${reversalAmount > 0 ? "+" : ""}${reversalAmount.toLocaleString()} coins`,
    `**Original description:** ${tx.description}`,
    `**Reason:** ${reason}`,
  ];

  // ── 3. Optionally reverse a store purchase ───────────────────────────────────
  if (purchaseId !== null) {
    const [purchase] = await db
      .select()
      .from(purchasesTable)
      .where(eq(purchasesTable.id, purchaseId))
      .limit(1);

    if (!purchase) {
      resultLines.push(`\n⚠️ Purchase #${purchaseId} not found — coin reversal was still applied, but no inventory changes were made.`);
    } else if (purchase.discordId !== tx.discordId) {
      resultLines.push(`\n⚠️ Purchase #${purchaseId} belongs to a different user — inventory reversal skipped for safety. Coin reversal was still applied.`);
    } else {
      const inventoryActions: string[] = [];

      // Remove inventory entries for this purchase
      const deletedInventory = await db
        .delete(inventoryTable)
        .where(eq(inventoryTable.purchaseId, purchaseId))
        .returning({ id: inventoryTable.id, itemType: inventoryTable.itemType, legendName: inventoryTable.legendName });

      for (const item of deletedInventory) {
        inventoryActions.push(`Removed inventory item: ${item.legendName ?? item.itemType}`);
      }

      // If it was a legend, mark the legend card as available again
      if (purchase.legendId) {
        await db
          .update(legendsTable)
          .set({ isAvailable: true })
          .where(eq(legendsTable.id, purchase.legendId));
        inventoryActions.push(`Legend #${purchase.legendId} (${purchase.playerName ?? "?"}) marked as available again`);
      }

      // Mark the purchase as refunded
      await db
        .update(purchasesTable)
        .set({ status: "refunded" })
        .where(eq(purchasesTable.id, purchaseId));

      resultLines.push(`\n**Purchase #${purchaseId} reversed:**`);
      if (inventoryActions.length > 0) {
        for (const action of inventoryActions) {
          resultLines.push(`• ${action}`);
        }
      } else {
        resultLines.push(`• Purchase marked refunded (no inventory items found to remove)`);
      }
    }
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🔄 Transaction Reversed")
    .setDescription(resultLines.join("\n"))
    .setFooter({ text: `Reversed by ${interaction.user.username} • TX#${transactionId}${purchaseId ? ` / Purchase #${purchaseId}` : ""}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
