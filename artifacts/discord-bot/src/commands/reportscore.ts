import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { payoutRequestsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "../lib/db-helpers.js";

export const H2H_WIN_PAYOUT  = 50;
export const H2H_LOSS_PAYOUT = 20;
export const CPU_WIN_PAYOUT  = 20;

export const data = new SlashCommandBuilder()
  .setName("reportscore")
  .setDescription("Report a final score to request your game payout")
  .addSubcommand(sub =>
    sub.setName("h2h")
      .setDescription("Report a head-to-head game against another league team")
      .addStringOption(opt =>
        opt.setName("opponent_team").setDescription("The name of the opponent's team").setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName("your_score").setDescription("Your team's final score").setRequired(true).setMinValue(0)
      )
      .addIntegerOption(opt =>
        opt.setName("opponent_score").setDescription("The opponent's final score").setRequired(true).setMinValue(0)
      )
  )
  .addSubcommand(sub =>
    sub.setName("cpu")
      .setDescription(`Report a CPU game — win pays +${CPU_WIN_PAYOUT} coins, loss pays nothing`)
      .addStringOption(opt =>
        opt.setName("opponent_team").setDescription("The CPU team name you played against").setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName("your_score").setDescription("Your team's final score").setRequired(true).setMinValue(0)
      )
      .addIntegerOption(opt =>
        opt.setName("opponent_score").setDescription("The CPU team's final score").setRequired(true).setMinValue(0)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub            = interaction.options.getSubcommand();
  const opponentTeam   = interaction.options.getString("opponent_team", true).trim();
  const myScore        = interaction.options.getInteger("your_score", true);
  const oppScore       = interaction.options.getInteger("opponent_score", true);
  const commChannelId  = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;

  // Get requester's DB record (so we know their team name)
  const requester = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const requesterTeam = requester.team ?? interaction.user.username;

  // ── H2H ──────────────────────────────────────────────────────────────────────
  if (sub === "h2h") {
    // Try to look up the opponent by team name to cache their discordId
    const opponentRows = await db.select({ discordId: usersTable.discordId })
      .from(usersTable)
      .where(eq(usersTable.team, opponentTeam))
      .limit(1);
    const opponentDiscordId = opponentRows[0]?.discordId ?? null;

    // Determine payout preview
    let payoutPreview: string;
    if (myScore > oppScore) {
      payoutPreview = `🏆 **${requesterTeam}** (winner) → +**${H2H_WIN_PAYOUT}** coins\n🎮 **${opponentTeam}** (loser) → +**${H2H_LOSS_PAYOUT}** coins`;
    } else if (oppScore > myScore) {
      payoutPreview = `🏆 **${opponentTeam}** (winner) → +**${H2H_WIN_PAYOUT}** coins\n🎮 **${requesterTeam}** (loser) → +**${H2H_LOSS_PAYOUT}** coins`;
    } else {
      payoutPreview = "🤝 **Tie** — no payout will be awarded.";
    }

    const [request] = await db.insert(payoutRequestsTable).values({
      requesterId:    interaction.user.id,
      requesterTeam,
      opponentId:     opponentDiscordId,
      opponentTeam,
      requesterScore: myScore,
      opponentScore:  oppScore,
      gameType:       "h2h",
      status:         "pending",
    }).returning();

    const payoutId = request!.id;

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("🏈 Score Report — H2H Game")
      .addFields(
        { name: "Requester",  value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
        { name: "Opponent",   value: opponentTeam + (opponentDiscordId ? ` (<@${opponentDiscordId}>)` : ""), inline: true },
        { name: "Final Score", value: `**${requesterTeam}** ${myScore} – ${oppScore} **${opponentTeam}**` },
        { name: "Payout if Approved", value: payoutPreview },
      )
      .setFooter({ text: `Request #${payoutId}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`payout_approve:${payoutId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`payout_deny:${payoutId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
    );

    try {
      const channel = await interaction.client.channels.fetch(commChannelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as any).send({ embeds: [embed], components: [row] });
        await db.update(payoutRequestsTable).set({ discordMessageId: msg.id }).where(eq(payoutRequestsTable.id, payoutId));
      }
    } catch (err) {
      console.error("Failed to post H2H score report:", err);
    }

    await interaction.reply({
      content: `📨 Score report sent to the commissioner! (Request #\`${payoutId}\`)\n**${requesterTeam}** ${myScore} – ${oppScore} **${opponentTeam}**`,
      ephemeral: true,
    });
    return;
  }

  // ── CPU ──────────────────────────────────────────────────────────────────────
  if (sub === "cpu") {
    const isWin  = myScore > oppScore;
    const isTie  = myScore === oppScore;
    let payoutPreview: string;
    if (isWin)       payoutPreview = `+**${CPU_WIN_PAYOUT}** coins *(win confirmed)*`;
    else if (isTie)  payoutPreview = "🤝 Tie — no payout.";
    else             payoutPreview = "No payout — loss vs CPU pays nothing.";

    const [request] = await db.insert(payoutRequestsTable).values({
      requesterId:    interaction.user.id,
      requesterTeam,
      opponentTeam,
      requesterScore: myScore,
      opponentScore:  oppScore,
      gameType:       "cpu",
      status:         "pending",
    }).returning();

    const payoutId = request!.id;

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("🤖 Score Report — CPU Game")
      .addFields(
        { name: "Requester",  value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
        { name: "CPU Team",   value: opponentTeam, inline: true },
        { name: "Final Score", value: `**${requesterTeam}** ${myScore} – ${oppScore} **${opponentTeam}**` },
        { name: "Payout if Approved", value: payoutPreview },
      )
      .setFooter({ text: `Request #${payoutId}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`payout_approve:${payoutId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`payout_deny:${payoutId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
    );

    try {
      const channel = await interaction.client.channels.fetch(commChannelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as any).send({ embeds: [embed], components: [row] });
        await db.update(payoutRequestsTable).set({ discordMessageId: msg.id }).where(eq(payoutRequestsTable.id, payoutId));
      }
    } catch (err) {
      console.error("Failed to post CPU score report:", err);
    }

    await interaction.reply({
      content: `📨 CPU score report sent to the commissioner! (Request #\`${payoutId}\`)\n**${requesterTeam}** ${myScore} – ${oppScore} **${opponentTeam}**`,
      ephemeral: true,
    });
  }
}
