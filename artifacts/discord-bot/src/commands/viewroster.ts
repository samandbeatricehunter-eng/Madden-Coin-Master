import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, franchiseRostersTable, seasonsTable } from "@workspace/db";
import { eq, and, ilike, asc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { requireMcaEnabled } from "../lib/server-settings.js";

// ── Position grouping (mirrors my-roster.ts) ─────────────────────────────────

const OFFENSE_GROUPS: { label: string; positions: string[] }[] = [
  { label: "Quarterback",    positions: ["QB"] },
  { label: "Running Back",   positions: ["HB", "FB"] },
  { label: "Wide Receiver",  positions: ["WR"] },
  { label: "Tight End",      positions: ["TE"] },
  { label: "Offensive Line", positions: ["LT", "LG", "C", "RG", "RT"] },
];

const DEFENSE_GROUPS: { label: string; positions: string[] }[] = [
  { label: "Defensive Line",  positions: ["LE", "RE", "DT", "DE", "LEDGE", "REDGE"] },
  { label: "MIKE Linebacker", positions: ["MLB", "MIKE"] },
  { label: "SAM Linebacker",  positions: ["LOLB", "SAM"] },
  { label: "WILL Linebacker", positions: ["ROLB", "WILL"] },
  { label: "Cornerback",      positions: ["CB"] },
  { label: "Safety",          positions: ["FS", "SS", "S"] },
];

const SPECIAL_TEAMS_POSITIONS = ["K", "P", "KR", "PR", "LS"];

const OFFENSE_POSITIONS_SET = new Set(OFFENSE_GROUPS.flatMap(g => g.positions));
const DEFENSE_POSITIONS_SET = new Set(DEFENSE_GROUPS.flatMap(g => g.positions));

// Madden CFM devTrait: 0=Normal 1=Star 2=Superstar 3/4=X-Factor
function devBadge(trait: number): string {
  if (trait >= 3) return " ⚡";
  if (trait === 2) return " ★★★";
  if (trait === 1) return " ★★";
  return "";
}

function formatPlayerLine(p: {
  firstName: string; lastName: string;
  position: string; overall: number; devTrait: number;
  jerseyNum: number | null; age: number | null;
  contractYearsLeft: number | null;
}): string {
  const num = p.jerseyNum != null ? `#${p.jerseyNum} ` : "";
  const agePart = p.age != null ? ` | Age ${p.age}` : "";
  const contractFlag = p.contractYearsLeft === 1 ? " 📋" : "";
  return `${num}**${p.firstName} ${p.lastName}** (${p.position}) — OVR ${p.overall}${agePart}${devBadge(p.devTrait)}${contractFlag}`;
}

function fieldChunks(label: string, lines: string[]): { name: string; value: string }[] {
  if (lines.length === 0) return [];
  const chunks: { name: string; value: string }[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const addition = (current.length ? 1 : 0) + line.length;
    if (currentLen + addition > 1020 && current.length > 0) {
      chunks.push({ name: chunks.length === 0 ? label : `${label} (cont.)`, value: current.join("\n") });
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += addition;
  }
  if (current.length) {
    chunks.push({ name: chunks.length === 0 ? label : `${label} (cont.)`, value: current.join("\n") });
  }
  return chunks;
}

// ── Command definition ─────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("viewroster")
  .setDescription("View the full roster of any team in the league")
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("Team name (start typing to search)")
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Look up a team by its Discord manager instead")
      .setRequired(false),
  )
  .addBooleanOption(opt =>
    opt.setName("public")
      .setDescription("Post publicly in the channel? (default: only visible to you)")
      .setRequired(false),
  );

// ── Autocomplete — return matching team names from the active season ──────────

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();

  try {
    const [season] = await db.select({ id: seasonsTable.id })
      .from(seasonsTable)
      .where(eq(seasonsTable.isActive, true))
      .limit(1);

    if (!season) { await interaction.respond([]); return; }

    // Distinct team names in this season, ordered alphabetically
    const rows = await db
      .selectDistinct({ teamName: franchiseRostersTable.teamName })
      .from(franchiseRostersTable)
      .where(eq(franchiseRostersTable.seasonId, season.id))
      .orderBy(asc(franchiseRostersTable.teamName));

    const filtered = rows
      .map(r => r.teamName)
      .filter(n => n.toLowerCase().includes(focused))
      .slice(0, 25);

    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  } catch {
    await interaction.respond([]);
  }
}

// ── Command handler ────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const teamInput  = interaction.options.getString("team")?.trim() ?? null;
  const targetUser = interaction.options.getUser("user");
  const isPublic   = interaction.options.getBoolean("public") ?? false;

  if (!teamInput && !targetUser) {
    await interaction.reply({
      content: "❌ Please provide a **team** name or **@user** to look up.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: !isPublic });
  if (!await requireMcaEnabled(interaction)) return;

  // ── Find the active season ─────────────────────────────────────────────────
  const [season] = await db.select()
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found." });
    return;
  }

  // ── Resolve the team name ──────────────────────────────────────────────────
  let resolvedTeamName: string | null = null;
  let ownerMention: string | null = null;

  if (targetUser) {
    // Primary: look up by discordId stored on roster rows (set after MCA import + linkteam)
    const [byDiscord] = await db
      .selectDistinct({ teamName: franchiseRostersTable.teamName })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, season.id),
        eq(franchiseRostersTable.discordId, targetUser.id),
      ))
      .limit(1);

    if (byDiscord) {
      resolvedTeamName = byDiscord.teamName;
      ownerMention = `<@${targetUser.id}>`;
    } else {
      // Fallback: look up via usersTable.team → ilike match against roster teamName
      const [linked] = await db.select({ team: usersTable.team })
        .from(usersTable)
        .where(eq(usersTable.discordId, targetUser.id))
        .limit(1);

      if (!linked?.team) {
        await interaction.editReply({
          content: `❌ <@${targetUser.id}> is not registered or doesn't have a team assigned. Rosters may also not be imported yet.`,
        });
        return;
      }

      const [rosterMatch] = await db
        .selectDistinct({ teamName: franchiseRostersTable.teamName })
        .from(franchiseRostersTable)
        .where(and(
          eq(franchiseRostersTable.seasonId, season.id),
          ilike(franchiseRostersTable.teamName, `%${linked.team}%`),
        ))
        .limit(1);

      if (!rosterMatch) {
        await interaction.editReply({
          content: `❌ No roster found for **${linked.team}** this season. Make sure MCA rosters have been imported and the team name matches.`,
        });
        return;
      }

      resolvedTeamName = rosterMatch.teamName;
      ownerMention = `<@${targetUser.id}>`;
    }
  } else if (teamInput) {
    // Case-insensitive lookup to find the exact stored name
    const [match] = await db
      .selectDistinct({ teamName: franchiseRostersTable.teamName })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, season.id),
        ilike(franchiseRostersTable.teamName, teamInput),
      ))
      .limit(1);

    if (!match) {
      await interaction.editReply({
        content: `❌ No team found matching **${teamInput}** this season. Use the autocomplete list to find the correct name.`,
      });
      return;
    }
    resolvedTeamName = match.teamName;

    // Try to find the manager for this team (may be CPU — no Discord user)
    const rosterSample = await db.select({ discordId: franchiseRostersTable.discordId })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, season.id),
        eq(franchiseRostersTable.teamName, resolvedTeamName),
      ))
      .limit(1);

    const ownerId = rosterSample[0]?.discordId;
    if (ownerId) ownerMention = `<@${ownerId}>`;
  }

  if (!resolvedTeamName) {
    await interaction.editReply({ content: "❌ Could not resolve team." });
    return;
  }

  // ── Fetch the full roster ──────────────────────────────────────────────────
  const players = await db.select()
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId,  season.id),
      eq(franchiseRostersTable.teamName,  resolvedTeamName),
    ))
    .orderBy(sql`overall DESC`);

  if (players.length === 0) {
    await interaction.editReply({
      content: `❌ No roster data found for **${resolvedTeamName}** this season. Roster data is imported when the franchise ZIP is uploaded.`,
    });
    return;
  }

  // ── Organise by position group ─────────────────────────────────────────────
  const byPos = new Map<string, typeof players>();
  for (const p of players) {
    const pos = p.position.toUpperCase();
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos)!.push(p);
  }

  const fields: { name: string; value: string; inline?: boolean }[] = [];

  // Build lines for a position group, sub-grouped by individual position.
  // A bold **POS** label is inserted between sub-groups when the group has
  // multiple distinct positions with players. Within each position, players
  // are sorted by overall descending.
  function buildGroupLines(positions: string[]): string[] {
    const filled = positions.filter(pos => (byPos.get(pos)?.length ?? 0) > 0);
    const showLabel = filled.length > 1;
    const lines: string[] = [];
    for (const pos of positions) {
      const posPlayers = byPos.get(pos) ?? [];
      if (posPlayers.length === 0) continue;
      if (showLabel) lines.push(`**${pos}**`);
      posPlayers
        .slice()
        .sort((a, b) => b.overall - a.overall)
        .forEach(p => lines.push(formatPlayerLine(p)));
    }
    return lines;
  }

  for (const group of OFFENSE_GROUPS) {
    const lines = buildGroupLines(group.positions);
    if (lines.length > 0) fields.push(...fieldChunks(`🏈 ${group.label}`, lines));
  }

  for (const group of DEFENSE_GROUPS) {
    const lines = buildGroupLines(group.positions);
    if (lines.length > 0) fields.push(...fieldChunks(`🛡️ ${group.label}`, lines));
  }

  const stLines = buildGroupLines(SPECIAL_TEAMS_POSITIONS);
  if (stLines.length > 0) fields.push(...fieldChunks("⚡ Special Teams", stLines));

  const unknownPlayers = players.filter(p => {
    const pos = p.position.toUpperCase();
    return !OFFENSE_POSITIONS_SET.has(pos) && !DEFENSE_POSITIONS_SET.has(pos) && !SPECIAL_TEAMS_POSITIONS.includes(pos);
  });
  if (unknownPlayers.length > 0) {
    fields.push(...fieldChunks("📋 Other", unknownPlayers.sort((a, b) => b.overall - a.overall).map(formatPlayerLine)));
  }

  const avgOvr = Math.round(players.reduce((s, p) => s + p.overall, 0) / players.length);
  const managerLine = ownerMention ? `Manager: ${ownerMention} • ` : "CPU Team • ";

  const FIELDS_PER_EMBED = 25;
  const embeds: EmbedBuilder[] = [];
  for (let i = 0; i < fields.length; i += FIELDS_PER_EMBED) {
    const slice = fields.slice(i, i + FIELDS_PER_EMBED);
    const embed = new EmbedBuilder().setColor(Colors.Green).setFields(slice);

    if (i === 0) {
      embed
        .setTitle(`📋 ${resolvedTeamName} Roster`)
        .setDescription(
          `**Season ${season.seasonNumber}** • ${managerLine}${players.length} players • Avg OVR: **${avgOvr}**\n` +
          `⚡ = X-Factor  ★★★ = Superstar  ★★ = Star`,
        );
    } else {
      embed.setTitle(`📋 ${resolvedTeamName} Roster (cont.)`);
    }
    embeds.push(embed);
  }

  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    if (i === 0) {
      await interaction.editReply({ embeds: batch });
    } else {
      await interaction.followUp({ embeds: batch, ephemeral: !isPublic });
    }
  }
}
