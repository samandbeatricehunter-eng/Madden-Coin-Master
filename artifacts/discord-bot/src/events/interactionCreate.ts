import {
  Interaction, ButtonInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  purchasesTable, inventoryTable, legendsTable, usersTable,
  franchiseGameParticipantsTable, interviewRequestsTable, wagersTable,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  addBalance, logTransaction,
  getOrCreateActiveSeason, getOrCreateUser,
} from "../lib/db-helpers.js";
import { INTERVIEW_PAYOUT, getQuestionPool } from "../commands/interviewrequest.js";
import { weekLabel } from "../commands/advanceweek.js";

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
        const interviewUser = await db.select({ team: usersTable.team }).from(usersTable)
          .where(eq(usersTable.discordId, interview.discordId)).limit(1);
        const teamName = interviewUser[0]?.team ?? null;

        const interviewee = await interaction.client.users.fetch(interview.discordId).catch(() => null);

        const headlinesEmbed = new EmbedBuilder()
          .setColor(Colors.Blurple)
          .setTitle("🎙️ Post-Game Interview")
          .setDescription(
            `**<@${interview.discordId}>**${teamName ? ` — ${teamName}` : ""}\n` +
            `💰 **+${INTERVIEW_PAYOUT} coins** awarded.`
          )
          .addFields(
            {
              name: `❓ Q1: ${interview.question1 ?? ""}`,
              value: interview.answer1 ?? "*No answer provided*",
            },
            {
              name: `❓ Q2: ${interview.question2 ?? ""}`,
              value: interview.answer2 ?? "*No answer provided*",
            },
            {
              name: `❓ Q3: ${interview.question3 ?? ""}`,
              value: interview.answer3 ?? "*No answer provided*",
            },
          )
          .setFooter({ text: `Interview #${interviewId}${interview.week ? ` • ${interview.week}` : ""}` })
          .setTimestamp();

        if (interviewee) headlinesEmbed.setThumbnail(interviewee.displayAvatarURL());

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
    await interaction.showModal(modal).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal (deny) error:", err);
    });
    return;
  }

  // ── Wager: opponent accepts ───────────────────────────────────────────────
  if (action === "wager_accept") {
    const wagerId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const rows = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
    const wager = rows[0];
    if (!wager) { await interaction.followUp({ content: "❌ Wager not found.", ephemeral: true }); return; }
    if (wager.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This wager is no longer pending (status: **${wager.status}**).`, ephemeral: true });
      return;
    }
    if (interaction.user.id !== wager.opponentId) {
      await interaction.followUp({ content: "❌ Only the challenged player can accept this wager.", ephemeral: true });
      return;
    }

    // Verify both users still have sufficient funds
    const [challengerRow] = await db.select({ balance: usersTable.balance })
      .from(usersTable).where(eq(usersTable.discordId, wager.challengerId)).limit(1);
    const [opponentRow] = await db.select({ balance: usersTable.balance })
      .from(usersTable).where(eq(usersTable.discordId, wager.opponentId)).limit(1);

    const challengerBal = challengerRow?.balance ?? 0;
    const opponentBal   = opponentRow?.balance   ?? 0;

    if (challengerBal < wager.amount) {
      await db.update(wagersTable).set({ status: "cancelled" }).where(eq(wagersTable.id, wagerId));
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Wager Cancelled")
          .setDescription(`<@${wager.challengerId}> no longer has enough coins to cover this wager.\n**Wager #${wagerId}** has been cancelled.`)
          .setTimestamp()],
        components: [],
      });
      return;
    }
    if (opponentBal < wager.amount) {
      await interaction.followUp({
        content: `❌ You don't have enough coins. Balance: **${opponentBal.toLocaleString()}**, wager: **${wager.amount.toLocaleString()}**.`,
        ephemeral: true,
      });
      return;
    }

    // Deduct from both — coins go into holding (tracked by wager record)
    await addBalance(wager.challengerId, -wager.amount);
    await logTransaction(wager.challengerId, -wager.amount, "removecoins",
      `Wager #${wagerId} held: ${wager.teamFor} vs ${wager.teamAgainst}`, wager.opponentId);

    await addBalance(wager.opponentId, -wager.amount);
    await logTransaction(wager.opponentId, -wager.amount, "removecoins",
      `Wager #${wagerId} held: ${wager.teamAgainst} vs ${wager.teamFor}`, wager.challengerId);

    await db.update(wagersTable).set({ status: "active" }).where(eq(wagersTable.id, wagerId));

    // Edit the challenge message to show active state
    const activeEmbed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("⚔️ Wager Active — Awaiting Result")
      .setDescription(`<@${wager.challengerId}> vs <@${wager.opponentId}>`)
      .addFields(
        { name: "💰 Pot",                             value: `**${wager.pot.toLocaleString()} coins** in holding` },
        { name: `🏈 <@${wager.challengerId}> is taking`, value: `**${wager.teamFor}**`,    inline: true },
        { name: `🏈 <@${wager.opponentId}> is taking`,   value: `**${wager.teamAgainst}**`, inline: true },
        { name: "📋 Status",                          value: "🔒 Coins held — commissioner will declare the winner" },
      )
      .setFooter({ text: `Wager #${wagerId}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [activeEmbed], components: [] });

    // Post to commissioner channel with winner buttons
    const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
    const commEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("⚔️ Wager — Declare Winner")
      .addFields(
        { name: "Player 1 (Challenger)", value: `<@${wager.challengerId}> — **${wager.teamFor}**`,  inline: true },
        { name: "Player 2 (Opponent)",   value: `<@${wager.opponentId}> — **${wager.teamAgainst}**`, inline: true },
        { name: "💰 Pot", value: `**${wager.pot.toLocaleString()} coins** → goes to winner`, inline: false },
      )
      .setFooter({ text: `Wager #${wagerId} • Click the winner below once the game is played` })
      .setTimestamp();

    const commRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`wager_winner:${wagerId}:${wager.challengerId}`)
        .setLabel(`🏆 ${wager.teamFor} Wins`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`wager_winner:${wagerId}:${wager.opponentId}`)
        .setLabel(`🏆 ${wager.teamAgainst} Wins`)
        .setStyle(ButtonStyle.Primary),
    );

    try {
      const commChannel = await interaction.client.channels.fetch(commChannelId);
      if (commChannel?.isTextBased()) {
        const commMsg = await (commChannel as any).send({ embeds: [commEmbed], components: [commRow] });
        await db.update(wagersTable)
          .set({ commissionerMessageId: commMsg.id })
          .where(eq(wagersTable.id, wagerId));
      }
    } catch (err) { console.error("Failed to post wager to commissioner channel:", err); }

    // DM both players
    for (const [uid, myTeam, theirTeam] of [
      [wager.challengerId, wager.teamFor,    wager.teamAgainst],
      [wager.opponentId,   wager.teamAgainst, wager.teamFor],
    ] as [string, string, string][]) {
      try {
        const u = await interaction.client.users.fetch(uid);
        await u.send(
          `⚔️ **Wager #${wagerId} is now active!**\n` +
          `**${wager.amount.toLocaleString()} coins** have been held from your balance.\n` +
          `You are taking **${myTeam}** against **${theirTeam}**.\n` +
          `The commissioner will declare the winner once the game is played. The pot of **${wager.pot.toLocaleString()} coins** goes to the winner.`
        ).catch(() => {});
      } catch (_) {}
    }
    return;
  }

  // ── Wager: opponent refuses ───────────────────────────────────────────────
  if (action === "wager_refuse") {
    const wagerId = parseInt(secondPart ?? "0", 10);
    await interaction.deferUpdate();

    const rows = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
    const wager = rows[0];
    if (!wager) { await interaction.followUp({ content: "❌ Wager not found.", ephemeral: true }); return; }
    if (wager.status !== "pending") {
      await interaction.followUp({ content: `⚠️ This wager is no longer pending (status: **${wager.status}**).`, ephemeral: true });
      return;
    }
    if (interaction.user.id !== wager.opponentId) {
      await interaction.followUp({ content: "❌ Only the challenged player can refuse this wager.", ephemeral: true });
      return;
    }

    await db.update(wagersTable)
      .set({ status: "refused", resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(wagersTable.id, wagerId));

    const refusedEmbed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle("❌ Wager Refused")
      .setDescription(`<@${wager.opponentId}> refused the wager challenge from <@${wager.challengerId}>.`)
      .addFields(
        { name: `🏈 <@${wager.challengerId}> was taking`, value: `**${wager.teamFor}**`,    inline: true },
        { name: `🏈 <@${wager.opponentId}> was taking`,   value: `**${wager.teamAgainst}**`, inline: true },
      )
      .setFooter({ text: `Wager #${wagerId}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [refusedEmbed], components: [] });

    // DM the challenger
    try {
      const challenger = await interaction.client.users.fetch(wager.challengerId);
      await challenger.send(
        `❌ <@${wager.opponentId}> (**${wager.opponentUsername}**) refused your wager challenge.\n` +
        `Wager #${wagerId} (${wager.teamFor} vs ${wager.teamAgainst}) — no coins were deducted.`
      ).catch(() => {});
    } catch (_) {}
    return;
  }

  // ── Wager: commissioner declares winner ───────────────────────────────────
  if (action === "wager_winner") {
    const wagerId  = parseInt(secondPart ?? "0", 10);
    const winnerId = userId!;
    await interaction.deferUpdate();

    const rows = await db.select().from(wagersTable).where(eq(wagersTable.id, wagerId)).limit(1);
    const wager = rows[0];
    if (!wager) { await interaction.followUp({ content: "❌ Wager not found.", ephemeral: true }); return; }
    if (wager.status !== "active") {
      await interaction.followUp({ content: `⚠️ This wager is not active (status: **${wager.status}**).`, ephemeral: true });
      return;
    }

    const loserId = winnerId === wager.challengerId ? wager.opponentId : wager.challengerId;
    const winnerTeam = winnerId === wager.challengerId ? wager.teamFor : wager.teamAgainst;
    const loserTeam  = winnerId === wager.challengerId ? wager.teamAgainst : wager.teamFor;

    // Pay out the full pot to the winner
    await addBalance(winnerId, wager.pot);
    await logTransaction(winnerId, wager.pot, "addcoins",
      `Wager #${wagerId} won: ${winnerTeam} vs ${loserTeam}`, interaction.user.id);

    await db.update(wagersTable)
      .set({ status: "completed", winnerId, resolvedAt: new Date(), resolvedBy: interaction.user.id })
      .where(eq(wagersTable.id, wagerId));

    // Edit the commissioner message
    const resolvedEmbed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Wager Resolved")
      .setDescription(`**${winnerTeam}** wins!\n<@${winnerId}> collects the pot of **${wager.pot.toLocaleString()} coins**.`)
      .addFields(
        { name: "🏆 Winner", value: `<@${winnerId}> (${winnerTeam})`, inline: true },
        { name: "📉 Loser",  value: `<@${loserId}> (${loserTeam})`,  inline: true },
        { name: "💰 Payout", value: `**${wager.pot.toLocaleString()} coins** → <@${winnerId}>`, inline: false },
        { name: "🔖 Decided by", value: interaction.user.toString(), inline: false },
      )
      .setFooter({ text: `Wager #${wagerId}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [resolvedEmbed], components: [] });

    // DM both players
    try {
      const winnerUser = await interaction.client.users.fetch(winnerId);
      await winnerUser.send(
        `🏆 **You won Wager #${wagerId}!**\n` +
        `You took **${winnerTeam}** and they won — **${wager.pot.toLocaleString()} coins** have been added to your balance.`
      ).catch(() => {});
    } catch (_) {}
    try {
      const loserUser = await interaction.client.users.fetch(loserId);
      await loserUser.send(
        `📉 **Wager #${wagerId} result:** You lost.\n` +
        `You took **${loserTeam}** and they lost to **${winnerTeam}**. Your **${wager.amount.toLocaleString()} coins** have been paid out to the winner.`
      ).catch(() => {});
    } catch (_) {}
    return;
  }

  // ── Interview: open answer modal (player-facing) ──────────────────────────
  if (action === "interview_answer") {
    const targetUserId = secondPart!;    // the user who ran /interviewrequest
    // New format: interview_answer:userId:poolType:i1,i2,i3
    // Old format: interview_answer:userId:i1,i2,i3  (backwards compat)
    const isNewFormat  = userId === "r" || userId === "l";
    const poolType     = isNewFormat ? (userId as "r" | "l") : "r";
    const indicesStr   = isNewFormat ? purchaseType! : userId!;

    if (interaction.user.id !== targetUserId) {
      await interaction.reply({ content: "❌ This interview form isn't yours to fill out.", ephemeral: true });
      return;
    }

    const indices = indicesStr.split(",").map(Number);
    const pool = getQuestionPool(poolType);
    const q1 = pool[indices[0]!]!;
    const q2 = pool[indices[1]!]!;
    const q3 = pool[indices[2]!]!;

    const truncLabel = (q: string) => q.length <= 45 ? q : q.slice(0, 42) + "...";

    const modal = new ModalBuilder()
      .setCustomId(`interview_answer_modal:${poolType}:${indicesStr}`)
      .setTitle("🎙️ Post-Game Interview");

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("a1")
          .setLabel(truncLabel(q1))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(1000)
          .setPlaceholder("Type your answer here..."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("a2")
          .setLabel(truncLabel(q2))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(1000)
          .setPlaceholder("Type your answer here..."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("a3")
          .setLabel(truncLabel(q3))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(10)
          .setMaxLength(1000)
          .setPlaceholder("Type your answer here..."),
      ),
    );

    await interaction.showModal(modal).catch((err: Error) => {
      if ((err as any).code !== 40060) console.error("showModal error:", err);
    });
    return;
  }
}

// ── Modal handler ──────────────────────────────────────────────────────────────
async function handleModal(interaction: ModalSubmitInteraction) {
  const parts  = interaction.customId.split(":");
  const action = parts[0]!;
  const idStr  = parts[1];

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

  // ── Interview: submit answers (player-facing modal) ───────────────────────
  if (action === "interview_answer_modal") {
    // New format: interview_answer_modal:poolType:i1,i2,i3
    // Old format: interview_answer_modal:i1,i2,i3  (backwards compat)
    const isNewFormat = idStr === "r" || idStr === "l";
    const poolType    = isNewFormat ? (idStr as "r" | "l") : "r";
    const indicesStr  = isNewFormat ? parts[2]! : idStr!;
    const indices    = indicesStr.split(",").map(Number);
    const pool = getQuestionPool(poolType);
    const q1 = pool[indices[0]!]!;
    const q2 = pool[indices[1]!]!;
    const q3 = pool[indices[2]!]!;
    const a1 = interaction.fields.getTextInputValue("a1");
    const a2 = interaction.fields.getTextInputValue("a2");
    const a3 = interaction.fields.getTextInputValue("a3");

    await interaction.deferReply({ ephemeral: true });

    const requester     = await getOrCreateUser(interaction.user.id, interaction.user.username);
    const requesterTeam = requester.team ?? interaction.user.username;
    const season        = await getOrCreateActiveSeason();
    const currentWeek   = (season as any).currentWeek ?? "1";
    const weekDisplay   = weekLabel(currentWeek);
    const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;

    // Re-check: must have a game processed by /franchiseupdate this week
    const gameThisWeek = await db.select({
      id:       franchiseGameParticipantsTable.id,
      gameType: franchiseGameParticipantsTable.gameType,
    })
      .from(franchiseGameParticipantsTable)
      .where(and(
        eq(franchiseGameParticipantsTable.discordId, interaction.user.id),
        eq(franchiseGameParticipantsTable.week,      currentWeek),
        eq(franchiseGameParticipantsTable.seasonId,  season.id),
      ))
      .limit(1);

    if (gameThisWeek.length === 0) {
      await interaction.editReply({
        content: `❌ No game on record for ${weekDisplay} yet. A game must be processed via the franchise update before you can submit an interview.`,
      });
      return;
    }

    // Re-check: only one interview per week
    const existingInterview = await db.select({ id: interviewRequestsTable.id, status: interviewRequestsTable.status })
      .from(interviewRequestsTable)
      .where(and(
        eq(interviewRequestsTable.discordId, interaction.user.id),
        eq(interviewRequestsTable.week, currentWeek),
        inArray(interviewRequestsTable.status, ["pending", "approved"]),
      ))
      .limit(1);

    if (existingInterview.length > 0) {
      const dupe = existingInterview[0]!;
      await interaction.editReply({
        content: `⚠️ You already have an interview for ${weekDisplay} (Interview #\`${dupe.id}\`, status: **${dupe.status}**). Only one per week.`,
      });
      return;
    }

    // Create the interview record with questions + answers
    const [interview] = await db.insert(interviewRequestsTable).values({
      discordId: interaction.user.id,
      week:      currentWeek,
      status:    "pending",
      question1: q1,
      question2: q2,
      question3: q3,
      answer1:   a1,
      answer2:   a2,
      answer3:   a3,
    }).returning();

    const interviewId   = interview!.id;
    const gameTypeLabel = (gameThisWeek[0]?.gameType ?? "cpu") === "h2h" ? "H2H Game" : "CPU Game";

    // ── Commissioner embed with all 3 Q&A pairs ──────────────────────────────
    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("🎙️ Post-Game Interview")
      .addFields(
        { name: "Player",    value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
        { name: "Week",      value: weekDisplay,   inline: true },
        { name: "Game Type", value: gameTypeLabel, inline: true },
        { name: `Q1: ${q1.slice(0, 200)}`, value: a1.slice(0, 1000) },
        { name: `Q2: ${q2.slice(0, 200)}`, value: a2.slice(0, 1000) },
        { name: `Q3: ${q3.slice(0, 200)}`, value: a3.slice(0, 1000) },
        { name: "Payout if Approved", value: `+**${INTERVIEW_PAYOUT} coins**` },
      )
      .setFooter({ text: `Interview #${interviewId}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`interview_approve:${interviewId}`)
        .setLabel("✅ Approve Interview")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`interview_deny:${interviewId}`)
        .setLabel("❌ Deny")
        .setStyle(ButtonStyle.Danger),
    );

    try {
      const channel = await interaction.client.channels.fetch(commChannelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as any).send({ embeds: [embed], components: [row] });
        await db.update(interviewRequestsTable)
          .set({ discordMessageId: msg.id })
          .where(eq(interviewRequestsTable.id, interviewId));
      }
    } catch (err) {
      console.error("Failed to post interview to commissioner channel:", err);
    }

    await interaction.editReply({
      content: [
        `✅ **Interview submitted for ${weekDisplay}!** (Interview #\`${interviewId}\`)`,
        `Your answers have been sent to the commissioner for review.`,
        `You'll get a DM once it's approved or denied.`,
      ].join("\n"),
    });
    return;
  }
}
