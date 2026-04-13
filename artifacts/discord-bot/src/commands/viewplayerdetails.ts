import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { franchiseRostersTable, seasonsTable } from "@workspace/db";
import { eq, and, asc, desc, ilike, or } from "drizzle-orm";
import { requireMcaEnabled } from "../lib/server-settings.js";

// ── Portrait URL ───────────────────────────────────────────────────────────────
// EA's Madden 26 player portrait CDN. Discord's proxy fetches these fine even
// though direct server-side requests get 403'd by EA's CDN.
function portraitUrl(playerId: number): string {
  return `https://madden-assets-cdn.pulse.ea.com/madden26/portraits/64/${playerId}.png`;
}

// ── Dev trait label ────────────────────────────────────────────────────────────
function devLabel(trait: number): string {
  if (trait >= 4) return "⚡ X-Factor";
  if (trait === 3) return "⚡ X-Factor";
  if (trait === 2) return "★★★ Superstar";
  if (trait === 1) return "★★ Star";
  return "Normal";
}

// ── Bio helpers ────────────────────────────────────────────────────────────────
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

// ── Short attribute abbreviations (NeonSportz style) ──────────────────────────
const SHORT: Record<string, string> = {
  // Athletics
  speedRating: "SPD", accelRating: "ACC", accelerationRating: "ACC",
  agilityRating: "AGI", changeOfDirectionRating: "COD", strengthRating: "STR",
  awarenessRating: "AWR", awareRating: "AWR", jumpingRating: "JMP", jumpRating: "JMP",
  staminaRating: "STA", toughnessRating: "TGH", toughRating: "TGH", injuryRating: "INJ",
  // Passing
  throwPowerRating: "THP",
  throwAccRating: "TAC",
  throwAccuracyShortRating: "TAS", throwAccShortRating: "TAS",
  throwAccuracyMedRating: "TAM",  throwAccMidRating: "TAM",
  throwAccuracyDeepRating: "TAD", throwAccDeepRating: "TAD",
  throwOnRunRating: "TOR", throwUnderPressureRating: "TUP",
  breakSackRating: "BWS", playActionRating: "PAR",
  // Ball carrier
  carryingRating: "CAR", carryRating: "CAR",
  bCVRating: "BCV", ballCarrierVisionRating: "BCV",
  breakTackleRating: "BTK", truckingRating: "TRK", truckRating: "TRK",
  stiffArmRating: "SAR", spinMoveRating: "SPM", jukeMoveRating: "JKM",
  // Receiving
  catchingRating: "CTH", catchRating: "CTH",
  catchInTrafficRating: "CIT", cITRating: "CIT",
  specCatchRating: "SPC",
  shortRouteRunningRating: "SRR", routeRunShortRating: "SRR",
  medRouteRunningRating: "MRR",  routeRunMedRating: "MRR",
  deepRouteRunningRating: "DRR", routeRunDeepRating: "DRR",
  releaseRating: "REL",
  // Blocking
  passBlockRating: "PBK", passBlockPowerRating: "PBP", passBlockFinesseRating: "PBF",
  runBlockRating: "RBK", runBlockPowerRating: "RBP", runBlockFinesseRating: "RBF",
  leadBlockRating: "LBK", impactBlockingRating: "IBK", impactBlockRating: "IBK",
  // Defense
  tacklingRating: "TAK", tackleRating: "TAK",
  hitPowerRating: "HTP", pursuitRating: "PUR",
  blockSheddingRating: "BSH", blockShedRating: "BSH",
  finesseMovesRating: "FNM", powerMovesRating: "PWM",
  playRecognitionRating: "PRC", playRecRating: "PRC",
  manCoverageRating: "MCV", manCoverRating: "MCV",
  zoneCoverageRating: "ZCV", zoneCoverRating: "ZCV",
  pressRating: "PRS",
  // Special teams
  kickPowerRating: "KPW", kickAccuracyRating: "KAC", kickAccRating: "KAC",
  kickReturnRating: "KTR", kickRetRating: "KTR",
  longSnapRating: "LNS",
  confRating: "CNF",
};

// ── Position-specific key attribute groups ─────────────────────────────────────
type AttrGroup = { label: string; keys: string[] };

const ATH = ["speedRating","accelRating","accelerationRating","agilityRating","changeOfDirectionRating","strengthRating","awarenessRating","awareRating"];

const POSITION_GROUPS: Record<string, AttrGroup[]> = {
  QB: [
    { label: "Athletics",   keys: ATH },
    { label: "Passing",     keys: ["throwPowerRating","throwAccShortRating","throwAccuracyShortRating","throwAccMidRating","throwAccuracyMedRating","throwAccDeepRating","throwAccuracyDeepRating"] },
    { label: "Situational", keys: ["throwOnRunRating","throwUnderPressureRating","playActionRating","breakSackRating"] },
  ],
  HB: [
    { label: "Athletics",    keys: ATH },
    { label: "Ball Carrier", keys: ["carryingRating","carryRating","bCVRating","ballCarrierVisionRating","breakTackleRating","truckingRating","truckRating","stiffArmRating","spinMoveRating","jukeMoveRating"] },
  ],
  FB: [
    { label: "Athletics",    keys: ATH },
    { label: "Ball Carrier", keys: ["carryingRating","carryRating","breakTackleRating","truckingRating","truckRating","stiffArmRating"] },
    { label: "Blocking",     keys: ["leadBlockRating","passBlockRating","runBlockRating","impactBlockingRating","impactBlockRating"] },
  ],
  WR: [
    { label: "Athletics",  keys: ATH },
    { label: "Receiving",  keys: ["catchingRating","catchRating","catchInTrafficRating","cITRating","specCatchRating","releaseRating"] },
    { label: "Routes",     keys: ["shortRouteRunningRating","routeRunShortRating","medRouteRunningRating","routeRunMedRating","deepRouteRunningRating","routeRunDeepRating"] },
  ],
  TE: [
    { label: "Athletics",  keys: ATH },
    { label: "Receiving",  keys: ["catchingRating","catchRating","catchInTrafficRating","cITRating","specCatchRating","releaseRating"] },
    { label: "Routes",     keys: ["shortRouteRunningRating","routeRunShortRating","medRouteRunningRating","routeRunMedRating","deepRouteRunningRating","routeRunDeepRating"] },
    { label: "Blocking",   keys: ["passBlockRating","runBlockRating","leadBlockRating","impactBlockingRating","impactBlockRating"] },
  ],
  LT: olGroups(), LG: olGroups(), C: olGroups(), RG: olGroups(), RT: olGroups(),
  DE: defGroups(), DT: defGroups(),
  MLB: lbGroups(), LOLB: lbGroups(), ROLB: lbGroups(),
  CB: dbGroups(), FS: dbGroups(), SS: dbGroups(),
  K:  [{ label: "Kicking",   keys: ["kickPowerRating","kickAccuracyRating","kickAccRating"] }, { label: "Athletics", keys: ATH }],
  P:  [{ label: "Punting",   keys: ["kickPowerRating","kickAccuracyRating","kickAccRating"] }, { label: "Athletics", keys: ATH }],
};

function olGroups(): AttrGroup[] {
  return [
    { label: "Athletics",     keys: ATH },
    { label: "Pass Blocking", keys: ["passBlockRating","passBlockPowerRating","passBlockFinesseRating"] },
    { label: "Run Blocking",  keys: ["runBlockRating","runBlockPowerRating","runBlockFinesseRating","leadBlockRating","impactBlockingRating","impactBlockRating"] },
  ];
}
function defGroups(): AttrGroup[] {
  return [
    { label: "Athletics",    keys: ATH },
    { label: "Pass Rush",    keys: ["finesseMovesRating","powerMovesRating","blockSheddingRating","blockShedRating","hitPowerRating","pursuitRating"] },
    { label: "Run Defense",  keys: ["tacklingRating","tackleRating","playRecognitionRating","playRecRating"] },
  ];
}
function lbGroups(): AttrGroup[] {
  return [
    { label: "Athletics",  keys: ATH },
    { label: "Defense",    keys: ["tacklingRating","tackleRating","hitPowerRating","pursuitRating","blockSheddingRating","blockShedRating"] },
    { label: "Coverage",   keys: ["manCoverageRating","manCoverRating","zoneCoverageRating","zoneCoverRating","pressRating","playRecognitionRating","playRecRating"] },
  ];
}
function dbGroups(): AttrGroup[] {
  return [
    { label: "Athletics",  keys: ATH },
    { label: "Coverage",   keys: ["manCoverageRating","manCoverRating","zoneCoverageRating","zoneCoverRating","pressRating","playRecognitionRating","playRecRating"] },
    { label: "Tackling",   keys: ["tacklingRating","tackleRating","hitPowerRating","pursuitRating"] },
  ];
}

// ── Render a group of attributes as compact pipe-separated rows (4 per row) ───
function renderGroup(attrs: Record<string, unknown>, keys: string[]): string | null {
  // De-dupe: if two keys map to the same abbreviation, only show the first one with a value
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const k of keys) {
    const abbr = SHORT[k];
    if (!abbr || seen.has(abbr)) continue;
    const val = Number(attrs[k]);
    if (!val || val <= 0) continue;
    seen.add(abbr);
    pairs.push(`${abbr}: ${val}`);
  }
  if (pairs.length === 0) return null;
  const rows: string[] = [];
  for (let i = 0; i < pairs.length; i += 4) {
    rows.push(pairs.slice(i, i + 4).join(" | "));
  }
  return rows.join("\n");
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

// ── Autocomplete ───────────────────────────────────────────────────────────────
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
      await interaction.respond(
        sorted.filter(n => n.toLowerCase().includes(focusedValue)).slice(0, 25)
          .map(n => ({ name: n, value: n })),
      );
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
  if (!await requireMcaEnabled(interaction)) return;

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

  // ── Bio ────────────────────────────────────────────────────────────────────
  const heightRaw = attrs["height"] ?? attrs["heightInches"];
  const weightRaw = attrs["weight"];
  const heightStr = fmtHeight(heightRaw);
  const weightStr = fmtWeight(weightRaw);
  const devStr    = devLabel(player.devTrait);

  const isFreeAgent = teamName === "Free Agents";
  const displayTeam = isFreeAgent ? "FA" : teamName;

  // ── Embed color: gold for free agents, dark teal for active roster ─────────
  const embedColor = isFreeAgent ? 0xf0c040 : 0x1abc9c;

  // ── Header description block ───────────────────────────────────────────────
  // Line 1: player identity card
  const bioLine = [
    player.age     != null ? `AGE: ${player.age}` : null,
    heightStr && weightStr ? `HT/WT: ${heightStr}, ${weightStr}` : (heightStr ?? weightStr),
  ].filter(Boolean).join(" | ");

  const devLine = `${devStr}${player.jerseyNum != null ? `  |  #${player.jerseyNum}` : ""}`;

  const contractLine = player.contractYearsLeft != null
    ? `📋 ${player.contractYearsLeft === 1 ? "**Contract Year**" : `${player.contractYearsLeft} yrs remaining`}`
    : null;

  const managerLine = player.discordId ? `Manager: <@${player.discordId}>` : null;

  const descParts = [devLine, bioLine || null, contractLine, managerLine].filter(Boolean);

  // ── Build embed ────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(`REC League — Players [1 Result]`)
    .setDescription(`**${player.position} ${player.firstName} ${player.lastName} — ${displayTeam} — ${player.overall} OVR**\n\n${descParts.join("\n")}`)
    .setThumbnail(portraitUrl(player.playerId))
    .setFooter({ text: `Season ${season.seasonNumber} • Player ID ${player.playerId}` })
    .setTimestamp();

  // ── Position-specific key attribute groups ─────────────────────────────────
  const groups = POSITION_GROUPS[player.position] ?? [
    { label: "Athletics", keys: ATH },
  ];

  let attrCount = 0;
  const coveredKeys = new Set<string>();

  for (const group of groups) {
    const val = renderGroup(attrs, group.keys);
    if (!val) continue;
    embed.addFields({ name: `**${group.label}**`, value: val, inline: false });
    group.keys.forEach(k => coveredKeys.add(k));
    attrCount++;
  }

  // ── Catch-all: any *Rating not covered by the position groups ──────────────
  const remaining = Object.keys(attrs).filter(
    k => !coveredKeys.has(k) && k.endsWith("Rating") && Number(attrs[k]) > 0 && SHORT[k],
  );
  if (remaining.length > 0) {
    const val = renderGroup(attrs, remaining);
    if (val) {
      embed.addFields({ name: "**Other**", value: val, inline: false });
      attrCount++;
    }
  }

  if (attrCount === 0) {
    embed.addFields({
      name: "ℹ️ No Attribute Data",
      value: "Re-export from MCA to populate detailed attributes.",
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
