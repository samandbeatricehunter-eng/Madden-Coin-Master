import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { NFL_TEAMS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("admin-linkteam")
  .setDescription("Admin: assign or view team assignments for all players (safe — no data wipe)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("set")
    .setDescription("Assign a team to an existing player (does NOT wipe their balance or records)")
    .addUserOption(o => o
      .setName("user")
      .setDescription("Discord user to assign")
      .setRequired(true))
    .addStringOption(o => o
      .setName("team")
      .setDescription("NFL team name")
      .setRequired(true)
      .setAutocomplete(true)))
  .addSubcommand(sub => sub
    .setName("view")
    .setDescription("Show all current player → team assignments and any unlinked players"));

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  await interaction.respond(
    NFL_TEAMS
      .filter(t => t.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(t => ({ name: t, value: t }))
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── VIEW ──────────────────────────────────────────────────────────────────
  if (sub === "view_all_user_teams") {
    const allUsers = await db.select({
      discordId:       usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team:            usersTable.team,
      balance:         usersTable.balance,
      allTimeH2HWins:  usersTable.allTimeH2HWins,
      milestoneTier:   usersTable.milestoneTierAwarded,
    }).from(usersTable).orderBy(usersTable.team);

    const linked   = allUsers.filter(u => u.team);
    const unlinked = allUsers.filter(u => !u.team);

    const linkedLines = linked.map(u =>
      `🏈 **${u.team}** → <@${u.discordId}> (${u.discordUsername}) | ${u.allTimeH2HWins}W · tier ${u.milestoneTier}`
    );
    const unlinkedLines = unlinked.map(u =>
      `❓ <@${u.discordId}> (${u.discordUsername}) — no team assigned`
    );

    // Split an array of lines into chunks that each fit within Discord's 1024-char field limit
    function chunkLines(lines: string[], limit = 1020): string[] {
      const chunks: string[] = [];
      let current = "";
      for (const line of lines) {
        const addition = current ? "\n" + line : line;
        if (current.length + addition.length > limit) {
          chunks.push(current);
          current = line;
        } else {
          current += addition;
        }
      }
      if (current) chunks.push(current);
      return chunks;
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("🏈 Team Assignments")
      .setTimestamp();

    if (linkedLines.length > 0) {
      const chunks = chunkLines(linkedLines);
      chunks.forEach((chunk, i) => {
        embed.addFields({
          name: i === 0 ? `Linked Players (${linked.length})` : `Linked Players (cont.)`,
          value: chunk,
        });
      });
    }

    if (unlinkedLines.length > 0) {
      const chunks = chunkLines(unlinkedLines);
      chunks.forEach((chunk, i) => {
        const isLast = i === chunks.length - 1;
        embed.addFields({
          name: i === 0 ? `⚠️ Unlinked Players (${unlinked.length})` : `⚠️ Unlinked Players (cont.)`,
          value: chunk + (isLast ? "\n\nUse `/admin set_user_team` to assign their teams." : ""),
        });
      });
    }

    if (allUsers.length === 0) {
      embed.setDescription("No players registered yet.");
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // ── SET ───────────────────────────────────────────────────────────────────
  const targetUser = interaction.options.getUser("user", true);
  const teamName   = interaction.options.getString("team", true).trim();

  if (!(NFL_TEAMS as readonly string[]).includes(teamName)) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setDescription(`❌ **${teamName}** is not a valid NFL team. Choose from the autocomplete list.`)],
    });
  }

  // Check if another player is already linked to this team
  const existingOwner = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
  }).from(usersTable).where(eq(usersTable.team, teamName)).limit(1);

  if (existingOwner.length > 0 && existingOwner[0]!.discordId !== targetUser.id) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("❌ Team Already Taken")
        .setDescription(
          `**${teamName}** is already linked to <@${existingOwner[0]!.discordId}> (${existingOwner[0]!.discordUsername}).\n\n` +
          `Use \`/admin-linkteam set\` on that user first to re-assign, or use \`/deletemember\` to fully remove them.`
        )],
    });
  }

  // Fetch or create the target user row
  const existing = await db.select().from(usersTable)
    .where(eq(usersTable.discordId, targetUser.id)).limit(1);

  if (existing.length === 0) {
    await db.insert(usersTable).values({
      discordId:        targetUser.id,
      discordUsername:  targetUser.username,
      team:             teamName,
      balance:          0,
      totalLegendPurchases: 0,
    });
  } else {
    const oldTeam = existing[0]!.team;
    await db.update(usersTable)
      .set({ team: teamName, discordUsername: targetUser.username, updatedAt: new Date() })
      .where(eq(usersTable.discordId, targetUser.id));

    if (oldTeam && oldTeam !== teamName) {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Team Reassigned")
          .addFields(
            { name: "Player",    value: `<@${targetUser.id}>`, inline: true },
            { name: "Old team",  value: oldTeam,               inline: true },
            { name: "New team",  value: teamName,              inline: true },
          )
          .setDescription("Balance, records, and inventory are untouched.")
          .setTimestamp()],
      });
    }
  }

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Team Linked")
      .addFields(
        { name: "Player", value: `<@${targetUser.id}> (${targetUser.username})`, inline: true },
        { name: "Team",   value: teamName,                                         inline: true },
      )
      .setDescription("Balance, records, and inventory are untouched.")
      .setTimestamp()],
  });
}
