import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, coinTransactionsTable, payoutConfigTable, usersTable, userSavingsTable } from "@workspace/db";
import { getSavingsInterestRateBps } from "../../../scheduling/savings-interest.js";

type EconomyUserRow = {
  discordId: string;
  discordUsername: string | null;
  balance: number;
};

function hubRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );
}

async function getOrCreateEconomyUser(discordId: string, username: string, guildId: string): Promise<EconomyUserRow> {
  const existing = await db
    .select({
      discordId: usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      balance: usersTable.balance,
    })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, discordId), eq(usersTable.guildId, guildId)))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing) return existing;

  await db
    .insert(usersTable)
    .values({ discordId, discordUsername: username, balance: 0, guildId })
    .onConflictDoNothing();

  return {
    discordId,
    discordUsername: username,
    balance: 0,
  };
}

async function getSavingsBalance(discordId: string): Promise<number> {
  const row = await db
    .select({ balance: userSavingsTable.balance })
    .from(userSavingsTable)
    .where(eq(userSavingsTable.discordId, discordId))
    .limit(1)
    .then((rows) => rows[0]);

  return row?.balance ?? 0;
}

async function logCoinTransaction(input: {
  guildId: string;
  discordId: string;
  amount: number;
  type:
    | "sendcoins_sent"
    | "sendcoins_received"
    | "savings_deposit"
    | "savings_withdraw";
  description: string;
  relatedUserId?: string | null;
}) {
  await db.insert(coinTransactionsTable).values({
    guildId: input.guildId,
    discordId: input.discordId,
    amount: input.amount,
    type: input.type,
    description: input.description,
    relatedUserId: input.relatedUserId ?? null,
  });
}

export async function showCoinBalance(interaction: ButtonInteraction) {
  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  if (!guildId) return;

  const user = await getOrCreateEconomyUser(interaction.user.id, interaction.user.username, guildId);
  const savings = await getSavingsBalance(interaction.user.id);
  const total = Number(user.balance) + Number(savings);

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🪙 Your Coin Balance")
    .addFields(
      { name: "💰 Wallet", value: `**${Number(user.balance).toLocaleString()}** coins`, inline: true },
      { name: "🏦 Savings", value: `**${Number(savings).toLocaleString()}** coins`, inline: true },
      { name: "📊 Total", value: `**${total.toLocaleString()}** coins`, inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_send_coins_modal").setLabel("📤 Send Coins").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ac_transfer").setLabel("💸 Transfer").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_hub").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function showSendCoinsModal(interaction: ButtonInteraction) {
  const modal = new ModalBuilder()
    .setCustomId("ac_modal_sendcoins")
    .setTitle("Send Coins")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("recipient")
          .setLabel("Recipient's Discord username or @mention")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Amount (coins)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 100"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel("Note (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100),
      ),
    );

  await interaction.showModal(modal);
}

export async function submitSendCoins(interaction: ModalSubmitInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const recipientInput = interaction.fields.getTextInputValue("recipient").trim().replace(/[<@!>]/g, "");
  const amount = Number.parseInt(interaction.fields.getTextInputValue("amount").trim(), 10);
  const note = interaction.fields.getTextInputValue("note").trim();

  if (!Number.isFinite(amount) || amount < 1) {
    await interaction.reply({ content: "❌ Invalid amount.", ephemeral: true });
    return;
  }

  const recipient = await db
    .select({ discordId: usersTable.discordId, discordUsername: usersTable.discordUsername })
    .from(usersTable)
    .where(and(
      eq(usersTable.guildId, guildId),
      sql`lower(${usersTable.discordUsername}) = lower(${recipientInput}) OR ${usersTable.discordId} = ${recipientInput}`,
    ))
    .limit(1)
    .then((rows) => rows[0]);

  if (!recipient) {
    await interaction.reply({ content: `❌ Could not find user **${recipientInput}** in this server.`, ephemeral: true });
    return;
  }

  if (recipient.discordId === interaction.user.id) {
    await interaction.reply({ content: "❌ You can't send coins to yourself.", ephemeral: true });
    return;
  }

  const sender = await getOrCreateEconomyUser(interaction.user.id, interaction.user.username, guildId);
  if (Number(sender.balance) < amount) {
    await interaction.reply({
      content: `❌ Insufficient coins. You have **${Number(sender.balance).toLocaleString()}**, trying to send **${amount.toLocaleString()}**.`,
      ephemeral: true,
    });
    return;
  }

  const recipientName = recipient.discordUsername ?? recipient.discordId;

  await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({ balance: Number(sender.balance) - amount, updatedAt: new Date() as any })
      .where(and(eq(usersTable.discordId, interaction.user.id), eq(usersTable.guildId, guildId)));

    await tx
      .update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() as any })
      .where(and(eq(usersTable.discordId, recipient.discordId), eq(usersTable.guildId, guildId)));

    await tx.insert(coinTransactionsTable).values([
      {
        guildId,
        discordId: interaction.user.id,
        amount: -amount,
        type: "sendcoins_sent",
        description: `Sent to ${recipientName}${note ? `: ${note}` : ""}`,
        relatedUserId: recipient.discordId,
      },
      {
        guildId,
        discordId: recipient.discordId,
        amount,
        type: "sendcoins_received",
        description: `Received from ${interaction.user.username}${note ? `: ${note}` : ""}`,
        relatedUserId: interaction.user.id,
      },
    ]);
  });

  await interaction.reply({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Coins Sent")
        .setDescription(`Sent **${amount.toLocaleString()} coins** to **${recipientName}**${note ? `\n*"${note}"*` : ""}`),
    ],
    components: [hubRow()],
  });
}

export async function showTransferMenu(interaction: ButtonInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const [user, savings, rateBps, lastRunRow] = await Promise.all([
    getOrCreateEconomyUser(interaction.user.id, interaction.user.username, guildId),
    getSavingsBalance(interaction.user.id),
    getSavingsInterestRateBps(),
    db
      .select({ value: payoutConfigTable.value })
      .from(payoutConfigTable)
      .where(and(eq(payoutConfigTable.guildId, guildId), eq(payoutConfigTable.key, "savings_last_interest_at")))
      .limit(1)
      .then((rows) => rows[0]),
  ]);

  const projectedInterest = rateBps > 0 && savings > 0 ? Math.ceil((savings * rateBps) / 10000) : 0;
  const ratePercent = (rateBps / 100).toFixed(2);

  let nextPayoutStr = "~24h from last payout";
  if (lastRunRow?.value) {
    const nextRunMs = Number(lastRunRow.value) * 1000 + 24 * 60 * 60 * 1000;
    const msLeft = nextRunMs - Date.now();
    if (msLeft > 0) {
      const hLeft = Math.floor(msLeft / 3_600_000);
      const mLeft = Math.floor((msLeft % 3_600_000) / 60_000);
      nextPayoutStr = `~${hLeft}h ${mLeft}m`;
    } else {
      nextPayoutStr = "very soon";
    }
  }

  const interestFieldValue =
    rateBps <= 0
      ? "No interest rate currently set."
      : savings <= 0
        ? `Rate: **${ratePercent}%**/day\nDeposit coins to start earning.`
        : `**+${projectedInterest.toLocaleString()} coins** next payout\nRate: **${ratePercent}%**/day · Next: **${nextPayoutStr}**`;

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("💸 Transfer — Choose Direction")
    .setDescription("Move coins between your wallet and savings account.")
    .addFields(
      { name: "💰 Wallet", value: `**${Number(user.balance).toLocaleString()}** coins`, inline: true },
      { name: "🏦 Savings", value: `**${savings.toLocaleString()}** coins`, inline: true },
      { name: "📈 Projected Interest", value: interestFieldValue, inline: false },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ac_transfer_dir:IN").setLabel("➡ Wallet → Savings").setStyle(ButtonStyle.Primary).setDisabled(Number(user.balance) <= 0),
    new ButtonBuilder().setCustomId("ac_transfer_dir:OUT").setLabel("⬅ Savings → Wallet").setStyle(ButtonStyle.Success).setDisabled(savings <= 0),
    new ButtonBuilder().setCustomId("ac_coins").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ac_close").setLabel("✖ Close").setStyle(ButtonStyle.Danger),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

export async function showTransferAmountModal(interaction: ButtonInteraction) {
  const direction = interaction.customId.split(":")[1] as "IN" | "OUT";
  const label = direction === "IN" ? "Wallet → Savings" : "Savings → Wallet";

  const modal = new ModalBuilder()
    .setCustomId(`ac_modal_transfer:${direction}`)
    .setTitle(`Transfer: ${label}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("Amount to transfer (coins)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 500")
          .setRequired(true)
          .setMaxLength(20),
      ),
    );

  await interaction.showModal(modal);
}

export async function submitTransfer(interaction: ModalSubmitInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const direction = interaction.customId.split(":")[1] as "IN" | "OUT";
  const amount = Number.parseInt(interaction.fields.getTextInputValue("amount").trim(), 10);

  if (!Number.isFinite(amount) || amount < 1) {
    await interaction.reply({ content: "❌ Please enter a valid positive amount.", ephemeral: true });
    return;
  }

  const user = await getOrCreateEconomyUser(interaction.user.id, interaction.user.username, guildId);
  const savings = await getSavingsBalance(interaction.user.id);

  if (direction === "IN" && Number(user.balance) < amount) {
    await interaction.reply({ content: `❌ Insufficient wallet balance. You have **${Number(user.balance).toLocaleString()}** coins.`, ephemeral: true });
    return;
  }

  if (direction === "OUT" && savings < amount) {
    await interaction.reply({ content: `❌ Insufficient savings balance. You have **${savings.toLocaleString()}** coins in savings.`, ephemeral: true });
    return;
  }

  await db.transaction(async (tx) => {
    if (direction === "IN") {
      await tx
        .update(usersTable)
        .set({ balance: Number(user.balance) - amount, updatedAt: new Date() as any })
        .where(and(eq(usersTable.discordId, interaction.user.id), eq(usersTable.guildId, guildId)));

      await tx
        .insert(userSavingsTable)
        .values({ discordId: interaction.user.id, balance: amount })
        .onConflictDoUpdate({
          target: userSavingsTable.discordId,
          set: { balance: sql`${userSavingsTable.balance} + ${amount}`, updatedAt: new Date() as any },
        });

      await tx.insert(coinTransactionsTable).values({
        guildId,
        discordId: interaction.user.id,
        amount: -amount,
        type: "savings_deposit",
        description: `Moved ${amount.toLocaleString()} coins from wallet to savings.`,
      });
    } else {
      await tx
        .update(usersTable)
        .set({ balance: Number(user.balance) + amount, updatedAt: new Date() as any })
        .where(and(eq(usersTable.discordId, interaction.user.id), eq(usersTable.guildId, guildId)));

      await tx
        .update(userSavingsTable)
        .set({ balance: savings - amount, updatedAt: new Date() as any })
        .where(eq(userSavingsTable.discordId, interaction.user.id));

      await tx.insert(coinTransactionsTable).values({
        guildId,
        discordId: interaction.user.id,
        amount,
        type: "savings_withdraw",
        description: `Moved ${amount.toLocaleString()} coins from savings to wallet.`,
      });
    }
  });

  const walletAfter = direction === "IN" ? Number(user.balance) - amount : Number(user.balance) + amount;
  const savingsAfter = direction === "IN" ? savings + amount : savings - amount;
  const target = direction === "IN" ? "savings" : "wallet";

  await interaction.reply({
    content: `✅ Transferred **${amount.toLocaleString()}** coins to ${target}.\n💰 Wallet: **${walletAfter.toLocaleString()}** | 🏦 Savings: **${savingsAfter.toLocaleString()}**`,
    ephemeral: true,
  });
}
