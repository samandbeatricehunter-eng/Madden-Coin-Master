import {
  Interaction, ButtonInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  purchasesTable, inventoryTable, legendsTable, usersTable,
  payoutRequestsTable, interviewRequestsTable, userRecordsTable, wagersTable,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  addBalance, logTransaction,
  upsertH2HRecord, appendGameLog, getOrCreateActiveSeason, getOrCreateUser,
} from "../lib/db-helpers.js";
import { H2H_WIN_PAYOUT, H2H_LOSS_PAYOUT, CPU_WIN_PAYOUT } from "../commands/reportscore.js";
import { INTERVIEW_PAYOUT, getQuestionPool } from "../commands/interviewrequest.js";
import { weekLabel } from "../commands/advanceweek.js";

const HEADLINES_CHANNEL_ID     = "1477717664804896899";
const DRAFT_TRACKER_CHANNEL_ID = "1485399096075358299";
const GENERAL_CHANNEL_ID       = "1476321282868908052";

// ── Playoff + milestone constants ─────────────────────────────────────────────
const PLAYOFF_WEEKS        = new Set(["wildcard", "divisional", "conference", "superbowl"]);
const PLAYOFF_WIN_TOP4     = 75;   // Seeds 1-4 in their conference
const PLAYOFF_WIN_WILDCARD = 100;  // Seeds 5-7 (wildcard entrants)
const PLAYOFF_LOSS_BONUS   = 50;   // All playoff losers

const SB_BONUSES: Record<number, number> = { 1: 250, 2: 500 };
const SB_BONUS_3PLUS = 1000;

const H2H_MILESTONES = [
  { tier: 4, wins: 50, bonus: 1000 },
  { tier: 3, wins: 25, bonus: 500  },
  { tier: 2, wins: 12, bonus: 250  },
  { tier: 1, wins: 5,  bonus: 100  },
] as const;

function checkMilestone(
  totalWins: number,
  currentTier: number,
): { tier: number; wins: number; bonus: number } | null {
  for (const m of H2H_MILESTONES) {
    if (totalWins >= m.wins && currentTier < m.tier) return m;
  }
  return null;
}

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

        const isPlayoffGame   = PLAYOFF_WEEKS.has(request.week ?? "");
        const isSuperBowlGame = request.week === "superbowl";
        const gameLogType: "regular_season" | "playoff" | "superbowl" =
          isSuperBowlGame ? "superbowl" : isPlayoffGame ? "playoff" : "regular_season";

        // Fetch winner's full data (seed, milestones, SB wins) in one read
        const winnerUserRows = winnerId
          ? await db.select({
              allTimeH2HWins:       usersTable.allTimeH2HWins,
              allTimeSuperbowlWins: usersTable.allTimeSuperbowlWins,
              milestoneTierAwarded: usersTable.milestoneTierAwarded,
              playoffSeed:          usersTable.playoffSeed,
            }).from(usersTable).where(eq(usersTable.discordId, winnerId)).limit(1)
          : [];
        const winnerData = winnerUserRows[0] ?? null;

        // ── Determine payouts ──────────────────────────────────────────────
        let winnerPayout: number;
        let loserPayout: number;
        if (isPlayoffGame) {
          const seed   = winnerData?.playoffSeed ?? null;
          const isTop4 = seed !== null && seed <= 4;
          winnerPayout = isTop4 ? PLAYOFF_WIN_TOP4 : PLAYOFF_WIN_WILDCARD;
          loserPayout  = PLAYOFF_LOSS_BONUS;
        } else {
          winnerPayout = H2H_WIN_PAYOUT;
          loserPayout  = H2H_LOSS_PAYOUT;
        }

        // ── Award base payouts ─────────────────────────────────────────────
        const gameDesc = isPlayoffGame ? "Playoff" : "H2H";
        if (winnerId) {
          await addBalance(winnerId, winnerPayout);
          await logTransaction(winnerId, winnerPayout, "addcoins",
            `${gameDesc} win vs ${loserTeam} (${Math.max(myScore,oppScore)}–${Math.min(myScore,oppScore)})`, interaction.user.id);
          resultLines.push(`🏆 **${winnerTeam}** (winner) → +**${winnerPayout} coins**`);
        }
        if (loserId) {
          await addBalance(loserId, loserPayout);
          await logTransaction(loserId, loserPayout, "addcoins",
            `${gameDesc} loss vs ${winnerTeam} (${Math.min(myScore,oppScore)}–${Math.max(myScore,oppScore)})`, interaction.user.id);
          resultLines.push(`🎮 **${loserTeam}** (loser) → +**${loserPayout} coins**`);
        }

        // ── Win/loss record totals ─────────────────────────────────────────
        await upsertH2HRecord(request.requesterId, season.id, requesterWon,  spread);
        if (request.opponentId) await upsertH2HRecord(request.opponentId, season.id, !requesterWon, -spread);

        // ── Playoff-specific record counters ──────────────────────────────
        if (isPlayoffGame && winnerId && loserId) {
          const winnerSeasonRows = await db.select({ id: userRecordsTable.id })
            .from(userRecordsTable)
            .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)))
            .limit(1);
          const loserSeasonRows = await db.select({ id: userRecordsTable.id })
            .from(userRecordsTable)
            .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)))
            .limit(1);

          if (winnerSeasonRows.length > 0) {
            if (isSuperBowlGame) {
              await db.update(userRecordsTable)
                .set({ superbowlWins: sql`${userRecordsTable.superbowlWins} + 1`, updatedAt: new Date() })
                .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)));
            } else {
              await db.update(userRecordsTable)
                .set({ playoffWins: sql`${userRecordsTable.playoffWins} + 1`, updatedAt: new Date() })
                .where(and(eq(userRecordsTable.discordId, winnerId), eq(userRecordsTable.seasonId, season.id)));
            }
          }
          if (loserSeasonRows.length > 0) {
            if (isSuperBowlGame) {
              await db.update(userRecordsTable)
                .set({ superbowlLosses: sql`${userRecordsTable.superbowlLosses} + 1`, updatedAt: new Date() })
                .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)));
            } else {
              await db.update(userRecordsTable)
                .set({ playoffLosses: sql`${userRecordsTable.playoffLosses} + 1`, updatedAt: new Date() })
                .where(and(eq(userRecordsTable.discordId, loserId), eq(userRecordsTable.seasonId, season.id)));
            }
          }
        }

        // ── Super Bowl champion bonus ──────────────────────────────────────
        if (isSuperBowlGame && winnerId && winnerData) {
          const newSBWins = (winnerData.allTimeSuperbowlWins ?? 0) + 1;
          await db.update(usersTable)
            .set({ allTimeSuperbowlWins: sql`${usersTable.allTimeSuperbowlWins} + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, winnerId));
          const sbBonus = SB_BONUSES[newSBWins] ?? SB_BONUS_3PLUS;
          await addBalance(winnerId, sbBonus);
          await logTransaction(winnerId, sbBonus, "addcoins",
            `Super Bowl champion bonus (career SB #${newSBWins})`, interaction.user.id);
          resultLines.push(`🏆 **${winnerTeam}** Super Bowl champion bonus (career #${newSBWins}) → +**${sbBonus} coins**`);
          try {
            const u = await interaction.client.users.fetch(winnerId);
            await u.send(
              `🏆 **Super Bowl Champion!** Career SB win #${newSBWins} earns you **+${sbBonus} coins**! Legendary! 🎉`
            ).catch(() => {});
          } catch (_) {}
        }

        // ── Career H2H loss tracker ────────────────────────────────────────
        if (loserId) {
          await db.update(usersTable)
            .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, loserId));
        }

        // ── Career H2H win milestone check ─────────────────────────────────
        if (winnerId && winnerData) {
          const prevWins    = winnerData.allTimeH2HWins ?? 0;
          const newWins     = prevWins + 1;
          const currentTier = winnerData.milestoneTierAwarded ?? 0;
          await db.update(usersTable)
            .set({ allTimeH2HWins: sql`${usersTable.allTimeH2HWins} + 1`, updatedAt: new Date() })
            .where(eq(usersTable.discordId, winnerId));
          const milestone = checkMilestone(newWins, currentTier);
          if (milestone) {
            await addBalance(winnerId, milestone.bonus);
            await logTransaction(winnerId, milestone.bonus, "addcoins",
              `Career H2H win milestone: ${milestone.wins} wins`, interaction.user.id);
            await db.update(usersTable)
              .set({ milestoneTierAwarded: milestone.tier, updatedAt: new Date() })
              .where(eq(usersTable.discordId, winnerId));
            resultLines.push(`🎯 **${winnerTeam}** hit the **${milestone.wins}-win career milestone** → +**${milestone.bonus} bonus coins**!`);
            try {
              const u = await interaction.client.users.fetch(winnerId);
              await u.send(
                `🎯 **Win Milestone Reached!** You've hit **${milestone.wins} career H2H wins** — **+${milestone.bonus} bonus coins**! Keep it up! 🔥`
              ).catch(() => {});
            } catch (_) {}
          }
        }

        // ── Game log ──────────────────────────────────────────────────────
        await appendGameLog(request.requesterId, season.id, requesterWon ? "win" : "loss", spread, request.opponentTeam ?? "Unknown", gameLogType);
        if (request.opponentId) await appendGameLog(request.opponentId, season.id, requesterWon ? "loss" : "win", -spread, request.requesterTeam ?? "Unknown", gameLogType);

        await db.update(payoutRequestsTable)
          .set({ status: "approved", resolvedAt: new Date(), resolvedBy: interaction.user.id })
          .where(eq(payoutRequestsTable.id, payoutId));

        if (winnerId) try {
          const u = await interaction.client.users.fetch(winnerId);
          await u.send(`🏆 ${gameDesc} win payout approved! **+${winnerPayout} coins** added. (${Math.max(myScore,oppScore)}–${Math.min(myScore,oppScore)} vs ${loserTeam})`).catch(() => {});
        } catch (_) {}
        if (loserId) try {
          const u = await interaction.client.users.fetch(loserId);
          await u.send(`🎮 ${gameDesc} loss payout approved! **+${loserPayout} coins** added. (${Math.min(myScore,oppScore)}–${Math.max(myScore,oppScore)} vs ${winnerTeam})`).catch(() => {});
        } catch (_) {}
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

    // Re-check: must have submitted a game this week
    const gameThisWeek = await db.select({ id: payoutRequestsTable.id })
      .from(payoutRequestsTable)
      .where(and(
        eq(payoutRequestsTable.requesterId, interaction.user.id),
        eq(payoutRequestsTable.week, currentWeek),
      ))
      .limit(1);

    if (gameThisWeek.length === 0) {
      await interaction.editReply({ content: `❌ No game submitted for ${weekDisplay} yet. Report a game with \`/reportscore\` first.` });
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

    // Get the linked score report
    const linkedReport = gameThisWeek[0]!;
    const fullReports  = await db.select().from(payoutRequestsTable).where(eq(payoutRequestsTable.id, linkedReport.id)).limit(1);
    const report       = fullReports[0];

    // Mark score report as interview claimed
    await db.update(payoutRequestsTable)
      .set({ interviewClaimed: true })
      .where(eq(payoutRequestsTable.id, linkedReport.id));

    // Create the interview record with questions + answers
    const [interview] = await db.insert(interviewRequestsTable).values({
      discordId:       interaction.user.id,
      payoutRequestId: linkedReport.id,
      week:            currentWeek,
      status:          "pending",
      question1:       q1,
      question2:       q2,
      question3:       q3,
      answer1:         a1,
      answer2:         a2,
      answer3:         a3,
    }).returning();

    const interviewId   = interview!.id;
    const gameTypeLabel = (report?.gameType ?? "cpu") === "cpu" ? "CPU Game" : "H2H Game";
    const myTeam        = report?.requesterTeam ?? requesterTeam;
    const oppTeam       = report?.opponentTeam  ?? "Unknown";
    const myScore       = report?.requesterScore ?? "?";
    const oppScore      = report?.opponentScore  ?? "?";

    // ── Commissioner embed with all 3 Q&A pairs ──────────────────────────────
    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("🎙️ Post-Game Interview")
      .addFields(
        { name: "Player",    value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
        { name: "Week",      value: weekDisplay,   inline: true },
        { name: "Game Type", value: gameTypeLabel, inline: true },
        { name: "Game",      value: `**${myTeam}** ${myScore} – ${oppScore} **${oppTeam}**` },
        { name: `Q1: ${q1.slice(0, 200)}`, value: a1.slice(0, 1000) },
        { name: `Q2: ${q2.slice(0, 200)}`, value: a2.slice(0, 1000) },
        { name: `Q3: ${q3.slice(0, 200)}`, value: a3.slice(0, 1000) },
        { name: "Payout if Approved", value: `+**${INTERVIEW_PAYOUT} coins**` },
      )
      .setFooter({ text: `Interview #${interviewId} • Score Report #${linkedReport.id}` })
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
