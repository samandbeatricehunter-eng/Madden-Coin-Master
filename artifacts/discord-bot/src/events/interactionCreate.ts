import {
  Interaction, ButtonInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  purchasesTable, inventoryTable, legendsTable, usersTable,
  payoutRequestsTable, interviewRequestsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  addBalance, logTransaction,
  upsertH2HRecord, appendGameLog, getOrCreateActiveSeason,
} from "../lib/db-helpers.js";
import { H2H_WIN_PAYOUT, H2H_LOSS_PAYOUT, CPU_WIN_PAYOUT } from "../commands/reportscore.js";
import { INTERVIEW_PAYOUT } from "../commands/interviewrequest.js";

const HEADLINES_CHANNEL_ID     = "1477717664804896899";
const DRAFT_TRACKER_CHANNEL_ID = "1485399096075358299";
const GENERAL_CHANNEL_ID       = "1476321282868908052";

export const name = "interactionCreate";

export async function execute(interaction: Interaction) {
  if (interaction.isAutocomplete()) {
    const client = interaction.client as any;
    const command = client.commands?.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try { await command.autocomplete(interaction); } catch (err) { console.error("Autocomplete error:", err); }
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
      if (interaction.replied || interaction.deferred) await interaction.followUp(errorMsg).catch(() => {});
      else await interaction.reply(errorMsg).catch(() => {});
    }
    return;
  }

  if (interaction.isButton())      { await handleButton(interaction); return; }
  if (interaction.isModalSubmit()) { await handleModal(interaction); }
}

// ── Button handler ─────────────────────────────────────────────────────────────
async function handleButton(interaction: ButtonInteraction) {
  const [action, secondPart, userId, purchaseType] = interaction.customId.split(":");

  // ── Purchase: approve ────────────────────────────────────────────────────────
  if (action === "approve_purchase") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];
    if (!purchase)                      { await interaction.followUp({ content: "❌ Purchase not found.",  ephemeral: true }); return; }
    if (purchase.status === "approved") { await interaction.followUp({ content: "⚠️ Already approved.",    ephemeral: true }); return; }
    if (purchase.status === "refunded") { await interaction.followUp({ content: "⚠️ Already refunded.",    ephemeral: true }); return; }

    await db.update(purchasesTable).set({ status: "approved", approvedAt: new Date() }).where(eq(purchasesTable.id, purchaseId));

    if (purchaseType === "legend" && purchase.legendId) {
      await db.insert(inventoryTable).values({
        discordId: userId!, seasonId: purchase.seasonId, purchaseId: purchase.id,
        itemType: "legend", legendId: purchase.legendId,
        legendName: purchase.playerName, playerPosition: purchase.playerPosition,
      });
      await db.update(legendsTable).set({ isAvailable: false }).where(eq(legendsTable.id, purchase.legendId));
    }

    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Applied In-Game")
      .setDescription(`Purchase **#${purchaseId}** applied.\nApproved by: ${interaction.user.toString()}`)
      .setTimestamp();
    await interaction.editReply({
      embeds: [approvedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("approved_done").setLabel("✅ Applied").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });

    try {
      const user = await interaction.client.users.fetch(userId!);
      let msg = "";
      if (purchaseType === "legend")                      msg = `🏆 Your legend **${purchase.playerName}** has been added to the draft pool! Check \`/inventory\`.`;
      else if (purchaseType === "attribute")              msg = `⚡ Your **${purchase.attributeName}** attribute upgrade has been applied!`;
      else if (purchaseType === "dev_up")                 msg = `📈 Your dev upgrade for **${purchase.playerName}** has been applied!`;
      else if (purchaseType === "age_reset")              msg = `🔄 Your age reset for **${purchase.playerName}** has been applied!`;
      else if (purchaseType?.startsWith("custom_player")) msg = `🎨 Your custom player **${purchase.playerName}** has been applied!`;
      await user.send(`✅ **Purchase #${purchaseId} Approved!**\n${msg}`).catch(() => {});
    } catch (_) {}

    // ── Draft tracker post (legend + custom player only) ──────────────────────
    if (purchaseType === "legend" || purchaseType?.startsWith("custom_player")) {
      try {
        const draftChannel = await interaction.client.channels.fetch(DRAFT_TRACKER_CHANNEL_ID);
        if (draftChannel?.isTextBased()) {
          const tierLabel = purchaseType?.startsWith("custom_player")
            ? ` (${purchaseType.replace("custom_player_", "").toUpperCase()} tier)`
            : "";
          const itemLabel = purchaseType === "legend" ? "Legend" : "Custom Player";

          const draftEmbed = new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle(`🏈 ${itemLabel} Purchase — Draft Tracker`)
            .addFields(
              { name: "Player",    value: `<@${userId}>`, inline: true },
              { name: "Item",      value: `${purchase.playerName ?? "Unknown"}${tierLabel}`, inline: true },
              { name: "Purchase",  value: `#${purchaseId}`, inline: true },
            )
            .setTimestamp();

          const draftRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`draft_drafted:${purchaseId}`)
              .setLabel("✅ Drafted")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`draft_revoked:${purchaseId}`)
              .setLabel("❌ Revoked")
              .setStyle(ButtonStyle.Danger),
          );

          const draftMsg = await (draftChannel as any).send({ embeds: [draftEmbed], components: [draftRow] });
          await db.update(purchasesTable)
            .set({ draftTrackerMessageId: draftMsg.id })
            .where(eq(purchasesTable.id, purchaseId));
        }
      } catch (err) { console.error("Failed to post to draft tracker channel:", err); }

      // ── General channel announcement (legend only) ──────────────────────────
      if (purchaseType === "legend") {
        try {
          const generalChannel = await interaction.client.channels.fetch(GENERAL_CHANNEL_ID);
          if (generalChannel?.isTextBased()) {
            const announceEmbed = new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle("🏆 Legend Purchased!")
              .setDescription(`<@${userId}> just acquired **${purchase.playerName ?? "a Legend"}** from the store!`)
              .setTimestamp();
            await (generalChannel as any).send({ embeds: [announceEmbed] });
          }
        } catch (err) { console.error("Failed to post legend announcement to general channel:", err); }
      }
    }
    return;
  }

  // ── Purchase: refund ─────────────────────────────────────────────────────────
  if (action === "refund_purchase") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];
    if (!purchase)                      { await interaction.followUp({ content: "❌ Purchase not found.", ephemeral: true }); return; }
    if (purchase.status === "refunded") { await interaction.followUp({ content: "⚠️ Already refunded.",  ephemeral: true }); return; }

    await db.update(purchasesTable).set({ status: "refunded" }).where(eq(purchasesTable.id, purchaseId));
    await addBalance(userId!, purchase.cost);
    await logTransaction(userId!, purchase.cost, "purchase_refund",
      `Refund: ${purchase.purchaseType.replace(/_/g, " ")}${purchase.playerName ? ` — ${purchase.playerName}` : ""}`,
      interaction.user.id);

    if (purchaseType === "legend") {
      await db.update(usersTable)
        .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, userId!));
    }
    await db.delete(inventoryTable).where(and(eq(inventoryTable.purchaseId, purchaseId), eq(inventoryTable.discordId, userId!)));

    const refundedEmbed = new EmbedBuilder()
      .setColor(Colors.Red).setTitle("🔄 Purchase Refunded")
      .setDescription(`Purchase **#${purchaseId}** refunded. **${purchase.cost.toLocaleString()} coins** returned.\nRefunded by: ${interaction.user.toString()}`)
      .setTimestamp();
    await interaction.editReply({
      embeds: [refundedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("refunded_done").setLabel("🔄 Refunded").setStyle(ButtonStyle.Danger).setDisabled(true),
      )],
    });

    try {
      const user = await interaction.client.users.fetch(userId!);
      await user.send(`🔄 **Purchase #${purchaseId} Refunded**\n**${purchase.cost.toLocaleString()} coins** returned to your balance.`).catch(() => {});
    } catch (_) {}
    return;
  }

  // ── Draft tracker: drafted (remove message) ──────────────────────────────────
  if (action === "draft_drafted") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();
    try {
      await interaction.message.delete();
    } catch (err) { console.error("Failed to delete draft tracker message:", err); }
    return;
  }

  // ── Draft tracker: revoked (refund + remove message) ─────────────────────────
  if (action === "draft_revoked") {
    const purchaseId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId)).limit(1);
    const purchase = purchases[0];
    if (!purchase) { await interaction.followUp({ content: "❌ Purchase not found.", ephemeral: true }); return; }
    if (purchase.status === "refunded") { await interaction.followUp({ content: "⚠️ Already refunded.", ephemeral: true }); return; }

    const buyerId = purchase.discordId;

    // Refund coins
    await db.update(purchasesTable).set({ status: "refunded" }).where(eq(purchasesTable.id, purchaseId));
    await addBalance(buyerId, purchase.cost);
    await logTransaction(buyerId, purchase.cost, "purchase_refund",
      `Draft revoked: ${purchase.purchaseType.replace(/_/g, " ")}${purchase.playerName ? ` — ${purchase.playerName}` : ""}`,
      interaction.user.id);

    // Restore legend to store if applicable
    if (purchase.purchaseType === "legend" && purchase.legendId) {
      await db.update(legendsTable).set({ isAvailable: true }).where(eq(legendsTable.id, purchase.legendId));
      await db.update(usersTable)
        .set({ totalLegendPurchases: sql`GREATEST(0, ${usersTable.totalLegendPurchases} - 1)`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, buyerId));
    }

    // Remove from inventory
    await db.delete(inventoryTable).where(eq(inventoryTable.purchaseId, purchaseId));

    // DM the buyer
    try {
      const buyer = await interaction.client.users.fetch(buyerId);
      const itemLabel = purchase.playerName ?? purchase.purchaseType.replace(/_/g, " ");
      await buyer.send(
        `❌ **Your ${itemLabel} purchase (#${purchaseId}) has been revoked by the commissioner.**\n` +
        `**${purchase.cost.toLocaleString()} coins** have been returned to your balance.`
      ).catch(() => {});
    } catch (_) {}

    // Delete the draft tracker message
    try {
      await interaction.message.delete();
    } catch (err) { console.error("Failed to delete draft tracker message after revoke:", err); }
    return;
  }

  // ── Score report: approve ────────────────────────────────────────────────────
  if (action === "payout_approve") {
    const payoutId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const rows = await db.select().from(payoutRequestsTable).where(eq(payoutRequestsTable.id, payoutId)).limit(1);
    const request = rows[0];
    if (!request) { await interaction.followUp({ content: "❌ Request not found.", ephemeral: true }); return; }
    if (request.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This request has already been **${request.status}**.`, ephemeral: true });
      return;
    }

    const season      = await getOrCreateActiveSeason();
    const resultLines: string[] = [];
    const myScore  = request.requesterScore ?? 0;
    const oppScore = request.opponentScore  ?? 0;
    const spread   = myScore - oppScore;
    const requesterWon = myScore > oppScore;
    const isTie    = myScore === oppScore;

    // ── H2H ──────────────────────────────────────────────────────────────────
    if (request.gameType === "h2h" || request.gameType === "pvp") {
      if (isTie) {
        await db.update(payoutRequestsTable)
          .set({ status: "tied", resolvedAt: new Date(), resolvedBy: interaction.user.id })
          .where(eq(payoutRequestsTable.id, payoutId));

        await appendGameLog(request.requesterId, season.id, "loss", 0, `[TIE] ${request.opponentTeam ?? "Unknown"}`);
        if (request.opponentId) await appendGameLog(request.opponentId, season.id, "loss", 0, `[TIE] ${request.requesterTeam ?? "Unknown"}`);

        resultLines.push("🤝 **Tie game** — no payout awarded to either player.");
        for (const uid of [request.requesterId, request.opponentId].filter(Boolean) as string[]) {
          try {
            const u = await interaction.client.users.fetch(uid);
            await u.send(`🤝 Your game vs **${uid === request.requesterId ? request.opponentTeam : request.requesterTeam}** was confirmed as a **tie** (${myScore}–${oppScore}). No payout for ties.`).catch(() => {});
          } catch (_) {}
        }
      } else {
        const winnerId   = requesterWon ? request.requesterId : (request.opponentId ?? null);
        const loserId    = requesterWon ? (request.opponentId ?? null) : request.requesterId;
        const winnerTeam = requesterWon ? request.requesterTeam : request.opponentTeam;
        const loserTeam  = requesterWon ? request.opponentTeam  : request.requesterTeam;

        if (winnerId) {
          await addBalance(winnerId, H2H_WIN_PAYOUT);
          await logTransaction(winnerId, H2H_WIN_PAYOUT, "addcoins",
            `H2H win payout vs ${loserTeam} (${Math.max(myScore,oppScore)}–${Math.min(myScore,oppScore)})`, interaction.user.id);
          resultLines.push(`🏆 **${winnerTeam}** (winner) → +**${H2H_WIN_PAYOUT} coins**`);
        }
        if (loserId) {
          await addBalance(loserId, H2H_LOSS_PAYOUT);
          await logTransaction(loserId, H2H_LOSS_PAYOUT, "addcoins",
            `H2H loss payout vs ${winnerTeam} (${Math.min(myScore,oppScore)}–${Math.max(myScore,oppScore)})`, interaction.user.id);
          resultLines.push(`🎮 **${loserTeam}** (loser) → +**${H2H_LOSS_PAYOUT} coins**`);
        }

        await upsertH2HRecord(request.requesterId, season.id, requesterWon,  spread);
        if (request.opponentId) await upsertH2HRecord(request.opponentId, season.id, !requesterWon, -spread);

        await appendGameLog(request.requesterId, season.id, requesterWon ? "win" : "loss", spread, request.opponentTeam ?? "Unknown");
        if (request.opponentId) await appendGameLog(request.opponentId, season.id, requesterWon ? "loss" : "win", -spread, request.requesterTeam ?? "Unknown");

        await db.update(payoutRequestsTable)
          .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
          .where(eq(payoutRequestsTable.id, payoutId));

        if (winnerId) try { const u = await interaction.client.users.fetch(winnerId); await u.send(`🏆 H2H payout approved! **+${H2H_WIN_PAYOUT} coins** added. (${Math.max(myScore,oppScore)}–${Math.min(myScore,oppScore)} vs ${loserTeam})`).catch(() => {}); } catch (_) {}
        if (loserId)  try { const u = await interaction.client.users.fetch(loserId);  await u.send(`🎮 H2H payout approved! **+${H2H_LOSS_PAYOUT} coins** added. (${Math.min(myScore,oppScore)}–${Math.max(myScore,oppScore)} vs ${winnerTeam})`).catch(() => {}); } catch (_) {}
      }

    // ── CPU ────────────────────────────────────────────────────────────────────
    } else if (request.gameType === "cpu") {
      if (requesterWon && !isTie) {
        await addBalance(request.requesterId, CPU_WIN_PAYOUT);
        await logTransaction(request.requesterId, CPU_WIN_PAYOUT, "addcoins",
          `CPU win payout vs ${request.opponentTeam ?? "CPU"}`, interaction.user.id);
        resultLines.push(`🤖 **${request.requesterTeam}** → +**${CPU_WIN_PAYOUT} coins** (CPU win)`);
        try { const u = await interaction.client.users.fetch(request.requesterId); await u.send(`🤖 CPU win payout approved! **+${CPU_WIN_PAYOUT} coins** added. (${myScore}–${oppScore} vs ${request.opponentTeam})`).catch(() => {}); } catch (_) {}
      } else if (isTie) {
        resultLines.push("🤝 **Tie vs CPU** — no payout.");
        try { const u = await interaction.client.users.fetch(request.requesterId); await u.send(`🤝 CPU game vs **${request.opponentTeam}** confirmed as a tie (${myScore}–${oppScore}). No payout for ties.`).catch(() => {}); } catch (_) {}
      } else {
        resultLines.push("❌ **Loss vs CPU** — no payout.");
        try { const u = await interaction.client.users.fetch(request.requesterId); await u.send(`CPU game vs **${request.opponentTeam}** confirmed (${myScore}–${oppScore}). No payout for CPU losses.`).catch(() => {}); } catch (_) {}
      }

      await appendGameLog(request.requesterId, season.id, requesterWon ? "win" : "loss", spread, `[CPU] ${request.opponentTeam ?? "CPU"}`);
      await db.update(payoutRequestsTable)
        .set({ status: isTie ? "tied" : "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
        .where(eq(payoutRequestsTable.id, payoutId));
    }

    const resolvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Score Report Processed")
      .setDescription(resultLines.join("\n") + `\n\nProcessed by: ${interaction.user.toString()}`)
      .setTimestamp();
    await interaction.editReply({
      embeds: [resolvedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("payout_done").setLabel("✅ Processed").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });
    return;
  }

  // ── Score report: deny ───────────────────────────────────────────────────────
  if (action === "payout_deny") {
    const payoutId = secondPart!;
    const modal = new ModalBuilder().setCustomId(`payout_modal:${payoutId}`).setTitle("Deny Score Report");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Reason for denial")
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
        .setPlaceholder("Explain why this score report is being denied..."),
    ));
    await interaction.showModal(modal);
    return;
  }

  // ── Interview: approve ───────────────────────────────────────────────────────
  if (action === "interview_approve") {
    const interviewId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const rows = await db.select().from(interviewRequestsTable).where(eq(interviewRequestsTable.id, interviewId)).limit(1);
    const interview = rows[0];
    if (!interview) { await interaction.followUp({ content: "❌ Interview request not found.", ephemeral: true }); return; }
    if (interview.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This interview has already been **${interview.status}**.`, ephemeral: true });
      return;
    }

    await addBalance(interview.discordId, INTERVIEW_PAYOUT);
    await logTransaction(interview.discordId, INTERVIEW_PAYOUT, "addcoins", "Post-game interview payout", interaction.user.id);
    await db.update(interviewRequestsTable)
      .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(interviewRequestsTable.id, interviewId));

    try {
      const u = await interaction.client.users.fetch(interview.discordId);
      await u.send(`🎙️ Your post-game interview was approved! **+${INTERVIEW_PAYOUT} coins** added to your balance.`).catch(() => {});
    } catch (_) {}

    const approvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green).setTitle("✅ Interview Approved")
      .setDescription(`**+${INTERVIEW_PAYOUT} coins** awarded to <@${interview.discordId}>.\nApproved by: ${interaction.user.toString()}`)
      .setTimestamp();
    await interaction.editReply({
      embeds: [approvedEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("interview_done").setLabel("✅ Approved").setStyle(ButtonStyle.Success).setDisabled(true),
      )],
    });

    try {
      const headlinesChannel = await interaction.client.channels.fetch(HEADLINES_CHANNEL_ID).catch(() => null);
      if (headlinesChannel?.isTextBased()) {
        const headlinesEmbed = new EmbedBuilder()
          .setColor(Colors.Blurple)
          .setTitle("🎙️ Post-Game Interview Approved!")
          .setDescription(`<@${interview.discordId}>'s post-game interview has been approved!\n💰 **+${INTERVIEW_PAYOUT} coins** awarded.`)
          .setFooter({ text: `Interview #${interviewId}` })
          .setTimestamp();
        await (headlinesChannel as TextChannel).send({ content: "@everyone", embeds: [headlinesEmbed] });
      }
    } catch (err) {
      console.error("Failed to post interview approval to headlines channel:", err);
    }

    return;
  }

  // ── Interview: deny (open modal) ─────────────────────────────────────────────
  if (action === "interview_deny") {
    const interviewId = secondPart!;
    const modal = new ModalBuilder().setCustomId(`interview_modal:${interviewId}`).setTitle("Deny Interview Request");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Reason for denial")
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
        .setPlaceholder("Explain why this interview request is being denied..."),
    ));
    await interaction.showModal(modal);
    return;
  }
}

// ── Modal handler ──────────────────────────────────────────────────────────────
async function handleModal(interaction: ModalSubmitInteraction) {
  const parts  = interaction.customId.split(":");
  const action = parts[0]!;
  const idStr  = parts[1];

  // ── Score report denial ──────────────────────────────────────────────────────
  if (action === "payout_modal") {
    const payoutId = parseInt(idStr!, 10);
    const reason   = interaction.fields.getTextInputValue("reason");

    const rows = await db.select().from(payoutRequestsTable).where(eq(payoutRequestsTable.id, payoutId)).limit(1);
    const request = rows[0];
    if (!request) { await interaction.reply({ content: "❌ Request not found.", ephemeral: true }); return; }
    if (request.status !== "pending") {
      await interaction.reply({ content: `⚠️ This request has already been **${request.status}**.`, ephemeral: true });
      return;
    }

    await db.update(payoutRequestsTable)
      .set({ status: "denied", denialReason: reason, resolvedAt: new Date(), resolvedBy: interaction.user.id, interviewClaimed: false })
      .where(eq(payoutRequestsTable.id, payoutId));

    try {
      const requester = await interaction.client.users.fetch(request.requesterId);
      const gameDesc  = request.gameType === "cpu"
        ? `CPU game vs ${request.opponentTeam ?? "CPU"} (${request.requesterScore}–${request.opponentScore})`
        : `H2H game vs ${request.opponentTeam ?? "Unknown"} (${request.requesterScore}–${request.opponentScore})`;
      await requester.send(`❌ **Your score report for your ${gameDesc} was denied.**\n**Reason:** ${reason}\n\nYour interview eligibility has been reset — you may interview after your next verified game.`).catch(() => {});
    } catch (_) {}

    try {
      const commChannel = await interaction.client.channels.fetch(process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!);
      if (commChannel?.isTextBased() && request.discordMessageId) {
        const msg = await (commChannel as any).messages.fetch(request.discordMessageId);
        const deniedEmbed = new EmbedBuilder()
          .setColor(Colors.Red).setTitle("❌ Score Report Denied")
          .setDescription(`**Denied by:** ${interaction.user.toString()}\n**Reason:** ${reason}`)
          .setTimestamp();
        await msg.edit({
          embeds: [deniedEmbed],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("payout_denied_done").setLabel("❌ Denied").setStyle(ButtonStyle.Danger).setDisabled(true),
          )],
        });
      }
    } catch (err) { console.error("Failed to edit commissioner message after score denial:", err); }

    await interaction.reply({ content: `✅ Score report **#${payoutId}** denied. The requester has been notified.`, ephemeral: true });
    return;
  }

  // ── Interview denial ─────────────────────────────────────────────────────────
  if (action === "interview_modal") {
    const interviewId = parseInt(idStr!, 10);
    const reason      = interaction.fields.getTextInputValue("reason");

    const rows = await db.select().from(interviewRequestsTable).where(eq(interviewRequestsTable.id, interviewId)).limit(1);
    const interview = rows[0];
    if (!interview) { await interaction.reply({ content: "❌ Interview not found.", ephemeral: true }); return; }
    if (interview.status !== "pending") {
      await interaction.reply({ content: `⚠️ This interview has already been **${interview.status}**.`, ephemeral: true });
      return;
    }

    await db.update(interviewRequestsTable)
      .set({ status: "denied", denialReason: reason, resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(interviewRequestsTable.id, interviewId));

    await db.update(payoutRequestsTable)
      .set({ interviewClaimed: false })
      .where(eq(payoutRequestsTable.id, interview.payoutRequestId));

    try {
      const u = await interaction.client.users.fetch(interview.discordId);
      await u.send(`❌ **Your post-game interview request was denied.**\n**Reason:** ${reason}\n\nYour interview slot has been reset — you may submit another interview after your next game.`).catch(() => {});
    } catch (_) {}

    try {
      const commChannel = await interaction.client.channels.fetch(process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!);
      if (commChannel?.isTextBased() && interview.discordMessageId) {
        const msg = await (commChannel as any).messages.fetch(interview.discordMessageId);
        const deniedEmbed = new EmbedBuilder()
          .setColor(Colors.Red).setTitle("❌ Interview Denied")
          .setDescription(`**Denied by:** ${interaction.user.toString()}\n**Reason:** ${reason}`)
          .setTimestamp();
        await msg.edit({
          embeds: [deniedEmbed],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("interview_denied_done").setLabel("❌ Denied").setStyle(ButtonStyle.Danger).setDisabled(true),
          )],
        });
      }
    } catch (err) { console.error("Failed to edit commissioner message after interview denial:", err); }

    await interaction.reply({ content: `✅ Interview **#${interviewId}** denied. The player has been notified and their slot has been reset.`, ephemeral: true });
    return;
  }
}
