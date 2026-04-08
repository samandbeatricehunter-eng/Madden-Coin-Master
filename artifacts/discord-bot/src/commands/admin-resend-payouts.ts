import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { pendingChannelPayoutsTable, usersTable } from "@workspace/db";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-resend-payouts")
  .setDescription("Admin: re-send commissioner messages for stream/highlight payouts that failed to deliver")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o
    .setName("type")
    .setDescription("Which payout type to recover (default: both)")
    .setRequired(false)
    .addChoices(
      { name: "Streams only",    value: "stream"    },
      { name: "Highlights only", value: "highlight" },
      { name: "Both",            value: "both"      },
    ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"];
  if (!commChannelId) {
    await interaction.editReply("❌ `DISCORD_COMMISSIONER_CHANNEL_ID` is not set.");
    return;
  }

  const commChannel = await interaction.client.channels.fetch(commChannelId).catch(() => null);
  if (!commChannel?.isTextBased()) {
    await interaction.editReply("❌ Cannot reach the commissioner channel — check the channel ID env var.");
    return;
  }

  const typeFilter = interaction.options.getString("type") ?? "both";
  const types: ("stream" | "highlight")[] = typeFilter === "stream"
    ? ["stream"]
    : typeFilter === "highlight"
      ? ["highlight"]
      : ["stream", "highlight"];

  const season = await getOrCreateActiveSeason();

  // Find all pending payouts with no commMessageId (orphaned)
  const orphans = await db
    .select()
    .from(pendingChannelPayoutsTable)
    .where(and(
      eq(pendingChannelPayoutsTable.seasonId, season.id),
      inArray(pendingChannelPayoutsTable.type, types),
      inArray(pendingChannelPayoutsTable.status, ["pending"]),
      isNull(pendingChannelPayoutsTable.commMessageId),
    ));

  if (orphans.length === 0) {
    await interaction.editReply("✅ No orphaned pending payouts found — everything looks good.");
    return;
  }

  let sent = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const payout of orphans) {
    try {
      // Look up the user's team name if not stored
      const [userRow] = await db
        .select({ team: usersTable.team })
        .from(usersTable)
        .where(eq(usersTable.discordId, payout.discordId))
        .limit(1);
      const team = payout.opponentTeam ?? userRow?.team ?? null;

      if (payout.type === "stream") {
        const isH2H = !!payout.opponentDiscordId;
        const payoutDesc = isH2H
          ? `+${payout.amount} coins → <@${payout.discordId}>\n+${payout.opponentAmount ?? payout.amount} coins → <@${payout.opponentDiscordId}> (H2H opponent)`
          : `+${payout.amount} coins → <@${payout.discordId}> (CPU game — opponent not awarded)`;

        const embed = new EmbedBuilder()
          .setColor(Colors.Purple)
          .setTitle("🎮 Stream Payout — Approval Required")
          .setDescription(
            `<@${payout.discordId}>${team ? ` (${team})` : ""} posted a Twitch stream.\n\n` +
            `**Payout:**\n${payoutDesc}\n\n` +
            `⚠️ *This message was re-sent by admin — original delivery failed.*`,
          )
          .setFooter({ text: `Payout #${payout.id} • Week ${payout.week}` })
          .setTimestamp();

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`stream_approve:${payout.id}`)
            .setLabel("✅ Approve & Pay Out")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`stream_deny:${payout.id}`)
            .setLabel("❌ Deny")
            .setStyle(ButtonStyle.Danger),
        );

        const msg = await (commChannel as TextChannel).send({ embeds: [embed], components: [row] });
        await db.update(pendingChannelPayoutsTable)
          .set({ commMessageId: msg.id })
          .where(eq(pendingChannelPayoutsTable.id, payout.id));
        sent++;

      } else if (payout.type === "highlight") {
        const embed = new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("🎬 Highlight Payout — Approval Required")
          .setDescription(
            `<@${payout.discordId}>${team ? ` (${team})` : ""} posted a highlight video.\n\n` +
            `**Payout:** +${payout.amount} coins → <@${payout.discordId}>\n\n` +
            `⚠️ *This message was re-sent by admin — original delivery failed.*`,
          )
          .setFooter({ text: `Payout #${payout.id} • Week ${payout.week}` })
          .setTimestamp();

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`highlight_approve:${payout.id}`)
            .setLabel("✅ Approve & Pay Out")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`highlight_deny:${payout.id}`)
            .setLabel("❌ Deny")
            .setStyle(ButtonStyle.Danger),
        );

        const msg = await (commChannel as TextChannel).send({ embeds: [embed], components: [row] });
        await db.update(pendingChannelPayoutsTable)
          .set({ commMessageId: msg.id })
          .where(eq(pendingChannelPayoutsTable.id, payout.id));
        sent++;
      }

    } catch (err) {
      console.error(`[admin-resend-payouts] Failed for payout #${payout.id}:`, err);
      failed++;
      failures.push(`Payout #${payout.id} (<@${payout.discordId}>, week ${payout.week})`);
    }
  }

  const lines: string[] = [
    `**Found ${orphans.length} orphaned payout(s)**`,
    `✅ Successfully re-sent: **${sent}**`,
  ];
  if (failed > 0) {
    lines.push(`❌ Failed: **${failed}**`);
    lines.push(failures.join("\n"));
  }

  await interaction.editReply(lines.join("\n"));
}
