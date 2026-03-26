import {
  Interaction, ButtonInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { purchasesTable, inventoryTable, legendsTable, usersTable, payoutRequestsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { addBalance, logTransaction } from "../lib/db-helpers.js";
import { PVP_WIN_PAYOUT, PVP_LOSS_PAYOUT, CPU_WIN_PAYOUT } from "../commands/requestpayout.js";

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
    return;
  }

  if (interaction.isModalSubmit()) {
    await handleModal(interaction);
  }
}

// ── Button handler ─────────────────────────────────────────────────────────────
async function handleButton(interaction: ButtonInteraction) {
  const [action, secondPart, userId, purchaseType] = interaction.customId.split(":");

  // ── Purchase buttons ─────────────────────────────────────────────────────────
  if (action === "approve_purchase") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];

    if (!purchase) { await interaction.followUp({ content: "❌ Purchase not found.", ephemeral: true }); return; }
    if (purchase.status === "approved") { await interaction.followUp({ content: "⚠️ This purchase has already been approved.", ephemeral: true }); return; }
    if (purchase.status === "refunded") { await interaction.followUp({ content: "⚠️ This purchase was already refunded.", ephemeral: true }); return; }

    await db.update(purchasesTable).set({ status: "approved", approvedAt: new Date() }).where(eq(purchasesTable.id, purchaseId));

    if (purchaseType === "legend" && purchase.legendId) {
      await db.insert(inventoryTable).values({
        discordId: userId!,
        seasonId: purchase.seasonId,
        purchaseId: purchase.id,
        itemType: "legend",
        legendId: purchase.legendId,
        legendName: purchase.playerName,
        playerPosition: purchase.playerPosition,
      });
      await db.update(legendsTable).set({ isAvailable: false }).where(eq(legendsTable.id, purchase.legendId));
    }

    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Applied In-Game")
      .setDescription(`Purchase **#${purchaseId}** has been applied in-game.\n\nApproved by: ${interaction.user.toString()}`)
      .setTimestamp();

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("approved_done").setLabel("✅ Applied").setStyle(ButtonStyle.Success).setDisabled(true),
    );

    await interaction.editReply({ embeds: [approvedEmbed], components: [disabledRow] });

    try {
      const user = await interaction.client.users.fetch(userId!);
      let notifyMessage = "";
      if (purchaseType === "legend") notifyMessage = `🏆 Your legend **${purchase.playerName}** has been added to the draft pool! Check your inventory with \`/inventory\`.`;
      else if (purchaseType === "attribute") notifyMessage = `⚡ Your **${purchase.attributeName}** attribute upgrade has been applied in-game!`;
      else if (purchaseType === "dev_up") notifyMessage = `📈 Your dev upgrade for **${purchase.playerName}** has been applied in-game!`;
      else if (purchaseType === "age_reset") notifyMessage = `🔄 Your age reset for **${purchase.playerName}** has been applied in-game!`;
      else if (purchaseType?.startsWith("custom_player")) notifyMessage = `🎨 Your custom player **${purchase.playerName}** has been applied in-game!`;
      await user.send(`✅ **Purchase #${purchaseId} Approved!**\n${notifyMessage}`).catch(() => {});
    } catch (_) {}
    return;
  }

  if (action === "refund_purchase") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];

    if (!purchase) { await interaction.followUp({ content: "❌ Purchase not found.", ephemeral: true }); return; }
    if (purchase.status === "refunded") { await interaction.followUp({ content: "⚠️ This purchase was already refunded.", ephemeral: true }); return; }

    await db.update(purchasesTable).set({ status: "refunded" }).where(eq(purchasesTable.id, purchaseId));
    await addBalance(userId!, purchase.cost);
    await logTransaction(userId!, purchase.cost, "purchase_refund", `Refund: ${purchase.purchaseType.replace(/_/g, " ")}${purchase.playerName ? ` — ${purchase.playerName}` : ""}`, interaction.user.id);

    if (purchaseType === "legend") {
      await db.update(usersTable)
        .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, userId!));
    }

    await db.delete(inventoryTable).where(and(eq(inventoryTable.purchaseId, purchaseId), eq(inventoryTable.discordId, userId!)));

    const refundedEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("🔄 Purchase Refunded")
      .setDescription(`Purchase **#${purchaseId}** has been refunded. **${purchase.cost.toLocaleString()} coins** returned.\n\nRefunded by: ${interaction.user.toString()}`)
      .setTimestamp();

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("refunded_done").setLabel("🔄 Refunded").setStyle(ButtonStyle.Danger).setDisabled(true),
    );

    await interaction.editReply({ embeds: [refundedEmbed], components: [disabledRow] });

    try {
      const user = await interaction.client.users.fetch(userId!);
      await user.send(`🔄 **Purchase #${purchaseId} Refunded**\n**${purchase.cost.toLocaleString()} coins** have been returned to your balance.`).catch(() => {});
    } catch (_) {}
    return;
  }

  // ── Payout buttons ───────────────────────────────────────────────────────────
  if (action === "payout_approve") {
    const payoutId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const rows = await db.select().from(payoutRequestsTable).where(eq(payoutRequestsTable.id, payoutId)).limit(1);
    const request = rows[0];

    if (!request) { await interaction.followUp({ content: "❌ Payout request not found.", ephemeral: true }); return; }
    if (request.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This request has already been **${request.status}**.`, ephemeral: true });
      return;
    }

    let resultLines: string[] = [];

    if (request.gameType === "pvp") {
      const myScore  = request.requesterScore!;
      const oppScore = request.opponentScore!;

      if (myScore === oppScore) {
        // Tie — no coins
        await db.update(payoutRequestsTable)
          .set({ status: "tied", resolvedAt: new Date(), resolvedBy: interaction.user.id })
          .where(eq(payoutRequestsTable.id, payoutId));

        resultLines.push("🤝 **Tie game** — no payout awarded to either player.");

        for (const uid of [request.requesterId, request.opponentId].filter(Boolean) as string[]) {
          try {
            const u = await interaction.client.users.fetch(uid);
            await u.send(`🤝 Your game was confirmed as a **tie** (${myScore}–${oppScore}). No payout is awarded for tied games.`).catch(() => {});
          } catch (_) {}
        }
      } else {
        const winnerId = myScore > oppScore ? request.requesterId : request.opponentId!;
        const loserId  = myScore > oppScore ? request.opponentId! : request.requesterId;
        const winScore = Math.max(myScore, oppScore);
        const loseScore = Math.min(myScore, oppScore);

        await addBalance(winnerId, PVP_WIN_PAYOUT);
        await logTransaction(winnerId, PVP_WIN_PAYOUT, "addcoins", `PvP win payout (${winScore}–${loseScore})`, interaction.user.id);
        await addBalance(loserId, PVP_LOSS_PAYOUT);
        await logTransaction(loserId, PVP_LOSS_PAYOUT, "addcoins", `PvP participation payout (${loseScore}–${winScore})`, interaction.user.id);

        await db.update(payoutRequestsTable)
          .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
          .where(eq(payoutRequestsTable.id, payoutId));

        resultLines.push(
          `🏆 Winner <@${winnerId}> → **+${PVP_WIN_PAYOUT} coins**`,
          `🎮 <@${loserId}> → **+${PVP_LOSS_PAYOUT} coins**`,
        );

        try { const u = await interaction.client.users.fetch(winnerId); await u.send(`🏆 Your PvP payout was approved! **+${PVP_WIN_PAYOUT} coins** added to your balance.`).catch(() => {}); } catch (_) {}
        try { const u = await interaction.client.users.fetch(loserId);  await u.send(`🎮 Your PvP payout was approved! **+${PVP_LOSS_PAYOUT} coins** added to your balance.`).catch(() => {}); } catch (_) {}
      }
    } else if (request.gameType === "cpu") {
      await addBalance(request.requesterId, CPU_WIN_PAYOUT);
      await logTransaction(request.requesterId, CPU_WIN_PAYOUT, "addcoins", "CPU win payout", interaction.user.id);

      await db.update(payoutRequestsTable)
        .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
        .where(eq(payoutRequestsTable.id, payoutId));

      resultLines.push(`🤖 <@${request.requesterId}> → **+${CPU_WIN_PAYOUT} coins** for CPU win`);

      try { const u = await interaction.client.users.fetch(request.requesterId); await u.send(`🤖 Your CPU win payout was approved! **+${CPU_WIN_PAYOUT} coins** added to your balance.`).catch(() => {}); } catch (_) {}
    }

    const resolvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Payout Approved")
      .setDescription(resultLines.join("\n") + `\n\nApproved by: ${interaction.user.toString()}`)
      .setTimestamp();

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("payout_done").setLabel("✅ Approved").setStyle(ButtonStyle.Success).setDisabled(true),
    );

    await interaction.editReply({ embeds: [resolvedEmbed], components: [disabledRow] });
    return;
  }

  if (action === "payout_deny") {
    const payoutId = secondPart!;

    const modal = new ModalBuilder()
      .setCustomId(`payout_modal:${payoutId}`)
      .setTitle("Deny Payout Request");

    const reasonInput = new TextInputBuilder()
      .setCustomId("reason")
      .setLabel("Reason for denial")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500)
      .setPlaceholder("Explain why this payout is being denied...");

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
    await interaction.showModal(modal);
    return;
  }
}

// ── Modal handler ──────────────────────────────────────────────────────────────
async function handleModal(interaction: ModalSubmitInteraction) {
  const [action, idStr] = interaction.customId.split(":");

  if (action === "payout_modal") {
    const payoutId = parseInt(idStr!, 10);
    const reason   = interaction.fields.getTextInputValue("reason");

    const rows = await db.select().from(payoutRequestsTable).where(eq(payoutRequestsTable.id, payoutId)).limit(1);
    const request = rows[0];

    if (!request) {
      await interaction.reply({ content: "❌ Payout request not found.", ephemeral: true });
      return;
    }
    if (request.status !== "pending") {
      await interaction.reply({ content: `⚠️ This request has already been **${request.status}**.`, ephemeral: true });
      return;
    }

    await db.update(payoutRequestsTable)
      .set({ status: "denied", denialReason: reason, resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(payoutRequestsTable.id, payoutId));

    // DM requester
    try {
      const requester = await interaction.client.users.fetch(request.requesterId);
      const gameDesc  = request.gameType === "cpu"
        ? "CPU win"
        : `PvP game (Score: ${request.requesterScore}–${request.opponentScore})`;
      await requester.send(
        `❌ **Your payout request for your ${gameDesc} was denied by a commissioner.**\n**Reason:** ${reason}`,
      ).catch(() => {});
    } catch (_) {}

    // Edit the original commissioner channel message
    try {
      const commChannel = await interaction.client.channels.fetch(process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!);
      if (commChannel?.isTextBased() && request.discordMessageId) {
        const msg = await (commChannel as any).messages.fetch(request.discordMessageId);
        const deniedEmbed = new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Payout Denied")
          .setDescription(`**Denied by:** ${interaction.user.toString()}\n**Reason:** ${reason}`)
          .setTimestamp();
        const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("payout_denied_done").setLabel("❌ Denied").setStyle(ButtonStyle.Danger).setDisabled(true),
        );
        await msg.edit({ embeds: [deniedEmbed], components: [disabledRow] });
      }
    } catch (err) {
      console.error("Failed to edit commissioner message after payout denial:", err);
    }

    await interaction.reply({
      content: `✅ Payout request **#${payoutId}** has been denied. The requester has been notified.`,
      ephemeral: true,
    });
  }
}
