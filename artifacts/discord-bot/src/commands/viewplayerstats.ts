/**
 * /viewplayerstats — Browse full player profile for any player on any team.
 * 3-step menu flow: NFC/AFC team → position → player.
 * Shows: bio, archetype, dev trait, abilities (Superstar/X-Factor), XP, season stats,
 *        and a full position-specific attribute breakdown.
 *
 * Merged from the former /viewplayerdetails command (now retired).
 */
import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseMcaTeamsTable, franchiseRostersTable,
  playerSeasonStatsTable, playerXpLogTable, seasonsTable, purchasesTable,
} from "@workspace/db";
import { eq, and, desc, ne } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { requireMcaEnabled } from "../lib/server-settings.js";
import { CORE_ATTRIBUTES } from "../lib/constants.js";

// ── EA portrait CDN ─────────────────────────────────────────────────────────
function portraitUrl(playerId: number): string {
  return `https://madden-assets-cdn.pulse.ea.com/madden26/portraits/64/${playerId}.png`;
}

// ── Dev trait display ────────────────────────────────────────────────────────
function devLabel(trait: number): string {
  if (trait >= 3) return "⚡ X-Factor";
  if (trait === 2) return "★★★ Superstar";
  if (trait === 1) return "★★ Star";
  return "Normal";
}

// ── Archetype display names ──────────────────────────────────────────────────
const ARCHETYPE_NAMES: Record<string, string> = {
  FIELD_GENERAL: "Field General",   STRONG_ARM: "Strong Arm",
  IMPROVISER: "Improviser",         SCRAMBLER: "Scrambler",
  ELUSIVE_BACK: "Elusive Back",     POWER_BACK: "Power Back",
  RECEIVING_BACK: "Receiving Back",
  BLOCKING: "Blocking",             BLOCKING_FB: "Blocking",    BLOCKING_FULLBACK: "Blocking",
  UTILITY: "Utility",               UTILITY_FB: "Utility",      RECEIVING_FB: "Utility",
  DEEP_THREAT: "Deep Threat",       PHYSICAL: "Physical",       PHYSICAL_WR: "Physical",
  SLOT: "Slot",                     SLOT_WR: "Slot",            SLOT_RECEIVER: "Slot",
  PLAYMAKER: "Playmaker",
  VERTICAL_THREAT: "Vertical Threat", VERTICAL_THREAT_TE: "Vertical Threat",
  POSSESSION: "Possession",         POSSESSION_TE: "Possession",
  BLOCKING_TE: "Blocking",
  PASS_PROTECTOR: "Pass Protector", PASS_BLOCKER: "Pass Protector",
  POWER_BLOCKER: "Power",           RUN_BLOCKER: "Power",
  AGILE: "Agile",                   AGILE_OL: "Agile",
  SPEED_RUSHER: "Speed Rusher",     POWER_RUSHER: "Power Rusher",
  RUN_STOPPER: "Run Stopper",
  PASS_COVERAGE: "Pass Coverage",   COVERAGE: "Pass Coverage",  COVERAGE_LB: "Pass Coverage",
  MAN_TO_MAN: "Man to Man",         MAN_COVERAGE: "Man to Man",
  ZONE_CORNER: "Zone",              ZONE_COVERAGE: "Zone",
  SLOT_CORNER: "Slot",              SLOT_CB: "Slot",
  ZONE_SAFETY: "Zone",              ZONE: "Zone",
  HYBRID: "Hybrid",                 HYBRID_SAFETY: "Hybrid",
  RUN_SUPPORT: "Run Support",
  ACCURATE: "Accurate",             ACCURATE_KICKER: "Accurate",  ACCURATE_PUNTER: "Accurate",
  POWER: "Power",                   POWER_KICKER: "Power",        POWER_PUNTER: "Power",
};

function archetypeLabel(abbrev: string | null): string | null {
  if (!abbrev) return null;
  const key = abbrev.trim().toUpperCase();
  if (ARCHETYPE_NAMES[key]) return ARCHETYPE_NAMES[key]!;
  return key.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}

// ── Conference detection ─────────────────────────────────────────────────────
const NFC_FULL  = new Set(["Dallas Cowboys","New York Giants","Philadelphia Eagles","Washington Commanders","Chicago Bears","Detroit Lions","Green Bay Packers","Minnesota Vikings","Atlanta Falcons","Carolina Panthers","New Orleans Saints","Tampa Bay Buccaneers","Arizona Cardinals","Los Angeles Rams","San Francisco 49ers","Seattle Seahawks"]);
const NFC_NICK  = new Set(["Giants","Eagles","Cowboys","Commanders","Bears","Lions","Packers","Vikings","Buccaneers","Falcons","Panthers","Saints","Cardinals","Rams","49ers","Seahawks"]);
function isNfc(conference: string | null, fullName: string, nickName: string): boolean {
  if (conference === "NFC") return true;
  if (conference === "AFC") return false;
  return NFC_FULL.has(fullName) || NFC_NICK.has(nickName);
}

// ── Position ordering ────────────────────────────────────────────────────────
const POSITION_ORDER = ["QB","HB","FB","WR","TE","LT","LG","C","RG","RT","LE","RE","DT","LOLB","MLB","ROLB","CB","FS","SS","K","P"];
function sortPositions(positions: string[]): string[] {
  const known   = POSITION_ORDER.filter(p => positions.includes(p));
  const unknown = positions.filter(p => !POSITION_ORDER.includes(p)).sort();
  return [...known, ...unknown];
}

// ── Attribute rendering ──────────────────────────────────────────────────────
const SHORT: Record<string, string> = {
  speedRating:"SPD", accelRating:"ACC", accelerationRating:"ACC",
  agilityRating:"AGI", changeOfDirectionRating:"COD", strengthRating:"STR",
  awarenessRating:"AWR", awareRating:"AWR", jumpingRating:"JMP", jumpRating:"JMP",
  staminaRating:"STA", toughnessRating:"TGH", toughRating:"TGH", injuryRating:"INJ",
  throwPowerRating:"THP",
  throwAccRating:"TAC",
  throwAccuracyShortRating:"TAS", throwAccShortRating:"TAS",
  throwAccuracyMedRating:"TAM",  throwAccMidRating:"TAM",
  throwAccuracyDeepRating:"TAD", throwAccDeepRating:"TAD",
  throwOnRunRating:"TOR", throwUnderPressureRating:"TUP",
  breakSackRating:"BWS", playActionRating:"PAR",
  carryingRating:"CAR", carryRating:"CAR",
  bCVRating:"BCV", ballCarrierVisionRating:"BCV",
  breakTackleRating:"BTK", truckingRating:"TRK", truckRating:"TRK",
  stiffArmRating:"SAR", spinMoveRating:"SPM", jukeMoveRating:"JKM",
  catchingRating:"CTH", catchRating:"CTH",
  catchInTrafficRating:"CIT", cITRating:"CIT",
  specCatchRating:"SPC",
  shortRouteRunningRating:"SRR", routeRunShortRating:"SRR",
  medRouteRunningRating:"MRR",   routeRunMedRating:"MRR",
  deepRouteRunningRating:"DRR",  routeRunDeepRating:"DRR",
  releaseRating:"REL",
  passBlockRating:"PBK", passBlockPowerRating:"PBP", passBlockFinesseRating:"PBF",
  runBlockRating:"RBK", runBlockPowerRating:"RBP", runBlockFinesseRating:"RBF",
  leadBlockRating:"LBK", impactBlockingRating:"IBK", impactBlockRating:"IBK",
  tacklingRating:"TAK", tackleRating:"TAK",
  hitPowerRating:"HTP", pursuitRating:"PUR",
  blockSheddingRating:"BSH", blockShedRating:"BSH",
  finesseMovesRating:"FNM", powerMovesRating:"PWM",
  playRecognitionRating:"PRC", playRecRating:"PRC",
  manCoverageRating:"MCV", manCoverRating:"MCV",
  zoneCoverageRating:"ZCV", zoneCoverRating:"ZCV",
  pressRating:"PRS",
  kickPowerRating:"KPW", kickAccuracyRating:"KAC", kickAccRating:"KAC",
  kickReturnRating:"KTR", kickRetRating:"KTR",
  longSnapRating:"LNS", confRating:"CNF",
};

type AttrGroup = { label: string; keys: string[] };
const ATH = ["speedRating","accelRating","accelerationRating","agilityRating","changeOfDirectionRating","strengthRating","awarenessRating","awareRating"];
const POSITION_GROUPS: Record<string, AttrGroup[]> = {
  QB:   [{ label:"Athletics",   keys:ATH },{ label:"Passing",     keys:["throwPowerRating","throwAccShortRating","throwAccuracyShortRating","throwAccMidRating","throwAccuracyMedRating","throwAccDeepRating","throwAccuracyDeepRating"] },{ label:"Situational", keys:["throwOnRunRating","throwUnderPressureRating","playActionRating","breakSackRating"] }],
  HB:   [{ label:"Athletics",   keys:ATH },{ label:"Ball Carrier",keys:["carryingRating","carryRating","bCVRating","ballCarrierVisionRating","breakTackleRating","truckingRating","truckRating","stiffArmRating","spinMoveRating","jukeMoveRating"] }],
  FB:   [{ label:"Athletics",   keys:ATH },{ label:"Ball Carrier",keys:["carryingRating","carryRating","breakTackleRating","truckingRating","truckRating","stiffArmRating"] },{ label:"Blocking",    keys:["leadBlockRating","passBlockRating","runBlockRating","impactBlockingRating","impactBlockRating"] }],
  WR:   [{ label:"Athletics",   keys:ATH },{ label:"Receiving",   keys:["catchingRating","catchRating","catchInTrafficRating","cITRating","specCatchRating","releaseRating"] },{ label:"Routes",      keys:["shortRouteRunningRating","routeRunShortRating","medRouteRunningRating","routeRunMedRating","deepRouteRunningRating","routeRunDeepRating"] }],
  TE:   [{ label:"Athletics",   keys:ATH },{ label:"Receiving",   keys:["catchingRating","catchRating","catchInTrafficRating","cITRating","specCatchRating","releaseRating"] },{ label:"Routes",      keys:["shortRouteRunningRating","routeRunShortRating","medRouteRunningRating","routeRunMedRating","deepRouteRunningRating","routeRunDeepRating"] },{ label:"Blocking",    keys:["passBlockRating","runBlockRating","leadBlockRating","impactBlockingRating","impactBlockRating"] }],
  LT:   olGroups(), LG: olGroups(), C: olGroups(), RG: olGroups(), RT: olGroups(),
  LE:   defGroups(), RE: defGroups(), DT: defGroups(),
  MLB:  lbGroups(), LOLB: lbGroups(), ROLB: lbGroups(),
  CB:   dbGroups(), FS: dbGroups(), SS: dbGroups(),
  K:    [{ label:"Kicking",     keys:["kickPowerRating","kickAccuracyRating","kickAccRating"] },{ label:"Athletics",   keys:ATH }],
  P:    [{ label:"Punting",     keys:["kickPowerRating","kickAccuracyRating","kickAccRating"] },{ label:"Athletics",   keys:ATH }],
};
function olGroups(): AttrGroup[]  { return [{ label:"Athletics",     keys:ATH },{ label:"Pass Blocking",keys:["passBlockRating","passBlockPowerRating","passBlockFinesseRating"] },{ label:"Run Blocking", keys:["runBlockRating","runBlockPowerRating","runBlockFinesseRating","leadBlockRating","impactBlockingRating","impactBlockRating"] }]; }
function defGroups(): AttrGroup[] { return [{ label:"Athletics",     keys:ATH },{ label:"Pass Rush",    keys:["finesseMovesRating","powerMovesRating","blockSheddingRating","blockShedRating","hitPowerRating","pursuitRating"] },{ label:"Run Defense",  keys:["tacklingRating","tackleRating","playRecognitionRating","playRecRating"] }]; }
function lbGroups(): AttrGroup[]  { return [{ label:"Athletics",     keys:ATH },{ label:"Defense",      keys:["tacklingRating","tackleRating","hitPowerRating","pursuitRating","blockSheddingRating","blockShedRating"] },{ label:"Coverage",     keys:["manCoverageRating","manCoverRating","zoneCoverageRating","zoneCoverRating","pressRating","playRecognitionRating","playRecRating"] }]; }
function dbGroups(): AttrGroup[]  { return [{ label:"Athletics",     keys:ATH },{ label:"Coverage",     keys:["manCoverageRating","manCoverRating","zoneCoverageRating","zoneCoverRating","pressRating","playRecognitionRating","playRecRating"] },{ label:"Tackling",     keys:["tacklingRating","tackleRating","hitPowerRating","pursuitRating"] }]; }

function renderGroup(attrs: Record<string, unknown>, keys: string[]): string | null {
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
  for (let i = 0; i < pairs.length; i += 4) rows.push(pairs.slice(i, i + 4).join(" | "));
  return rows.join("\n");
}

// ── Command definition ───────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("viewplayerstats")
  .setDescription("Browse full player profile and stats — pick team → position → player");

// ── Step 1: Entry — show NFC/AFC team pickers ───────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!await requireMcaEnabled(interaction)) return;

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  const allTeams = await db
    .select({ teamId: franchiseMcaTeamsTable.teamId, fullName: franchiseMcaTeamsTable.fullName, nickName: franchiseMcaTeamsTable.nickName, conference: franchiseMcaTeamsTable.conference })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id))
    .orderBy(franchiseMcaTeamsTable.fullName);

  if (allTeams.length === 0) {
    await interaction.editReply("No teams found for this season. MCA data hasn't been imported yet.");
    return;
  }

  const nfcTeams = allTeams.filter(t => isNfc(t.conference, t.fullName, t.nickName));
  const afcTeams = allTeams.filter(t => !isNfc(t.conference, t.fullName, t.nickName));
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (nfcTeams.length > 0) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`viewps_team:${season.id}:nfc`)
        .setPlaceholder("🏈 Select NFC Team…")
        .addOptions(nfcTeams.slice(0, 25).map(t =>
          new StringSelectMenuOptionBuilder().setLabel(t.fullName).setValue(String(t.teamId)),
        )),
    ));
  }
  if (afcTeams.length > 0) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`viewps_team:${season.id}:afc`)
        .setPlaceholder("🏈 Select AFC Team…")
        .addOptions(afcTeams.slice(0, 25).map(t =>
          new StringSelectMenuOptionBuilder().setLabel(t.fullName).setValue(String(t.teamId)),
        )),
    ));
  }

  if (rows.length === 0) { await interaction.editReply("No teams available."); return; }
  await interaction.editReply({ content: "**Select a team to browse its players:**", components: rows });
}

// ── Step 2: Team selected → show position dropdown ──────────────────────────

export async function handleTeamSelect(interaction: StringSelectMenuInteraction, seasonId: number) {
  await interaction.deferUpdate();

  const teamId = Number(interaction.values[0]);
  if (isNaN(teamId)) { await interaction.editReply({ content: "Invalid team selection.", components: [] }); return; }

  const posRows = await db
    .selectDistinct({ position: franchiseRostersTable.position })
    .from(franchiseRostersTable)
    .where(and(eq(franchiseRostersTable.seasonId, seasonId), eq(franchiseRostersTable.teamId, teamId)));

  if (posRows.length === 0) {
    await interaction.editReply({ content: "No roster data found for this team.", components: [] });
    return;
  }

  const [teamRow] = await db
    .select({ fullName: franchiseMcaTeamsTable.fullName })
    .from(franchiseMcaTeamsTable)
    .where(and(eq(franchiseMcaTeamsTable.seasonId, seasonId), eq(franchiseMcaTeamsTable.teamId, teamId)))
    .limit(1);
  const teamName = teamRow?.fullName ?? "Team";
  const positions = sortPositions(posRows.map(r => r.position).filter(Boolean) as string[]);

  await interaction.editReply({
    content: `**${teamName}** — select a position:`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`viewps_pos:${seasonId}:${teamId}`)
          .setPlaceholder(`Select a position on the ${teamName}…`)
          .addOptions(positions.slice(0, 25).map(pos =>
            new StringSelectMenuOptionBuilder().setLabel(pos).setValue(pos),
          )),
      ),
    ],
    embeds: [],
  });
}

// ── Step 3: Position selected → show player dropdown ───────────────────────

export async function handlePositionSelect(interaction: StringSelectMenuInteraction, seasonId: number, teamId: number) {
  await interaction.deferUpdate();

  const position = interaction.values[0]!;
  const DEV_LABEL: Record<number, string> = { 0:"Normal", 1:"Star", 2:"Superstar", 3:"X-Factor", 4:"X-Factor" };

  const players = await db
    .select({ playerId: franchiseRostersTable.playerId, firstName: franchiseRostersTable.firstName, lastName: franchiseRostersTable.lastName, position: franchiseRostersTable.position, overall: franchiseRostersTable.overall, devTrait: franchiseRostersTable.devTrait, teamName: franchiseRostersTable.teamName })
    .from(franchiseRostersTable)
    .where(and(eq(franchiseRostersTable.seasonId, seasonId), eq(franchiseRostersTable.teamId, teamId), eq(franchiseRostersTable.position, position)))
    .orderBy(desc(franchiseRostersTable.overall))
    .limit(25);

  if (players.length === 0) {
    await interaction.editReply({ content: `No **${position}** players found on this roster.`, components: [] });
    return;
  }

  const teamName = players[0]!.teamName;
  await interaction.editReply({
    content: `**${teamName} — ${position}s** · Select a player to view their full profile:`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`viewps_player:${seasonId}:${teamId}`)
          .setPlaceholder(`Select a ${teamName} ${position}…`)
          .addOptions(players.map(p => {
            const name  = `${p.firstName} ${p.lastName}`.trim() || "(Unknown)";
            const dev   = p.devTrait >= 2 ? ` · ${DEV_LABEL[p.devTrait] ?? ""}` : "";
            const desc  = `${p.overall} OVR${dev}`;
            return new StringSelectMenuOptionBuilder()
              .setLabel(name.slice(0, 100))
              .setDescription(desc)
              .setValue(String(p.playerId));
          })),
      ),
    ],
    embeds: [],
  });
}

// ── Step 4: Player selected → full profile embed ────────────────────────────

export async function handlePlayerSelect(interaction: StringSelectMenuInteraction, seasonId: number, teamId: number) {
  await interaction.deferUpdate();

  const playerId = Number(interaction.values[0]);
  if (isNaN(playerId)) { await interaction.editReply({ content: "Invalid player selection.", components: [] }); return; }

  const [rosterRows, statRows, xpRows, seasonRow] = await Promise.all([
    db.select().from(franchiseRostersTable)
      .where(and(eq(franchiseRostersTable.seasonId, seasonId), eq(franchiseRostersTable.teamId, teamId), eq(franchiseRostersTable.playerId, playerId)))
      .limit(1),
    db.select().from(playerSeasonStatsTable)
      .where(and(eq(playerSeasonStatsTable.seasonId, seasonId), eq(playerSeasonStatsTable.playerId, playerId)))
      .limit(1),
    db.select({ xpEarned: playerXpLogTable.xpEarned, xpTotal: playerXpLogTable.xpTotal, weekNum: playerXpLogTable.weekNum })
      .from(playerXpLogTable)
      .where(and(eq(playerXpLogTable.seasonId, seasonId), eq(playerXpLogTable.playerId, playerId)))
      .orderBy(desc(playerXpLogTable.loggedAt))
      .limit(1),
    db.select({ seasonNumber: seasonsTable.seasonNumber }).from(seasonsTable).where(eq(seasonsTable.id, seasonId)).limit(1),
  ]);

  // Fetch attribute upgrades used on this player this season (after we have roster data)
  const roster0 = rosterRows[0];
  const attrPurchases = roster0
    ? await db.select({ attributeName: purchasesTable.attributeName })
        .from(purchasesTable)
        .where(and(
          eq(purchasesTable.seasonId, seasonId),
          eq(purchasesTable.playerName, `${roster0.firstName} ${roster0.lastName}`.trim()),
          eq(purchasesTable.playerPosition, roster0.position ?? ""),
          eq(purchasesTable.purchaseType, "attribute"),
          ne(purchasesTable.status, "refunded"),
        ))
    : [];

  const roster   = rosterRows[0];
  const stats    = statRows[0];
  const xpEntry  = xpRows[0];
  const seasonLabel = seasonRow[0]?.seasonNumber ?? seasonId;

  if (!roster) { await interaction.editReply({ content: "Player not found in roster data.", components: [] }); return; }

  const fullName = `${roster.firstName} ${roster.lastName}`.trim() || "(Unknown)";
  const attrs    = (roster.attributes ?? {}) as Record<string, unknown>;
  const abilities = (roster.abilities ?? null) as { zone?: string; superstar?: string[] } | null;

  // ── Bio ───────────────────────────────────────────────────────────────────
  const heightRaw = attrs["height"] ?? attrs["heightInches"];
  const weightRaw = attrs["weight"];
  const heightIn  = heightRaw != null ? Number(heightRaw) : NaN;
  const weightLbs = weightRaw != null ? Number(weightRaw) : NaN;
  const heightStr = !isNaN(heightIn) && heightIn > 0 ? `${Math.floor(heightIn / 12)}'${heightIn % 12}"` : null;
  const weightStr = !isNaN(weightLbs) && weightLbs > 0 ? `${weightLbs} lbs` : null;

  const archName    = archetypeLabel(roster.archetypeAbbrev);
  const isFreeAgent = roster.teamName === "Free Agents";

  const descParts: string[] = [
    devLabel(roster.devTrait),
    archName ? `🎯 ${archName}` : null,
    `${roster.overall} OVR${roster.jerseyNum != null ? ` · #${roster.jerseyNum}` : ""}`,
    roster.age != null ? `Age ${roster.age}` : null,
    heightStr && weightStr ? `${heightStr} · ${weightStr}` : (heightStr ?? weightStr),
    roster.contractYearsLeft != null
      ? (roster.contractYearsLeft === 1 ? "📋 Contract Year" : `📋 ${roster.contractYearsLeft} yrs left`)
      : null,
    roster.discordId ? `Manager: <@${roster.discordId}>` : null,
  ].filter(Boolean) as string[];

  // ── Season stats block ────────────────────────────────────────────────────
  const pos  = roster.position ?? "";
  const isQB = pos === "QB";
  const isK  = pos === "K";
  const isP  = pos === "P";
  const statLines: string[] = [];

  if (stats) {
    if (stats.passYds > 0 || stats.passAtt > 0) {
      const compPct = stats.passAtt > 0 ? ` (${((stats.passComp / stats.passAtt) * 100).toFixed(1)}% comp)` : "";
      const ypa = stats.passAtt > 0 ? ` · ${(stats.passYds / stats.passAtt).toFixed(1)} YPA` : "";
      statLines.push(`🎯 **Passing:** ${stats.passYds.toLocaleString()} yds · ${stats.passTDs} TDs${stats.passInts > 0 ? ` · ${stats.passInts} INT` : ""}\n   ${stats.passComp}/${stats.passAtt}${compPct}${ypa}${stats.timesSacked > 0 ? ` · ${stats.timesSacked} sacked` : ""}`);
    }
    if (stats.rushYds > 0 || stats.rushAtt > 0) {
      const ypc = stats.rushAtt > 0 ? ` · ${(stats.rushYds / stats.rushAtt).toFixed(1)} YPC` : "";
      statLines.push(`${isQB ? "🏃 **QB Rush:**" : "💨 **Rushing:**"} ${stats.rushYds.toLocaleString()} yds · ${stats.rushTDs} TDs\n   ${stats.rushAtt} carries${ypc}${stats.fumbles > 0 ? ` · ${stats.fumbles} fum` : ""}`);
    } else if (isQB && stats.fumbles > 0) {
      statLines.push(`💢 **Fumbles:** ${stats.fumbles}`);
    }
    if (stats.recYds > 0 || stats.recRec > 0) {
      const ypr = stats.recRec > 0 ? ` · ${(stats.recYds / stats.recRec).toFixed(1)} YPR` : "";
      statLines.push(`🙌 **Receiving:** ${stats.recYds.toLocaleString()} yds · ${stats.recTDs} TDs\n   ${stats.recRec} rec${ypr}`);
    }
    if (!isQB && !isK && !isP && stats.fumbles > 0) statLines.push(`💢 **Fumbles:** ${stats.fumbles}`);
    const tackles = stats.totalTackles > 0 ? `${stats.totalTackles} total (${stats.tackleSolo} solo · ${stats.tackleAssist} ast)`
      : stats.tackleSolo + stats.tackleAssist > 0 ? `${stats.tackleSolo} solo · ${stats.tackleAssist} ast` : null;
    if (tackles)                  statLines.push(`🦺 **Tackles:** ${tackles}`);
    if (stats.tacklesForLoss > 0) statLines.push(`🔻 **TFL:** ${stats.tacklesForLoss}`);
    if (stats.sacks > 0)          statLines.push(`💥 **Sacks:** ${stats.sacks}`);
    if (stats.defInts > 0)        statLines.push(`🫳 **INTs:** ${stats.defInts}`);
    if (stats.forcedFumbles > 0)  statLines.push(`🏈 **Forced Fum:** ${stats.forcedFumbles}`);
    if (stats.defFumblesRec > 0)  statLines.push(`🤲 **Fum Rec:** ${stats.defFumblesRec}`);
    if (stats.defTDs > 0)         statLines.push(`🏆 **Def TDs:** ${stats.defTDs}`);
    if (isK && (stats.fgMade > 0 || stats.fgAtt > 0 || stats.xpMade > 0)) {
      const fgPct = stats.fgAtt > 0 ? ` (${((stats.fgMade / stats.fgAtt) * 100).toFixed(1)}%)` : "";
      statLines.push(`🏟️ **Field Goals:** ${stats.fgMade}/${stats.fgAtt}${fgPct}${stats.fgLong > 0 ? ` · Long: ${stats.fgLong}` : ""}`);
      if (stats.xpAtt > 0) statLines.push(`✅ **Extra Points:** ${stats.xpMade}/${stats.xpAtt} (${((stats.xpMade / stats.xpAtt) * 100).toFixed(1)}%)`);
    }
    if (isP && (stats.puntAtt > 0 || stats.puntYds > 0)) {
      const avg = stats.puntAtt > 0 ? ` · Avg: ${(stats.puntYds / stats.puntAtt).toFixed(1)}` : "";
      statLines.push(`👟 **Punting:** ${stats.puntAtt} punts · ${stats.puntYds.toLocaleString()} yds${avg}${stats.puntLong > 0 ? ` · Long: ${stats.puntLong}` : ""}${stats.puntIn20 > 0 ? ` · In-20: ${stats.puntIn20}` : ""}`);
    }
    if (stats.krAtt > 0 || stats.krYds > 0) {
      const krAvg = stats.krAtt > 0 ? ` · ${(stats.krYds / stats.krAtt).toFixed(1)} avg` : "";
      statLines.push(`↩️ **KR:** ${stats.krAtt} att · ${stats.krYds} yds${krAvg}${stats.krTDs > 0 ? ` · ${stats.krTDs} TD` : ""}`);
    }
    if (stats.prAtt > 0 || stats.prYds > 0) {
      const prAvg = stats.prAtt > 0 ? ` · ${(stats.prYds / stats.prAtt).toFixed(1)} avg` : "";
      statLines.push(`↩️ **PR:** ${stats.prAtt} att · ${stats.prYds} yds${prAvg}${stats.prTDs > 0 ? ` · ${stats.prTDs} TD` : ""}`);
    }
  }
  if (statLines.length === 0) statLines.push("*(no stats recorded this season)*");

  // ── Embed ─────────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(isFreeAgent ? 0xf0c040 : Colors.Blue)
    .setTitle(`${roster.jerseyNum != null ? `#${roster.jerseyNum} ` : ""}${fullName} · ${pos} · ${roster.teamName || "Free Agent"}`)
    .setDescription(descParts.join("\n"))
    .setThumbnail(portraitUrl(roster.playerId));

  // Abilities — Superstar/X-Factor only
  if (abilities && (abilities.zone || (abilities.superstar && abilities.superstar.length > 0))) {
    const abilityLines: string[] = [];
    if (abilities.zone)      abilityLines.push(`⚡ **Zone:** ${abilities.zone}`);
    if (abilities.superstar?.length) abilityLines.push(`★ **Abilities:** ${abilities.superstar.join(" · ")}`);
    embed.addFields({ name: "🎮 Superstar Abilities", value: abilityLines.join("\n"), inline: false });
  }

  // Season stats
  embed.addFields({ name: `📊 Season ${seasonLabel} Stats`, value: statLines.join("\n"), inline: false });

  // XP
  const xpTotalLive = roster.xpTotal ?? xpEntry?.xpTotal;
  if (xpTotalLive != null || xpEntry) {
    const xpParts: string[] = [];
    if (xpEntry) xpParts.push(`+${xpEntry.xpEarned.toLocaleString()} XP (Week ${xpEntry.weekNum ?? "?"})`);
    if (xpTotalLive != null) xpParts.push(`**${xpTotalLive.toLocaleString()} total**`);
    embed.addFields({ name: "⚡ Experience", value: xpParts.join(" · "), inline: false });
  }

  // Core attribute upgrades used this season on this player
  const usedCoreAttrs = attrPurchases
    .map(p => p.attributeName)
    .filter((n): n is string => !!n && CORE_ATTRIBUTES.has(n));
  if (usedCoreAttrs.length > 0) {
    embed.addFields({
      name: "⭐ Core Upgrades Used This Season",
      value: usedCoreAttrs.join(", "),
      inline: false,
    });
  }

  // Attribute ratings — position-specific groups
  const groups = POSITION_GROUPS[pos] ?? [{ label: "Athletics", keys: ATH }];
  const coveredKeys = new Set<string>();
  let attrCount = 0;

  for (const group of groups) {
    const val = renderGroup(attrs, group.keys);
    if (!val) continue;
    embed.addFields({ name: `**${group.label}**`, value: val, inline: false });
    group.keys.forEach(k => coveredKeys.add(k));
    attrCount++;
  }

  // Any remaining ratings not covered by position groups
  const remaining = Object.keys(attrs).filter(k => !coveredKeys.has(k) && k.endsWith("Rating") && Number(attrs[k]) > 0 && SHORT[k]);
  if (remaining.length > 0) {
    const val = renderGroup(attrs, remaining);
    if (val) { embed.addFields({ name: "**Other**", value: val, inline: false }); attrCount++; }
  }

  if (attrCount === 0) {
    embed.addFields({ name: "ℹ️ No Attribute Data", value: "Re-export from MCA to populate detailed attributes.", inline: false });
  }

  embed
    .setFooter({ text: `Season ${seasonLabel} · Player ID ${roster.playerId}${roster.archetypeAbbrev ? ` · ${roster.archetypeAbbrev}` : ""}` })
    .setTimestamp();

  await interaction.editReply({ content: null, embeds: [embed], components: [] });
}
