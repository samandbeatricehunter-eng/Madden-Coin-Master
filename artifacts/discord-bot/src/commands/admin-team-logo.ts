import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  AutocompleteInteraction, PermissionFlagsBits,
} from "discord.js";
import { db, franchiseMcaTeamsTable, defaultTeamLogosTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import {
  uploadTeamLogo, deleteTeamLogo,
  globalLogoPath, guildLogoPath,
} from "../lib/gcs-reader.js";
import { fetchImageBuffer } from "../lib/matchup-image.js";

const GLOBAL_PASSWORD = "Global";

export const data = new SlashCommandBuilder()
  .setName("adminteamlogo")
  .setDescription("Manage team logos for matchup banners")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

  // set — guild-specific logo override via attachment
  .addSubcommand(sc => sc
    .setName("set")
    .setDescription("Upload a custom logo for a team in this guild (overrides global default)")
    .addStringOption(o => o
      .setName("team").setDescription("Team name").setRequired(true).setAutocomplete(true),
    )
    .addAttachmentOption(o => o
      .setName("image").setDescription("PNG or JPG team logo").setRequired(true),
    ),
  )

  // setglobal — upload the permanent global default (password protected)
  .addSubcommand(sc => sc
    .setName("setglobal")
    .setDescription("Set the global default logo for a team (password required)")
    .addStringOption(o => o
      .setName("team").setDescription("Team name").setRequired(true).setAutocomplete(true),
    )
    .addStringOption(o => o
      .setName("password").setDescription("Authorization password").setRequired(true),
    )
    .addAttachmentOption(o => o
      .setName("image").setDescription("PNG or JPG team logo").setRequired(true),
    ),
  )

  // setdefault — revert this guild back to the global default
  .addSubcommand(sc => sc
    .setName("setdefault")
    .setDescription("Revert this guild's custom logo for a team back to the global default")
    .addStringOption(o => o
      .setName("team").setDescription("Team name").setRequired(true).setAutocomplete(true),
    ),
  )

  // list — show logo status for this guild
  .addSubcommand(sc => sc
    .setName("list")
    .setDescription("Show logo status for all teams this season"),
  );

// ── Autocomplete ──────────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const teams = await db
    .select({
      teamId:   franchiseMcaTeamsTable.teamId,
      fullName: franchiseMcaTeamsTable.fullName,
      nickName: franchiseMcaTeamsTable.nickName,
    })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id))
    .orderBy(asc(franchiseMcaTeamsTable.fullName));

  const matches = teams
    .filter(t => t.fullName.toLowerCase().includes(focused) || t.nickName.toLowerCase().includes(focused))
    .slice(0, 25);

  await interaction.respond(matches.map(t => ({ name: t.fullName, value: String(t.teamId) })));
}

// ── Execute ───────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const sub     = interaction.options.getSubcommand();

  if (!await isAdminUser(interaction.user.id, guildId)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    return;
  }

  // ── set ─────────────────────────────────────────────────────────────────────
  if (sub === "set") {
    await interaction.deferReply({ ephemeral: true });

    const teamId     = parseInt(interaction.options.getString("team", true), 10);
    const attachment = interaction.options.getAttachment("image", true);
    const season     = await getOrCreateActiveSeason(guildId);

    const [team] = await db
      .select()
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)))
      .limit(1);

    if (!team) { await interaction.editReply("❌ Team not found in current season."); return; }
    if (!attachment.contentType?.startsWith("image/")) {
      await interaction.editReply("❌ Attachment must be a PNG or JPG image."); return;
    }

    const imgBuf  = await fetchImageBuffer(attachment.url);
    const gcsPath = guildLogoPath(guildId, teamId);
    await uploadTeamLogo(gcsPath, imgBuf, attachment.contentType);

    await db
      .update(franchiseMcaTeamsTable)
      .set({ logoUrl: gcsPath })
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)));

    await interaction.editReply(`✅ Custom logo set for **${team.fullName}** in this server.`);
    return;
  }

  // ── setglobal ────────────────────────────────────────────────────────────────
  if (sub === "setglobal") {
    const password   = interaction.options.getString("password", true);

    if (password !== GLOBAL_PASSWORD) {
      await interaction.reply({ content: "❌ Incorrect password.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const teamId     = parseInt(interaction.options.getString("team", true), 10);
    const attachment = interaction.options.getAttachment("image", true);
    const season     = await getOrCreateActiveSeason(guildId);

    const [mcaTeam] = await db
      .select()
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)))
      .limit(1);

    // Fall back to existing defaults table for name if not in current season MCA
    let fullName = mcaTeam?.fullName ?? `Team ${teamId}`;
    let nickName = mcaTeam?.nickName ?? `Team ${teamId}`;

    if (!mcaTeam) {
      const [existing] = await db
        .select()
        .from(defaultTeamLogosTable)
        .where(eq(defaultTeamLogosTable.teamId, teamId))
        .limit(1);
      if (existing) { fullName = existing.fullName; nickName = existing.nickName; }
    }

    if (!attachment.contentType?.startsWith("image/")) {
      await interaction.editReply("❌ Attachment must be a PNG or JPG image."); return;
    }

    const imgBuf  = await fetchImageBuffer(attachment.url);
    const gcsPath = globalLogoPath(teamId);
    await uploadTeamLogo(gcsPath, imgBuf, attachment.contentType);

    await db
      .insert(defaultTeamLogosTable)
      .values({ teamId, fullName, nickName, logoUrl: gcsPath })
      .onConflictDoUpdate({
        target: defaultTeamLogosTable.teamId,
        set: { logoUrl: gcsPath, fullName, nickName, updatedAt: new Date() },
      });

    await interaction.editReply(
      `✅ Global default logo set for **${fullName}**.\n` +
      `All guilds without a custom logo will use this image.`,
    );
    return;
  }

  // ── setdefault (revert guild to global) ─────────────────────────────────────
  if (sub === "setdefault") {
    await interaction.deferReply({ ephemeral: true });

    const teamId = parseInt(interaction.options.getString("team", true), 10);
    const season = await getOrCreateActiveSeason(guildId);

    const [team] = await db
      .select()
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)))
      .limit(1);

    if (!team) { await interaction.editReply("❌ Team not found in current season."); return; }

    // Remove GCS guild file and clear DB column
    await deleteTeamLogo(guildLogoPath(guildId, teamId));
    await db
      .update(franchiseMcaTeamsTable)
      .set({ logoUrl: null })
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.teamId, teamId)));

    await interaction.editReply(
      `✅ **${team.fullName}** reverted to global default logo for this server.`,
    );
    return;
  }

  // ── list ─────────────────────────────────────────────────────────────────────
  if (sub === "list") {
    await interaction.deferReply({ ephemeral: true });

    const season   = await getOrCreateActiveSeason(guildId);
    const teams    = await db
      .select()
      .from(franchiseMcaTeamsTable)
      .where(and(eq(franchiseMcaTeamsTable.seasonId, season.id), eq(franchiseMcaTeamsTable.isHuman, true)))
      .orderBy(asc(franchiseMcaTeamsTable.fullName));

    const defaults = await db.select().from(defaultTeamLogosTable);
    const defSet   = new Set(defaults.map(d => d.teamId));

    const lines = teams.map(t => {
      if (t.logoUrl)         return `✅ **${t.fullName}** — guild custom`;
      if (defSet.has(t.teamId)) return `🌐 **${t.fullName}** — global default`;
      return                        `❌ **${t.fullName}** — no logo`;
    });

    // Split into chunks of 25 to avoid embed field limits
    const CHUNK = 25;
    const embeds: EmbedBuilder[] = [];
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      embeds.push(
        new EmbedBuilder()
          .setColor(Colors.Blurple)
          .setTitle(i === 0 ? "🖼️ Team Logo Status" : null as any)
          .setDescription(chunk.join("\n"))
          .setFooter(i + CHUNK >= lines.length
            ? { text: "✅ guild custom · 🌐 global default · ❌ no logo" }
            : null as any),
      );
    }

    if (!embeds.length) {
      await interaction.editReply("No human teams found for this season.");
      return;
    }

    await interaction.editReply({ embeds });
    return;
  }
}
