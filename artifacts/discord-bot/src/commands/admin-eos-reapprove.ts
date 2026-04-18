import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { pendingEosPayoutsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { addBalance, logTransaction, getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";


export const data = new SlashCommandBuilder()
  .setName("admin-eos-reapprove")
  .setDescription("Admin: manually approve a stuck pending EOS payout (use when the button failed)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(o => o
    .setName("payout_id")
    .setDescription("The numeric payout ID (shown on the commissioner message footer as 'Payout ID: #X')")
    .setRequired(false)
    .setMinValue(1))
  .addUserOption(o => o
    .setName("user")
    .setDescription("Alternative: find the most recent pending payout for this user")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const payoutId  = interaction.options.getInteger("payout_id");
  const targetUser = interaction.options.getUser("user");

  if (!payoutId && !targetUser) {
    await interaction.editReply({ content: "❌ Provide either a `payout_id` or a `user`." });
    return;
  }

  // ── Look up the payout ─────────────────────────────────────────────────────
  let payout: typeof pendingEosPayoutsTable.$inferSelect | undefined;

  if (payoutId) {
    const [row] = await db.select().from(pendingEosPayoutsTable)
      .where(eq(pendingEosPayoutsTable.id, payoutId)).limit(1);
    payout = row;
  } else if (targetUser) {
    const rows = await db.select().from(pendingEosPayoutsTable)
      .where(and(
        eq(pendingEosPayoutsTable.discordId, targetUser.id),
        inArray(pendingEosPayoutsTable.status, ["pending"]),
      ))
      .orderBy(pendingEosPayoutsTable.id)
      .limit(10);

    if (rows.length === 0) {
      await interaction.editReply({
        content: `❌ No pending EOS payouts found for <@${targetUser.id}>.`,
      });
      return;
    }

    if (rows.length > 1) {
      const list = rows.map(r =>
        `**#${r.id}** — ${r.totalCoins.toLocaleString()} coins (Season ${r.seasonId})`
      ).join("\n");
      await interaction.editReply({
        content: `⚠️ Multiple pending payouts found for <@${targetUser.id}>. Run again with a specific \`payout_id\`:\n${list}`,
      });
      return;
    }

    payout = rows[0];
  }

  if (!payout) {
    await interaction.editReply({ content: `❌ No payout found with ID #${payoutId}.` });
    return;
  }

  if (payout.status !== "pending") {
    await interaction.editReply({
      content: `⚠️ Payout **#${payout.id}** is already **${payout.status}** — no action taken.`,
    });
    return;
  }

  // ── Credit coins and mark approved ────────────────────────────────────────
  await addBalance(payout.discordId, payout.totalCoins, interaction.guildId!);
  await logTransaction(
    payout.discordId,
    payout.totalCoins,
    "addcoins",
    `EOS Season ${payout.seasonId} payout — manually re-approved by ${interaction.user.username}`,
    interaction.user.id,
  );
  await db.update(pendingEosPayoutsTable)
    .set({ status: "approved", approvedBy: interaction.user.id, approvedAt: new Date() })
    .where(eq(pendingEosPayoutsTable.id, payout.id));

  // ── Post to public payouts channel ────────────────────────────────────────
  type BreakdownItem = { label: string; statValue: number; unit: string; tier: number; coins: number };
  const breakdown = (payout.statBreakdown ?? []) as BreakdownItem[];
  const breakdownLines = breakdown.length > 0
    ? breakdown.map(b => `• **${b.label}**: Tier ${b.tier} (+${b.coins.toLocaleString()} coins)`).join("\n")
    : "*No breakdown recorded.*";
  const teamLabel = payout.teamName ? ` (${payout.teamName})` : "";

  try {
    const reapprovePayoutsChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.PAYOUTS);
    const ch = reapprovePayoutsChannelId
      ? await interaction.client.channels.fetch(reapprovePayoutsChannelId).catch(() => null)
      : null;
    if (ch?.isTextBased()) {
      const publicEmbed = new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle("🏆 End-of-Season Payout")
        .setDescription(
          `<@${payout.discordId}>${teamLabel}\n\n` +
          `${breakdownLines}\n\n` +
          `**Total Earned: +${payout.totalCoins.toLocaleString()} 🪙**`,
        )
        .setFooter({ text: `Season ${payout.seasonId} • EOS Payout #${payout.id} (re-approved)` })
        .setTimestamp();
      await (ch as TextChannel).send({ embeds: [publicEmbed] });
    }
  } catch {
    // Non-fatal — coins are already credited
  }

  // ── DM the recipient ───────────────────────────────────────────────────────
  try {
    const u = await interaction.client.users.fetch(payout.discordId);
    const dmEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("🏆 Your EOS Payout Has Been Credited!")
      .setDescription(
        `Your end-of-season payout for Season ${payout.seasonId} has been processed.\n\n` +
        `${breakdownLines}\n\n` +
        `**+${payout.totalCoins.toLocaleString()} coins** added to your balance!`,
      )
      .setFooter({ text: `EOS Payout #${payout.id}` })
      .setTimestamp();
    await u.send({ embeds: [dmEmbed] }).catch(() => {});
  } catch {
    // DMs may be closed
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ EOS Payout Re-Approved")
        .setDescription(
          `**Payout #${payout.id}** for <@${payout.discordId}>${teamLabel} has been manually approved.\n\n` +
          `**+${payout.totalCoins.toLocaleString()} coins** credited successfully.`,
        )
        .addFields(
          { name: "Season",      value: `Season ${payout.seasonId}`, inline: true },
          { name: "Approved By", value: interaction.user.username,    inline: true },
        )
        .setTimestamp(),
    ],
  });
}
