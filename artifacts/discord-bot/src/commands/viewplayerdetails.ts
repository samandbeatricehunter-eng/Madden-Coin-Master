import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseRostersTable, seasonsTable } from "@workspace/db";
import { eq, and, asc, desc, ilike, or, sql } from "drizzle-orm";

// ── Dev trait labels ──────────────────────────────────────────────────────────

function devLabel(trait: number): string {
  if (trait >= 4) return "⚡ X-Factor";
  if (trait === 3) return "⚡ X-Factor";
  if (trait === 2) return "★★★ Superstar";
  if (trait === 1) return "★★ Star";
  return "Normal";
}

// ── Attribute groups and display labels ──────────────────────────────────────

const ATTR_LABELS: Record<string, string> = {
  speedRating:               "Speed",
  accelerationRating:        "Acceleration",
  agilityRating:             "Agility",
  strengthRating:            "Strength",
  jumpingRating:             "Jumping",
  injuryRating:              "Injury",
  staminaRating:             "Stamina",
  toughnessRating:           "Toughness",
  awarenessRating:           "Awareness",
  throwPowerRating:          "Throw Power",
  throwAccuracyShortRating:  "Short Acc.",
  throwAccuracyMedRating:    "Mid Acc.",
  throwAccuracyDeepRating:   "Deep Acc.",
  throwOnRunRating:          "Throw on Run",
  throwUnderPressureRating:  "Throw Under Pressure",
  breakSackRating:           "Break Sack",
  carryingRating:            "Carrying",
  truckingRating:            "Trucking",
  spinMoveRating:            "Spin Move",
  jukeMoveRating:            "Juke Move",
  stiffArmRating:            "Stiff Arm",
  breakTackleRating:         "Break Tackle",
  ballCarrierVisionRating:   "Ball Carrier Vision",
  changeOfDirectionRating:   "Change of Direction",
  catchingRating:            "Catching",
  specCatchRating:           "Spectacular Catch",
  catchInTrafficRating:      "Catch in Traffic",
  shortRouteRunningRating:   "Short Route",
  medRouteRunningRating:     "Medium Route",
  deepRouteRunningRating:    "Deep Route",
  releaseRating:             "Release",
  runBlockRating:            "Run Block",
  passBlockRating:           "Pass Block",
  runBlockPowerRating:       "Run Block Power",
  runBlockFinesseRating:     "Run Block Finesse",
  passBlockPowerRating:      "Pass Block Power",
  passBlockFinesseRating:    "Pass Block Finesse",
  impactBlockingRating:      "Impact Block",
  leadBlockRating:           "Lead Block",
  tacklingRating:            "Tackling",
  hitPowerRating:            "Hit Power",
  powerMovesRating:          "Power Moves",
  finesseMovesRating:        "Finesse Moves",
  blockSheddingRating:       "Block Shedding",
  pursuitRating:             "Pursuit",
  playRecognitionRating:     "Play Recognition",
  manCoverageRating:         "Man Coverage",
  zoneCoverageRating:        "Zone Coverage",
  pressRating:               "Press",
  kickPowerRating:           "Kick Power",
  kickAccuracyRating:        "Kick Accuracy",
  kickReturnRating:          "Kick Return",
};

const ATTR_GROUPS: { emoji: string; label: string; keys: string[] }[] = [
  {
    emoji: "⚡",
    label: "Physical",
    keys: [
      "speedRating", "accelerationRating", "agilityRating", "strengthRating",
      "jumpingRating", "injuryRating", "staminaRating", "toughnessRating", "awarenessRating",
    ],
  },
  {
    emoji: "🏈",
    label: "Passing",
    keys: [
      "throwPowerRating", "throwAccuracyShortRating", "throwAccuracyMedRating",
      "throwAccuracyDeepRating", "throwOnRunRating", "throwUnderPressureRating", "breakSackRating",
    ],
  },
  {
    emoji: "🏃",
    label: "Ball Carrier",
    keys: [
      "carryingRating", "truckingRating", "spinMoveRating", "jukeMoveRating",
      "stiffArmRating", "breakTackleRating", "ballCarrierVisionRating", "changeOfDirectionRating",
    ],
  },
  {
    emoji: "🙌",
    label: "Receiving",
    keys: [
      "catchingRating", "specCatchRating", "catchInTrafficRating",
      "shortRouteRunningRating", "medRouteRunningRating", "deepRouteRunningRating", "releaseRating",
    ],
  },
  {
    emoji: "🛡️",
    label: "Blocking",
    keys: [
      "runBlockRating", "passBlockRating", "runBlockPowerRating", "runBlockFinesseRating",
      "passBlockPowerRating", "passBlockFinesseRating", "impactBlockingRating", "leadBlockRating",
    ],
  },
  {
    emoji: "🔒",
    label: "Defense",
    keys: [
      "tacklingRating", "hitPowerRating", "powerMovesRating", "finesseMovesRating",
      "blockSheddingRating", "pursuitRating", "playRecognitionRating",
      "manCoverageRating", "zoneCoverageRating", "pressRating",
    ],
  },
  {
    emoji: "🎯",
    label: "Special Teams",
    keys: ["kickPowerRating", "kickAccuracyRating", "kickReturnRating"],
  },
];

// Formats attributes in a group as 3-per-row lines
function formatAttrField(attrs: Record<string, number>, keys: string[]): string | null {
  const pairs = keys
    .filter(k => attrs[k] != null && attrs[k] > 0)
    .map(k => `${ATTR_LABELS[k] ?? k}: **${attrs[k]}**`);
  if (pairs.length === 0) return null;

  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 3) {
    lines.push(pairs.slice(i, i + 3).join("  |  "));
  }
  return lines.join("\n");
}

// ── Command definition ─────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("viewplayerdetails")
  .setDescription("View full attribute breakdown for any player in the league or free agent pool")
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("Select a team or Free Agents")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption(opt =>
    opt.setName("player")
      .setDescription("Select a player from that team (start typing a name to search)")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addBooleanOption(opt =>
    opt.setName("public")
      .setDescription("Post publicly in the channel? (default: only visible to you)")
      .setRequired(false),
  );

// ── Autocomplete ──────────────────────────────────────────────────────────────

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused      = interaction.options.getFocused(true);
  const focusedValue = focused.value.toLowerCase();

  try {
    const [season] = await db.select({ id: seasonsTable.id })
      .from(seasonsTable)
      .where(eq(seasonsTable.isActive, true))
      .limit(1);

    if (!season) { await interaction.respond([]); return; }

    if (focused.name === "team") {
      // Distinct team names + "Free Agents" always at top if it exists
      const rows = await db
        .selectDistinct({ teamName: franchiseRostersTable.teamName })
        .from(franchiseRostersTable)
        .where(eq(franchiseRostersTable.seasonId, season.id))
        .orderBy(asc(franchiseRostersTable.teamName));

      const names = rows.map(r => r.teamName);
      // Bubble "Free Agents" to top of results
      const sorted = [
        ...names.filter(n => n === "Free Agents"),
        ...names.filter(n => n !== "Free Agents"),
      ];
      const filtered = sorted.filter(n => n.toLowerCase().includes(focusedValue)).slice(0, 25);
      await interaction.respond(filtered.map(n => ({ name: n, value: n })));
      return;
    }

    if (focused.name === "player") {
      const teamName = interaction.options.getString("team");
      if (!teamName) { await interaction.respond([]); return; }

      // Search by first OR last name containing the typed text
      const rows = await db.select({
        playerId:  franchiseRostersTable.playerId,
        firstName: franchiseRostersTable.firstName,
        lastName:  franchiseRostersTable.lastName,
        position:  franchiseRostersTable.position,
        overall:   franchiseRostersTable.overall,
      })
        .from(franchiseRostersTable)
        .where(and(
          eq(franchiseRostersTable.seasonId, season.id),
          eq(franchiseRostersTable.teamName, teamName),
          or(
            ilike(franchiseRostersTable.firstName, `%${focusedValue}%`),
            ilike(franchiseRostersTable.lastName,  `%${focusedValue}%`),
          ),
        ))
        .orderBy(desc(franchiseRostersTable.overall))
        .limit(25);

      await interaction.respond(rows.map(p => ({
        name:  `${p.firstName} ${p.lastName} (${p.position}) — OVR ${p.overall}`,
        value: String(p.playerId),
      })));
      return;
    }

    await interaction.respond([]);
  } catch {
    await interaction.respond([]);
  }
}

// ── Command handler ────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const teamName     = interaction.options.getString("team",   true);
  const playerIdStr  = interaction.options.getString("player", true);
  const isPublic     = interaction.options.getBoolean("public") ?? false;

  await interaction.deferReply({ ephemeral: !isPublic });

  const [season] = await db.select()
    .from(seasonsTable)
    .where(eq(seasonsTable.isActive, true))
    .limit(1);

  if (!season) {
    await interaction.editReply({ content: "❌ No active season found." });
    return;
  }

  const playerId = parseInt(playerIdStr, 10);
  if (isNaN(playerId)) {
    await interaction.editReply({ content: "❌ Invalid player selection. Please use the autocomplete list." });
    return;
  }

  const [player] = await db.select()
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, season.id),
      eq(franchiseRostersTable.teamName, teamName),
      eq(franchiseRostersTable.playerId, playerId),
    ))
    .limit(1);

  if (!player) {
    await interaction.editReply({
      content: `❌ Player not found on **${teamName}** this season. They may have been moved — try selecting the team again.`,
    });
    return;
  }

  const attrs = (player.attributes ?? {}) as Record<string, number>;

  // ── Build header description ─────────────────────────────────────────────────
  const devStr         = devLabel(player.devTrait);
  const jerseyStr      = player.jerseyNum != null ? `#${player.jerseyNum}` : "";
  const ageStr         = player.age != null ? `Age ${player.age}` : "";
  const contractStr    = player.contractYearsLeft === 1 ? "📋 Contract Year" : player.contractYearsLeft != null ? `${player.contractYearsLeft} yrs left` : "";
  const discordStr     = player.discordId ? `\nManager: <@${player.discordId}>` : "";
  const teamStr        = teamName === "Free Agents" ? "🔓 Free Agent" : `🏟️ ${teamName}`;

  const headerParts = [jerseyStr, ageStr, contractStr].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(teamName === "Free Agents" ? Colors.Gold : Colors.Green)
    .setTitle(`${player.firstName} ${player.lastName} — ${player.position}`)
    .setDescription(
      `${teamStr}${discordStr}\n` +
      `Overall: **${player.overall}**  |  Dev: **${devStr}**` +
      (headerParts.length ? `\n${headerParts.join("  |  ")}` : ""),
    )
    .setFooter({ text: `Season ${season.seasonNumber} • Player ID ${player.playerId}` })
    .setTimestamp();

  // ── Add attribute group fields (skip groups with no data) ─────────────────────
  let attrCount = 0;
  for (const group of ATTR_GROUPS) {
    const fieldValue = formatAttrField(attrs, group.keys);
    if (!fieldValue) continue;
    embed.addFields({ name: `${group.emoji} ${group.label}`, value: fieldValue, inline: false });
    attrCount++;
  }

  if (attrCount === 0) {
    embed.addFields({
      name: "ℹ️ No Attribute Data",
      value: "Detailed attributes aren't available yet for this player. Re-upload the franchise ZIP to populate them.",
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
