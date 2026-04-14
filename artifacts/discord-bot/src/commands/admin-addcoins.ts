import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { getOrCreateUser, logTransaction } from "../lib/db-helpers.js";
import { isAdminUser } from "../lib/db-helpers.js";

const MAX_USERS = 32;

// ── Extract all Discord snowflake IDs from a raw string of mentions / IDs ──────
// Handles: <@123456789> <@!123456789> and bare 17-20 digit numbers
function extractUserIds(raw: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  // Match mention formats first, then fall back to bare snowflakes
  const mentionRe = /<@!?(\d{17,20})>/g;
  const snowflakeRe = /\b(\d{17,20})\b/g;

  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(raw)) !== null) {
    if (!seen.has(m[1]!)) { seen.add(m[1]!); results.push(m[1]!); }
  }
  // Also capture bare IDs not already caught by mention regex
  while ((m = snowflakeRe.exec(raw)) !== null) {
    if (!seen.has(m[1]!)) { seen.add(m[1]!); results.push(m[1]!); }
  }
  return results;
}

export const data = new SlashCommandBuilder()
  .setName("addcoins")
  .setDescription("Commissioner: Add coins to up to 32 users at once")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("users")
      .setDescription(`@mention or paste up to ${MAX_USERS} users (space or comma separated)`)
      .setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName("amount")
      .setDescription("Coins to add to each user")
      .setRequired(true)
      .setMinValue(1)
  )
  .addStringOption(opt =>
    opt.setName("reason")
      .setDescription("Optional reason shown to each user")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const rawUsers = interaction.options.getString("users", true);
  const amount   = interaction.options.getInteger("amount",  true);
  const reason   = interaction.options.getString("reason") ?? null;

  // ── Parse and validate IDs ────────────────────────────────────────────────
  let userIds = extractUserIds(rawUsers);

  if (userIds.length === 0) {
    return interaction.editReply({
      content: "❌ No valid users found. Please @mention users or paste their IDs.",
    });
  }

  if (userIds.length > MAX_USERS) {
    userIds = userIds.slice(0, MAX_USERS);
  }

  // ── Ensure all users exist in DB ──────────────────────────────────────────
  for (const uid of userIds) {
    const discordUser = await interaction.client.users.fetch(uid).catch(() => null);
    if (discordUser) await getOrCreateUser(uid, discordUser.username, interaction.guildId!);
  }

  // ── Bulk add balance ──────────────────────────────────────────────────────
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${amount}`, updatedAt: new Date() })
    .where(and(inArray(usersTable.discordId, userIds), eq(usersTable.guildId, interaction.guildId!)));

  // ── Fetch new balances for summary ────────────────────────────────────────
  const updated = await db.select({ discordId: usersTable.discordId, balance: usersTable.balance })
    .from(usersTable)
    .where(and(inArray(usersTable.discordId, userIds), eq(usersTable.guildId, interaction.guildId!)));

  const balanceMap = new Map(updated.map(r => [r.discordId, r.balance]));

  // ── Log transactions + DM each user ──────────────────────────────────────
  const txReason = reason ? `Commissioner added coins — ${reason}` : "Commissioner added coins";
  const successLines: string[] = [];
  const failedIds:    string[] = [];

  await Promise.all(userIds.map(async uid => {
    await logTransaction(uid, amount, "addcoins", txReason, interaction.guildId!, interaction.user.id);

    const newBal = balanceMap.get(uid);
    const discordUser = await interaction.client.users.fetch(uid).catch(() => null);

    if (discordUser) {
      successLines.push(
        `${discordUser.toString()} → +**${amount.toLocaleString()}** coins ` +
        `(balance: **${newBal?.toLocaleString() ?? "?"}**)`,
      );
      await discordUser.send(
        `🪙 A commissioner added **${amount.toLocaleString()} coins** to your balance!\n` +
        (reason ? `Reason: *${reason}*\n` : "") +
        `New balance: **${newBal?.toLocaleString() ?? "?"} coins**`
      ).catch(() => {});
    } else {
      failedIds.push(uid);
    }
  }));

  // ── Reply ─────────────────────────────────────────────────────────────────
  const description = [
    ...successLines,
    ...(failedIds.length > 0
      ? [`\n⚠️ Could not fetch ${failedIds.length} user(s): ${failedIds.join(", ")}`]
      : []),
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`✅ Coins Added — ${userIds.length} user${userIds.length !== 1 ? "s" : ""}`)
    .setDescription(description.length > 4000 ? description.slice(0, 3997) + "..." : description)
    .addFields({ name: "Amount each", value: `${amount.toLocaleString()} coins`, inline: true })
    .setTimestamp();

  if (reason) embed.addFields({ name: "Reason", value: reason, inline: true });

  return interaction.editReply({ embeds: [embed] });
}
