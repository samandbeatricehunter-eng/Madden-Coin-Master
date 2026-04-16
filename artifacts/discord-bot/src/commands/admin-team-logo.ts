import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, AutocompleteInteraction, PermissionFlagsBits,
} from "discord.js";
import { db, franchiseMcaTeamsTable, defaultTeamLogosTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("adminteamlogo")
  .setDescription("Manage team logos for matchup banners")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  // set — guild-specific logo for a team this season
  .addSubcommand(sc => sc
    .setName("set")
    .setDescription("Set a guild-specific logo URL for a team this season")
    .addStringOption(o => o
      .setName("team")
      .setDescription("Team name (from current season roster)")
      .setRequired(true)
      .setAutocomplete(true),
    )
    .addStringOption(o => o
      .setName("url")
      .setDescription("Publicly accessible image URL (PNG/JPG, ideally square or 1:1)")
      .setRequired(true),
    ),
  )
  // setdefault — global fallback logo for any guild
  .addSubcommand(sc => sc
    .setName("setdefault")
    .setDescription("Set the global default logo for one of the 32 NFL teams (used when no guild logo is set)")
    .addStringOption(o => o
      .setName("team")
      .setDescription("Team name or teamId")
      .setRequired(true)
      .setAutocomplete(true),
    )
    .addStringOption(o => o
      .setName("url")
      .setDescription("Publicly accessible image URL")
      .setRequired(true),
    ),
  )
  // list — show logo assignments for this guild
  .addSubcommand(sc => sc
    .setName("list")
    .setDescription("List all team logo assignments for this season"),
  )
  // clear — remove guild-specific logo (falls back to default)
  .addSubcommand(sc => sc
    .setName("clear")
    .setDescription("Remove the guild-specific logo for a team (falls back to the global default)")
    .addStringOption(o => o
      .setName("team")
      .setDescription("Team name")
      .setRequired(true)
      .setAutocomplete(true),
    ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const sub     = interaction.options.getSubcommand(false);
  const focused = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId!;

  if (sub === "set" || sub === "clear") {
    const season = await getOrCreateActiveSeason(guildId);
    const teams  = await db
      .select({ teamId: franchiseMcaTeamsTable.teamId, fullName: franchiseMcaTeamsTable.fullName, nickName: franchiseMcaTeamsTable.nickName })
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.isHuman, true)))
      .orderBy(asc(franchiseMcaTeamsTable.fullName));

    const matches = teams.filter(t =>
      t.fullName.toLowerCase().includes(focused) || t.nickName.toLowerCase().includes(focused),
    ).slice(0, 25);

    await interaction.respond(matches.map(t => ({ name: t.fullName, value: String(t.teamId) })));
    return;
  }

  if (sub === "setdefault") {
    const defaults = await db.select().from(defaultTeamLogosTable).orderBy(asc(defaultTeamLogosTable.fullName));
    const season   = await getOrCreateActiveSeason(guildId);
    const mcaTeams = await db
      .select({ teamId: franchiseMcaTeamsTable.teamId, fullName: franchiseMcaTeamsTable.fullName, nickName: franchiseMcaTeamsTable.nickName })
      .from(franchiseMcaTeamsTable)
      .where(eq(franchiseMcaTeamsTable.seasonId, season.id))
      .orderBy(asc(franchiseMcaTeamsTable.fullName));

    // Merge: prefer existing defaults list, add any MCA teams not yet in defaults
    const seen = new Set(defaults.map(d => d.teamId));
    const combined = [
      ...defaults.map(d => ({ teamId: d.teamId, fullName: d.fullName, nickName: d.nickName })),
      ...mcaTeams.filter(t => !seen.has(t.teamId)),
    ];

    const matches = combined.filter(t =>
      t.fullName.toLowerCase().includes(focused) || t.nickName.toLowerCase().includes(focused),
    ).slice(0, 25);

    await interaction.respond(matches.map(t => ({ name: t.fullName, value: String(t.teamId) })));
    return;
  }

  await interaction.respond([]);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;

  if (!await isAdminUser(interaction.user.id, guildId)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── set ──────────────────────────────────────────────────────────────────────
  if (sub === "set") {
    await interaction.deferReply({ ephemeral: true });
    const teamIdStr = interaction.options.getString("team", true);
    const url       = interaction.options.getString("url",  true);
    const teamId    = parseInt(teamIdStr, 10);
    const season    = await getOrCreateActiveSeason(guildId);

    const [team] = await db
      .select()
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)))
      .limit(1);

    if (!team) {
      await interaction.editReply("❌ Team not found in this season.");
      return;
    }

    await db
      .update(franchiseMcaTeamsTable)
      .set({ logoUrl: url })
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)));

    await interaction.editReply(`✅ **${team.fullName}** logo set for this guild.\n${url}`);
    return;
  }

  // ── setdefault ───────────────────────────────────────────────────────────────
  if (sub === "setdefault") {
    await interaction.deferReply({ ephemeral: true });
    const teamIdStr = interaction.options.getString("team", true);
    const url       = interaction.options.getString("url",  true);
    const teamId    = parseInt(teamIdStr, 10);
    const season    = await getOrCreateActiveSeason(guildId);

    // Resolve display names: try defaults table first, then MCA teams
    let fullName = `Team ${teamId}`;
    let nickName = `Team ${teamId}`;

    const [existing] = await db
      .select()
      .from(defaultTeamLogosTable)
      .where(eq(defaultTeamLogosTable.teamId, teamId))
      .limit(1);

    if (existing) {
      fullName = existing.fullName;
      nickName = existing.nickName;
    } else {
      const [mca] = await db
        .select()
        .from(franchiseMcaTeamsTable)
        .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)))
        .limit(1);
      if (mca) { fullName = mca.fullName; nickName = mca.nickName; }
    }

    await db
      .insert(defaultTeamLogosTable)
      .values({ teamId, fullName, nickName, logoUrl: url })
      .onConflictDoUpdate({
        target: defaultTeamLogosTable.teamId,
        set: { logoUrl: url, updatedAt: new Date() },
      });

    await interaction.editReply(`✅ Global default logo set for **${fullName}** (all guilds).\n${url}`);
    return;
  }

  // ── clear ────────────────────────────────────────────────────────────────────
  if (sub === "clear") {
    await interaction.deferReply({ ephemeral: true });
    const teamIdStr = interaction.options.getString("team", true);
    const teamId    = parseInt(teamIdStr, 10);
    const season    = await getOrCreateActiveSeason(guildId);

    const [team] = await db
      .select()
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)))
      .limit(1);

    if (!team) {
      await interaction.editReply("❌ Team not found in this season.");
      return;
    }

    await db
      .update(franchiseMcaTeamsTable)
      .set({ logoUrl: null })
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)));

    await interaction.editReply(`✅ Guild logo cleared for **${team.fullName}** — will fall back to global default.`);
    return;
  }

  // ── list ─────────────────────────────────────────────────────────────────────
  if (sub === "list") {
    await interaction.deferReply({ ephemeral: true });
    const season = await getOrCreateActiveSeason(guildId);

    const teams = await db
      .select()
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.isHuman, true)))
      .orderBy(asc(franchiseMcaTeamsTable.fullName));

    const defaults = await db.select().from(defaultTeamLogosTable);
    const defMap   = new Map(defaults.map(d => [d.teamId, d.logoUrl]));

    const lines = teams.map(t => {
      if (t.logoUrl)              return `✅ **${t.fullName}** — guild logo set`;
      if (defMap.has(t.teamId))   return `🌐 **${t.fullName}** — using global default`;
      return                             `❌ **${t.fullName}** — no logo`;
    });

    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("🖼️ Team Logo Assignments")
      .setDescription(lines.join("\n") || "No human teams found for this season.")
      .setFooter({ text: "✅ guild-specific · 🌐 global default · ❌ not set" });

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
