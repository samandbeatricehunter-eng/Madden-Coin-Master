import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getOrCreateUser, getUserBalance, logTransaction } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("removecoins")
  .setDescription("Commissioner: Remove coins from a user's balance")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(opt =>
    opt.setName("user").setDescription("The user to remove coins from").setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName("amount").setDescription("Amount of coins to remove").setRequired(true).setMinValue(1)
  )
  .addStringOption(opt =>
    opt.setName("reason").setDescription("Optional reason (shown to the user)").setRequired(false)
  )
  .addBooleanOption(opt =>
    opt.setName("allow_negative").setDescription("Allow balance to go negative? (default: no)").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const reason = interaction.options.getString("reason");
  const allowNegative = interaction.options.getBoolean("allow_negative") ?? false;

  await getOrCreateUser(target.id, target.username, interaction.guildId!);

  if (!allowNegative) {
    const balance = await getUserBalance(target.id, interaction.guildId!);
    if (balance < amount) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ Insufficient Balance")
            .setDescription(
              `${target.toString()} only has **${balance.toLocaleString()} coins** — can't remove **${amount.toLocaleString()}**.\n\nUse \`allow_negative: True\` to force the deduction.`
            ),
        ],
      });
    }
  }

  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} - ${amount}`, updatedAt: new Date() })
    .where(eq(usersTable.discordId, target.id));

  const newBalance = await db.select({ balance: usersTable.balance })
    .from(usersTable).where(eq(usersTable.discordId, target.id)).limit(1);

  await logTransaction(
    target.id,
    -amount,
    "removecoins",
    reason ? `Commissioner removed coins — ${reason}` : "Commissioner removed coins",
    interaction.user.id,
  );

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🔻 Coins Removed")
    .setDescription(
      `Removed **${amount.toLocaleString()} coins** from ${target.toString()}.\n` +
      `New balance: **${newBalance[0]?.balance.toLocaleString() ?? "?"} coins**` +
      (reason ? `\nReason: *${reason}*` : "")
    )
    .setTimestamp();

  await target.send(
    `🔻 A commissioner removed **${amount.toLocaleString()} coins** from your balance.\n` +
    (reason ? `Reason: *${reason}*\n` : "") +
    `New balance: **${newBalance[0]?.balance.toLocaleString() ?? "?"} coins**`
  ).catch(() => {});

  return interaction.editReply({ embeds: [embed] });
}
