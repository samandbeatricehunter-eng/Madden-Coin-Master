import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { h2hMatchupRecordsTable, usersTable } from "@workspace/db";
import { eq, and, or } from "drizzle-orm";
import { getUserByDiscordId } from "../lib/db-helpers.js";
import { requireMcaEnabled } from "../lib/server-settings.js";

export const data = new SlashCommandBuilder()
  .setName("h2hrecord")
  .setDescription("View your all-time head-to-head record against another league member")
  .addUserOption(o => o
    .setName("opponent")
    .setDescription("The league member to check your record against")
    .setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  if (!await requireMcaEnabled(interaction)) return;

  const callerId   = interaction.user.id;
  const opponentUser = interaction.options.getUser("opponent", true);

  if (opponentUser.id === callerId) {
    await interaction.editReply({ content: "❌ You can't check your record against yourself." });
    return;
  }

  // Look up both users
  const [callerRow, opponentRow] = await Promise.all([
    getUserByDiscordId(callerId),
    getUserByDiscordId(opponentUser.id),
  ]);

  if (!callerRow) {
    await interaction.editReply({ content: "❌ You're not registered in the league yet." });
    return;
  }
  if (!opponentRow) {
    await interaction.editReply({
      content: `❌ <@${opponentUser.id}> is not registered in the league.`,
    });
    return;
  }

  // Canonical pair order (alphabetically smaller ID first)
  const [id1, id2] = callerId < opponentUser.id
    ? [callerId, opponentUser.id]
    : [opponentUser.id, callerId];
  const callerIsId1 = callerId === id1;

  const [record] = await db.select()
    .from(h2hMatchupRecordsTable)
    .where(and(
      eq(h2hMatchupRecordsTable.discordId1, id1),
      eq(h2hMatchupRecordsTable.discordId2, id2),
    ))
    .limit(1);

  const callerWins   = record ? (callerIsId1 ? record.wins1 : record.wins2) : 0;
  const opponentWins = record ? (callerIsId1 ? record.wins2 : record.wins1) : 0;
  const totalGames   = callerWins + opponentWins;

  const callerTeam   = callerRow.team   ?? interaction.user.username;
  const opponentTeam = opponentRow.team ?? opponentUser.username;

  let outcome: string;
  let colour: number;
  if (totalGames === 0) {
    outcome = "No games played yet.";
    colour  = Colors.Grey;
  } else if (callerWins > opponentWins) {
    outcome = `**${callerTeam}** leads the all-time series.`;
    colour  = Colors.Green;
  } else if (opponentWins > callerWins) {
    outcome = `**${opponentTeam}** leads the all-time series.`;
    colour  = Colors.Red;
  } else {
    outcome = "The all-time series is **tied**.";
    colour  = Colors.Yellow;
  }

  const embed = new EmbedBuilder()
    .setTitle("🏈 All-Time H2H Record")
    .setColor(colour)
    .setDescription(outcome)
    .addFields(
      { name: callerTeam,   value: `**${callerWins}** win${callerWins !== 1 ? "s" : ""}`,   inline: true },
      { name: "vs",         value: "—",                                                        inline: true },
      { name: opponentTeam, value: `**${opponentWins}** win${opponentWins !== 1 ? "s" : ""}`, inline: true },
    )
    .setFooter({ text: `Total games: ${totalGames} • Head-to-head H2H games only` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
