import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, franchiseMcaTeamsTable, franchiseRostersTable, seasonsTable,
} from "@workspace/db";
import { eq, and, or, ilike, isNotNull } from "drizzle-orm";
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
    .setDescription("Show all current player → team assignments and any unlinked players"))
  .addSubcommand(sub => sub
    .setName("relink")
    .setDescription("Re-cascade team assignments to MCA teams & roster rows (run after /leagueteams import)."));

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  await interaction.respond(
    NFL_TEAMS
      .filter(t => t.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(t => ({ name: t, value: t }))
  );
}

// ── Helper: cascade a single discordId to franchise_mca_teams + franchise_rosters ──
async function cascadeDiscordId(seasonId: number, teamName: string, discordId: string): Promise<number> {
  const teamSearch = teamName.trim();
  const mcaTeams = await db
    .select({ teamId: franchiseMcaTeamsTable.teamId })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      or(
        ilike(franchiseMcaTeamsTable.fullName, `%${teamSearch}%`),
        ilike(franchiseMcaTeamsTable.nickName, `%${teamSearch}%`),
      ),
    ));

  if (mcaTeams.length === 0) return 0;

  let rosterRowsUpdated = 0;
  for (const { teamId } of mcaTeams) {
    await db.update(franchiseMcaTeamsTable)
      .set({ discordId, isHuman: true, updatedAt: new Date() })
      .where(and(
        eq(franchiseMcaTeamsTable.seasonId, seasonId),
        eq(franchiseMcaTeamsTable.teamId, teamId),
      ));
    const result = await db.update(franchiseRostersTable)
      .set({ discordId })
      .where(and(
        eq(franchiseRostersTable.seasonId, seasonId),
        eq(franchiseRostersTable.teamId, teamId),
      ));
    rosterRowsUpdated += (result as any).rowCount ?? 0;
  }
  return rosterRowsUpdated;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── VIEW ────────────────────────────────────────────────────────────────────
  if (sub === "view") {
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
          value: chunk + (isLast ? "\n\nUse `/admin-linkteam set` to assign their teams." : ""),
        });
      });
    }

    if (allUsers.length === 0) {
      embed.setDescription("No players registered yet.");
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // ── RELINK ──────────────────────────────────────────────────────────────────
  if (sub === "relink") {
    const [season] = await db.select({ id: seasonsTable.id })
      .from(seasonsTable)
      .where(eq(seasonsTable.isActive, true))
      .limit(1);

    if (!season) {
      return interaction.editReply({ content: "❌ No active season found." });
    }

    const usersWithTeams = await db.select({
      discordId: usersTable.discordId,
      team:      usersTable.team,
    }).from(usersTable).where(isNotNull(usersTable.team));

    if (usersWithTeams.length === 0) {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle("⚠️ No Teams Registered")
          .setDescription("No users have a team assigned yet. Use `/admin-linkteam set` first.")],
      });
    }

    let totalLinked = 0;
    let totalRosterRows = 0;
    const results: string[] = [];

    for (const { discordId, team } of usersWithTeams) {
      if (!team) continue;
      const rosterRows = await cascadeDiscordId(season.id, team, discordId);
      if (rosterRows > 0 || true) {
        totalLinked++;
        totalRosterRows += rosterRows;
        results.push(`• **${team}** → <@${discordId}> (${rosterRows} roster rows updated)`);
      }
    }

    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Relink Complete")
        .setDescription(
          `Processed **${totalLinked}** team(s) for season ${season.id}.\n` +
          `Updated **${totalRosterRows}** total roster rows.\n\n` +
          results.slice(0, 20).join("\n") +
          (results.length > 20 ? `\n…and ${results.length - 20} more` : "")
        )
        .setFooter({ text: "If roster rows = 0, MCA rosters haven't been imported yet. Re-export from MCA." })
        .setTimestamp()],
    });
  }

  // ── SET ─────────────────────────────────────────────────────────────────────
  const targetUser = interaction.options.getUser("user", true);
  const teamName   = interaction.options.getString("team", true).trim();

  if (!(NFL_TEAMS as readonly string[]).includes(teamName)) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setDescription(`❌ **${teamName}** is not a valid NFL team. Choose from the autocomplete list.`)],
    });
  }

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
          `Use \`/admin-linkteam set\` on that user first to re-assign.`
        )],
    });
  }

  const existing = await db.select().from(usersTable)
    .where(eq(usersTable.discordId, targetUser.id)).limit(1);

  const oldTeam = existing[0]?.team ?? null;

  if (existing.length === 0) {
    await db.insert(usersTable).values({
      discordId:            targetUser.id,
      discordUsername:      targetUser.username,
      team:                 teamName,
      balance:              0,
      totalLegendPurchases: 0,
    });
  } else {
    await db.update(usersTable)
      .set({ team: teamName, discordUsername: targetUser.username, updatedAt: new Date() })
      .where(eq(usersTable.discordId, targetUser.id));
  }

  // ── Cascade discordId to franchise_mca_teams + franchise_rosters ────────────
  const [season] = await db.select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);

  let rosterInfo = "";
  if (season) {
    const rosterRows = await cascadeDiscordId(season.id, teamName, targetUser.id);
    rosterInfo = rosterRows > 0
      ? `\n✅ ${rosterRows} roster row(s) linked to this user.`
      : "\n⚠️ No roster rows found — MCA rosters may not have been imported yet. Import /leagueteams and roster from MCA, or run `/admin-linkteam relink` after importing.";
  }

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
        .setDescription(`Balance, records, and inventory are untouched.${rosterInfo}`)
        .setTimestamp()],
    });
  }

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle("✅ Team Linked")
      .addFields(
        { name: "Player", value: `<@${targetUser.id}> (${targetUser.username})`, inline: true },
        { name: "Team",   value: teamName,                                         inline: true },
      )
      .setDescription(`Balance, records, and inventory are untouched.${rosterInfo}`)
      .setTimestamp()],
  });
}
