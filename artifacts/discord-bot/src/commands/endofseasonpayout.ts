import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, seasonStatTierConfigsTable, seasonsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import axios from "axios";
import AdmZip from "adm-zip";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { addBalance, logTransaction, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import {
  STAT_CATEGORIES, STAT_CATEGORY_MAP, evaluateTier, extractStat,
} from "../lib/stat-categories.js";

// ── Helpers ─────────────────────────────────────────────────────────────────
function findFile(dir: string, name: string): string | null {
  const direct = path.join(dir, name);
  if (fs.existsSync(direct)) return direct;
  function scan(d: string): string | null {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase())
        return path.join(d, entry.name);
      if (entry.isDirectory()) {
        const r = scan(path.join(d, entry.name));
        if (r) return r;
      }
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

// ── Command ─────────────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("endofseasonpayout")
  .setDescription("Admin: distribute end-of-season stat bonuses from franchise ZIP")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addAttachmentOption(o => o
    .setName("file")
    .setDescription("The Madden franchise export ZIP file")
    .setRequired(true))
  .addBooleanOption(o => o
    .setName("dry_run")
    .setDescription("Preview payouts without actually awarding coins (default: false)")
    .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const attachment = interaction.options.getAttachment("file", true);
  const dryRun     = interaction.options.getBoolean("dry_run") ?? false;

  if (!attachment.name.toLowerCase().endsWith(".zip")) {
    await interaction.editReply({ content: "❌ Please upload a `.zip` file from your Madden franchise export." });
    return;
  }

  await interaction.editReply({ content: "📥 Downloading franchise ZIP..." });

  const season = await getOrCreateActiveSeason();

  // ── Load tier configs for this season ────────────────────────────────────────
  const allTierRows = await db.select()
    .from(seasonStatTierConfigsTable)
    .where(eq(seasonStatTierConfigsTable.seasonId, season.id));

  // Group by category key
  const tiersByCategory = new Map<string, { tier: number; threshold: number; payout: number }[]>();
  for (const row of allTierRows) {
    let arr = tiersByCategory.get(row.statCategory);
    if (!arr) { arr = []; tiersByCategory.set(row.statCategory, arr); }
    arr.push({ tier: row.tier, threshold: row.threshold, payout: row.payout });
  }

  // Validate: all 11 categories must have all 4 tiers configured
  const missingCategories: string[] = [];
  for (const cat of STAT_CATEGORIES) {
    const tiers = tiersByCategory.get(cat.key) ?? [];
    const tierNums = new Set(tiers.map(t => t.tier));
    const missingTiers = [1, 2, 3, 4].filter(n => !tierNums.has(n));
    if (missingTiers.length > 0) {
      missingCategories.push(`**${cat.label}** — missing tiers: ${missingTiers.join(", ")}`);
    }
  }

  if (missingCategories.length > 0) {
    await interaction.editReply({
      content:
        `❌ Not all stat tier configs are set for Season ${season.id}. ` +
        `Use \`/admin-set-stat-tier\` to fill in the blanks:\n` +
        missingCategories.map(m => `• ${m}`).join("\n"),
    });
    return;
  }

  // ── Download and extract ZIP ─────────────────────────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eos-"));

  try {
    const resp    = await axios({ url: attachment.url, method: "GET", responseType: "arraybuffer", timeout: 30000 });
    const zipBuf  = Buffer.from(resp.data as ArrayBuffer);
    const zipPath = path.join(tmpDir, "franchise.zip");
    fs.writeFileSync(zipPath, zipBuf);

    const zip        = new AdmZip(zipPath);
    const extractDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);

    // Try teamseasonstat.json first, fall back to teams.json
    let statsJson = readJsonFile(extractDir, "teamseasonstat.json")
                 ?? readJsonFile(extractDir, "teamSeasonStat.json")
                 ?? readJsonFile(extractDir, "teams.json");

    if (!statsJson) {
      await interaction.editReply({ content: "❌ Could not find team season stats in the ZIP (`teamseasonstat.json` or `teams.json`)." });
      return;
    }

    // Normalize: the JSON might be a wrapper object; try to find the actual array/object of teams
    if (typeof statsJson === "object" && !Array.isArray(statsJson)) {
      const keys = Object.keys(statsJson);
      // Common Madden wrappers: { "teamSeasonStatInfoList": [...] } or { teams: [...] }
      const wrapperKey = keys.find(k => Array.isArray(statsJson[k]));
      if (wrapperKey) statsJson = statsJson[wrapperKey];
    }

    const statTeams: any[] = Array.isArray(statsJson) ? statsJson : Object.values(statsJson);

    // ── Build teamId/nicknames → stats map ────────────────────────────────────
    // teamsJson for name matching
    const teamsJson = readJsonFile(extractDir, "teams.json");
    const teamIdToNames = new Map<number, { name: string; nickname: string }>();
    if (teamsJson) {
      for (const t of (Array.isArray(teamsJson) ? teamsJson : Object.values(teamsJson)) as any[]) {
        const id = Number(t?.teamId ?? t?.teamIndex);
        if (isNaN(id)) continue;
        const nick = (t.teamName ?? "").trim();
        const full = [t.cityName, nick].filter(Boolean).join(" ").trim();
        teamIdToNames.set(id, { name: full, nickname: nick });
      }
    }

    // ── Load all registered users ──────────────────────────────────────────────
    const registeredUsers = await db.select({
      discordId: usersTable.discordId,
      discordUsername: usersTable.discordUsername,
      team: usersTable.team,
    }).from(usersTable).where(eq(usersTable.team, usersTable.team));

    const teamToUser = new Map<string, { discordId: string; discordUsername: string; team: string }>();
    for (const u of registeredUsers) {
      if (u.team) teamToUser.set(u.team.toLowerCase().trim(), { discordId: u.discordId, discordUsername: u.discordUsername, team: u.team });
    }

    // ── Evaluate each team's stats ─────────────────────────────────────────────
    const payoutLines: string[] = [];
    let totalAwarded = 0;
    let totalUsers   = 0;

    for (const teamStat of statTeams) {
      if (!teamStat || typeof teamStat !== "object") continue;

      // Resolve team identity
      const teamId    = Number(teamStat.teamId ?? teamStat.teamIndex);
      const names     = teamIdToNames.get(teamId);
      const nickname  = (teamStat.teamName ?? names?.nickname ?? "").trim();
      const fullName  = names?.name ?? nickname;

      // Skip CPU teams (no user registered)
      const user = teamToUser.get(fullName.toLowerCase()) ?? teamToUser.get(nickname.toLowerCase());
      if (!user) continue;

      let userTotal = 0;
      const userLines: string[] = [];

      for (const cat of STAT_CATEGORIES) {
        const tiers = tiersByCategory.get(cat.key);
        if (!tiers) continue;

        const statValue = extractStat(teamStat, cat.jsonFields);
        if (statValue == null) continue;

        const result = evaluateTier(tiers, statValue, cat.direction);
        if (!result) continue;

        userLines.push(`  • ${cat.label}: **${statValue} ${cat.unit}** → Tier ${result.tier} (+${result.payout} coins)`);
        userTotal += result.payout;
      }

      if (userTotal > 0) {
        if (!dryRun) {
          await addBalance(user.discordId, userTotal);
          await logTransaction(user.discordId, userTotal, "addcoins",
            `End-of-season stat bonus (Season ${season.id}): ${userLines.map(l => l.trim()).join(" | ")}`);
        }
        payoutLines.push(`**${user.team}** (${user.discordUsername}) — +${userTotal} coins`);
        for (const l of userLines) payoutLines.push(l);
        totalAwarded += userTotal;
        totalUsers++;
      }
    }

    // ── Build result embed ────────────────────────────────────────────────────
    const embed = new EmbedBuilder()
      .setTitle(dryRun ? "🧪 End-of-Season Stat Bonus — DRY RUN" : "🏆 End-of-Season Stat Bonuses Distributed!")
      .setColor(dryRun ? Colors.Yellow : Colors.Gold)
      .setDescription(
        payoutLines.length
          ? payoutLines.join("\n").slice(0, 3900)
          : "*No qualifying results found. Check that your stat JSON fields match the category definitions.*"
      )
      .addFields(
        { name: "Season",            value: `Season ${season.id}`,    inline: true },
        { name: "Teams Rewarded",    value: `${totalUsers}`,           inline: true },
        { name: "Total Coins Issued", value: `${totalAwarded}`,        inline: true },
        { name: "Mode",              value: dryRun ? "DRY RUN (no coins awarded)" : "LIVE", inline: false },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
