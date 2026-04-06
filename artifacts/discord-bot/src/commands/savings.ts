import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userSavingsTable, coinTransactionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getServerSettings } from "../lib/server-settings.js";
import { logTransaction } from "../lib/db-helpers.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getSavings(discordId: string): Promise<number> {
  const row = await db.select({ balance: userSavingsTable.balance })
    .from(userSavingsTable)
    .where(eq(userSavingsTable.discordId, discordId))
    .limit(1);
  return row[0]?.balance ?? 0;
}

async function getWallet(discordId: string): Promise<number> {
  const row = await db.select({ balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.discordId, discordId))
    .limit(1);
  return row[0]?.balance ?? 0;
}

async function ensureSavingsRow(discordId: string): Promise<void> {
  await db.insert(userSavingsTable)
    .values({ discordId, balance: 0, updatedAt: new Date() })
    .onConflictDoNothing();
}

// ── Command definition ─────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("savings")
  .setDescription("Manage your global savings account — accessible from any league server")
  .addSubcommand(sub =>
    sub.setName("balance")
      .setDescription("View your wallet and savings balances")
  )
  .addSubcommand(sub =>
    sub.setName("deposit")
      .setDescription("Move coins from your league wallet into your global savings account")
      .addIntegerOption(o =>
        o.setName("amount")
          .setDescription("How many coins to deposit")
          .setMinValue(1)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("withdraw")
      .setDescription("Move coins from your global savings account into your league wallet")
      .addIntegerOption(o =>
        o.setName("amount")
          .setDescription("How many coins to withdraw")
          .setMinValue(1)
          .setRequired(true)
      )
  );

// ── Execute ────────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const settings = await getServerSettings();
  if (!settings.coinEconomy) {
    await interaction.reply({
      content: "❌ The coin economy is currently disabled by the commissioners.",
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === "balance")  return handleBalance(interaction);
  if (sub === "deposit")  return handleDeposit(interaction);
  if (sub === "withdraw") return handleWithdraw(interaction);
}

// ── /savings balance ───────────────────────────────────────────────────────────

async function handleBalance(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const discordId = interaction.user.id;

  const userRow = await db.select({ balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.discordId, discordId))
    .limit(1);

  if (!userRow[0]) {
    await interaction.editReply({ content: "❌ You're not registered. Use `/register` to get started." });
    return;
  }

  await ensureSavingsRow(discordId);

  const wallet  = userRow[0].balance;
  const savings = await getSavings(discordId);
  const total   = wallet + savings;

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏦 Your Economy Overview")
    .addFields(
      {
        name: "💳 League Wallet",
        value: `**${wallet.toLocaleString()} coins**\n*Active balance in this server — used for store purchases, wagers, and trades*`,
        inline: false,
      },
      {
        name: "🏦 Global Savings",
        value: `**${savings.toLocaleString()} coins**\n*Accessible from any server running this bot*`,
        inline: false,
      },
      {
        name: "📊 Total",
        value: `**${total.toLocaleString()} coins** across both accounts`,
        inline: false,
      },
    )
    .setFooter({ text: "Use /savings deposit or /savings withdraw to transfer between accounts" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── /savings deposit ──────────────────────────────────────────────────────────

async function handleDeposit(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const discordId = interaction.user.id;
  const amount    = interaction.options.getInteger("amount", true);

  const userRow = await db.select({ balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.discordId, discordId))
    .limit(1);

  if (!userRow[0]) {
    await interaction.editReply({ content: "❌ You're not registered. Use `/register` to get started." });
    return;
  }

  const walletBalance = userRow[0].balance;
  if (walletBalance < amount) {
    await interaction.editReply({
      content: `❌ Insufficient wallet balance. You have **${walletBalance.toLocaleString()} coins** but tried to deposit **${amount.toLocaleString()}**.`,
    });
    return;
  }

  await ensureSavingsRow(discordId);

  // Atomic transfer: deduct from wallet, credit savings
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} - ${amount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, discordId));

  await db.update(userSavingsTable)
    .set({ balance: sql`${userSavingsTable.balance} + ${amount}`, updatedAt: new Date() })
    .where(eq(userSavingsTable.discordId, discordId));

  await logTransaction(discordId, amount, "savings_deposit", `Deposited ${amount.toLocaleString()} coins to global savings`);

  const newWallet  = walletBalance - amount;
  const newSavings = await getSavings(discordId);

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Deposit Successful")
    .setDescription(`**${amount.toLocaleString()} coins** moved from your league wallet into your global savings.`)
    .addFields(
      { name: "💳 New Wallet Balance",  value: `${newWallet.toLocaleString()} coins`,  inline: true },
      { name: "🏦 New Savings Balance", value: `${newSavings.toLocaleString()} coins`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── /savings withdraw ─────────────────────────────────────────────────────────

async function handleWithdraw(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const discordId = interaction.user.id;
  const amount    = interaction.options.getInteger("amount", true);

  const userRow = await db.select({ balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.discordId, discordId))
    .limit(1);

  if (!userRow[0]) {
    await interaction.editReply({ content: "❌ You're not registered. Use `/register` to get started." });
    return;
  }

  await ensureSavingsRow(discordId);
  const savingsBalance = await getSavings(discordId);

  if (savingsBalance < amount) {
    await interaction.editReply({
      content: `❌ Insufficient savings balance. You have **${savingsBalance.toLocaleString()} coins** in savings but tried to withdraw **${amount.toLocaleString()}**.`,
    });
    return;
  }

  // Atomic transfer: deduct from savings, credit wallet
  await db.update(userSavingsTable)
    .set({ balance: sql`${userSavingsTable.balance} - ${amount}`, updatedAt: new Date() })
    .where(eq(userSavingsTable.discordId, discordId));

  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, discordId));

  await logTransaction(discordId, amount, "savings_withdraw", `Withdrew ${amount.toLocaleString()} coins from global savings to league wallet`);

  const newSavings = savingsBalance - amount;
  const newWallet  = (userRow[0].balance) + amount;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("✅ Withdrawal Successful")
    .setDescription(`**${amount.toLocaleString()} coins** moved from your global savings into your league wallet.`)
    .addFields(
      { name: "🏦 New Savings Balance", value: `${newSavings.toLocaleString()} coins`, inline: true },
      { name: "💳 New Wallet Balance",  value: `${newWallet.toLocaleString()} coins`,  inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
