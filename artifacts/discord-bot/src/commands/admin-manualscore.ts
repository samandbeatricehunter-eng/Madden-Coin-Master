import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable, gameLogTable, coinTransactionsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { addBalance, logTransaction, getOrCreateActiveSeason, isAdminUser } from "../lib/db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";

const COMMISSIONER_CHANNEL_ID = process.env["DISCORD_COMMISSIONER_CHANNEL_ID"] ?? "";

export const data = new SlashCommandBuilder()
  .setName("admin-manualscore")
  .setDescription("Admin: manually record a game result when MCA is unavailable")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o => o
    .setName("homeuser")
    .setDescription("Discord user who played the HOME team")
    .setRequired(true))
  .addIntegerOption(o => o
    .setName("homescore")
    .setDescription("Home team final score")
    .setRequired(true)
    .setMinValue(0))
  .addIntegerOption(o => o
    .setName("awayscore")
    .setDescription("Away team final score")
    .setRequired(true)
    .setMinValue(0))
  .addIntegerOption(o => o
    .setName("week")
    .setDescription("Week number (1–18)")
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(18))
  .addUserOption(o => o
    .setName("awayuser")
    .setDescription("Discord user who played the AWAY team (omit if CPU game)")
    .setRequired(false))
  .addStringOption(o => o
    .setName("gametype")
    .setDescription("Game type (default: regular_season)")
    .setRequired(false)
    .addChoices(
      { name: "Regular Season", value: "regular_season" },
      { name: "Playoff",        value: "playoff" },
      { name: "Super Bowl",     value: "superbowl" },
    ))
  .addStringOption(o => o
    .setName("notes")
    .setDescription("Reason for manual entry (e.g. 'MCA was down Week 8')")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member         = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);
  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const homeDiscordUser = interaction.options.getUser("homeuser", true);
  const awayDiscordUser = interaction.options.getUser("awayuser");
  const homeScore       = interaction.options.getInteger("homescore", true);
  const awayScore       = interaction.options.getInteger("awayscore", true);
  const week            = interaction.options.getInteger("week", true);
  const gameType        = (interaction.options.getString("gametype") ?? "regular_season") as "regular_season" | "playoff" | "superbowl";
  const notes           = interaction.options.getString("notes") ?? "";

  const H2H_WIN_PAYOUT  = await getPayoutValue(PAYOUT_KEYS.H2H_WIN);
  const H2H_LOSS_PAYOUT = await getPayoutValue(PAYOUT_KEYS.H2H_LOSS);
  const CPU_WIN_PAYOUT  = await getPayoutValue(PAYOUT_KEYS.CPU_WIN);

  const season = await getOrCreateActiveSeason();

  const [homeUser] = await db.select().from(usersTable).where(eq(usersTable.discordId, homeDiscordUser.id)).limit(1);
  if (!homeUser) {
    await interaction.editReply({ content: `❌ <@${homeDiscordUser.id}> is not registered. Use \`/admin-setuser\` first.` });
    return;
  }

  let awayUser: typeof homeUser | null = null;
  if (awayDiscordUser) {
    const [row] = await db.select().from(usersTable).where(eq(usersTable.discordId, awayDiscordUser.id)).limit(1);
    if (!row) {
      await interaction.editReply({ content: `❌ <@${awayDiscordUser.id}> is not registered. Use \`/admin-setuser\` first.` });
      return;
    }
    awayUser = row;
  }

  const isCpu  = !awayUser;
  const isTie  = !isCpu && homeScore === awayScore;
  const homeWon = homeScore > awayScore;

  const resultLines: string[] = [];
  const notesLine = notes ? `\nNotes: *${notes}*` : "";

  await db.transaction(async (tx) => {
    if (isCpu) {
      // ── CPU game: home user wins ────────────────────────────────────────
      await tx.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${CPU_WIN_PAYOUT}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, homeUser.discordId));
      await tx.insert(coinTransactionsTable).values({
        discordId: homeUser.discordId, amount: CPU_WIN_PAYOUT, type: "addcoins",
        description: `[Manual Wk${week}] CPU win vs CPU (${homeScore}–${awayScore})`,
      });
      await tx.insert(gameLogTable).values({
        discordId: homeUser.discordId, seasonId: season.id,
        result: "win", pointSpread: homeScore - awayScore,
        opponentLabel: "[CPU]", gameType,
      });
      resultLines.push(`✅ **${homeUser.team ?? homeDiscordUser.username}** beats CPU **${homeScore}–${awayScore}**`);
      resultLines.push(`💰 +${CPU_WIN_PAYOUT} coins → <@${homeUser.discordId}>`);

    } else if (isTie) {
      // ── H2H Tie ──────────────────────────────────────────────────────────
      const upsertTie = async (uid: string, uname: string, team: string | null) => {
        await tx.insert(userRecordsTable).values({
          discordId: uid, discordUsername: uname,
          team, seasonId: season.id,
          wins: 0, losses: 0, ties: 1, pointDifferential: 0,
        }).onConflictDoUpdate({
          target: [userRecordsTable.discordId, userRecordsTable.seasonId],
          set: { ties: sql`${userRecordsTable.ties} + 1`, updatedAt: new Date() },
        });
        await tx.insert(gameLogTable).values({
          discordId: uid, seasonId: season.id,
          result: "tie", pointSpread: 0,
          opponentLabel: team ?? uid, gameType,
        });
      };
      await upsertTie(homeUser.discordId, homeUser.discordUsername, homeUser.team ?? null);
      await upsertTie(awayUser!.discordId, awayUser!.discordUsername, awayUser!.team ?? null);
      resultLines.push(`🤝 TIE: **${homeUser.team ?? homeDiscordUser.username}** ${homeScore}–${awayScore} **${awayUser!.team ?? awayDiscordUser!.username}**`);
      resultLines.push("📋 Ties recorded for both teams — no coins awarded.");

    } else {
      // ── H2H win/loss ──────────────────────────────────────────────────────
      const winner  = homeWon ? homeUser : awayUser!;
      const loser   = homeWon ? awayUser! : homeUser;
      const winDiscord = homeWon ? homeDiscordUser : awayDiscordUser!;
      const loseDiscord = homeWon ? awayDiscordUser! : homeDiscordUser;
      const pointDiff  = Math.abs(homeScore - awayScore);

      // Coins
      await tx.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${H2H_WIN_PAYOUT}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, winner.discordId));
      await tx.insert(coinTransactionsTable).values({
        discordId: winner.discordId, amount: H2H_WIN_PAYOUT, type: "addcoins",
        description: `[Manual Wk${week}] H2H win vs ${loser.team ?? "?"} (${homeScore}–${awayScore})`,
      });
      await tx.update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${H2H_LOSS_PAYOUT}`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, loser.discordId));
      await tx.insert(coinTransactionsTable).values({
        discordId: loser.discordId, amount: H2H_LOSS_PAYOUT, type: "addcoins",
        description: `[Manual Wk${week}] H2H loss vs ${winner.team ?? "?"} (${homeScore}–${awayScore})`,
      });

      // Records
      await tx.insert(userRecordsTable).values({
        discordId: winner.discordId, discordUsername: winner.discordUsername,
        team: winner.team ?? null, seasonId: season.id,
        wins: 1, losses: 0, ties: 0, pointDifferential: pointDiff,
      }).onConflictDoUpdate({
        target: [userRecordsTable.discordId, userRecordsTable.seasonId],
        set: {
          wins: sql`${userRecordsTable.wins} + 1`,
          pointDifferential: sql`${userRecordsTable.pointDifferential} + ${pointDiff}`,
          updatedAt: new Date(),
        },
      });
      await tx.insert(userRecordsTable).values({
        discordId: loser.discordId, discordUsername: loser.discordUsername,
        team: loser.team ?? null, seasonId: season.id,
        wins: 0, losses: 1, ties: 0, pointDifferential: -pointDiff,
      }).onConflictDoUpdate({
        target: [userRecordsTable.discordId, userRecordsTable.seasonId],
        set: {
          losses: sql`${userRecordsTable.losses} + 1`,
          pointDifferential: sql`${userRecordsTable.pointDifferential} - ${pointDiff}`,
          updatedAt: new Date(),
        },
      });
      // All-time H2H counters
      await tx.update(usersTable)
        .set({ allTimeH2HWins:   sql`${usersTable.allTimeH2HWins}   + 1`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, winner.discordId));
      await tx.update(usersTable)
        .set({ allTimeH2HLosses: sql`${usersTable.allTimeH2HLosses} + 1`, updatedAt: new Date() })
        .where(eq(usersTable.discordId, loser.discordId));

      // Game log
      await tx.insert(gameLogTable).values({
        discordId: winner.discordId, seasonId: season.id,
        result: "win", pointSpread: pointDiff,
        opponentLabel: loser.team ?? loser.discordUsername, gameType,
      });
      await tx.insert(gameLogTable).values({
        discordId: loser.discordId, seasonId: season.id,
        result: "loss", pointSpread: -pointDiff,
        opponentLabel: winner.team ?? winner.discordUsername, gameType,
      });

      resultLines.push(`🏆 **${winner.team ?? winDiscord.username}** defeats **${loser.team ?? loseDiscord.username}**, **${Math.max(homeScore, awayScore)}–${Math.min(homeScore, awayScore)}**`);
      resultLines.push(`💰 +${H2H_WIN_PAYOUT} coins → <@${winner.discordId}> | +${H2H_LOSS_PAYOUT} coins → <@${loser.discordId}>`);
      resultLines.push(`📋 Records: **${winner.team ?? "?"}** +1W, **${loser.team ?? "?"}** +1L, PD ${pointDiff > 0 ? "+" : ""}${pointDiff}`);
    }
  });

  const embed = new EmbedBuilder()
    .setColor(isTie ? Colors.Yellow : Colors.Green)
    .setTitle(`🏈 Manual Score Recorded — Week ${week}`)
    .setDescription(resultLines.join("\n") + notesLine)
    .addFields(
      { name: "Season",    value: `Season ${season.seasonNumber}`, inline: true },
      { name: "Week",      value: `Week ${week}`,                  inline: true },
      { name: "Game Type", value: gameType.replace("_", " "),      inline: true },
    )
    .setFooter({ text: `Recorded manually by ${interaction.user.username}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  // ── Post to commissioner log ──────────────────────────────────────────────
  if (COMMISSIONER_CHANNEL_ID) {
    try {
      const ch = await interaction.client.channels.fetch(COMMISSIONER_CHANNEL_ID);
      if (ch?.isTextBased()) {
        const logEmbed = new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle(`📋 Manual Score Entry — Week ${week}`)
          .setDescription(resultLines.join("\n") + notesLine)
          .setFooter({ text: `Entered by ${interaction.user.username} (${interaction.user.id})` })
          .setTimestamp();
        await (ch as TextChannel).send({ embeds: [logEmbed] });
      }
    } catch (err) { console.error("Failed to log manual score to commissioner channel:", err); }
  }
}
