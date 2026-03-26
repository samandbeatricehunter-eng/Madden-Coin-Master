import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { payoutRequestsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "../lib/db-helpers.js";

export const PVP_WIN_PAYOUT  = 50;
export const PVP_LOSS_PAYOUT = 20;
export const CPU_WIN_PAYOUT  = 20;

export const data = new SlashCommandBuilder()
  .setName("requestpayout")
  .setDescription("Request a coin payout for a completed game")
  .addSubcommand(sub =>
    sub.setName("pvp")
      .setDescription("Request payout for a game against another league member")
      .addUserOption(opt =>
        opt.setName("opponent").setDescription("The player you played against").setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName("my_score").setDescription("Your final score").setRequired(true).setMinValue(0)
      )
      .addIntegerOption(opt =>
        opt.setName("opponent_score").setDescription("Your opponent's final score").setRequired(true).setMinValue(0)
      )
  )
  .addSubcommand(sub =>
    sub.setName("cpu")
      .setDescription(`Request a ${CPU_WIN_PAYOUT}-coin payout for winning a CPU game`)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;

  await getOrCreateUser(interaction.user.id, interaction.user.username);

  // ── PvP ──────────────────────────────────────────────────────────────────────
  if (sub === "pvp") {
    const opponent    = interaction.options.getUser("opponent", true);
    const myScore     = interaction.options.getInteger("my_score", true);
    const oppScore    = interaction.options.getInteger("opponent_score", true);

    if (opponent.id === interaction.user.id) {
      await interaction.reply({ content: "❌ You can't request a payout against yourself.", ephemeral: true });
      return;
    }
    if (opponent.bot) {
      await interaction.reply({ content: "❌ That's a bot. Use `/requestpayout cpu` for CPU games.", ephemeral: true });
      return;
    }

    await getOrCreateUser(opponent.id, opponent.username).catch(() => {});

    const [request] = await db.insert(payoutRequestsTable).values({
      requesterId:    interaction.user.id,
      opponentId:     opponent.id,
      requesterScore: myScore,
      opponentScore:  oppScore,
      gameType:       "pvp",
      status:         "pending",
    }).returning();

    const payoutId = request!.id;

    let payoutPreview: string;
    if (myScore > oppScore) {
      payoutPreview = `🏆 **${interaction.user.username}** (winner) → +**${PVP_WIN_PAYOUT}** coins\n🎮 **${opponent.username}** (loser) → +**${PVP_LOSS_PAYOUT}** coins`;
    } else if (oppScore > myScore) {
      payoutPreview = `🏆 **${opponent.username}** (winner) → +**${PVP_WIN_PAYOUT}** coins\n🎮 **${interaction.user.username}** (loser) → +**${PVP_LOSS_PAYOUT}** coins`;
    } else {
      payoutPreview = "🤝 **Tie game** — no payout will be awarded if approved.";
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("🎮 Payout Request — PvP Game")
      .addFields(
        { name: "Requester", value: interaction.user.toString(), inline: true },
        { name: "Opponent",  value: opponent.toString(),         inline: true },
        { name: "Final Score", value: `**${interaction.user.username}** ${myScore} – ${oppScore} **${opponent.username}**` },
        { name: "Payout if Approved", value: payoutPreview },
      )
      .setFooter({ text: `Request #${payoutId} • Submitted by ${interaction.user.tag}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`payout_approve:${payoutId}`).setLabel("✅ Approve Payout").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`payout_deny:${payoutId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
    );

    try {
      const channel = await interaction.client.channels.fetch(commChannelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as any).send({ embeds: [embed], components: [row] });
        await db.update(payoutRequestsTable).set({ discordMessageId: msg.id }).where(eq(payoutRequestsTable.id, payoutId));
      }
    } catch (err) {
      console.error("Failed to post payout request to commissioner channel:", err);
    }

    await interaction.reply({
      content: `📨 Your payout request has been sent to the commissioner for review! (Request #\`${payoutId}\`)`,
      ephemeral: true,
    });
    return;
  }

  // ── CPU ──────────────────────────────────────────────────────────────────────
  if (sub === "cpu") {
    const [request] = await db.insert(payoutRequestsTable).values({
      requesterId: interaction.user.id,
      gameType:    "cpu",
      status:      "pending",
    }).returning();

    const payoutId = request!.id;

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("🤖 Payout Request — CPU Game")
      .addFields(
        { name: "Requester",          value: interaction.user.toString(), inline: true },
        { name: "Game Type",          value: "Win vs CPU",                inline: true },
        { name: "Payout if Approved", value: `+**${CPU_WIN_PAYOUT}** coins` },
      )
      .setFooter({ text: `Request #${payoutId} • Submitted by ${interaction.user.tag}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`payout_approve:${payoutId}`).setLabel("✅ Approve Payout").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`payout_deny:${payoutId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger),
    );

    try {
      const channel = await interaction.client.channels.fetch(commChannelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as any).send({ embeds: [embed], components: [row] });
        await db.update(payoutRequestsTable).set({ discordMessageId: msg.id }).where(eq(payoutRequestsTable.id, payoutId));
      }
    } catch (err) {
      console.error("Failed to post CPU payout request to commissioner channel:", err);
    }

    await interaction.reply({
      content: `📨 Your CPU win payout request has been sent to the commissioner! (Request #\`${payoutId}\`)`,
      ephemeral: true,
    });
  }
}
