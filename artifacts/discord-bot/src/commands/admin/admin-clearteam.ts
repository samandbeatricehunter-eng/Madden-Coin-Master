import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, AutocompleteInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable, seasonsTable } from "@workspace/db";
import { eq, and, isNotNull, inArray } from "drizzle-orm";
import { isAdminUser } from "../../lib/db/db-helpers.js";

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
    .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, interaction.guildId!)));

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
    .where(and(eq(usersTable.team, teamName), eq(usersTable.guildId, interaction.guildId!)))
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
    .where(and(eq(usersTable.discordId, target.discordId), eq(usersTable.guildId, interaction.guildId!)));

  // Scope record deletion to seasons belonging to this guild only
  const guildSeasonIds = db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.guildId, interaction.guildId!));

  const deleted = await db.delete(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, target.discordId), inArray(userRecordsTable.seasonId, guildSeasonIds)))
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
