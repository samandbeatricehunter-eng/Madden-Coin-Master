import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userSavingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getServerSettings } from "../lib/server-settings.js";
import { isAdminUser, logTransaction } from "../lib/db-helpers.js";
import {
  getSavingsInterestRateBps,
  setSavingsInterestRateBps,
} from "../lib/savings-interest.js";

const SAVINGS_PASSWORD = "interest";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getSavingsBalance(discordId: string): Promise<number> {
  const row = await db.select({ balance: userSavingsTable.balance })
    .from(userSavingsTable)
    .where(eq(userSavingsTable.discordId, discordId))
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
  )
  .addSubcommand(sub =>
    sub.setName("set-rate")
      .setDescription("(Admin) Set the daily savings interest rate (requires password)")
      .addNumberOption(o =>
        o.setName("rate")
          .setDescription("Daily interest percentage, e.g. 1 = 1%, 0.5 = 0.5%")
          .setMinValue(0)
          .setMaxValue(100)
          .setRequired(true)
      )
      .addStringOption(o =>
        o.setName("password")
          .setDescription("Admin password")
          .setRequired(true)
      )
  );

// ── Execute ────────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const settings = await getServerSettings();

  const sub = interaction.options.getSubcommand();

  // set-rate is admin-only — skip coinEconomy gate
  if (sub === "set-rate") return handleSetRate(interaction);

  if (!settings.coinEconomy) {
    await interaction.reply({
      content: "❌ The coin economy is currently disabled by the commissioners.",
      ephemeral: true,
    });
    return;
  }

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

  const wallet   = userRow[0].balance;
  const savings  = await getSavingsBalance(discordId);
  const total    = wallet + savings;
  const rateBps  = await getSavingsInterestRateBps();
  const rateStr  = rateBps > 0 ? `${(rateBps / 100).toFixed(2)}% per day` : "No interest currently set";

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
      {
        name: "📈 Daily Interest Rate",
        value: rateStr,
        inline: false,
      },
    )
    .setFooter({ text: "Interest is credited daily, rounded up — use /savings deposit to start earning" })
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

  await logTransaction(discordId, amount, "savings_deposit", `Deposited ${amount.toLocaleString()} coins to global savings`, interaction.guildId!);

  const newWallet  = walletBalance - amount;
  const newSavings = await getSavingsBalance(discordId);
  const rateBps    = await getSavingsInterestRateBps();
  const interestPreview = rateBps > 0
    ? `\n💡 At today's rate (${(rateBps / 100).toFixed(2)}%), your savings will earn **${Math.ceil(newSavings * rateBps / 10000).toLocaleString()} coins** tomorrow.`
    : "";

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Deposit Successful")
    .setDescription(`**${amount.toLocaleString()} coins** moved from your league wallet into your global savings.${interestPreview}`)
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
  const savingsBalance = await getSavingsBalance(discordId);

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

  await logTransaction(discordId, amount, "savings_withdraw", `Withdrew ${amount.toLocaleString()} coins from global savings to league wallet`, interaction.guildId!);

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

// ── /savings set-rate ─────────────────────────────────────────────────────────

async function handleSetRate(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const password = interaction.options.getString("password", true);
  if (password !== SAVINGS_PASSWORD) {
    await interaction.editReply({ content: "❌ Incorrect password." });
    return;
  }

  const admin = await isAdminUser(interaction.user.id, interaction.guildId!);
  if (!admin) {
    await interaction.editReply({ content: "❌ This command is restricted to league admins." });
    return;
  }

  const ratePercent = interaction.options.getNumber("rate", true);
  const rateBps     = Math.round(ratePercent * 100); // e.g. 1.5% → 150 bps

  await setSavingsInterestRateBps(rateBps, interaction.user.id);

  const displayRate = (rateBps / 100).toFixed(2);

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("✅ Interest Rate Updated")
    .setDescription(
      rateBps === 0
        ? "Daily savings interest has been **disabled**."
        : `Daily savings interest rate set to **${displayRate}% per day**.\n\nInterest is calculated on the savings balance at the time of the nightly payout and rounded up to the nearest whole coin.`,
    )
    .setFooter({ text: `Set by ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
