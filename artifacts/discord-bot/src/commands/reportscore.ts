import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { payoutRequestsTable, usersTable } from "@workspace/db";
import { eq, and, or, inArray } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "./advanceweek.js";

export const H2H_WIN_PAYOUT  = 50;
export const H2H_LOSS_PAYOUT = 20;
export const CPU_WIN_PAYOUT  = 20;

const NFL_TEAMS = [
  "Arizona Cardinals",  "Atlanta Falcons",    "Baltimore Ravens",   "Buffalo Bills",
  "Carolina Panthers",  "Chicago Bears",      "Cincinnati Bengals", "Cleveland Browns",
  "Dallas Cowboys",     "Denver Broncos",     "Detroit Lions",      "Green Bay Packers",
  "Houston Texans",     "Indianapolis Colts", "Jacksonville Jaguars","Kansas City Chiefs",
  "Las Vegas Raiders",  "Los Angeles Chargers","Los Angeles Rams",   "Miami Dolphins",
  "Minnesota Vikings",  "New England Patriots","New Orleans Saints", "New York Giants",
  "New York Jets",      "Philadelphia Eagles", "Pittsburgh Steelers","San Francisco 49ers",
  "Seattle Seahawks",   "Tampa Bay Buccaneers","Tennessee Titans",   "Washington Commanders",
];

export const data = new SlashCommandBuilder()
  .setName("reportscore")
  .setDescription("Report a final score to request your game payout")
  .addSubcommand(sub =>
    sub.setName("h2h")
      .setDescription(`Report a head-to-head game — win +${H2H_WIN_PAYOUT} coins, loss +${H2H_LOSS_PAYOUT} coins`)
      .addUserOption(opt =>
        opt.setName("opponent").setDescription("The league member you played against").setRequired(true)
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
        opt.setName("opponent_team")
          .setDescription("The NFL team you played against (CPU)")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addIntegerOption(opt =>
        opt.setName("your_score").setDescription("Your team's final score").setRequired(true).setMinValue(0)
      )
      .addIntegerOption(opt =>
        opt.setName("opponent_score").setDescription("The CPU team's final score").setRequired(true).setMinValue(0)
      )
  );

// ── Autocomplete for CPU opponent team ───────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();

  // Look up the user's own team so we can exclude it
  const userRows = await db.select({ team: usersTable.team })
    .from(usersTable)
    .where(eq(usersTable.discordId, interaction.user.id))
    .limit(1);
  const myTeam = userRows[0]?.team ?? null;

  const choices = NFL_TEAMS
    .filter(t => t !== myTeam)
    .filter(t => t.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(t => ({ name: t, value: t }));

  await interaction.respond(choices);
}

// ── Main execute ─────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub           = interaction.options.getSubcommand();
  const myScore       = interaction.options.getInteger("your_score", true);
  const oppScore      = interaction.options.getInteger("opponent_score", true);
  const commChannelId = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;

  const requester     = await getOrCreateUser(interaction.user.id, interaction.user.username);
  const requesterTeam = requester.team ?? interaction.user.username;

  // Get current league week
  const season      = await getOrCreateActiveSeason();
  const currentWeek = (season as any).currentWeek ?? "1";

  // ── Weekly game limit: one payout per user per week (H2H or CPU, not both) ──
  const alreadyHasGame = await db.select({
    id:       payoutRequestsTable.id,
    gameType: payoutRequestsTable.gameType,
  })
    .from(payoutRequestsTable)
    .where(and(
      eq(payoutRequestsTable.week, currentWeek),
      or(
        eq(payoutRequestsTable.requesterId, interaction.user.id),
        eq(payoutRequestsTable.opponentId,  interaction.user.id),
      ),
      inArray(payoutRequestsTable.status, ["pending", "approved"]),
    ))
    .limit(1);

  if (alreadyHasGame.length > 0) {
    const existing  = alreadyHasGame[0]!;
    const typeLabel = existing.gameType === "cpu" ? "CPU" : "head-to-head";
    await interaction.editReply({
      content: [
        `⚠️ **Weekly game limit reached — ${weekLabel(currentWeek)}.**`,
        `You've already ${existing.gameType === "cpu" ? "submitted" : "been part of"} a **${typeLabel}** payout this week (Report #\`${existing.id}\`).`,
        `Only one game payout is allowed per week. Wait for the week to advance.`,
      ].join("\n"),
    });
    return;
  }

  // ── H2H ─────────────────────────────────────────────────────────────────────
  if (sub === "h2h") {
    const opponentUser      = interaction.options.getUser("opponent", true);
    const opponentDiscordId = opponentUser.id;

    if (opponentDiscordId === interaction.user.id) {
      await interaction.editReply({ content: "❌ You can't report a game against yourself." });
      return;
    }

    // ── Duplicate check: block if this matchup already has a pending/approved payout this week ──
    const existing = await db.select({ id: payoutRequestsTable.id, status: payoutRequestsTable.status })
      .from(payoutRequestsTable)
      .where(and(
        eq(payoutRequestsTable.week, currentWeek),
        eq(payoutRequestsTable.gameType, "h2h"),
        or(
          and(
            eq(payoutRequestsTable.requesterId, interaction.user.id),
            eq(payoutRequestsTable.opponentId, opponentDiscordId),
          ),
          and(
            eq(payoutRequestsTable.requesterId, opponentDiscordId),
            eq(payoutRequestsTable.opponentId, interaction.user.id),
          ),
        ),
        inArray(payoutRequestsTable.status, ["pending", "approved"]),
      ))
      .limit(1);

    if (existing.length > 0) {
      const dupe = existing[0]!;
      const stateNote = dupe.status === "approved"
        ? "already been **approved and paid**"
        : "already been **submitted and is pending** commissioner review";
      await interaction.editReply({
        content: [
          `⚠️ **Duplicate game detected — ${weekLabel(currentWeek)}.**`,
          `A score report between you and ${opponentUser.toString()} has ${stateNote} this week.`,
          `Score Report #\`${dupe.id}\` — contact a commissioner if there's a mistake.`,
        ].join("\n"),
      });
      return;
    }

    // Look up opponent's team name from DB
    const opponentRows = await db.select({ team: usersTable.team })
      .from(usersTable)
      .where(eq(usersTable.discordId, opponentDiscordId))
      .limit(1);
    const opponentTeam = opponentRows[0]?.team ?? opponentUser.username;

    // Payout preview
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
      week:           currentWeek,
      status:         "pending",
    }).returning();

    const payoutId = request!.id;

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("🏈 Score Report — H2H Game")
      .addFields(
        { name: "Requester",  value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
        { name: "Opponent",   value: `${opponentUser.toString()} (${opponentTeam})`,      inline: true },
        { name: "Week",       value: weekLabel(currentWeek), inline: true },
        { name: "Final Score",         value: `**${requesterTeam}** ${myScore} – ${oppScore} **${opponentTeam}**` },
        { name: "Payout if Approved",  value: payoutPreview },
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

    await interaction.editReply({
      content: `📨 Score report sent! (Request #\`${payoutId}\`)\n**${requesterTeam}** ${myScore} – ${oppScore} **${opponentTeam}**`,
    });
    return;
  }

  // ── CPU ──────────────────────────────────────────────────────────────────────
  if (sub === "cpu") {
    const opponentTeam = interaction.options.getString("opponent_team", true).trim();
    const isWin  = myScore > oppScore;
    const isTie  = myScore === oppScore;

    let payoutPreview: string;
    if (isWin)      payoutPreview = `+**${CPU_WIN_PAYOUT}** coins *(win confirmed)*`;
    else if (isTie) payoutPreview = "🤝 Tie — no payout.";
    else            payoutPreview = "No payout — CPU losses pay nothing.";

    const [request] = await db.insert(payoutRequestsTable).values({
      requesterId:    interaction.user.id,
      requesterTeam,
      opponentTeam,
      requesterScore: myScore,
      opponentScore:  oppScore,
      gameType:       "cpu",
      week:           currentWeek,
      status:         "pending",
    }).returning();

    const payoutId = request!.id;

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle("🤖 Score Report — CPU Game")
      .addFields(
        { name: "Requester",  value: `${interaction.user.toString()} (${requesterTeam})`, inline: true },
        { name: "CPU Team",   value: opponentTeam, inline: true },
        { name: "Final Score",        value: `**${requesterTeam}** ${myScore} – ${oppScore} **${opponentTeam}**` },
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

    await interaction.editReply({
      content: `📨 CPU score report sent! (Request #\`${payoutId}\`)\n**${requesterTeam}** ${myScore} – ${oppScore} **${opponentTeam}**`,
    });
  }
}
