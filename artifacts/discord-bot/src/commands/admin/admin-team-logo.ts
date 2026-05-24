import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  AutocompleteInteraction, PermissionFlagsBits,
} from "discord.js";
import { db, franchiseMcaTeamsTable, defaultTeamLogosTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../../lib/db/db-helpers.js";
import {
  uploadTeamLogo, deleteTeamLogo,
  globalLogoPath, guildLogoPath,
} from "../../lib/franchise/gcs-reader.js";
import { fetchImageBuffer } from "../../lib/discord/matchup-image.js";

const GLOBAL_PASSWORD = "Global";

// ── Hardcoded 32 NFL teams (Madden 25 teamId → display names) ────────────────
// value = teamId string (matches Madden CFM API); name = full city+nickname
const NFL_TEAMS: { teamId: number; fullName: string; nickName: string }[] = [
  { teamId:  0, fullName: "Arizona Cardinals",      nickName: "Cardinals"  },
  { teamId:  1, fullName: "Atlanta Falcons",         nickName: "Falcons"    },
  { teamId:  2, fullName: "Baltimore Ravens",        nickName: "Ravens"     },
  { teamId:  3, fullName: "Buffalo Bills",           nickName: "Bills"      },
  { teamId:  4, fullName: "Carolina Panthers",       nickName: "Panthers"   },
  { teamId:  5, fullName: "Chicago Bears",           nickName: "Bears"      },
  { teamId:  6, fullName: "Cincinnati Bengals",      nickName: "Bengals"    },
  { teamId:  7, fullName: "Cleveland Browns",        nickName: "Browns"     },
  { teamId:  8, fullName: "Dallas Cowboys",          nickName: "Cowboys"    },
  { teamId:  9, fullName: "Denver Broncos",          nickName: "Broncos"    },
  { teamId: 10, fullName: "Detroit Lions",           nickName: "Lions"      },
  { teamId: 11, fullName: "Green Bay Packers",       nickName: "Packers"    },
  { teamId: 12, fullName: "Houston Texans",          nickName: "Texans"     },
  { teamId: 13, fullName: "Indianapolis Colts",      nickName: "Colts"      },
  { teamId: 14, fullName: "Jacksonville Jaguars",    nickName: "Jaguars"    },
  { teamId: 15, fullName: "Kansas City Chiefs",      nickName: "Chiefs"     },
  { teamId: 16, fullName: "Las Vegas Raiders",       nickName: "Raiders"    },
  { teamId: 17, fullName: "Los Angeles Chargers",    nickName: "Chargers"   },
  { teamId: 18, fullName: "Los Angeles Rams",        nickName: "Rams"       },
  { teamId: 19, fullName: "Miami Dolphins",          nickName: "Dolphins"   },
  { teamId: 20, fullName: "Minnesota Vikings",       nickName: "Vikings"    },
  { teamId: 21, fullName: "New England Patriots",    nickName: "Patriots"   },
  { teamId: 22, fullName: "New Orleans Saints",      nickName: "Saints"     },
  { teamId: 23, fullName: "New York Giants",         nickName: "Giants"     },
  { teamId: 24, fullName: "New York Jets",           nickName: "Jets"       },
  { teamId: 25, fullName: "Philadelphia Eagles",     nickName: "Eagles"     },
  { teamId: 26, fullName: "Pittsburgh Steelers",     nickName: "Steelers"   },
  { teamId: 27, fullName: "San Francisco 49ers",     nickName: "49ers"      },
  { teamId: 28, fullName: "Seattle Seahawks",        nickName: "Seahawks"   },
  { teamId: 29, fullName: "Tampa Bay Buccaneers",    nickName: "Buccaneers" },
  { teamId: 30, fullName: "Tennessee Titans",        nickName: "Titans"     },
  { teamId: 31, fullName: "Washington Commanders",   nickName: "Commanders" },
];

// ── Command builder ───────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("adminteamlogo")
  .setDescription("Manage team logos for matchup banners")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

  // set — guild-specific logo override
  .addSubcommand(sc => sc
    .setName("set")
    .setDescription("Upload a custom logo for a team in this guild (overrides global default)")
    .addStringOption(o => o
      .setName("team").setDescription("NFL team").setRequired(true).setAutocomplete(true),
    )
    .addAttachmentOption(o => o
      .setName("image").setDescription("PNG or JPG team logo").setRequired(true),
    ),
  )

  // setglobal — permanent global default, password protected
  .addSubcommand(sc => sc
    .setName("setglobal")
    .setDescription("Set the global default logo for a team (password required)")
    .addStringOption(o => o
      .setName("team").setDescription("NFL team").setRequired(true).setAutocomplete(true),
    )
    .addStringOption(o => o
      .setName("password").setDescription("Authorization password").setRequired(true),
    )
    .addAttachmentOption(o => o
      .setName("image").setDescription("PNG or JPG team logo").setRequired(true),
    ),
  )

  // setdefault — revert guild to global default
  .addSubcommand(sc => sc
    .setName("setdefault")
    .setDescription("Revert this guild's logo for a team back to the global default")
    .addStringOption(o => o
      .setName("team").setDescription("NFL team").setRequired(true).setAutocomplete(true),
    ),
  )

  // list — show status for all teams this season
  .addSubcommand(sc => sc
    .setName("list")
    .setDescription("Show logo status for all teams this season"),
  );

// ── Autocomplete — always serves the full hardcoded 32-team list ──────────────
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();

  const matches = NFL_TEAMS
    .filter(t =>
      t.fullName.toLowerCase().includes(focused) ||
      t.nickName.toLowerCase().includes(focused),
    )
    .slice(0, 25)
    .map(t => ({ name: t.fullName, value: String(t.teamId) }));

  await interaction.respond(matches);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function nflTeamById(teamId: number) {
  return NFL_TEAMS.find(t => t.teamId === teamId);
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
    const nflTeam    = nflTeamById(teamId);
    const season     = await getOrCreateActiveSeason(guildId);

    if (!nflTeam) { await interaction.editReply("❌ Unknown team."); return; }
    if (!attachment.contentType?.startsWith("image/")) {
      await interaction.editReply("❌ Attachment must be a PNG or JPG image."); return;
    }

    const imgBuf  = await fetchImageBuffer(attachment.url);
    const gcsPath = guildLogoPath(guildId, teamId);
    await uploadTeamLogo(gcsPath, imgBuf, attachment.contentType);

    // Update DB row if the team exists in the current season
    await db
      .update(franchiseMcaTeamsTable)
      .set({ logoUrl: gcsPath })
      .where(and(
        eq(franchiseMcaTeamsTable.seasonId, season.id),
        eq(franchiseMcaTeamsTable.teamId, teamId),
      ));

    await interaction.editReply(
      `✅ Custom logo set for **${nflTeam.fullName}** in this server.\n` +
      `This overrides the global default for this guild only.`,
    );
    return;
  }

  // ── setglobal ────────────────────────────────────────────────────────────────
  if (sub === "setglobal") {
    const password = interaction.options.getString("password", true);

    if (password !== GLOBAL_PASSWORD) {
      await interaction.reply({ content: "❌ Incorrect password.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const teamId     = parseInt(interaction.options.getString("team", true), 10);
    const attachment = interaction.options.getAttachment("image", true);
    const nflTeam    = nflTeamById(teamId);

    if (!nflTeam) { await interaction.editReply("❌ Unknown team."); return; }
    if (!attachment.contentType?.startsWith("image/")) {
      await interaction.editReply("❌ Attachment must be a PNG or JPG image."); return;
    }

    const imgBuf  = await fetchImageBuffer(attachment.url);
    const gcsPath = globalLogoPath(teamId);
    await uploadTeamLogo(gcsPath, imgBuf, attachment.contentType);

    await db
      .insert(defaultTeamLogosTable)
      .values({
        teamId:   nflTeam.teamId,
        fullName: nflTeam.fullName,
        nickName: nflTeam.nickName,
        logoUrl:  gcsPath,
      })
      .onConflictDoUpdate({
        target: defaultTeamLogosTable.teamId,
        set: { logoUrl: gcsPath, fullName: nflTeam.fullName, nickName: nflTeam.nickName, updatedAt: new Date() },
      });

    await interaction.editReply(
      `✅ Global default logo set for **${nflTeam.fullName}**.\n` +
      `All guilds without a custom logo will now use this image.`,
    );
    return;
  }

  // ── setdefault (revert to global) ───────────────────────────────────────────
  if (sub === "setdefault") {
    await interaction.deferReply({ ephemeral: true });

    const teamId  = parseInt(interaction.options.getString("team", true), 10);
    const nflTeam = nflTeamById(teamId);
    const season  = await getOrCreateActiveSeason(guildId);

    if (!nflTeam) { await interaction.editReply("❌ Unknown team."); return; }

    // Remove GCS guild file and clear DB column
    await deleteTeamLogo(guildLogoPath(guildId, teamId));
    await db
      .update(franchiseMcaTeamsTable)
      .set({ logoUrl: null })
      .where(and(
        eq(franchiseMcaTeamsTable.seasonId, season.id),
        eq(franchiseMcaTeamsTable.teamId, teamId),
      ));

    await interaction.editReply(
      `✅ **${nflTeam.fullName}** reverted to global default logo for this server.`,
    );
    return;
  }

  // ── list ─────────────────────────────────────────────────────────────────────
  if (sub === "list") {
    await interaction.deferReply({ ephemeral: true });

    // Get guild-specific overrides from active season
    const season = await getOrCreateActiveSeason(guildId);
    const dbTeams = await db
      .select({ teamId: franchiseMcaTeamsTable.teamId, logoUrl: franchiseMcaTeamsTable.logoUrl })
      .from(franchiseMcaTeamsTable)
      .where(and(
        eq(franchiseMcaTeamsTable.seasonId, season.id),
        eq(franchiseMcaTeamsTable.isHuman, true),
      ));

    const guildLogoMap = new Map(dbTeams.map(t => [t.teamId, t.logoUrl]));

    // Global defaults
    const defaults = await db.select({ teamId: defaultTeamLogosTable.teamId }).from(defaultTeamLogosTable);
    const globalSet = new Set(defaults.map(d => d.teamId));

    const lines = NFL_TEAMS.map(t => {
      if (guildLogoMap.get(t.teamId)) return `✅ **${t.fullName}** — guild custom`;
      if (globalSet.has(t.teamId))    return `🌐 **${t.fullName}** — global default`;
      return                                  `❌ **${t.fullName}** — no logo`;
    });

    // Split into embeds of 16 lines each to stay well within limits
    const CHUNK = 16;
    const embeds: EmbedBuilder[] = [];
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      embeds.push(
        new EmbedBuilder()
          .setColor(Colors.Blurple)
          .setTitle(i === 0 ? "🖼️ Team Logo Status" : null as any)
          .setDescription(chunk.join("\n"))
          .setFooter(i + CHUNK >= lines.length
            ? { text: "✅ guild custom  ·  🌐 global default  ·  ❌ no logo" }
            : null as any),
      );
    }

    await interaction.editReply({ embeds });
    return;
  }
}
