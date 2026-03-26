import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { isAdminUser } from "../lib/db-helpers.js";
import { isNotNull } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("listuserteams")
  .setDescription("List all active users and their linked teams (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member       = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const users = await db
    .select({
      discordId:       usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team:            usersTable.team,
    })
    .from(usersTable)
    .where(isNotNull(usersTable.team))
    .orderBy(usersTable.team);

  if (users.length === 0) {
    await interaction.editReply({ content: "No users have a team linked yet." });
    return;
  }

  // Discord embed field values cap at 1024 chars — chunk into pages of 25
  const lines = users.map(u => `<@${u.discordId}> — **${u.team}**`);
  const chunkSize = 25;
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    chunks.push(lines.slice(i, i + chunkSize));
  }

  const embeds = chunks.map((chunk, idx) =>
    new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle(idx === 0 ? `📋 User Teams (${users.length} total)` : `📋 User Teams (cont.)`)
      .setDescription(chunk.join("\n"))
      .setTimestamp(idx === chunks.length - 1 ? new Date() : null),
  );

  await interaction.editReply({ embeds });
}
