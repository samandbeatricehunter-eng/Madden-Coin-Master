import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, franchiseRostersTable, seasonsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

// ── Position grouping ─────────────────────────────────────────────────────────
const OFFENSE_GROUPS: { label: string; positions: string[] }[] = [
  { label: "Quarterback",   positions: ["QB"] },
  { label: "Running Back",  positions: ["HB", "FB"] },
  { label: "Wide Receiver", positions: ["WR"] },
  { label: "Tight End",     positions: ["TE"] },
  { label: "Offensive Line",positions: ["LT", "LG", "C", "RG", "RT"] },
];

const DEFENSE_GROUPS: { label: string; positions: string[] }[] = [
  { label: "Defensive Line", positions: ["LE", "RE", "DT", "DE", "LEDGE", "REDGE"] },
  { label: "MIKE Linebacker", positions: ["MLB", "MIKE"] },
  { label: "SAM Linebacker",  positions: ["LOLB", "SAM"] },
  { label: "WILL Linebacker", positions: ["ROLB", "WILL"] },
  { label: "Cornerback",      positions: ["CB"] },
  { label: "Safety",          positions: ["FS", "SS", "S"] },
];

const SPECIAL_TEAMS_POSITIONS = ["K", "P", "KR", "PR", "LS"];

const OFFENSE_POSITIONS_SET = new Set(
  OFFENSE_GROUPS.flatMap(g => g.positions),
);
const DEFENSE_POSITIONS_SET = new Set(
  DEFENSE_GROUPS.flatMap(g => g.positions),
);

// Madden CFM devTrait values: 0=Normal 1=Star 2=Superstar 3=X-Factor
function devBadge(trait: number): string {
  switch (trait) {
    case 3: return " ⚡";   // X-Factor
    case 2: return " ★★★";  // Superstar
    case 1: return " ★★";   // Star
    default: return "";      // Normal (0) or unknown
  }
}

function formatPlayerLine(p: {
  firstName: string; lastName: string;
  position: string; overall: number; devTrait: number;
  jerseyNum: number | null; age: number | null;
}): string {
  const num = p.jerseyNum != null ? `#${p.jerseyNum} ` : "";
  const agePart = p.age != null ? ` | Age ${p.age}` : "";
  return `${num}**${p.firstName} ${p.lastName}** (${p.position}) — OVR ${p.overall}${agePart}${devBadge(p.devTrait)}`;
}

// Split long text into ≤1024-char chunks (Discord embed field limit)
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

export const data = new SlashCommandBuilder()
  .setName("myroster")
  .setDescription("View your current team roster with overalls and development traits");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // ── Look up the calling user ───────────────────────────────────────────────
  const [user] = await db.select()
    .from(usersTable)
    .where(eq(usersTable.discordId, interaction.user.id))
    .limit(1);

  if (!user) {
    await interaction.editReply({ content: "❌ You are not registered. Ask a commissioner to register you first." });
    return;
  }
  if (!user.team) {
    await interaction.editReply({ content: "❌ You don't have a team assigned yet. Ask a commissioner to set your team." });
    return;
  }

  // ── Get active season ──────────────────────────────────────────────────────
  const [season] = await db.select()
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found. A commissioner needs to start a season first." });
    return;
  }

  // ── Fetch roster for this user's team in the active season ────────────────
  const players = await db.select()
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId,  season.id),
      eq(franchiseRostersTable.discordId, interaction.user.id),
    ))
    .orderBy(desc(franchiseRostersTable.overall));

  if (players.length === 0) {
    await interaction.editReply({
      content: `❌ No roster data found for **${user.team}** this season. Run \`/franchiseupdate\` with a franchise ZIP that includes \`rosters.json\`.`,
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

  // Offense
  for (const group of OFFENSE_GROUPS) {
    const groupPlayers = group.positions.flatMap(pos => byPos.get(pos) ?? []);
    if (groupPlayers.length === 0) continue;
    const lines = groupPlayers
      .sort((a, b) => b.overall - a.overall)
      .map(formatPlayerLine);
    fields.push(...fieldChunks(`🏈 ${group.label}`, lines));
  }

  // Defense
  for (const group of DEFENSE_GROUPS) {
    const groupPlayers = group.positions.flatMap(pos => byPos.get(pos) ?? []);
    if (groupPlayers.length === 0) continue;
    const lines = groupPlayers
      .sort((a, b) => b.overall - a.overall)
      .map(formatPlayerLine);
    fields.push(...fieldChunks(`🛡️ ${group.label}`, lines));
  }

  // Special Teams
  const stPlayers = SPECIAL_TEAMS_POSITIONS.flatMap(pos => byPos.get(pos) ?? []);
  if (stPlayers.length > 0) {
    const lines = stPlayers.sort((a, b) => b.overall - a.overall).map(formatPlayerLine);
    fields.push(...fieldChunks("⚡ Special Teams", lines));
  }

  // Any position not yet categorised (catch-all)
  const unknownPlayers = players.filter(p => {
    const pos = p.position.toUpperCase();
    return (
      !OFFENSE_POSITIONS_SET.has(pos) &&
      !DEFENSE_POSITIONS_SET.has(pos) &&
      !SPECIAL_TEAMS_POSITIONS.includes(pos)
    );
  });
  if (unknownPlayers.length > 0) {
    const lines = unknownPlayers.sort((a, b) => b.overall - a.overall).map(formatPlayerLine);
    fields.push(...fieldChunks("📋 Other", lines));
  }

  // ── Build average overall for the title ───────────────────────────────────
  const avgOvr = Math.round(players.reduce((s, p) => s + p.overall, 0) / players.length);

  // Discord limits: 25 fields per embed
  const FIELDS_PER_EMBED = 25;
  const embeds: EmbedBuilder[] = [];
  for (let i = 0; i < fields.length; i += FIELDS_PER_EMBED) {
    const slice = fields.slice(i, i + FIELDS_PER_EMBED);
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setFields(slice);

    if (i === 0) {
      embed
        .setTitle(`📋 ${user.team} Roster`)
        .setDescription(
          `**Season ${season.seasonNumber}** • ${players.length} players • Avg OVR: **${avgOvr}**\n` +
          `⚡ = X-Factor  ★★★ = Superstar  ★★ = Star`,
        );
    } else {
      embed.setTitle(`📋 ${user.team} Roster (cont.)`);
    }
    embeds.push(embed);
  }

  // Discord allows up to 10 embeds per message
  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    if (i === 0) {
      await interaction.editReply({ embeds: batch });
    } else {
      await interaction.followUp({ embeds: batch, ephemeral: true });
    }
  }
}
