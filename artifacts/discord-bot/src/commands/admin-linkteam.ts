import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, globalUserRecordsTable, franchiseMcaTeamsTable, franchiseRostersTable,
  playerSeasonStatsTable, seasonsTable, waitlistTable,
} from "@workspace/db";
import { eq, and, or, ilike, isNotNull, sql } from "drizzle-orm";
import { NFL_TEAMS } from "../lib/constants.js";
import { assignRosterLegends, formatLegendAssignResult } from "../lib/roster-legend-assign.js";
import { getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";

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
      .setAutocomplete(true))
    .addStringOption(o => o
      .setName("ea_id")
      .setDescription("Player's EA / PSN / Xbox gamertag used in CFM (optional)")
      .setRequired(false)))
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
// Falls back to franchise_rosters if the team has no MCA entry (e.g. was deleted
// when a previous owner was kicked), and auto-creates the missing MCA row.
async function cascadeDiscordId(seasonId: number, teamName: string, discordId: string): Promise<{ rosterRows: number; note?: string }> {
  const teamSearch = teamName.trim();

  // 1. Try MCA teams first (normal path)
  let mcaTeamIds = await db
    .select({ teamId: franchiseMcaTeamsTable.teamId })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      or(
        ilike(franchiseMcaTeamsTable.fullName, `%${teamSearch}%`),
        ilike(franchiseMcaTeamsTable.nickName, `%${teamSearch}%`),
      ),
    ));

  let note: string | undefined;

  // 2. Fallback: search franchise_rosters by team_name if MCA has no entry.
  //    This handles teams whose MCA row was wiped when a previous owner was removed.
  if (mcaTeamIds.length === 0) {
    const rosterTeams = await db
      .selectDistinct({ teamId: franchiseRostersTable.teamId, teamName: franchiseRostersTable.teamName })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, seasonId),
        or(
          ilike(franchiseRostersTable.teamName, `%${teamSearch}%`),
        ),
      ));

    if (rosterTeams.length > 0) {
      // Auto-create the missing MCA entry so future imports work correctly
      for (const { teamId, teamName: fullName } of rosterTeams) {
        const nick = fullName.split(" ").pop() ?? fullName;
        await db.insert(franchiseMcaTeamsTable)
          .values({ seasonId, teamId, fullName, nickName: nick, userName: teamSearch, isHuman: true, discordId, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [franchiseMcaTeamsTable.seasonId, franchiseMcaTeamsTable.teamId],
            set: { discordId, isHuman: true, updatedAt: new Date() },
          });
      }
      mcaTeamIds = rosterTeams.map(r => ({ teamId: r.teamId }));
      note = `Auto-created ${rosterTeams.length} missing MCA team entry(s) from roster data.`;
    }
  }

  if (mcaTeamIds.length === 0) return { rosterRows: 0 };

  let rosterRowsUpdated = 0;
  for (const { teamId } of mcaTeamIds) {
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
  return { rosterRows: rosterRowsUpdated, note };
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
    }).from(usersTable).where(eq(usersTable.guildId, interaction.guildId!)).orderBy(usersTable.team);

    const linked   = allUsers.filter(u => u.team);
    const unlinked = allUsers.filter(u => !u.team);

    const linkedLines = linked.map(u =>
      u.discordId.startsWith("unlinked_")
        ? `🔓 **${u.team}** — *Open Slot*`
        : `🏈 **${u.team}** → <@${u.discordId}> (${u.discordUsername}) | ${u.allTimeH2HWins}W all-time · tier ${u.milestoneTier}`
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
      .where(and(eq(seasonsTable.isActive, true), eq(seasonsTable.guildId, interaction.guildId!)))
      .limit(1);

    if (!season) {
      return interaction.editReply({ content: "❌ No active season found." });
    }

    const usersWithTeams = await db.select({
      discordId: usersTable.discordId,
      team:      usersTable.team,
    }).from(usersTable).where(and(isNotNull(usersTable.team), eq(usersTable.guildId, interaction.guildId!)));

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
      const { rosterRows, note } = await cascadeDiscordId(season.id, team, discordId);
      totalLinked++;
      totalRosterRows += rosterRows;
      const noteSuffix = note ? ` *(${note})*` : "";
      results.push(`• **${team}** → <@${discordId}> (${rosterRows} roster rows)${noteSuffix}`);
    }

    // ── Also cascade discord_ids into player_season_stats ────────────────────
    // Stats are imported before carryforward runs, leaving discord_id = NULL.
    // Fix that now by joining player_season_stats ↔ franchise_mca_teams on team_id.
    const statFixResult = await db.execute(sql`
      UPDATE player_season_stats pss
      SET    discord_id = mca.discord_id
      FROM   franchise_mca_teams mca
      WHERE  pss.season_id  = ${season.id}
        AND  pss.team_id    = mca.team_id
        AND  mca.season_id  = ${season.id}
        AND  mca.discord_id IS NOT NULL
        AND  (pss.discord_id IS NULL OR pss.discord_id != mca.discord_id)
    `);
    const statRowsFixed = (statFixResult as any).rowCount ?? (statFixResult as any).length ?? 0;

    // Split results into pages of 20 to avoid embed character limits
    const PAGE = 20;
    const pages: string[][] = [];
    for (let i = 0; i < results.length; i += PAGE) pages.push(results.slice(i, i + PAGE));

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Relink Complete")
        .setDescription(
          `Processed **${totalLinked}** team(s) for season ${season.id}.\n` +
          `Updated **${totalRosterRows}** roster rows.\n` +
          `Fixed **${statRowsFixed}** player stat row(s) with null discord_id.\n\n` +
          (pages[0]?.join("\n") ?? "No teams processed.")
        )
        .setFooter({ text: pages.length > 1 ? `Page 1/${pages.length} — continuing below…` : "If roster rows = 0, run EA export now (carryforward must run first)." })
        .setTimestamp()],
    });

    for (let p = 1; p < pages.length; p++) {
      await interaction.followUp({
        ephemeral: true,
        embeds: [new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`Relink Results (page ${p + 1}/${pages.length})`)
          .setDescription(pages[p]!.join("\n"))
          .setFooter({ text: p === pages.length - 1 ? "If roster rows = 0, run EA export now (carryforward must run first)." : `Continued on next page…` })],
      });
    }

    return;
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

  // Remove placeholder slot for this team so the real user can claim it cleanly
  await db.delete(usersTable)
    .where(and(
      eq(usersTable.discordId, `unlinked_${teamName.toLowerCase()}`),
      eq(usersTable.guildId, interaction.guildId!),
    ));

  const existingOwner = await db.select({
    discordId:       usersTable.discordId,
    discordUsername: usersTable.discordUsername,
  }).from(usersTable).where(and(eq(usersTable.team, teamName), eq(usersTable.guildId, interaction.guildId!))).limit(1);

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
    .where(and(eq(usersTable.discordId, targetUser.id), eq(usersTable.guildId, interaction.guildId!))).limit(1);

  const oldTeam = existing[0]?.team ?? null;
  const eaId    = interaction.options.getString("ea_id")?.trim() ?? null;

  if (existing.length === 0) {
    await db.insert(usersTable).values({
      discordId:            targetUser.id,
      guildId:              interaction.guildId!,
      discordUsername:      targetUser.username,
      team:                 teamName,
      balance:              0,
      totalLegendPurchases: 0,
      ...(eaId ? { eaId } : {}),
    });

    // Seed global record entry so this user is visible across all guilds
    await db.insert(globalUserRecordsTable)
      .values({ discordId: targetUser.id, wins: 0, losses: 0, ties: 0 })
      .onConflictDoNothing();
  } else {
    await db.update(usersTable)
      .set({
        team:            teamName,
        discordUsername: targetUser.username,
        updatedAt:       new Date(),
        ...(eaId ? { eaId } : {}),
      })
      .where(and(eq(usersTable.discordId, targetUser.id), eq(usersTable.guildId, interaction.guildId!)));
  }

  // ── Cascade discordId to franchise_mca_teams + franchise_rosters ────────────
  const [season] = await db.select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(and(eq(seasonsTable.isActive, true), eq(seasonsTable.guildId, interaction.guildId!)))
    .limit(1);

  let rosterInfo    = "";
  let legendSummary = "";

  if (season) {
    const { rosterRows, note } = await cascadeDiscordId(season.id, teamName, targetUser.id);
    const notePart = note ? `\nℹ️ ${note}` : "";
    rosterInfo = rosterRows > 0
      ? `\n✅ ${rosterRows} roster row(s) linked to this user.${notePart}`
      : "\n⚠️ No roster rows found — MCA rosters may not have been imported yet. Import /leagueteams and roster from MCA, or run `/admin-linkteam relink` after importing.";

    const legendResult = await assignRosterLegends(targetUser.id, interaction.guildId!, teamName, season.id);
    legendSummary = formatLegendAssignResult(legendResult, teamName);
  }

  // Fire-and-forget: refresh open teams + team list in #welcome
  postTeamListsToWelcome(interaction).catch(() => null);

  // Auto-remove from waitlist if this user was on it
  db.delete(waitlistTable)
    .where(and(eq(waitlistTable.guildId, interaction.guildId!), eq(waitlistTable.discordId, targetUser.id)))
    .catch(() => null);

  if (oldTeam && oldTeam !== teamName) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Team Reassigned")
        .addFields(
          { name: "Player",    value: `<@${targetUser.id}>`, inline: true },
          { name: "Old team",  value: oldTeam,               inline: true },
          { name: "New team",  value: teamName,              inline: true },
          ...(legendSummary ? [{ name: "🏅 Roster Legends", value: legendSummary }] : []),
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
        ...(legendSummary ? [{ name: "🏅 Roster Legends", value: legendSummary }] : []),
      )
      .setDescription(`Balance, records, and inventory are untouched.${rosterInfo}`)
      .setTimestamp()],
  });
}

// ── Helper: refresh open-teams + team-list in #welcome after every team link ──
async function postTeamListsToWelcome(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId   = interaction.guildId!;
  const welcomeId = await getGuildChannel(guildId, CHANNEL_KEYS.WELCOME).catch(() => null);
  if (!welcomeId) return;

  const welcomeCh = interaction.guild?.channels.cache.get(welcomeId)
    ?? await interaction.client.channels.fetch(welcomeId).catch(() => null);
  if (!welcomeCh?.isTextBased()) return;

  const tc = welcomeCh as TextChannel;

  // Delete previous open-teams / team-list posts from this bot
  const messages = await tc.messages.fetch({ limit: 50 }).catch(() => null);
  if (messages) {
    for (const msg of messages.values()) {
      if (msg.author.id !== interaction.client.user!.id) continue;
      const isTeamPost = msg.embeds.some(e =>
        e.title?.startsWith("🏈 Open Teams") ||
        e.title?.startsWith("🏈 League Teams"),
      );
      if (isTeamPost) await msg.delete().catch(() => null);
    }
  }

  // ── Open Teams embed ───────────────────────────────────────────────────────
  const takenRows = await db
    .select({ team: usersTable.team, discordId: usersTable.discordId })
    .from(usersTable)
    .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, guildId)));

  const taken = new Set(
    takenRows.filter(r => !r.discordId.startsWith("unlinked_")).map(r => r.team as string),
  );
  const open = NFL_TEAMS.filter(t => !taken.has(t));

  const openEmbed = open.length > 0
    ? new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`🏈 Open Teams (${open.length} available)`)
        .setDescription(open.map(t => `• ${t}`).join("\n"))
        .setTimestamp()
    : new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle("🏈 Open Teams")
        .setDescription("All 32 NFL teams are currently assigned to league members!")
        .setTimestamp();
  await tc.send({ embeds: [openEmbed] }).catch(() => null);

  // ── Team List embed ────────────────────────────────────────────────────────
  const allRows = await db
    .select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable)
    .where(and(isNotNull(usersTable.team), eq(usersTable.guildId, guildId)));

  const realMembers = allRows.filter(r => !r.discordId.startsWith("unlinked_"));
  if (realMembers.length === 0) return;

  const lines = realMembers.map(r => `**${r.team}** — <@${r.discordId}>`);
  for (let i = 0; i < lines.length; i += 25) {
    const chunk = lines.slice(i, i + 25);
    const listEmbed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(i === 0 ? `🏈 League Teams (${realMembers.length} linked)` : "🏈 League Teams (continued)")
      .setDescription(chunk.join("\n"))
      .setTimestamp();
    await tc.send({ embeds: [listEmbed] }).catch(() => null);
  }
}
