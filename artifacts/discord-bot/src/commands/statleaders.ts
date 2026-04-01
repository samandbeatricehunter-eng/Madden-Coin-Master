import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import axios from "axios";
import AdmZip from "adm-zip";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

// ── Player stat category definitions ─────────────────────────────────────────
interface PlayerStatCat {
  key:        string;
  label:      string;
  unit:       string;
  fields:     string[];  // Possible JSON field names to try (first match wins)
  suffix?:    string;    // e.g. "yds", "TDs"
}

const PLAYER_STAT_CATS: PlayerStatCat[] = [
  {
    key: "passing_yards", label: "Passing Yards", unit: "yds",
    fields: ["passYds", "passYards", "passingYards", "passYardsTotal", "passingYardsTotal"],
  },
  {
    key: "passing_tds", label: "Passing TDs", unit: "TDs",
    fields: ["passTDs", "passingTDs", "passTouchdowns", "passAttemptsTDs"],
  },
  {
    key: "rushing_yards", label: "Rushing Yards", unit: "yds",
    fields: ["rushYds", "rushYards", "rushingYards", "rushYardsTotal", "rushingYardsTotal"],
  },
  {
    key: "rushing_tds", label: "Rushing TDs", unit: "TDs",
    fields: ["rushTDs", "rushingTDs", "rushTouchdowns"],
  },
  {
    key: "receiving_yards", label: "Receiving Yards", unit: "yds",
    fields: ["recYds", "recYards", "receivingYards", "catchYds", "receivingYardsTotal"],
  },
  {
    key: "receiving_tds", label: "Receiving TDs", unit: "TDs",
    fields: ["recTDs", "receivingTDs", "recTouchdowns", "catchTDs"],
  },
  {
    key: "def_sacks", label: "Defensive Sacks", unit: "sacks",
    fields: ["sacks", "defSacks", "totalSacks", "sackYds"],
  },
  {
    key: "def_ints", label: "Defensive INTs", unit: "INTs",
    fields: ["defInts", "defensiveInterceptions", "interceptions", "intTotal", "defTotalInts"],
  },
  {
    key: "def_tackles", label: "Defensive Total Tackles", unit: "tackles",
    fields: ["totalTackles", "tackles", "tackleTotal",
             // fallback: sum of solo + assist (handled below)
             "tackleSolo", "soloTackles", "sack"],
  },
];

// ── Team stat field name tries ────────────────────────────────────────────────
function tryFields(obj: any, fields: string[]): number | null {
  for (const f of fields) {
    const v = obj?.[f];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

function getTeamOffYards(t: any): number {
  const summed = (tryFields(t, ["offPassYds","offensivePassYards","passYds","passingYards"]) ?? 0)
               + (tryFields(t, ["offRushYds","offensiveRushYards","rushYds","rushingYards"]) ?? 0);
  return summed || (tryFields(t, ["offTotalYds","totalOffYards","offYards","totalOffensiveYards"]) ?? 0);
}
function getTeamOffTDs(t: any): number {
  return tryFields(t, ["offTotalTDs","totalOffTDs","offTouchdowns","totalTouchdowns",
                       "offPassTDs","passTDs"]) ?? 0;
}
function getTeamDefPassYds(t: any): number {
  return tryFields(t, ["defPassYds","defPassYards","passingYardsAllowed","defPassingYards"]) ?? 0;
}
function getTeamDefRushYds(t: any): number {
  return tryFields(t, ["defRushYds","defRushYards","rushingYardsAllowed","defRushingYards"]) ?? 0;
}
function getTeamDefTotalYds(t: any): number {
  const sum = getTeamDefPassYds(t) + getTeamDefRushYds(t);
  if (sum > 0) return sum;
  return tryFields(t, ["defTotalYds","totalDefYards","defYards","totalDefensiveYards"]) ?? 0;
}
function getTeamDefTDs(t: any): number {
  return tryFields(t, ["defPtsAllowed","ptsAllowed","totalPtsAllowed",
                       "pointsAllowed","defTotalPts","defTDs","totalTDsAllowed"]) ?? 0;
}

// ── Local ZIP utilities (same pattern as endofseasonpayout) ──────────────────
function findFile(dir: string, name: string): string | null {
  const nameLower = name.toLowerCase();
  function scan(d: string): string | null {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { const r = scan(full); if (r) return r; }
      else if (e.name.toLowerCase().includes(nameLower)) return full;
    }
    return null;
  }
  return scan(dir);
}
function readJsonFile(dir: string, name: string): any | null {
  const found = findFile(dir, name);
  if (!found) return null;
  try { return JSON.parse(fs.readFileSync(found, "utf-8")); } catch { return null; }
}
function listAllFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}

// ── Flatten a Madden object/array into an array of items ─────────────────────
function flattenToArray(obj: any): any[] {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj.filter(x => x && typeof x === "object");
  if (typeof obj === "object") {
    // Check if it has a top-level array wrapper key
    const keys = Object.keys(obj);
    const wrapper = keys.find(k => Array.isArray(obj[k]) && obj[k].length > 0);
    if (wrapper) return obj[wrapper].filter((x: any) => x && typeof x === "object");
    // Otherwise values of the object
    return Object.values(obj).filter(x => x && typeof x === "object") as any[];
  }
  return [];
}

// ── Get the stat value for a player (handles tackle sum) ─────────────────────
function getPlayerStat(player: any, cat: PlayerStatCat): number | null {
  // Special case: tackles — try totalTackles first, then solo+assist
  if (cat.key === "def_tackles") {
    const total = tryFields(player, ["totalTackles", "tackles", "tackleTotal"]);
    if (total != null) return total;
    const solo   = tryFields(player, ["tackleSolo", "soloTackles", "tackleSoloTotal"]) ?? 0;
    const assist = tryFields(player, ["tackleAssist", "assistTackles", "tackleAssistTotal"]) ?? 0;
    if (solo > 0 || assist > 0) return solo + assist;
    return null;
  }
  return tryFields(player, cat.fields);
}

// ── Ordinal suffix ────────────────────────────────────────────────────────────
function ordinal(n: number): string {
  const s = ["th","st","nd","rd"], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// ── Slash command ─────────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("statleaders")
  .setDescription("Display season stat leaders from your franchise export")
  .addAttachmentOption(o => o
    .setName("franchise_zip")
    .setDescription("Your Madden franchise export ZIP file")
    .setRequired(true))
  .addStringOption(o => {
    const opt = o
      .setName("category")
      .setDescription("Which stat category to display")
      .setRequired(true)
      .addChoices(
        { name: "All Categories (top 3 each)",         value: "all"              },
        { name: "Passing Yards",                        value: "passing_yards"    },
        { name: "Passing TDs",                          value: "passing_tds"      },
        { name: "Rushing Yards",                        value: "rushing_yards"    },
        { name: "Rushing TDs",                          value: "rushing_tds"      },
        { name: "Receiving Yards",                      value: "receiving_yards"  },
        { name: "Receiving TDs",                        value: "receiving_tds"    },
        { name: "Defensive Sacks",                      value: "def_sacks"        },
        { name: "Defensive INTs",                       value: "def_ints"         },
        { name: "Defensive Total Tackles",              value: "def_tackles"      },
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

  const attachment = interaction.options.getAttachment("franchise_zip", true);
  const category   = interaction.options.getString("category", true);

  if (!attachment.name.toLowerCase().endsWith(".zip")) {
    await interaction.editReply("❌ Please upload a `.zip` file from your Madden franchise export.");
    return;
  }

  const season = await getOrCreateActiveSeason();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "statleaders-"));

  try {
    // ── Download & extract ZIP ───────────────────────────────────────────────
    const resp    = await axios({ url: attachment.url, method: "GET", responseType: "arraybuffer", timeout: 30000 });
    const zipBuf  = Buffer.from(resp.data as ArrayBuffer);
    const zipPath = path.join(tmpDir, "franchise.zip");
    fs.writeFileSync(zipPath, zipBuf);
    const zip = new AdmZip(zipPath);
    const extractDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);

    // ── Load JSON files ──────────────────────────────────────────────────────
    // Player stats — try several possible file names Madden might use
    let rawPlayerStats =
      readJsonFile(extractDir, "playerseasonstat") ??
      readJsonFile(extractDir, "playerstats") ??
      readJsonFile(extractDir, "stats");

    // Team stats — for offensive/defensive formula categories
    let rawTeamStats =
      readJsonFile(extractDir, "teamseasonstat") ??
      readJsonFile(extractDir, "teamstats") ??
      readJsonFile(extractDir, "teams");

    // Teams lookup (for name resolution)
    const rawTeams = readJsonFile(extractDir, "teams");

    // ── Build team ID → name map ─────────────────────────────────────────────
    const teamIdToName = new Map<number, string>();
    const teamsArr = flattenToArray(rawTeams);
    for (const t of teamsArr) {
      const id   = Number(t?.teamId ?? t?.teamIndex);
      if (isNaN(id)) continue;
      const nick = (t?.teamName ?? "").trim();
      const city = (t?.cityName ?? "").trim();
      const full = city ? `${city} ${nick}` : nick;
      if (full) teamIdToName.set(id, full);
      else if (nick) teamIdToName.set(id, nick);
    }

    // ── Build player list with stats ─────────────────────────────────────────
    const playerArr = flattenToArray(rawPlayerStats);
    // Fallback: if stats.json is the same as teams (no player data), use roster
    const hasPlayerStats = playerArr.some(p =>
      tryFields(p, ["passYds","passYards","rushYds","rushYards","recYds","recYards",
                     "sacks","defSacks","totalTackles","tackles","defInts"]) != null,
    );
    const players: any[] = hasPlayerStats
      ? playerArr
      : flattenToArray(readJsonFile(extractDir, "roster") ?? readJsonFile(extractDir, "rosters") ?? null);

    // ── Team stats array ────────────────────────────────────────────────────
    const teamStatsArr = flattenToArray(rawTeamStats);

    // ── Load registered users + records from DB ──────────────────────────────
    const allUsers   = await db.select().from(usersTable);
    const allRecords = await db.select().from(userRecordsTable)
      .where(eq(userRecordsTable.seasonId, season.id));

    const teamNameToUser = new Map<string, (typeof allUsers)[0]>();
    for (const u of allUsers) {
      if (u.team) teamNameToUser.set(u.team.toLowerCase(), u);
    }
    const discordIdToRecord = new Map<string, (typeof allRecords)[0]>();
    for (const r of allRecords) discordIdToRecord.set(r.discordId, r);

    // ── Helper: build top-N player leaders for one category ─────────────────
    function buildPlayerLeaders(cat: PlayerStatCat, topN: number): string {
      const entries: { name: string; teamName: string; value: number }[] = [];
      for (const p of players) {
        const val = getPlayerStat(p, cat);
        if (val == null || val <= 0) continue;
        const first = (p.firstName ?? p.first_name ?? "").trim();
        const last  = (p.lastName  ?? p.last_name  ?? "").trim();
        const name  = [first, last].filter(Boolean).join(" ") || "Unknown";
        const tid   = Number(p.teamId ?? p.team_id ?? p.teamIndex);
        const team  = (!isNaN(tid) ? teamIdToName.get(tid) : null) ?? p.teamName ?? "?";
        entries.push({ name, teamName: team, value: val });
      }
      entries.sort((a, b) => b.value - a.value);
      const top = entries.slice(0, topN);
      if (!top.length) return "*No data found*";
      return top.map((e, i) =>
        `**#${i + 1}** ${e.name} (${e.teamName}) — ${e.value.toLocaleString()} ${cat.unit}`,
      ).join("\n");
    }

    // ── Helper: build team formula leaders ──────────────────────────────────

    // Lethal Offense: 45% total offense yards + 55% total offensive TDs (normalized)
    function buildLethalOffense(topN: number): string {
      if (!teamStatsArr.length) return "*No team stat data found*";

      const entries: { name: string; score: number; detail: string }[] = [];
      for (const t of teamStatsArr) {
        const tid  = Number(t?.teamId ?? t?.teamIndex);
        const name = (!isNaN(tid) ? teamIdToName.get(tid) : null) ?? (t?.teamName ?? "?");
        if (!name || name === "?") continue;
        const offYds = getTeamOffYards(t);
        const offTDs = getTeamOffTDs(t);
        entries.push({ name, score: 0, detail: `${offYds.toLocaleString()} yds / ${offTDs} TDs` });
        (entries[entries.length - 1] as any)._offYds = offYds;
        (entries[entries.length - 1] as any)._offTDs = offTDs;
      }
      if (!entries.length) return "*No team stat data found*";

      // Normalize each component 0–1 then weight
      const maxYds = Math.max(...entries.map((e: any) => e._offYds), 1);
      const maxTDs  = Math.max(...entries.map((e: any) => e._offTDs), 1);
      for (const e of entries) {
        const normYds = (e as any)._offYds / maxYds;
        const normTDs  = (e as any)._offTDs / maxTDs;
        e.score = normYds * 0.45 + normTDs * 0.55;
      }
      entries.sort((a, b) => b.score - a.score);
      return entries.slice(0, topN).map((e, i) =>
        `**#${i + 1}** ${e.name} — ${e.detail} *(score: ${(e.score * 100).toFixed(1)})*`,
      ).join("\n");
    }

    // Stiff Defense: 40% pass yds allowed + 40% rush yds allowed + 20% TDs allowed
    // Lowest score = best defense → ranked lowest→highest (ascending)
    function buildStiffDefense(topN: number): string {
      if (!teamStatsArr.length) return "*No team stat data found*";

      const entries: { name: string; score: number; detail: string }[] = [];
      for (const t of teamStatsArr) {
        const tid  = Number(t?.teamId ?? t?.teamIndex);
        const name = (!isNaN(tid) ? teamIdToName.get(tid) : null) ?? (t?.teamName ?? "?");
        if (!name || name === "?") continue;
        const passAllowed = getTeamDefPassYds(t);
        const rushAllowed = getTeamDefRushYds(t);
        const tdsAllowed  = getTeamDefTDs(t);
        entries.push({ name, score: 0, detail: `${passAllowed.toLocaleString()} pass yds / ${rushAllowed.toLocaleString()} rush yds / ${tdsAllowed} TDs allowed` });
        (entries[entries.length - 1] as any)._pass = passAllowed;
        (entries[entries.length - 1] as any)._rush = rushAllowed;
        (entries[entries.length - 1] as any)._tds  = tdsAllowed;
      }
      if (!entries.length) return "*No team stat data found*";

      // Normalize (higher = more yards allowed = worse)
      const maxPass = Math.max(...entries.map((e: any) => e._pass), 1);
      const maxRush = Math.max(...entries.map((e: any) => e._rush), 1);
      const maxTDs  = Math.max(...entries.map((e: any) => e._tds),  1);
      for (const e of entries) {
        const normPass = (e as any)._pass / maxPass;
        const normRush = (e as any)._rush / maxRush;
        const normTDs  = (e as any)._tds  / maxTDs;
        // Lower score = better (fewer yards/TDs allowed)
        e.score = normPass * 0.40 + normRush * 0.40 + normTDs * 0.20;
      }
      entries.sort((a, b) => a.score - b.score); // ascending: best defense first
      return entries.slice(0, topN).map((e, i) =>
        `**#${i + 1}** ${e.name} — ${e.detail} *(score: ${(e.score * 100).toFixed(1)})*`,
      ).join("\n");
    }

    // Sleepers: teams with losing/even record, ranked by explosive formula
    // Formula: +50% off yards (normalized), +7.5% off TDs, -10% def yards (normalized), -7.5% def TDs
    // W/L differential factor: +25% (wl_diff / maxAbsWL) — this is negative for losing teams
    // Since sleepers MUST be losing/even, wl_diff ≤ 0. We negate it for the formula (so worse record = less bonus).
    function buildSleepers(topN: number): string {
      if (!teamStatsArr.length) return "*No team stat data found*";

      const entries: {
        name: string; score: number; detail: string;
        wins: number; losses: number;
      }[] = [];

      for (const t of teamStatsArr) {
        const tid  = Number(t?.teamId ?? t?.teamIndex);
        const name = (!isNaN(tid) ? teamIdToName.get(tid) : null) ?? (t?.teamName ?? "?");
        if (!name || name === "?") continue;

        // Look up W/L from our records (registered users only for records)
        const userEntry = teamNameToUser.get(name.toLowerCase());
        // Try nickname match too
        const userEntryNick = !userEntry
          ? [...teamNameToUser.entries()].find(([k]) => name.toLowerCase().includes(k))?.[1]
          : null;
        const user = userEntry ?? userEntryNick;

        let wins = 0;
        let losses = 0;
        if (user) {
          const rec = discordIdToRecord.get(user.discordId);
          wins   = rec?.wins   ?? 0;
          losses = rec?.losses ?? 0;
        } else {
          // Try to read from the team stat object itself
          wins   = tryFields(t, ["wins","totalWins","seasonWins"])   ?? 0;
          losses = tryFields(t, ["losses","totalLosses","seasonLosses"]) ?? 0;
        }

        // Only include teams with losing or even records
        if (wins > losses) continue;

        const offYds  = getTeamOffYards(t);
        const offTDs  = getTeamOffTDs(t);
        const defYds  = getTeamDefTotalYds(t);
        const defTDs  = getTeamDefTDs(t);
        const wlDiff  = wins - losses; // ≤ 0

        entries.push({
          name, wins, losses,
          score: 0,
          detail: `${wins}W–${losses}L | Off: ${offYds.toLocaleString()} yds/${offTDs} TDs | Def allowed: ${defYds.toLocaleString()} yds/${defTDs} pts`,
        });
        const last = entries[entries.length - 1] as any;
        last._offYds = offYds;
        last._offTDs = offTDs;
        last._defYds = defYds;
        last._defTDs = defTDs;
        last._wlDiff = wlDiff;
      }

      if (!entries.length) return "*No qualifying teams (all teams have winning records)*";

      // Normalize each component
      const maxOffYds  = Math.max(...entries.map((e: any) => e._offYds), 1);
      const maxOffTDs  = Math.max(...entries.map((e: any) => e._offTDs), 1);
      const maxDefYds  = Math.max(...entries.map((e: any) => e._defYds), 1);
      const maxDefTDs  = Math.max(...entries.map((e: any) => e._defTDs), 1);
      const maxAbsWL   = Math.max(...entries.map((e: any) => Math.abs(e._wlDiff)), 1);

      for (const e of entries) {
        const normOffYds = (e as any)._offYds / maxOffYds;
        const normOffTDs = (e as any)._offTDs / maxOffTDs;
        const normDefYds = (e as any)._defYds / maxDefYds;  // negative contribution
        const normDefTDs = (e as any)._defTDs / maxDefTDs;  // negative contribution
        const normWL     = (e as any)._wlDiff / maxAbsWL;   // ≤ 0; worse record = more negative
        e.score =
            normOffYds * 0.50
          + normOffTDs * 0.075
          - normDefYds * 0.10
          - normDefTDs * 0.075
          + normWL     * 0.25;  // W/L diff is negative, so this penalizes worse records
      }

      entries.sort((a, b) => b.score - a.score); // highest score = most explosive sleeper
      return entries.slice(0, topN).map((e, i) =>
        `**#${i + 1}** ${e.name} (${e.wins}–${e.losses}) — ${e.detail} *(score: ${(e.score * 100).toFixed(1)})*`,
      ).join("\n");
    }

    // ── Build embeds ─────────────────────────────────────────────────────────
    const embeds: EmbedBuilder[] = [];

    const teamStatsEmbed = new EmbedBuilder()
      .setTitle("🏟️ Team Performance Categories")
      .setColor(Colors.DarkGold)
      .addFields(
        {
          name: "⚡ Most Lethal Offenses (Top 5)",
          value: buildLethalOffense(5) || "*No data*",
        },
        {
          name: "🛡️ Most Stiff Defenses (Top 5) — lowest score = best",
          value: buildStiffDefense(5) || "*No data*",
        },
        {
          name: "💤 Most Explosive Sleepers (Top 5) — losing/even-record teams only",
          value: buildSleepers(5) || "*No data*",
        },
      )
      .setFooter({ text: `Season ${season.id} • Data from franchise export` })
      .setTimestamp();

    if (category === "all") {
      // Split 9 player categories across up to 2 embeds (≤ 10 fields each)
      const cat1 = PLAYER_STAT_CATS.slice(0, 5);
      const cat2 = PLAYER_STAT_CATS.slice(5);

      const embed1 = new EmbedBuilder()
        .setTitle("📊 Season Stat Leaders — All Categories (Top 3)")
        .setColor(Colors.Blurple);
      for (const cat of cat1) {
        embed1.addFields({ name: `${cat.label}`, value: buildPlayerLeaders(cat, 3) });
      }

      const embed2 = new EmbedBuilder()
        .setColor(Colors.Blurple);
      for (const cat of cat2) {
        embed2.addFields({ name: `${cat.label}`, value: buildPlayerLeaders(cat, 3) });
      }

      embeds.push(embed1, embed2, teamStatsEmbed);

    } else {
      // Individual category: top 10 for the selected stat
      const cat = PLAYER_STAT_CATS.find(c => c.key === category);
      if (!cat) {
        await interaction.editReply("❌ Unknown category selected.");
        return;
      }

      const leadersEmbed = new EmbedBuilder()
        .setTitle(`📊 ${cat.label} Leaders — Top 10`)
        .setColor(Colors.Blurple)
        .setDescription(buildPlayerLeaders(cat, 10))
        .setFooter({ text: `Season ${season.id} • Data from franchise export` })
        .setTimestamp();

      embeds.push(leadersEmbed, teamStatsEmbed);
    }

    await interaction.editReply({ embeds });

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
