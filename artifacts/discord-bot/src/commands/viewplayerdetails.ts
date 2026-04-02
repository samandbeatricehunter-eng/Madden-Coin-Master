import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseRostersTable, seasonsTable } from "@workspace/db";
import { eq, and, asc, desc, ilike, or } from "drizzle-orm";

// ── Dev trait label ───────────────────────────────────────────────────────────

function devLabel(trait: number): string {
  if (trait >= 3) return "⚡ X-Factor";
  if (trait === 2) return "★★★ Superstar";
  if (trait === 1) return "★★ Star";
  return "Normal";
}

// ── Bio field helpers ─────────────────────────────────────────────────────────

function fmtHeight(raw: unknown): string | null {
  const inches = Number(raw);
  if (!raw || isNaN(inches) || inches <= 0) return null;
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

function fmtWeight(raw: unknown): string | null {
  const lbs = Number(raw);
  if (!raw || isNaN(lbs) || lbs <= 0) return null;
  return `${lbs} lbs`;
}

function fmtHand(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (s === "0" || s === "right" || s === "r") return "Right";
  if (s === "1" || s === "left"  || s === "l") return "Left";
  if (s === "" || s === "null" || s === "undefined") return null;
  return String(raw); // pass through if export uses a different label
}

// ── All attribute label mappings (camelCase key → display name) ───────────────
// Covers every standard Madden CFM *Rating field name variant we know of.

const ATTR_LABELS: Record<string, string> = {
  // ── Athletics (long-form + MCA short-form) ────────────────────────────────
  speedRating:                "Speed",
  accelerationRating:         "Acceleration",
  accelRating:                "Acceleration",
  agilityRating:              "Agility",
  strengthRating:             "Strength",
  awarenessRating:            "Awareness",
  jumpingRating:              "Jumping",
  jumpRating:                 "Jumping",
  staminaRating:              "Stamina",
  toughnessRating:            "Toughness",
  toughRating:                "Toughness",
  injuryRating:               "Injury",
  changeOfDirectionRating:    "Change of Direction",
  // ── Ball Carrier ─────────────────────────────────────────────────────────
  carryingRating:             "Carrying",
  carryRating:                "Carrying",
  ballCarrierVisionRating:    "BC Vision",
  bCVRating:                  "Ball-Carrier Vision",
  breakTackleRating:          "Break Tackle",
  truckingRating:             "Trucking",
  truckRating:                "Trucking",
  stiffArmRating:             "Stiff Arm",
  spinMoveRating:             "Spin Move",
  jukeMoveRating:             "Juke Move",
  // ── Receiving ────────────────────────────────────────────────────────────
  catchingRating:             "Catching",
  catchRating:                "Catching",
  catchInTrafficRating:       "Catch in Traffic",
  cITRating:                  "Catching in Traffic",
  specCatchRating:            "Spectacular Catch",
  shortRouteRunningRating:    "Short Route Running",
  routeRunShortRating:        "Short Route Running",
  medRouteRunningRating:      "Medium Route Running",
  routeRunMedRating:          "Medium Route Running",
  deepRouteRunningRating:     "Deep Route Running",
  routeRunDeepRating:         "Deep Route Running",
  releaseRating:              "Release",
  // ── Passing ──────────────────────────────────────────────────────────────
  throwPowerRating:           "Throwing Power",
  throwAccRating:             "Throw Accuracy",
  throwAccuracyShortRating:   "Throw Accuracy - Short",
  throwAccShortRating:        "Throw Accuracy - Short",
  throwAccuracyMedRating:     "Throw Accuracy - Medium",
  throwAccMidRating:          "Throw Accuracy - Medium",
  throwAccuracyDeepRating:    "Throw Accuracy - Deep",
  throwAccDeepRating:         "Throw Accuracy - Deep",
  throwOnRunRating:           "Throw on the Run",
  throwUnderPressureRating:   "Throw Under Pressure",
  breakSackRating:            "Break Sack",
  playActionRating:           "Play Action",
  // ── Blocking ─────────────────────────────────────────────────────────────
  passBlockRating:            "Pass Blocking",
  passBlockPowerRating:       "Pass Block Power",
  passBlockFinesseRating:     "Pass Block Finesse",
  runBlockRating:             "Run Blocking",
  runBlockPowerRating:        "Run Block Power",
  runBlockFinesseRating:      "Run Block Finesse",
  leadBlockRating:            "Lead Block",
  impactBlockingRating:       "Impact Blocking",
  impactBlockRating:          "Impact Blocking",
  // ── Defense ──────────────────────────────────────────────────────────────
  playRecognitionRating:      "Play Recognition",
  playRecRating:              "Play Recognition",
  tacklingRating:             "Tackling",
  tackleRating:               "Tackling",
  hitPowerRating:             "Hit Power",
  blockSheddingRating:        "Block Shedding",
  blockShedRating:            "Block Shedding",
  finesseMovesRating:         "Finesse Moves",
  powerMovesRating:           "Power Moves",
  pursuitRating:              "Pursuit",
  manCoverageRating:          "Man Coverage",
  manCoverRating:             "Man Coverage",
  zoneCoverageRating:         "Zone Coverage",
  zoneCoverRating:            "Zone Coverage",
  pressRating:                "Press",
  // ── Special Teams ────────────────────────────────────────────────────────
  kickReturnRating:           "Kick/Punt Return",
  kickRetRating:              "Kick Return",
  kickPowerRating:            "Kicking Power",
  kickAccuracyRating:         "Kicking Accuracy",
  kickAccRating:              "Kick Accuracy",
  longSnapRating:             "Long Snap",
  // ── Other (MCA misc fields that land in catch-all) ───────────────────────
  awareRating:                "Awareness",
  confRating:                 "Confidence",
};

// ── Attribute display groups — order matches user's preferred layout ───────────

const ATTR_GROUPS: { emoji: string; label: string; keys: string[] }[] = [
  {
    emoji: "⚡",
    label: "Athletics",
    keys: [
      "speedRating",
      "accelerationRating", "accelRating",
      "agilityRating",
      "strengthRating",
      "jumpingRating", "jumpRating",
      "staminaRating",
      "toughnessRating", "toughRating",
      "injuryRating",
      "changeOfDirectionRating",
    ],
  },
  {
    emoji: "🏃",
    label: "Ball Carrier",
    keys: [
      "carryingRating", "carryRating",
      "ballCarrierVisionRating", "bCVRating",
      "breakTackleRating",
      "truckingRating", "truckRating",
      "stiffArmRating",
      "spinMoveRating",
      "jukeMoveRating",
    ],
  },
  {
    emoji: "🙌",
    label: "Receiving",
    keys: [
      "catchingRating", "catchRating",
      "catchInTrafficRating", "cITRating",
      "specCatchRating",
      "shortRouteRunningRating", "routeRunShortRating",
      "medRouteRunningRating",   "routeRunMedRating",
      "deepRouteRunningRating",  "routeRunDeepRating",
      "releaseRating",
    ],
  },
  {
    emoji: "🏈",
    label: "Passing",
    keys: [
      "throwPowerRating",
      "throwAccRating",
      "throwAccuracyShortRating", "throwAccShortRating",
      "throwAccuracyMedRating",   "throwAccMidRating",
      "throwAccuracyDeepRating",  "throwAccDeepRating",
      "throwOnRunRating",
      "throwUnderPressureRating",
      "breakSackRating",
      "playActionRating",
    ],
  },
  {
    emoji: "🛡️",
    label: "Blocking",
    keys: [
      "passBlockRating", "passBlockPowerRating", "passBlockFinesseRating",
      "runBlockRating",  "runBlockPowerRating",  "runBlockFinesseRating",
      "leadBlockRating",
      "impactBlockingRating", "impactBlockRating",
    ],
  },
  {
    emoji: "🔒",
    label: "Defense",
    keys: [
      "playRecognitionRating", "playRecRating",
      "tacklingRating", "tackleRating",
      "hitPowerRating",
      "blockSheddingRating", "blockShedRating",
      "finesseMovesRating",
      "powerMovesRating",
      "pursuitRating",
      "manCoverageRating", "manCoverRating",
      "zoneCoverageRating", "zoneCoverRating",
      "pressRating",
    ],
  },
  {
    emoji: "🎯",
    label: "Special Teams",
    keys: [
      "kickReturnRating", "kickRetRating",
      "kickPowerRating",
      "kickAccuracyRating", "kickAccRating",
      "longSnapRating",
    ],
  },
];

// All keys covered by the groups above — used by the catch-all below
const GROUPED_KEYS = new Set(ATTR_GROUPS.flatMap(g => g.keys));

// ── Format a set of attribute keys as 3-per-row bold-value lines ─────────────

function formatAttrField(attrs: Record<string, unknown>, keys: string[]): string | null {
  const pairs = keys
    .filter(k => attrs[k] != null && Number(attrs[k]) > 0)
    .map(k => {
      const label = ATTR_LABELS[k] ?? k;
      return `${label}: **${attrs[k]}**`;
    });
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
      const rows = await db
        .selectDistinct({ teamName: franchiseRostersTable.teamName })
        .from(franchiseRostersTable)
        .where(eq(franchiseRostersTable.seasonId, season.id))
        .orderBy(asc(franchiseRostersTable.teamName));

      const names = rows.map(r => r.teamName);
      const sorted = [
        ...names.filter(n => n === "Free Agents"),
        ...names.filter(n => n !== "Free Agents"),
      ];
      const filtered = sorted
        .filter(n => n.toLowerCase().includes(focusedValue))
        .slice(0, 25);
      await interaction.respond(filtered.map(n => ({ name: n, value: n })));
      return;
    }

    if (focused.name === "player") {
      const teamName = interaction.options.getString("team");
      if (!teamName) { await interaction.respond([]); return; }

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

// ── Execute ────────────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const teamName    = interaction.options.getString("team",   true);
  const playerIdStr = interaction.options.getString("player", true);
  const isPublic    = interaction.options.getBoolean("public") ?? false;

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
    await interaction.editReply({ content: "❌ Invalid player selection — please choose from the autocomplete list." });
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
      content: `❌ Player not found on **${teamName}** this season. They may have moved — try selecting the team again.`,
    });
    return;
  }

  const attrs = (player.attributes ?? {}) as Record<string, unknown>;

  // ── Bio fields from stored attributes ─────────────────────────────────────
  const handRaw   = attrs["handedness"] ?? attrs["throwingHand"] ?? attrs["playerHandedness"];
  const heightRaw = attrs["height"]     ?? attrs["heightInches"];
  const weightRaw = attrs["weight"];

  const handStr   = fmtHand(handRaw);
  const heightStr = fmtHeight(heightRaw);
  const weightStr = fmtWeight(weightRaw);

  // ── Header lines ───────────────────────────────────────────────────────────
  const teamStr      = teamName === "Free Agents" ? "🔓 Free Agent" : `🏟️ ${teamName}`;
  const discordStr   = player.discordId ? `\nManager: <@${player.discordId}>` : "";
  const devStr       = devLabel(player.devTrait);
  const jerseyStr    = player.jerseyNum != null ? `#${player.jerseyNum}` : null;
  const contractStr  = player.contractYearsLeft === 1
    ? "📋 Contract Year"
    : player.contractYearsLeft != null
      ? `${player.contractYearsLeft} yrs left`
      : null;

  const bioLine  = [jerseyStr, player.age != null ? `Age ${player.age}` : null, heightStr, weightStr, handStr ? `${handStr}-handed` : null]
    .filter(Boolean).join("  |  ");
  const infoLine = [contractStr].filter(Boolean).join("  |  ");

  const description = [
    `${teamStr}${discordStr}`,
    `Overall: **${player.overall}**  |  Dev: **${devStr}**`,
    bioLine  || null,
    infoLine || null,
  ].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setColor(teamName === "Free Agents" ? Colors.Gold : Colors.Green)
    .setTitle(`${player.firstName} ${player.lastName} — ${player.position}`)
    .setDescription(description)
    .setFooter({ text: `Season ${season.seasonNumber} • Player ID ${player.playerId}` })
    .setTimestamp();

  // ── Attribute groups ───────────────────────────────────────────────────────
  let attrCount = 0;
  const displayedKeys = new Set<string>();

  for (const group of ATTR_GROUPS) {
    const presentKeys = group.keys.filter(k => attrs[k] != null && Number(attrs[k]) > 0);
    if (presentKeys.length === 0) continue;
    const fieldValue = formatAttrField(attrs, presentKeys);
    if (!fieldValue) continue;
    embed.addFields({ name: `${group.emoji} ${group.label}`, value: fieldValue, inline: false });
    presentKeys.forEach(k => displayedKeys.add(k));
    attrCount++;
  }

  // ── Catch-all: any *Rating key in the stored data not covered above ────────
  const remainingKeys = Object.keys(attrs).filter(
    k => !GROUPED_KEYS.has(k) && k.endsWith("Rating") && Number(attrs[k]) > 0,
  );
  if (remainingKeys.length > 0) {
    const fieldValue = formatAttrField(attrs, remainingKeys);
    if (fieldValue) {
      embed.addFields({ name: "📊 Other Attributes", value: fieldValue, inline: false });
      attrCount++;
    }
  }

  if (attrCount === 0) {
    embed.addFields({
      name: "ℹ️ No Attribute Data",
      value: "Detailed attributes aren't available yet. Re-export from MCA to populate them.",
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
