import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getOrCreateUser, logTransaction } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("addcoins")
  .setDescription("Commissioner: Add coins to a user's balance")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(opt =>
    opt.setName("user").setDescription("The user to give coins to").setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName("amount").setDescription("Amount of coins to add").setRequired(true).setMinValue(1)
  )
  .addStringOption(opt =>
    opt.setName("reason").setDescription("Optional reason (shown to the user)").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const reason = interaction.options.getString("reason");

  await getOrCreateUser(target.id, target.username);

  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, target.id));

  const newBalance = await db.select({ balance: usersTable.balance })
    .from(usersTable).where(eq(usersTable.discordId, target.id)).limit(1);

  await logTransaction(
    target.id,
    amount,
    "addcoins",
    reason ? `Commissioner added coins — ${reason}` : "Commissioner added coins",
    interaction.user.id,
  );

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("✅ Coins Added")
    .setDescription(
      `Added **${amount.toLocaleString()} coins** to ${target.toString()}.\n` +
      `New balance: **${newBalance[0]?.balance.toLocaleString() ?? "?"} coins**` +
      (reason ? `\nReason: *${reason}*` : "")
    )
    .setTimestamp();

  await target.send(
    `🪙 A commissioner added **${amount.toLocaleString()} coins** to your balance!\n` +
    (reason ? `Reason: *${reason}*\n` : "") +
    `New balance: **${newBalance[0]?.balance.toLocaleString() ?? "?"} coins**`
  ).catch(() => {});

  return interaction.editReply({ embeds: [embed] });
}
