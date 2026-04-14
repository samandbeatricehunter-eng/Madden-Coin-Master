import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseMcaTeamsTable, franchiseRostersTable, teamSeasonStatsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { lookupNflDivision } from "../lib/constants.js";
import * as userStats          from "./userstats.js";
import * as viewstore          from "./viewstore.js";
import * as viewCustomArchetypes from "./viewcustomarchetypes.js";
import * as viewroster         from "./viewroster.js";
import * as viewtradeblock     from "./viewtradeblock.js";

import * as statLeaders        from "./statleaders.js";
import * as viewplayerstats    from "./viewplayerstats.js";
import * as rulesCmd           from "./rules.js";


export const data = new SlashCommandBuilder()
  .setName("view")
  .setDescription("View stats, store, rosters, and league information")

  // ── userStats ──────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("user_stats")
    .setDescription("View stats, coins, and inventory for any league member")
    .addUserOption(o => o.setName("user").setDescription("League member to look up — leave blank for yourself").setRequired(false))
  )

  // ── playerStats ────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("player_stats")
    .setDescription("Browse player season stats by team, or view stat leaders")
    .addStringOption(o => o.setName("mode").setDescription("What to view").setRequired(true)
      .addChoices(
        { name: "🏈 Browse by Team — pick any team's roster",        value: "team"            },
        { name: "📊 Top 3 Leaders — All Categories",                 value: "all"             },
        { name: "🏟️ Teams to Watch",                                 value: "teams"           },
        { name: "🎯 Top 10 — Passing Yards",                         value: "passing_yards"   },
        { name: "🏆 Top 10 — Passing TDs",                           value: "passing_tds"     },
        { name: "💨 Top 10 — Rushing Yards",                         value: "rushing_yards"   },
        { name: "🏆 Top 10 — Rushing TDs",                           value: "rushing_tds"     },
        { name: "🙌 Top 10 — Receiving Yards",                       value: "receiving_yards" },
        { name: "🏆 Top 10 — Receiving TDs",                         value: "receiving_tds"   },
        { name: "💥 Top 10 — Defensive Sacks",                       value: "def_sacks"       },
        { name: "🫳 Top 10 — Defensive INTs",                        value: "def_ints"        },
        { name: "🦺 Top 10 — Defensive Tackles",                     value: "def_tackles"     },
        { name: "🏟️ Top 10 — Field Goals Made (Kickers)",            value: "kicking_fg"      },
        { name: "👟 Top 10 — Punting Average",                       value: "punting_avg"     },
        { name: "↩️ Top 10 — Kick Return Yards",                     value: "kr_yards"        },
        { name: "↩️ Top 10 — Punt Return Yards",                     value: "pr_yards"        },
        { name: "🏈 Top 10 — Total Offensive Yards (Team)",          value: "off_yds"         },
        { name: "🛡️ Top 10 — Def. Yards Allowed (Team)",             value: "def_yds"         },
        { name: "📈 Top 10 — Point Differential (Team)",             value: "point_diff"      },
      )
    )
    .addBooleanOption(o => o.setName("public").setDescription("Post publicly in the channel (admin only)").setRequired(false))
  )

  // ── teamStats ──────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("team_stats")
    .setDescription("View team standings or a specific team's season performance")
    .addStringOption(o => o.setName("mode").setDescription("Teams to watch or look up a specific team").setRequired(true)
      .addChoices(
        { name: "📋 Teams to Watch — division leaders & playoff picture", value: "watch" },
        { name: "👤 User's Team — detailed season stats for one team",    value: "user"  },
        { name: "🌐 All 32 Teams — full league stats by conference",      value: "all"   },
      )
    )
    .addUserOption(o => o.setName("user").setDescription("(User Team mode) Look up by Discord user").setRequired(false))
    .addStringOption(o => o.setName("team").setDescription("(User Team mode) Look up by team name").setRequired(false).setAutocomplete(true))
    .addBooleanOption(o => o.setName("public").setDescription("Post publicly in the channel (admin only)").setRequired(false))
  )

  // ── store ──────────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("store")
    .setDescription("View the league store (legends, prices, and upgrade costs)")
  )

  // ── customPlayerArchetypes ─────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("custom_player_archetypes")
    .setDescription("Browse available custom player archetypes by position")
  )

  // ── roster ─────────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("roster")
    .setDescription("View the full roster of any team in the league")
    .addStringOption(o => o.setName("team").setDescription("Team name (start typing to search)").setRequired(false).setAutocomplete(true))
    .addUserOption(o => o.setName("user").setDescription("Look up a team by its Discord manager instead").setRequired(false))
    .addBooleanOption(o => o.setName("public").setDescription("Post publicly in the channel?").setRequired(false))
  )

  // ── tradeBlock ────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("trade_block")
    .setDescription("Browse active trade block listings and send offers")
    .addBooleanOption(o => o.setName("public").setDescription("Show to everyone in this channel?").setRequired(false))
    .addBooleanOption(o => o.setName("admin").setDescription("Admin mode: show Remove buttons on every listing").setRequired(false))
  )

  // ── rules ─────────────────────────────────────────────────────────────────
  .addSubcommand(s => s
    .setName("rules")
    .setDescription("Display a section of the league rules, or quote a specific rule")
    .addStringOption(o => o.setName("section").setDescription("Which rules section?").setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName("rule_number").setDescription("Quote only this rule number from the section (optional)").setRequired(false).setMinValue(1))
    .addStringOption(o => o.setName("mention").setDescription("Broadcast to @everyone or @here (overrides the user option)").setRequired(false)
      .addChoices(
        { name: "@everyone — ping the entire server", value: "everyone" },
        { name: "@here — ping online members only",   value: "here"     },
      )
    )
    .addUserOption(o => o.setName("user").setDescription("Tag a specific member to share this rule with them (makes it visible to everyone)").setRequired(false))
  );

// ── Execute router ─────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
  const sub = interaction.options.getSubcommand();

  if (sub === "user_stats")               return userStats.execute(interaction);
  if (sub === "store")                    return viewstore.execute(interaction);
  if (sub === "custom_player_archetypes") return viewCustomArchetypes.execute(interaction);
  if (sub === "roster")                   return viewroster.execute(interaction);
  if (sub === "trade_block")              return viewtradeblock.execute(interaction);
  if (sub === "rules")                    return rulesCmd.execute(interaction);

  if (sub === "player_stats") {
    const mode = interaction.options.getString("mode", true);
    if (mode === "team") {
      return viewplayerstats.execute(interaction);
    }
    // All other mode values (all, teams, passing_yards, def_sacks, …) are
    // stat-leader categories — pass directly to statLeaders which reads from
    // the "mode" option via its updated getString fallback.
    return statLeaders.execute(interaction);
  }

  if (sub === "team_stats") {
    const mode = interaction.options.getString("mode", true);
    if (mode === "all") return handleAllTeamsView(interaction);
    return handleTeamStatsView(interaction, mode);
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(`❌ Unknown subcommand: \`${sub}\``);
  return;
}

// ── Team Stats handler ─────────────────────────────────────────────────────────
async function handleTeamStatsView(
  interaction: ChatInputCommandInteraction,
  mode: string
): Promise<void> {
  if (mode === "watch") {
    return statLeaders.execute(interaction);
  }

  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user");
  const teamName   = interaction.options.getString("team");

  if (!targetUser && !teamName) {
    await interaction.editReply({ content: "❌ Please provide either a **@user** or **team** name for User Team mode." });
    return;
  }

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  let teamRosterQuery: any;
  if (targetUser) {
    teamRosterQuery = await db
      .select()
      .from(franchiseRostersTable)
      .where(
        and(
          eq(franchiseRostersTable.seasonId, season.id),
          eq(franchiseRostersTable.discordId, targetUser.id),
        )
      )
      .limit(5);
  } else {
    teamRosterQuery = await db
      .select()
      .from(franchiseRostersTable)
      .where(
        and(
          eq(franchiseRostersTable.seasonId, season.id),
          eq(franchiseRostersTable.teamName, teamName!),
        )
      )
      .limit(5);
  }

  if (teamRosterQuery.length === 0) {
    await interaction.editReply({ content: "❌ No roster data found for that team. Make sure MCA data has been imported." });
    return;
  }

  const firstEntry = teamRosterQuery[0];
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`${firstEntry.teamName} — Team Overview`)
    .setDescription(`Use \`/view player_stats\` to browse individual player stats for this team.`)
    .addFields({ name: "Season", value: `Season ${season.seasonNumber}`, inline: true });

  await interaction.editReply({ embeds: [embed] });
}

// ── All Teams Stats handler ────────────────────────────────────────────────────
async function handleAllTeamsView(interaction: ChatInputCommandInteraction): Promise<void> {
  const wantsPublic = interaction.options.getBoolean("public") ?? false;
  const isAdmin     = interaction.memberPermissions?.has(0x8n) ?? false;
  const ephemeral   = !(wantsPublic && isAdmin);

  await interaction.deferReply({ ephemeral });

  const season   = await getOrCreateActiveSeason(interaction.guildId!);
  const allStats = await db.select().from(teamSeasonStatsTable)
    .where(eq(teamSeasonStatsTable.seasonId, season.id));

  if (allStats.length === 0) {
    await interaction.editReply({
      content: "📭 No team stat data found for this season. Run a weekly MCA export first.",
    });
    return;
  }

  // Group teams by conference → division, looking up division from team name
  type TeamRow = {
    teamName:   string;
    wins:       number;
    losses:     number;
    offPassYds: number;
    offRushYds: number;
    offTDs:     number;
    offPtsPerGame: number;
    defPassYds: number;
    defRushYds: number;
    defTDs:     number;
    teamSacks:  number;
    teamInts:   number;
    discordId:  string | null;
  };

  const grouped: Record<string, Record<string, TeamRow[]>> = {
    AFC: { East: [], North: [], South: [], West: [] },
    NFC: { East: [], North: [], South: [], West: [] },
    Unknown: { Other: [] },
  };

  for (const t of allStats) {
    const nfl = lookupNflDivision(t.teamName);
    const conf = nfl?.conference ?? "Unknown";
    const div  = nfl?.division   ?? "Other";
    if (!grouped[conf]) grouped[conf] = {};
    if (!grouped[conf]![div]) grouped[conf]![div] = [];
    grouped[conf]![div]!.push({
      teamName:   t.teamName,
      wins:       t.wins,
      losses:     t.losses,
      offPassYds: t.offPassYds,
      offRushYds: t.offRushYds,
      offTDs:     t.offTDs,
      offPtsPerGame: t.offPtsPerGame,
      defPassYds: t.defPassYds,
      defRushYds: t.defRushYds,
      defTDs:     t.defTDs,
      teamSacks:  t.teamSacks,
      teamInts:   t.teamInts,
      discordId:  t.discordId,
    });
  }

  function fmtTeamLine(t: TeamRow): string {
    const record  = `${t.wins}-${t.losses}`;
    const offPass = (t.offPassYds / 1000).toFixed(1) + "k";
    const offRush = (t.offRushYds / 1000).toFixed(1) + "k";
    const defPass = (t.defPassYds / 1000).toFixed(1) + "k";
    const defRush = (t.defRushYds / 1000).toFixed(1) + "k";
    const ppg     = t.offPtsPerGame > 0
      ? t.offPtsPerGame.toFixed(1)
      : t.wins + t.losses > 0
        ? (t.offTDs / (t.wins + t.losses)).toFixed(1)
        : "—";
    const pag     = t.wins + t.losses > 0
      ? (t.defTDs / (t.wins + t.losses)).toFixed(1)
      : "—";
    const user = t.discordId ? ` 👤` : "";
    return `**${t.teamName}**${user} (${record}) | Off: ${offPass} pass, ${offRush} rush, ${ppg} PPG | Def: ${defPass} pass, ${defRush} rush, ${pag} PAG | ${t.teamSacks} sacks, ${t.teamInts} INTs`;
  }

  const embeds: EmbedBuilder[] = [];
  const DIVISIONS = ["East", "North", "South", "West"] as const;
  const CONF_COLORS: Record<string, number> = { AFC: Colors.Blue, NFC: Colors.Red };

  for (const conf of ["AFC", "NFC"] as const) {
    const confData = grouped[conf] ?? {};
    const fields: { name: string; value: string; inline: boolean }[] = [];

    for (const div of DIVISIONS) {
      const teams = (confData[div] ?? []).sort((a, b) => b.wins - a.wins || b.offPassYds - a.offPassYds);
      if (teams.length === 0) continue;
      const lines = teams.map(t => fmtTeamLine(t));
      // Discord field value limit = 1024 chars — split if needed
      let fieldVal = "";
      const chunks: string[] = [];
      for (const line of lines) {
        if (fieldVal.length + line.length + 1 > 1020) {
          chunks.push(fieldVal);
          fieldVal = "";
        }
        fieldVal += (fieldVal ? "\n" : "") + line;
      }
      if (fieldVal) chunks.push(fieldVal);
      for (let i = 0; i < chunks.length; i++) {
        fields.push({
          name:   i === 0 ? `${conf} ${div}` : `${conf} ${div} (cont.)`,
          value:  chunks[i]!,
          inline: false,
        });
      }
    }

    if (fields.length === 0) continue;

    // Discord embeds have a 25-field limit — split into multiple embeds if needed
    const fieldChunks: typeof fields[] = [];
    for (let i = 0; i < fields.length; i += 25) fieldChunks.push(fields.slice(i, i + 25));

    for (let ci = 0; ci < fieldChunks.length; ci++) {
      const embed = new EmbedBuilder()
        .setColor(CONF_COLORS[conf] ?? Colors.Blurple)
        .setTitle(`🏈 ${conf} Team Stats — Season ${season.seasonNumber}${ci > 0 ? " (continued)" : ""}`)
        .addFields(...fieldChunks[ci]!)
        .setFooter({ text: "👤 = user-controlled team • Off/Def in thousands of yards • PPG = pts per game, PAG = pts allowed per game" });
      embeds.push(embed);
    }
  }

  // Unknown conference teams (shouldn't happen often)
  const unknownTeams = (grouped["Unknown"]?.["Other"] ?? []);
  if (unknownTeams.length > 0) {
    embeds.push(
      new EmbedBuilder()
        .setColor(Colors.Grey)
        .setTitle("🏈 Unrecognized Teams")
        .setDescription(unknownTeams.map(t => fmtTeamLine(t)).join("\n")),
    );
  }

  if (embeds.length === 0) {
    await interaction.editReply({ content: "📭 No team stat data found for this season." });
    return;
  }

  // Send up to 10 embeds per message
  const [first, ...rest] = chunk(embeds, 10);
  await interaction.editReply({ embeds: first });
  for (const batch of rest) {
    await interaction.followUp({ embeds: batch, ephemeral });
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Autocomplete router ────────────────────────────────────────────────────────
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const sub = interaction.options.getSubcommand();

    if (sub === "roster")        return viewroster.autocomplete(interaction);
    if (sub === "rules")          return rulesCmd.autocomplete(interaction);

    if (sub === "team_stats") {
      const focused = interaction.options.getFocused(true);
      if (focused.name === "team") {
        const season = await getOrCreateActiveSeason(interaction.guildId!);
        const teams = await db
          .select({ name: franchiseMcaTeamsTable.nickName })
          .from(franchiseMcaTeamsTable)
          .where(eq(franchiseMcaTeamsTable.seasonId, season.id));
        const q = focused.value.toLowerCase();
        const choices = teams
          .filter(t => t.name.toLowerCase().includes(q))
          .slice(0, 25)
          .map(t => ({ name: t.name, value: t.name }));
        await interaction.respond(choices);
        return;
      }
    }

    await interaction.respond([]).catch(() => {});
  } catch {
    await interaction.respond([]).catch(() => {});
  }
}
