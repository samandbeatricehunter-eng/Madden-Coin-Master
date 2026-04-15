import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, seasonsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

import { isAdminUser } from "../lib/db-helpers.js";
import { assignRosterLegends, formatLegendAssignResult } from "../lib/roster-legend-assign.js";

export const data = new SlashCommandBuilder()
  .setName("admin-roster-legends")
  .setDescription("Commissioner: Scan a user's team roster and auto-assign matching permanent vault legends")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o => o
    .setName("user")
    .setDescription("The league member to scan")
    .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!await isAdminUser(interaction.user.id, interaction.guildId!)) {
    await interaction.editReply({ content: "❌ Commissioner access required." });
    return;
  }

  const targetUser = interaction.options.getUser("user", true);
  const guildId    = interaction.guildId!;

  const [userRow] = await db.select({
    discordId: usersTable.discordId,
    team:      usersTable.team,
  })
    .from(usersTable)
    .where(and(eq(usersTable.discordId, targetUser.id), eq(usersTable.guildId, guildId)))
    .limit(1);

  if (!userRow) {
    await interaction.editReply({ content: `❌ <@${targetUser.id}> is not registered in this league.` });
    return;
  }

  if (!userRow.team) {
    await interaction.editReply({ content: `❌ <@${targetUser.id}> does not have a team linked yet. Use \`/admin-linkteam set\` first.` });
    return;
  }

  const [season] = await db.select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(and(eq(seasonsTable.guildId, guildId), eq(seasonsTable.isActive, true)))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found." });
    return;
  }

  const result = await assignRosterLegends(targetUser.id, guildId, userRow.team, season.id);

  const summary = formatLegendAssignResult(result, userRow.team);

  const embed = new EmbedBuilder()
    .setColor(result.added.length > 0 ? Colors.Gold : Colors.Blue)
    .setTitle("🏅 Roster Legend Scan")
    .addFields(
      { name: "Player", value: `<@${targetUser.id}>`, inline: true },
      { name: "Team",   value: userRow.team,           inline: true },
      { name: "Result", value: summary },
    )
    .setFooter({ text: "Legends are assigned based on matching player names on the team's active roster." })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
