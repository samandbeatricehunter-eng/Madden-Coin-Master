import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userSavingsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getServerSettings } from "../lib/server-settings.js";
import { getSavingsInterestRateBps } from "../lib/savings-interest.js";

export const data = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("View your wallet balance, global savings, and current interest rate");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings(interaction.guildId!);
  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled by the commissioners." });
    return;
  }

  const discordId = interaction.user.id;

  const userRow = await db.select({ balance: usersTable.balance })
    .from(usersTable)
    .where(and(
      eq(usersTable.discordId, discordId),
      eq(usersTable.guildId,   interaction.guildId!),
    ))
    .limit(1);

  if (!userRow[0]) {
    await interaction.editReply({ content: "❌ You're not registered. Use `/register` to get started." });
    return;
  }

  const savingsRow = await db.select({ balance: userSavingsTable.balance })
    .from(userSavingsTable)
    .where(eq(userSavingsTable.discordId, discordId))
    .limit(1);

  const wallet  = userRow[0].balance;
  const savings = savingsRow[0]?.balance ?? 0;
  const total   = wallet + savings;
  const rateBps = await getSavingsInterestRateBps();
  const rateStr = rateBps > 0
    ? `${(rateBps / 100).toFixed(2)}% per day`
    : "No interest currently set";

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
