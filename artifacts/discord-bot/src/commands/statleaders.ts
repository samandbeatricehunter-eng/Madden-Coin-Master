import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  teamSeasonStatsTable,
  userRecordsTable, usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

// ── Team stat category definitions ────────────────────────────────────────────
type Direction = "higher" | "lower";

interface TeamStatCat {
  key:       string;
  label:     string;
  unit:      string;
  direction: Direction;
  emoji:     string;
  field:     (t: typeof teamSeasonStatsTable.$inferSelect) => number;
}

const TEAM_STAT_CATS: TeamStatCat[] = [
  {
    key: "off_yds",      label: "Total Offensive Yards",           unit: "yds", direction: "higher", emoji: "🏈",
    field: t => t.offYds,
  },
  {
    key: "pass_yds",     label: "Passing Yards",                   unit: "yds", direction: "higher", emoji: "🎯",
    field: t => t.offPassYds,
  },
  {
    key: "rush_yds",     label: "Rushing Yards",                   unit: "yds", direction: "higher", emoji: "💨",
    field: t => t.offRushYds,
  },
  {
    key: "def_yds",      label: "Def. Total Yards Allowed",        unit: "yds", direction: "lower",  emoji: "🛡️",
    field: t => t.defPassYds + t.defRushYds,
  },
  {
    key: "def_pass_yds", label: "Def. Passing Yards Allowed",      unit: "yds", direction: "lower",  emoji: "✋",
    field: t => t.defPassYds,
  },
  {
    key: "def_rush_yds", label: "Def. Rushing Yards Allowed",      unit: "yds", direction: "lower",  emoji: "🧱",
    field: t => t.defRushYds,
  },
  {
    key: "point_diff",   label: "Point Differential",              unit: "pts", direction: "higher", emoji: "📈",
    field: t => t.offTDs - t.defTDs,
  },
];

// ── Slash command ─────────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("statleaders")
  .setDescription("Display season team stat leaders from the last franchise update")
  .addStringOption(o =>
    o.setName("category")
      .setDescription("Which stat category to display")
      .setRequired(true)
      .addChoices(
        { name: "All Categories (top 3 each)",          value: "all"          },
        { name: "Teams to Watch",                        value: "teams"        },
        { name: "🏈 Total Offensive Yards",              value: "off_yds"      },
        { name: "🎯 Passing Yards",                      value: "pass_yds"     },
        { name: "💨 Rushing Yards",                      value: "rush_yds"     },
        { name: "🛡️ Def. Total Yards Allowed",           value: "def_yds"      },
        { name: "✋ Def. Passing Yards Allowed",          value: "def_pass_yds" },
        { name: "🧱 Def. Rushing Yards Allowed",         value: "def_rush_yds" },
        { name: "📈 Point Differential",                 value: "point_diff"   },
      ))
  .addBooleanOption(o => o
    .setName("public")
    .setDescription("Post this publicly in the channel (admin only)")
    .setRequired(false));

// ── Execute ───────────────────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  const wantsPublic = interaction.options.getBoolean("public") ?? false;
  const isAdmin     = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  const ephemeral   = !(wantsPublic && isAdmin);

  await interaction.deferReply({ ephemeral });

  const category = interaction.options.getString("category", true);
  const season   = await getOrCreateActiveSeason();

  // ── Load data ───────────────────────────────────────────────────────────────
  const [teamStats, allRecords, allUsers] = await Promise.all([
    db.select().from(teamSeasonStatsTable)
      .where(eq(teamSeasonStatsTable.seasonId, season.id)),
    db.select().from(userRecordsTable)
      .where(eq(userRecordsTable.seasonId, season.id)),
    db.select({ discordId: usersTable.discordId, team: usersTable.team }).from(usersTable),
  ]);

  if (teamStats.length === 0) {
    await interaction.editReply({
      content: "📭 No stat data found for this season. Run `/franchiseupdate` first.",
    });
    return;
  }

  // ── Lookup maps ─────────────────────────────────────────────────────────────
  const teamNameToUser = new Map<string, string>(); // teamName (lc) → discordId
  for (const u of allUsers) {
    if (u.team) teamNameToUser.set(u.team.toLowerCase().trim(), u.discordId);
  }
  const discordIdToRecord = new Map(allRecords.map(r => [r.discordId, r]));

  // Only user-controlled teams for "Teams to Watch" formula sections
  const userTeamStats = teamStats.filter(t =>
    t.discordId != null || teamNameToUser.has(t.teamName?.toLowerCase().trim() ?? "")
  );

  // ── Helper: build top-N team leaders for one stat category ─────────────────
  function buildTeamLeaders(cat: TeamStatCat, topN: number): string {
    const entries = teamStats
      .filter(t => t.teamName)
      .map(t => ({ t, val: cat.field(t) }))
      .filter(x => cat.direction === "lower" ? x.val > 0 : x.val !== 0);

    if (!entries.length) return "*No data — run `/franchiseupdate` first*";

    // Higher = best first; Lower = worst (most yards allowed) last = best first = ascending
    entries.sort((a, b) => cat.direction === "higher" ? b.val - a.val : a.val - b.val);

    return entries.slice(0, topN).map(({ t, val }, i) => {
      const sign  = cat.key === "point_diff" && val > 0 ? "+" : "";
      const value = `${sign}${val.toLocaleString()} ${cat.unit}`;
      return `**#${i + 1}** ${t.teamName} — ${value}`;
    }).join("\n");
  }

  // ── Helper: Lethal Offense — top total yards + pts (user teams only) ─────
  function buildLethalOffense(topN: number): string {
    const eligible = userTeamStats.filter(t => t.teamName && (t.offYds > 0 || t.offTDs > 0));
    if (!eligible.length) return "*No team stat data found — run `/franchiseupdate` first*";

    const entries = eligible.map(t => ({
      name: t.teamName, offYds: t.offYds, offTDs: t.offTDs, score: 0,
      detail: `${t.offYds.toLocaleString()} yds / ${t.offTDs} pts`,
    }));

    const maxYds = Math.max(...entries.map(e => e.offYds), 1);
    const maxTDs = Math.max(...entries.map(e => e.offTDs), 1);
    for (const e of entries) e.score = (e.offYds / maxYds) * 0.45 + (e.offTDs / maxTDs) * 0.55;
    entries.sort((a, b) => b.score - a.score);

    return entries.slice(0, topN).map((e, i) =>
      `**#${i + 1}** ${e.name} — ${e.detail}`,
    ).join("\n");
  }

  // ── Helper: Stiff Defense — fewest yards/pts allowed (user teams only) ─────
  function buildStiffDefense(topN: number): string {
    const eligible = userTeamStats.filter(t =>
      t.teamName && (t.defPassYds > 0 || t.defRushYds > 0 || t.defTDs > 0)
    );
    if (!eligible.length) return "*No team stat data found — run `/franchiseupdate` first*";

    const entries = eligible.map(t => ({
      name: t.teamName,
      totalYds: t.defPassYds + t.defRushYds,
      tdsAllowed: t.defTDs,
      detail: `${(t.defPassYds + t.defRushYds).toLocaleString()} total yds allowed / ${t.defTDs} pts against`,
      score: 0,
    }));

    const maxYds = Math.max(...entries.map(e => e.totalYds), 1);
    const maxTDs = Math.max(...entries.map(e => e.tdsAllowed), 1);
    for (const e of entries) {
      e.score = (e.totalYds / maxYds) * 0.80 + (e.tdsAllowed / maxTDs) * 0.20;
    }
    entries.sort((a, b) => a.score - b.score); // ascending: fewer yards = better

    return entries.slice(0, topN).map((e, i) =>
      `**#${i + 1}** ${e.name} — ${e.detail}`,
    ).join("\n");
  }

  // ── Helper: Sleepers — losing/even record teams w/ explosive output ─────────
  function buildSleepers(topN: number): string {
    const eligible = userTeamStats.filter(t => t.teamName);
    if (!eligible.length) return "*No team stat data found — run `/franchiseupdate` first*";

    const entries: {
      name: string; wins: number; losses: number;
      offYds: number; offTDs: number; defYds: number; defTDs: number;
      wlDiff: number; score: number; detail: string;
    }[] = [];

    for (const t of eligible) {
      let wins   = t.wins;
      let losses = t.losses;
      const discordId = t.discordId ?? teamNameToUser.get(t.teamName.toLowerCase().trim());
      if (discordId) {
        const rec = discordIdToRecord.get(discordId);
        if (rec) { wins = rec.wins; losses = rec.losses; }
      }

      if (wins > losses) continue;

      const defYdsTotal = t.defPassYds + t.defRushYds;
      const wlDiff      = wins - losses;

      entries.push({
        name: t.teamName, wins, losses,
        offYds: t.offYds, offTDs: t.offTDs,
        defYds: defYdsTotal, defTDs: t.defTDs,
        wlDiff, score: 0,
        detail: `${wins}W–${losses}L | Off: ${t.offYds.toLocaleString()} yds / ${t.offTDs} pts | Def allowed: ${defYdsTotal.toLocaleString()} yds`,
      });
    }

    if (!entries.length) return "*No qualifying teams (all teams have winning records)*";

    const maxOffYds = Math.max(...entries.map(e => e.offYds), 1);
    const maxOffTDs = Math.max(...entries.map(e => e.offTDs), 1);
    const maxDefYds = Math.max(...entries.map(e => e.defYds), 1);
    const maxDefTDs = Math.max(...entries.map(e => e.defTDs), 1);
    const maxAbsWL  = Math.max(...entries.map(e => Math.abs(e.wlDiff)), 1);

    for (const e of entries) {
      e.score =
          (e.offYds / maxOffYds) * 0.50
        + (e.offTDs / maxOffTDs) * 0.075
        - (e.defYds / maxDefYds) * 0.10
        - (e.defTDs / maxDefTDs) * 0.075
        + (e.wlDiff / maxAbsWL)  * 0.25;
    }
    entries.sort((a, b) => b.score - a.score);

    return entries.slice(0, topN).map((e, i) =>
      `**#${i + 1}** ${e.name} (${e.wins}–${e.losses}) — ${e.detail}`,
    ).join("\n");
  }

  // ── Build embeds ────────────────────────────────────────────────────────────
  const footerText = `Season ${season.seasonNumber ?? season.id} • Last updated via /franchiseupdate`;
  const embeds: EmbedBuilder[] = [];

  if (category === "all") {
    // Two embeds: 4 categories + 3 categories, then Teams to Watch
    const embed1 = new EmbedBuilder()
      .setTitle("📊 Season Team Stat Leaders — All Categories (Top 3)")
      .setColor(Colors.Blurple);

    for (const cat of TEAM_STAT_CATS.slice(0, 4)) {
      embed1.addFields({
        name:  `${cat.emoji} ${cat.label}`,
        value: buildTeamLeaders(cat, 3),
      });
    }

    const embed2 = new EmbedBuilder()
      .setColor(Colors.Blurple);

    for (const cat of TEAM_STAT_CATS.slice(4)) {
      embed2.addFields({
        name:  `${cat.emoji} ${cat.label}`,
        value: buildTeamLeaders(cat, 3),
      });
    }

    const teamsEmbed = new EmbedBuilder()
      .setTitle("🏟️ Teams to Watch")
      .setColor(Colors.DarkGold)
      .addFields(
        { name: "⚡ Most Lethal Offenses (Top 5)",                                    value: buildLethalOffense(5) },
        { name: "🛡️ Most Stiff Defenses (Top 5) — fewest yards allowed",              value: buildStiffDefense(5)  },
        { name: "💤 Most Explosive Sleepers (Top 5) — losing/even-record teams only",  value: buildSleepers(5)      },
      )
      .setFooter({ text: footerText })
      .setTimestamp();

    embeds.push(embed1, embed2, teamsEmbed);

  } else if (category === "teams") {
    const embed = new EmbedBuilder()
      .setTitle("🏟️ Teams to Watch")
      .setColor(Colors.DarkGold)
      .addFields(
        { name: "⚡ Most Lethal Offenses (Top 5)",                                    value: buildLethalOffense(5) },
        { name: "🛡️ Most Stiff Defenses (Top 5) — fewest yards allowed",              value: buildStiffDefense(5)  },
        { name: "💤 Most Explosive Sleepers (Top 5) — losing/even-record teams only",  value: buildSleepers(5)      },
      )
      .setFooter({ text: footerText })
      .setTimestamp();

    embeds.push(embed);

  } else {
    // Single team stat category — top 10
    const cat = TEAM_STAT_CATS.find(c => c.key === category);
    if (!cat) {
      await interaction.editReply({ content: "❌ Unknown category selected." });
      return;
    }

    const dirNote = cat.direction === "lower" ? " (fewest is best)" : "";

    const embed = new EmbedBuilder()
      .setTitle(`${cat.emoji} ${cat.label} Leaders — Top 10${dirNote}`)
      .setColor(Colors.Blurple)
      .setDescription(buildTeamLeaders(cat, 10))
      .setFooter({ text: footerText })
      .setTimestamp();

    embeds.push(embed);
  }

  await interaction.editReply({ embeds });
}
