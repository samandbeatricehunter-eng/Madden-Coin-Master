import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  usersTable, franchiseMcaTeamsTable, franchiseRostersTable,
  seasonsTable,
} from "@workspace/db";
import { eq, and, or, ilike, isNotNull, sql } from "drizzle-orm";
import { NFL_TEAMS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("admin-linkteam")
  .setDescription("Admin: assign or view team assignments for all players (safe — no data wipe)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
          .setDescription("No users have a team assigned yet. Link users via `/admin-user-data` or the link-new-user flow first.")],
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

  return interaction.editReply({ content: "❌ Unknown subcommand." });
}
