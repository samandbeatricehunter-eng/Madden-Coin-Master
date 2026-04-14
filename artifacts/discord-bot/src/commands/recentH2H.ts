import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { gameLogTable, usersTable, userRecordsTable } from "@workspace/db";
import { eq, desc, sum } from "drizzle-orm";
import { getOrCreateUser } from "../lib/db-helpers.js";
import { findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

const GAME_TYPE_LABEL: Record<string, string> = {
  regular_season: "Regular Season",
  playoff:        "Playoff",
  superbowl:      "🏆 Super Bowl",
};

export const data = new SlashCommandBuilder()
  .setName("recenth2h")
  .setDescription("View the last 5 H2H game results for any player")
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("NFL team name (leave blank to see your own)")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Discord user (alternative to team)")
      .setRequired(false)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const results = NFL_TEAMS
    .filter(t => t.toLowerCase().startsWith(focused))
    .slice(0, 25)
    .map(t => ({ name: t, value: t }));
  await interaction.respond(results);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const teamName  = interaction.options.getString("team")?.trim();
  const targetUser = interaction.options.getUser("user");

  let discordId: string;
  let label: string;

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Team Not Found").setDescription(`No user is assigned to the **${teamName}**.`)],
      });
    }
    discordId = found.discordId;
    label     = found.team ?? found.discordUsername;
  } else if (targetUser) {
    discordId = targetUser.id;
    await getOrCreateUser(discordId, targetUser.username, interaction.guildId!);
    const row = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
    label     = row[0]?.team ?? targetUser.username;
  } else {
    // Default: show caller's own record
    discordId = interaction.user.id;
    await getOrCreateUser(discordId, interaction.user.username, interaction.guildId!);
    const row = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
    label     = row[0]?.team ?? interaction.user.username;
  }

  const games = await db.select()
    .from(gameLogTable)
    .where(eq(gameLogTable.discordId, discordId))
    .orderBy(desc(gameLogTable.recordedAt))
    .limit(5);

  // All-time stats for summary footer
  const allRecs = await db.select({
    totalWins:   sum(userRecordsTable.wins),
    totalLosses: sum(userRecordsTable.losses),
    sbWins:      sum(userRecordsTable.superbowlWins),
    sbLosses:    sum(userRecordsTable.superbowlLosses),
    poWins:      sum(userRecordsTable.playoffWins),
    poLosses:    sum(userRecordsTable.playoffLosses),
  }).from(userRecordsTable).where(eq(userRecordsTable.discordId, discordId));

  const totals = allRecs[0]!;
  const totalW = Number(totals.totalWins  ?? 0);
  const totalL = Number(totals.totalLosses ?? 0);
  const sbW    = Number(totals.sbWins     ?? 0);
  const sbL    = Number(totals.sbLosses   ?? 0);
  const poW    = Number(totals.poWins     ?? 0);
  const poL    = Number(totals.poLosses   ?? 0);

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`🏈 Recent H2H — ${label}`);

  if (games.length === 0) {
    embed.setDescription("No games have been recorded yet.");
  } else {
    const rows = games.map(g => {
      const resultIcon = g.result === "win" ? "✅" : "❌";
      const spreadStr  = g.pointSpread >= 0 ? `+${g.pointSpread}` : `${g.pointSpread}`;
      const opp        = g.opponentLabel ? ` vs. **${g.opponentLabel}**` : "";
      const typeLabel  = GAME_TYPE_LABEL[g.gameType] ?? g.gameType;
      const ts         = `<t:${Math.floor(g.recordedAt.getTime() / 1000)}:d>`;
      return `${resultIcon} **${g.result === "win" ? "Win" : "Loss"}** (${spreadStr} pts)${opp} — *${typeLabel}* — ${ts}`;
    });
    embed.setDescription(rows.join("\n"));
  }

  // Summary fields
  embed.addFields(
    {
      name: "All-Time Record",
      value: `**${totalW}W - ${totalL}L**`,
      inline: true,
    },
    {
      name: "Postseason",
      value: `Playoffs: **${poW}W-${poL}L** | Super Bowl: **${sbW}W-${sbL}L**`,
      inline: true,
    },
  );

  embed.setFooter({ text: "Showing last 5 games recorded" }).setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}
