import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable } from "@workspace/db";
import { eq, isNotNull } from "drizzle-orm";
import { isAdminUser } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("clearteam")
  .setDescription("Admin: unlink a user from their NFL team and clear their season W/L records")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("The NFL team to unlink (autocomplete from currently linked teams)")
      .setRequired(true)
      .setAutocomplete(true)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();

  const linked = await db
    .select({ team: usersTable.team, discordUsername: usersTable.discordUsername })
    .from(usersTable)
    .where(isNotNull(usersTable.team));

  const choices = linked
    .filter(r => r.team && r.team.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(r => ({ name: `${r.team} (${r.discordUsername})`, value: r.team as string }));

  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const isAdmin = await isAdminUser(interaction.user.id, interaction.guildId!);
  if (!isAdmin && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Access Denied").setDescription("This command requires administrator permissions.")],
    });
  }

  const teamName = interaction.options.getString("team", true);

  const userRow = await db
    .select({
      discordId: usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team: usersTable.team,
    })
    .from(usersTable)
    .where(eq(usersTable.team, teamName))
    .limit(1);

  if (!userRow[0]) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Team Not Found")
          .setDescription(`No user is currently linked to **${teamName}**. Use \`/teamlist\` to see all linked teams.`),
      ],
    });
  }

  const target = userRow[0];

  await db.update(usersTable)
    .set({ team: null, playoffSeed: null, playoffConference: null, updatedAt: new Date() })
    .where(eq(usersTable.discordId, target.discordId));

  const deleted = await db.delete(userRecordsTable)
    .where(eq(userRecordsTable.discordId, target.discordId))
    .returning({ id: userRecordsTable.id });

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle("🗑️ Team Cleared")
        .setDescription(
          `**${target.discordUsername}** has been unlinked from **${teamName}**.\n\n` +
          `• Team assignment: **cleared**\n` +
          `• Playoff seed/conference: **cleared**\n` +
          `• Season W/L records: **${deleted.length} record${deleted.length === 1 ? "" : "s"} deleted**\n\n` +
          `Coin balance and inventory were preserved. Use \`/setuser\` to reassign this team.`
        )
        .setTimestamp(),
    ],
  });
}
