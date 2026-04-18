import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseRostersTable, seasonsTable } from "@workspace/db";
import { eq, and, asc, desc, gte, ilike } from "drizzle-orm";
import { devBadge } from "../lib/dev-trait.js";

// ── Position groups (mirrors viewroster layout) ───────────────────────────────

const ALL_GROUPS: { label: string; positions: string[] }[] = [
  { label: "Quarterback",     positions: ["QB"] },
  { label: "Running Back",    positions: ["HB", "FB"] },
  { label: "Wide Receiver",   positions: ["WR"] },
  { label: "Tight End",       positions: ["TE"] },
  { label: "Offensive Line",  positions: ["LT", "LG", "C", "RG", "RT"] },
  { label: "Defensive Line",  positions: ["LE", "RE", "DT", "DE", "LEDGE", "REDGE"] },
  { label: "MIKE Linebacker", positions: ["MLB", "MIKE"] },
  { label: "SAM Linebacker",  positions: ["LOLB", "SAM"] },
  { label: "WILL Linebacker", positions: ["ROLB", "WILL"] },
  { label: "Cornerback",      positions: ["CB"] },
  { label: "Safety",          positions: ["FS", "SS", "S"] },
  { label: "Special Teams",   positions: ["K", "P", "KR", "PR", "LS"] },
];

const KNOWN_POSITIONS = new Set(ALL_GROUPS.flatMap(g => g.positions));

// ── Shared helpers ────────────────────────────────────────────────────────────


type PlayerRow = {
  firstName: string; lastName: string;
  position: string; overall: number; devTrait: number;
  age: number | null; contractYearsLeft: number | null;
};

function formatLine(p: PlayerRow): string {
  const agePart      = p.age != null ? ` | Age ${p.age}` : "";
  const contractFlag = p.contractYearsLeft === 1 ? " 📋" : "";
  return `**${p.firstName} ${p.lastName}** (${p.position}) — OVR ${p.overall}${agePart}${devBadge(p.devTrait)}${contractFlag}`;
}

// Split lines into ≤1024-char Discord embed field chunks
function fieldChunks(label: string, lines: string[]): { name: string; value: string }[] {
  if (lines.length === 0) return [];
  const chunks: { name: string; value: string }[] = [];
  let current: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > 1020 && current.length > 0) {
      chunks.push({ name: chunks.length === 0 ? label : `${label} (cont.)`, value: current.join("\n") });
      current = [];
      len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length > 0) {
    chunks.push({ name: chunks.length === 0 ? label : `${label} (cont.)`, value: current.join("\n") });
  }
  return chunks;
}

// ── Command definition ─────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("viewfreeagents")
  .setDescription("Browse available free agents from the most recent roster import")
  .addStringOption(opt =>
    opt.setName("position")
      .setDescription("Filter to a specific position (leave blank for all positions grouped)")
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addIntegerOption(opt =>
    opt.setName("min_ovr")
      .setDescription("Only show players at or above this overall rating (default: 0)")
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(99),
  )
  .addBooleanOption(opt =>
    opt.setName("public")
      .setDescription("Post publicly in the channel? (default: only visible to you)")
      .setRequired(false),
  );

// ── Autocomplete ──────────────────────────────────────────────────────────────

export async function autocomplete(interaction: AutocompleteInteraction) {
  try {
    const focused = interaction.options.getFocused().toLowerCase();

    const [season] = await db
      .select({ id: seasonsTable.id })
      .from(seasonsTable)
      .where(and(eq(seasonsTable.isActive, true), eq(seasonsTable.guildId, interaction.guildId!)))
      .limit(1);

    if (!season) { await interaction.respond([]); return; }

    // Distinct positions in the FA pool, sorted by common first (known groups order)
    const rows = await db
      .selectDistinct({ position: franchiseRostersTable.position })
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId,  season.id),
        eq(franchiseRostersTable.teamName,  "Free Agents"),
      ))
      .orderBy(asc(franchiseRostersTable.position));

    // Sort: known positions in group order first, then unknown alphabetically
    const groupOrder = ALL_GROUPS.flatMap(g => g.positions);
    const positions = rows.map(r => r.position);
    const sorted = [
      ...groupOrder.filter(p => positions.includes(p)),
      ...positions.filter(p => !KNOWN_POSITIONS.has(p)).sort(),
    ];

    await interaction.respond(
      sorted
        .filter(p => p.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(p => ({ name: p, value: p })),
    );
  } catch {
    await interaction.respond([]);
  }
}

// ── Execute ────────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const posFilter = interaction.options.getString("position") ?? null;
  const minOvr    = interaction.options.getInteger("min_ovr") ?? 0;
  const isPublic  = interaction.options.getBoolean("public") ?? false;

  await interaction.deferReply({ ephemeral: !isPublic });

  const [season] = await db.select()
    .from(seasonsTable)
    .where(and(eq(seasonsTable.isActive, true), eq(seasonsTable.guildId, interaction.guildId!)))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found." });
    return;
  }

  // ── Fetch free agents ──────────────────────────────────────────────────────
  const conditions = [
    eq(franchiseRostersTable.seasonId, season.id),
    eq(franchiseRostersTable.teamName, "Free Agents"),
  ];
  if (minOvr > 0)    conditions.push(gte(franchiseRostersTable.overall, minOvr));
  if (posFilter)     conditions.push(ilike(franchiseRostersTable.position, posFilter));

  const players = await db
    .select({
      firstName:         franchiseRostersTable.firstName,
      lastName:          franchiseRostersTable.lastName,
      position:          franchiseRostersTable.position,
      overall:           franchiseRostersTable.overall,
      devTrait:          franchiseRostersTable.devTrait,
      age:               franchiseRostersTable.age,
      contractYearsLeft: franchiseRostersTable.contractYearsLeft,
    })
    .from(franchiseRostersTable)
    .where(and(...conditions))
    .orderBy(desc(franchiseRostersTable.overall), asc(franchiseRostersTable.lastName));

  if (players.length === 0) {
    const filterDesc = [
      posFilter ? `position **${posFilter}**` : null,
      minOvr > 0 ? `OVR ≥ ${minOvr}` : null,
    ].filter(Boolean).join(", ");
    await interaction.editReply({
      content: `No free agents found${filterDesc ? ` matching ${filterDesc}` : ""}. The pool updates automatically with each week export — run \`/admin_ea_export week\` or \`/admin_ea_export rosters\` to sync.`,
    });
    return;
  }

  // ── Build embed ────────────────────────────────────────────────────────────
  const titleFilter = [
    posFilter ? posFilter : null,
    minOvr > 0 ? `OVR ${minOvr}+` : null,
  ].filter(Boolean).join(" | ");

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🔓 Free Agent Pool${titleFilter ? ` — ${titleFilter}` : ""}`)
    .setFooter({ text: `Season ${season.seasonNumber} • ${players.length} player${players.length !== 1 ? "s" : ""}${minOvr > 0 ? ` at OVR ${minOvr}+` : ""}` })
    .setTimestamp();

  const fields: { name: string; value: string }[] = [];

  if (posFilter) {
    // ── Single position: flat list sorted by OVR ───────────────────────────
    const lines = players.map(p => formatLine(p));
    fields.push(...fieldChunks(posFilter, lines));
  } else {
    // ── All positions: grouped by position family ──────────────────────────
    for (const group of ALL_GROUPS) {
      const groupPlayers = players.filter(p => group.positions.includes(p.position.toUpperCase()));
      if (groupPlayers.length === 0) continue;
      const lines = groupPlayers.map(p => formatLine(p));
      fields.push(...fieldChunks(group.label, lines));
    }

    // Catch-all for any positions not in the known groups
    const ungrouped = players.filter(p => !KNOWN_POSITIONS.has(p.position.toUpperCase()));
    if (ungrouped.length > 0) {
      fields.push(...fieldChunks("Other", ungrouped.map(p => formatLine(p))));
    }
  }

  // Discord allows max 25 fields per embed — split into multiple embeds if needed
  const MAX_FIELDS = 25;
  const pages: { name: string; value: string }[][] = [];
  for (let i = 0; i < fields.length; i += MAX_FIELDS) {
    pages.push(fields.slice(i, i + MAX_FIELDS));
  }

  if (pages.length === 0) {
    embed.setDescription("No free agents matched your filters.");
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const embeds = pages.map((pageFields, idx) => {
    const e = new EmbedBuilder()
      .setColor(Colors.Gold)
      .addFields(pageFields);
    if (idx === 0) {
      e.setTitle(`🔓 Free Agent Pool${titleFilter ? ` — ${titleFilter}` : ""}`);
    }
    if (idx === pages.length - 1) {
      e.setFooter({ text: `Season ${season.seasonNumber} • ${players.length} player${players.length !== 1 ? "s" : ""}${minOvr > 0 ? ` at OVR ${minOvr}+` : ""}` });
      e.setTimestamp();
    }
    return e;
  });

  // Discord allows max 10 embeds per message
  await interaction.editReply({ embeds: embeds.slice(0, 10) });
}
