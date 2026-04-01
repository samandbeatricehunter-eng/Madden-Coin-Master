import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  playerSeasonStatsTable, teamSeasonStatsTable,
  userRecordsTable, usersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

// ── Player stat category definitions ─────────────────────────────────────────
interface PlayerStatCat {
  key:   string;
  label: string;
  unit:  string;
  field: (p: typeof playerSeasonStatsTable.$inferSelect) => number;
}

const PLAYER_STAT_CATS: PlayerStatCat[] = [
  { key: "passing_yards",   label: "Passing Yards",           unit: "yds",     field: p => p.passYds      },
  { key: "passing_tds",     label: "Passing TDs",             unit: "TDs",     field: p => p.passTDs      },
  { key: "rushing_yards",   label: "Rushing Yards",           unit: "yds",     field: p => p.rushYds      },
  { key: "rushing_tds",     label: "Rushing TDs",             unit: "TDs",     field: p => p.rushTDs      },
  { key: "receiving_yards", label: "Receiving Yards",         unit: "yds",     field: p => p.recYds       },
  { key: "receiving_tds",   label: "Receiving TDs",           unit: "TDs",     field: p => p.recTDs       },
  { key: "def_sacks",       label: "Defensive Sacks",         unit: "sacks",   field: p => p.sacks        },
  { key: "def_ints",        label: "Defensive INTs",          unit: "INTs",    field: p => p.defInts      },
  { key: "def_tackles",     label: "Defensive Total Tackles", unit: "tackles",
    field: p => p.totalTackles > 0 ? p.totalTackles : p.tackleSolo + p.tackleAssist },
];

// ── Ordinal suffix ─────────────────────────────────────────────────────────────
function ordinal(n: number): string {
  const s = ["th","st","nd","rd"], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// ── Slash command ─────────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("statleaders")
  .setDescription("Display season stat leaders from the last franchise update")
  .addStringOption(o => {
    const opt = o
      .setName("category")
      .setDescription("Which stat category to display")
      .setRequired(true)
      .addChoices(
        { name: "All Categories (top 3 each)",           value: "all"              },
        { name: "Passing Yards",                          value: "passing_yards"    },
        { name: "Passing TDs",                            value: "passing_tds"      },
        { name: "Rushing Yards",                          value: "rushing_yards"    },
        { name: "Rushing TDs",                            value: "rushing_tds"      },
        { name: "Receiving Yards",                        value: "receiving_yards"  },
        { name: "Receiving TDs",                          value: "receiving_tds"    },
        { name: "Defensive Sacks",                        value: "def_sacks"        },
        { name: "Defensive INTs",                         value: "def_ints"         },
        { name: "Defensive Total Tackles",                value: "def_tackles"      },
      );
    return opt;
  })
  .addBooleanOption(o => o
    .setName("public")
    .setDescription("Post this publicly in the channel (admin only)")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  const wantsPublic = interaction.options.getBoolean("public") ?? false;
  const isAdmin     = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  const ephemeral   = !(wantsPublic && isAdmin);

  await interaction.deferReply({ ephemeral });

  const category = interaction.options.getString("category", true);
  const season   = await getOrCreateActiveSeason();

  // ── Load all data from DB ──────────────────────────────────────────────────
  const [players, teamStats, allRecords, allUsers] = await Promise.all([
    db.select().from(playerSeasonStatsTable)
      .where(eq(playerSeasonStatsTable.seasonId, season.id)),
    db.select().from(teamSeasonStatsTable)
      .where(eq(teamSeasonStatsTable.seasonId, season.id)),
    db.select().from(userRecordsTable)
      .where(eq(userRecordsTable.seasonId, season.id)),
    db.select({ discordId: usersTable.discordId, team: usersTable.team }).from(usersTable),
  ]);

  if (players.length === 0 && teamStats.length === 0) {
    await interaction.editReply({
      content: "📭 No stat data found for this season. Run `/franchiseupdate` first to import stats from your franchise ZIP.",
    });
    return;
  }

  // Build lookup maps
  const teamNameToUser = new Map<string, string>(); // teamName (lc) → discordId
  for (const u of allUsers) {
    if (u.team) teamNameToUser.set(u.team.toLowerCase().trim(), u.discordId);
  }
  const discordIdToRecord = new Map(allRecords.map(r => [r.discordId, r]));

  // ── Helper: build top-N player leaders for one category ───────────────────
  function buildPlayerLeaders(cat: PlayerStatCat, topN: number): string {
    const entries = players
      .map(p => ({ p, val: cat.field(p) }))
      .filter(x => x.val > 0)
      .sort((a, b) => b.val - a.val)
      .slice(0, topN);

    if (!entries.length) return "*No data found*";
    return entries.map(({ p, val }, i) => {
      const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown";
      const team = p.teamName || "?";
      return `**#${i + 1}** ${name} (${team}) — ${val.toLocaleString()} ${cat.unit}`;
    }).join("\n");
  }

  // ── Helper: build team formula leaders ────────────────────────────────────

  // Lethal Offense: 45% total offense yards + 55% total offensive TDs (normalized)
  function buildLethalOffense(topN: number): string {
    if (!teamStats.length) return "*No team stat data found — run `/franchiseupdate` first*";

    const entries = teamStats.map(t => ({
      name:    t.teamName,
      offYds:  t.offYds,
      offTDs:  t.offTDs,
      detail:  `${t.offYds.toLocaleString()} yds / ${t.offTDs} TDs`,
      score:   0,
    })).filter(e => e.name);

    if (!entries.length) return "*No team stat data found*";

    const maxYds = Math.max(...entries.map(e => e.offYds), 1);
    const maxTDs = Math.max(...entries.map(e => e.offTDs), 1);
    for (const e of entries) {
      e.score = (e.offYds / maxYds) * 0.45 + (e.offTDs / maxTDs) * 0.55;
    }
    entries.sort((a, b) => b.score - a.score);
    return entries.slice(0, topN).map((e, i) =>
      `**#${i + 1}** ${e.name} — ${e.detail} *(score: ${(e.score * 100).toFixed(1)})*`,
    ).join("\n");
  }

  // Stiff Defense: 40% pass yds allowed + 40% rush yds allowed + 20% TDs allowed (lower = better)
  function buildStiffDefense(topN: number): string {
    if (!teamStats.length) return "*No team stat data found — run `/franchiseupdate` first*";

    const entries = teamStats.map(t => ({
      name:       t.teamName,
      passAllowed: t.defPassYds,
      rushAllowed: t.defRushYds,
      tdsAllowed:  t.defTDs,
      detail:     `${t.defPassYds.toLocaleString()} pass yds / ${t.defRushYds.toLocaleString()} rush yds / ${t.defTDs} TDs allowed`,
      score:      0,
    })).filter(e => e.name);

    if (!entries.length) return "*No team stat data found*";

    const maxPass = Math.max(...entries.map(e => e.passAllowed), 1);
    const maxRush = Math.max(...entries.map(e => e.rushAllowed), 1);
    const maxTDs  = Math.max(...entries.map(e => e.tdsAllowed),  1);
    for (const e of entries) {
      e.score = (e.passAllowed / maxPass) * 0.40
              + (e.rushAllowed / maxRush) * 0.40
              + (e.tdsAllowed  / maxTDs)  * 0.20;
    }
    entries.sort((a, b) => a.score - b.score); // ascending: best defense first
    return entries.slice(0, topN).map((e, i) =>
      `**#${i + 1}** ${e.name} — ${e.detail} *(score: ${(e.score * 100).toFixed(1)})*`,
    ).join("\n");
  }

  // Sleepers: losing/even record teams ranked by explosive formula
  function buildSleepers(topN: number): string {
    if (!teamStats.length) return "*No team stat data found — run `/franchiseupdate` first*";

    const entries: {
      name: string; wins: number; losses: number;
      offYds: number; offTDs: number; defYds: number; defTDs: number;
      wlDiff: number; score: number; detail: string;
    }[] = [];

    for (const t of teamStats) {
      if (!t.teamName) continue;

      // Get W/L: prefer userRecordsTable for registered users, fall back to teamSeasonStats
      let wins   = t.wins;
      let losses = t.losses;
      const discordId = t.discordId
        ?? teamNameToUser.get(t.teamName.toLowerCase().trim());
      if (discordId) {
        const rec = discordIdToRecord.get(discordId);
        if (rec) { wins = rec.wins; losses = rec.losses; }
      }

      if (wins > losses) continue; // only losing/even teams

      const defYds = (t.defPassYds + t.defRushYds) || t.offYds; // defYds = pass+rush allowed
      const defYdsTotal = t.defPassYds + t.defRushYds;
      const wlDiff = wins - losses;

      entries.push({
        name: t.teamName, wins, losses,
        offYds: t.offYds, offTDs: t.offTDs,
        defYds: defYdsTotal, defTDs: t.defTDs,
        wlDiff, score: 0,
        detail: `${wins}W–${losses}L | Off: ${t.offYds.toLocaleString()} yds/${t.offTDs} TDs | Def allowed: ${defYdsTotal.toLocaleString()} yds/${t.defTDs} pts`,
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
        + (e.wlDiff / maxAbsWL)  * 0.25; // wlDiff ≤ 0 for losing/even
    }
    entries.sort((a, b) => b.score - a.score);
    return entries.slice(0, topN).map((e, i) =>
      `**#${i + 1}** ${e.name} (${e.wins}–${e.losses}) — ${e.detail} *(score: ${(e.score * 100).toFixed(1)})*`,
    ).join("\n");
  }

  // ── Build embeds ───────────────────────────────────────────────────────────
  const footerText = `Season ${season.seasonNumber ?? season.id} • Last updated via /franchiseupdate`;
  const embeds: EmbedBuilder[] = [];

  const teamStatsEmbed = new EmbedBuilder()
    .setTitle("🏟️ Team Performance Categories")
    .setColor(Colors.DarkGold)
    .addFields(
      { name: "⚡ Most Lethal Offenses (Top 5)",                                   value: buildLethalOffense(5) || "*No data*" },
      { name: "🛡️ Most Stiff Defenses (Top 5) — lowest score = best",             value: buildStiffDefense(5) || "*No data*"  },
      { name: "💤 Most Explosive Sleepers (Top 5) — losing/even-record teams only", value: buildSleepers(5)     || "*No data*"  },
    )
    .setFooter({ text: footerText })
    .setTimestamp();

  if (category === "all") {
    const cat1 = PLAYER_STAT_CATS.slice(0, 5);
    const cat2 = PLAYER_STAT_CATS.slice(5);

    const embed1 = new EmbedBuilder()
      .setTitle("📊 Season Stat Leaders — All Categories (Top 3)")
      .setColor(Colors.Blurple);
    for (const cat of cat1) {
      embed1.addFields({ name: cat.label, value: buildPlayerLeaders(cat, 3) });
    }

    const embed2 = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setFooter({ text: footerText })
      .setTimestamp();
    for (const cat of cat2) {
      embed2.addFields({ name: cat.label, value: buildPlayerLeaders(cat, 3) });
    }

    embeds.push(embed1, embed2, teamStatsEmbed);
  } else {
    const cat = PLAYER_STAT_CATS.find(c => c.key === category);
    if (!cat) {
      await interaction.editReply("❌ Unknown category selected.");
      return;
    }

    const leadersEmbed = new EmbedBuilder()
      .setTitle(`📊 ${cat.label} Leaders — Top 10`)
      .setColor(Colors.Blurple)
      .setDescription(buildPlayerLeaders(cat, 10))
      .setFooter({ text: footerText })
      .setTimestamp();

    embeds.push(leadersEmbed, teamStatsEmbed);
  }

  await interaction.editReply({ embeds });
}
