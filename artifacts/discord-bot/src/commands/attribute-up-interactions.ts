/**
 * Interactive attribute-upgrade flow (for /purchase attributeUp).
 * Session-based flow: user selects target player → paginated attribute dropdown → cost preview → confirm.
 */
import {
  ChatInputCommandInteraction, ButtonInteraction, StringSelectMenuInteraction,
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseRostersTable, purchasesTable, inventoryTable, seasonStatsTable, usersTable,
} from "@workspace/db";
import { eq, and, sql, ne } from "drizzle-orm";
import {
  getOrCreateUser, getOrCreateActiveSeason, getSeasonStats,
  getCoreAttributes, getSeasonRules, deductBalance, logTransaction,
  getGuildChannel, CHANNEL_KEYS,
} from "../lib/db-helpers.js";
import { ATTRIBUTES } from "../lib/constants.js";
import { errorEmbed, pendingEmbed } from "../lib/embeds.js";
import { getServerSettings } from "../lib/server-settings.js";

// ── Attribute key lookup ───────────────────────────────────────────────────────
// EA franchise data stores attributes as camelCase keys (e.g. "speedRating"),
// but our ATTRIBUTES constant uses display names (e.g. "Speed").
// This map translates display name → all known DB key variants so we can read
// the player's actual current value regardless of which format the roster uses.
const DISPLAY_TO_DB_KEYS: Record<string, string[]> = {
  "Speed":               ["speedRating"],
  "Acceleration":        ["accelerationRating", "accelRating"],
  "Agility":             ["agilityRating"],
  "Strength":            ["strengthRating"],
  "Awareness":           ["awarenessRating", "awareRating"],
  "Carrying":            ["carryingRating", "carryRating"],
  "BC Vision":           ["ballCarrierVisionRating", "bCVRating"],
  "Break Tackle":        ["breakTackleRating"],
  "Trucking":            ["truckingRating", "truckRating"],
  "Stiff Arm":           ["stiffArmRating"],
  "Change of Direction": ["changeOfDirectionRating"],
  "Spin Move":           ["spinMoveRating"],
  "Juke Move":           ["jukeMoveRating"],
  "Catching":            ["catchingRating", "catchRating"],
  "Catch in Traffic":    ["catchInTrafficRating", "cITRating"],
  "Spectacular Catch":   ["specCatchRating"],
  "Short Route Running": ["shortRouteRunningRating", "routeRunShortRating"],
  "Medium Route Running":["medRouteRunningRating",  "routeRunMedRating"],
  "Deep Route Running":  ["deepRouteRunningRating",  "routeRunDeepRating"],
  "Release":             ["releaseRating"],
  "Jumping":             ["jumpingRating", "jumpRating"],
  "Throwing Power":      ["throwPowerRating"],
  "Short Accuracy":      ["throwAccuracyShortRating", "throwAccShortRating"],
  "Medium Accuracy":     ["throwAccuracyMedRating",   "throwAccMidRating"],
  "Deep Accuracy":       ["throwAccuracyDeepRating",  "throwAccDeepRating"],
  "Throw on the Run":    ["throwOnRunRating"],
  "Throw Under Pressure":["throwUnderPressureRating"],
  "Break Sack":          ["breakSackRating"],
  "Play Action":         ["playActionRating"],
  "Pass Blocking":       ["passBlockRating"],
  "Pass Block Power":    ["passBlockPowerRating"],
  "Pass Block Finesse":  ["passBlockFinesseRating"],
  "Run Blocking":        ["runBlockRating"],
  "Run Block Power":     ["runBlockPowerRating"],
  "Run Block Finesse":   ["runBlockFinesseRating"],
  "Lead Block":          ["leadBlockRating"],
  "Impact Blocking":     ["impactBlockingRating", "impactBlockRating"],
  "Play Recognition":    ["playRecognitionRating", "playRecRating"],
  "Tackling":            ["tacklingRating", "tackleRating"],
  "Hit Power":           ["hitPowerRating"],
  "Block Shedding":      ["blockSheddingRating", "blockShedRating"],
  "Finesse Moves":       ["finesseMovesRating"],
  "Power Moves":         ["powerMovesRating"],
  "Pursuit":             ["pursuitRating"],
  "Man Coverage":        ["manCoverageRating", "manCoverRating"],
  "Zone Coverage":       ["zoneCoverageRating", "zoneCoverRating"],
  "Press":               ["pressRating"],
  "Kick/Punt Return":    ["kickReturnRating", "kickRetRating"],
  "Kicking Power":       ["kickPowerRating"],
  "Kicking Accuracy":    ["kickAccuracyRating", "kickAccRating"],
  "Stamina":             ["staminaRating"],
  "Toughness":           ["toughnessRating", "toughRating"],
  "Injury":              ["injuryRating"],
  "Long Snap":           ["longSnapRating"],
};

/**
 * Resolve a display-name attribute (e.g. "Speed") to its current numeric value
 * from a player's attributes JSON, handling both:
 *   - EA franchise keys  (e.g. "speedRating")
 *   - Display-name keys  (e.g. "Speed" — used by custom players)
 * Returns 0 if the key cannot be found.
 */
function lookupAttrValue(attrs: Record<string, unknown>, displayName: string): number {
  // 1. Direct match — custom player data uses display names as keys
  const direct = attrs[displayName];
  if (typeof direct === "number") return direct;

  // 2. Try all known EA key variants for this display name
  const candidates = DISPLAY_TO_DB_KEYS[displayName] ?? [];
  for (const key of candidates) {
    const v = attrs[key];
    if (typeof v === "number") return v;
  }

  return 0;
}

// ── Session store ──────────────────────────────────────────────────────────────
interface AupSession {
  invokerId: string;       // discord ID of user who ran the command
  targetId: string;        // discord ID whose player is being upgraded
  playerName: string;
  playerPosition: string;
  playerId: number;
  attributes: Record<string, number>;  // current in-game attribute values
  page: number;
  selectedAttr?: string;
  currentValue?: number;
  baseCost?: number;
  scaledCost?: number;    // total cost for quantity upgrades
  isCore?: boolean;
  quantity?: number;      // number of points to upgrade (default 1)
  usedCoreAttrs?: Set<string>;    // core attrs already purchased for this player this season
  legacyCoreAttrMode?: boolean;   // when true: multi-point + repeat upgrades on same attr allowed
}

export const aupSessions = new Map<string, AupSession>();

const ATTRS_PER_PAGE = 15;

function sessionKey(invokerId: string, playerId: number) {
  return `${invokerId}:${playerId}`;
}

// ── Cost scaling model ─────────────────────────────────────────────────────────
function scaledCost(base: number, current: number): number | null {
  if (current >= 99) return null;           // can't upgrade at 99
  if (current >= 96) return base * 3;       // 96-98 → 3x
  if (current >= 91) return base * 2;       // 91-95 → 2x
  return base;                              // ≤ 90 → base cost
}

/**
 * Compute the total cost for upgrading `qty` points starting from `current`.
 * Returns null if any point in the range is already at 99 (can't upgrade).
 */
function stackedCost(base: number, current: number, qty: number): { total: number; pointsUpgradeable: number } | null {
  let total = 0;
  let upgradeable = 0;
  for (let i = 0; i < qty; i++) {
    const cost = scaledCost(base, current + i);
    if (cost === null) break;  // hit 99, stop counting
    total += cost;
    upgradeable++;
  }
  if (upgradeable === 0) return null;
  return { total, pointsUpgradeable: upgradeable };
}

// ── Helper: load core attrs already purchased for a player this season ────────
async function loadUsedCoreAttrs(
  seasonId: number,
  playerName: string,
  playerPosition: string,
  coreSet: Set<string>,
): Promise<Set<string>> {
  const rows = await db
    .select({ attributeName: purchasesTable.attributeName })
    .from(purchasesTable)
    .where(and(
      eq(purchasesTable.seasonId, seasonId),
      eq(purchasesTable.playerName, playerName),
      eq(purchasesTable.playerPosition, playerPosition),
      eq(purchasesTable.purchaseType, "attribute"),
      ne(purchasesTable.status, "refunded"),
    ));
  return new Set(
    rows
      .map(r => r.attributeName)
      .filter((n): n is string => n !== null && coreSet.has(n as any)),
  );
}

// ── Build paginated attribute embed ───────────────────────────────────────────
function buildAttrPage(
  session: AupSession,
  rules: { coreAttrCost: number; nonCoreAttrCost: number },
  coreSet: Set<string>,
) {
  const usedCoreAttrs = session.usedCoreAttrs ?? new Set<string>();
  const pageAttrs = ATTRIBUTES.slice(session.page * ATTRS_PER_PAGE, (session.page + 1) * ATTRS_PER_PAGE);
  const totalPages = Math.ceil(ATTRIBUTES.length / ATTRS_PER_PAGE);

  const lines: string[] = [];
  for (const attr of pageAttrs) {
    const current = lookupAttrValue(session.attributes, attr);
    const isCore = coreSet.has(attr as any);
    const base = isCore ? rules.coreAttrCost : rules.nonCoreAttrCost;
    const cost = scaledCost(base, current);
    let label: string;
    if (isCore && usedCoreAttrs.has(attr)) {
      label = `~~**${attr}**~~ ⭐ *(already upgraded this season)*`;
    } else if (cost === null) {
      label = `~~**${attr}**~~ (${current} — maxed out)`;
    } else {
      label = `**${attr}** — ${current} → ${current + 1} (**${cost.toLocaleString()} coins**)${isCore ? " ⭐" : ""}`;
    }
    lines.push(label);
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`⚡ Attribute Upgrade — ${session.playerName} (${session.playerPosition})`)
    .setDescription(
      `Select an attribute to upgrade from the dropdown below.\n\n` +
      lines.join("\n") +
      `\n\n📄 **Page ${session.page + 1} of ${totalPages}**`
    )
    .setFooter({ text: "Scaling cost: ≤90 = 1×, 91–95 = 2×, 96–98 = 3×, 99 = not upgradeable" });

  return embed;
}

function buildAttrDropdown(
  session: AupSession,
  rules: { coreAttrCost: number; nonCoreAttrCost: number },
  sKey: string,
  coreSet: Set<string>,
) {
  const usedCoreAttrs = session.usedCoreAttrs ?? new Set<string>();
  const pageAttrs = ATTRIBUTES.slice(session.page * ATTRS_PER_PAGE, (session.page + 1) * ATTRS_PER_PAGE);

  const options = pageAttrs
    .filter(attr => {
      const cur = lookupAttrValue(session.attributes, attr);
      if (cur >= 99) return false;
      if (coreSet.has(attr as any) && usedCoreAttrs.has(attr)) return false;
      return true;
    })
    .map(attr => {
      const cur = lookupAttrValue(session.attributes, attr);
      const isCore = coreSet.has(attr as any);
      const base = isCore ? rules.coreAttrCost : rules.nonCoreAttrCost;
      const cost = scaledCost(base, cur)!;
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${attr} (${cur} → ${cur + 1})`)
        .setValue(`${attr}`)
        .setDescription(`${cost.toLocaleString()} coins — ${isCore ? "Core ⭐" : "Non-core"}`);
    });

  if (options.length === 0) {
    // All attrs on this page are maxed
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`aup_sel:${sKey}`)
        .setPlaceholder("No upgradeable attributes on this page")
        .setDisabled(true)
        .addOptions(new StringSelectMenuOptionBuilder().setLabel("None").setValue("none"))
    );
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aup_sel:${sKey}`)
      .setPlaceholder("Select an attribute to upgrade…")
      .addOptions(options)
  );
}

function buildNavRow(session: AupSession, sKey: string) {
  const totalPages = Math.ceil(ATTRIBUTES.length / ATTRS_PER_PAGE);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`aup_prev:${sKey}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.page === 0),
    new ButtonBuilder()
      .setCustomId("aup_indicator")
      .setLabel(`${session.page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`aup_next:${sKey}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(session.page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`aup_cancel:${sKey}`)
      .setLabel("✖ Cancel")
      .setStyle(ButtonStyle.Danger),
  );
}

// ── Entry point: start the flow from /purchase attributeUp execute() ──────────
export async function startAttributeUp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings(interaction.guildId!);
  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled." });
    return;
  }
  if (!settings.attributeUpgradesEnabled) {
    await interaction.editReply({ content: "❌ Attribute upgrades are currently disabled." });
    return;
  }

  const targetUser     = interaction.options.getUser("user") ?? interaction.user;
  const playerName     = interaction.options.getString("player", true);
  const position       = interaction.options.getString("position", true);
  const presetAttr     = interaction.options.getString("attribute") ?? null;
  const presetQuantity = interaction.options.getInteger("quantity") ?? 1;

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  // Fetch the player from the franchise roster
  const [playerRow] = await db
    .select()
    .from(franchiseRostersTable)
    .where(
      and(
        eq(franchiseRostersTable.seasonId, season.id),
        eq(franchiseRostersTable.discordId, targetUser.id),
      )
    )
    .then(rows =>
      rows.filter(r =>
        `${r.firstName} ${r.lastName}`.toLowerCase().includes(playerName.toLowerCase()) &&
        r.position.toUpperCase() === position.toUpperCase()
      ).slice(0, 1)
    );

  if (!playerRow || !playerRow.attributes) {
    await interaction.editReply({
      content: `❌ Could not find **${playerName}** (${position}) on <@${targetUser.id}>'s roster. Make sure MCA data has been imported recently.`
    });
    return;
  }

  const attrs = playerRow.attributes as Record<string, number>;
  const rules   = await getSeasonRules(season);
  const coreSet = getCoreAttributes(season);
  const fullPlayerName    = `${playerRow.firstName} ${playerRow.lastName}`;
  const legacyCoreAttrMode = settings.legacyCoreAttrMode;
  const usedCoreAttrs = legacyCoreAttrMode
    ? new Set<string>()
    : await loadUsedCoreAttrs(season.id, fullPlayerName, playerRow.position, coreSet);
  const sKey  = sessionKey(interaction.user.id, playerRow.playerId);
  const session: AupSession = {
    invokerId: interaction.user.id,
    targetId: targetUser.id,
    playerName: fullPlayerName,
    playerPosition: playerRow.position,
    playerId: playerRow.playerId,
    attributes: attrs,
    page: 0,
    usedCoreAttrs,
    legacyCoreAttrMode,
  };
  aupSessions.set(sKey, session);

  // ── Direct path: attribute was specified in the slash command ────────────────
  if (presetAttr) {
    const isCore  = coreSet.has(presetAttr as any);
    const base    = isCore ? rules.coreAttrCost : rules.nonCoreAttrCost;
    const current = lookupAttrValue(attrs, presetAttr);

    // Core attributes: cap to 1 point unless legacy mode allows multi-point
    const effectiveQuantity = (isCore && !legacyCoreAttrMode) ? 1 : presetQuantity;

    // Core attributes: one upgrade per attribute per player per season (strict mode only)
    if (isCore && !legacyCoreAttrMode && usedCoreAttrs.has(presetAttr)) {
      await interaction.editReply({
        content: `❌ **${presetAttr}** has already been upgraded for **${fullPlayerName}** this season. Choose a different core attribute.`,
      });
      aupSessions.delete(sKey);
      return;
    }

    if (current >= 99) {
      await interaction.editReply({ content: `❌ **${presetAttr}** is already at max (99) — cannot upgrade further.` });
      aupSessions.delete(sKey);
      return;
    }

    const result = stackedCost(base, current, effectiveQuantity);
    if (!result) {
      await interaction.editReply({ content: `❌ **${presetAttr}** cannot be upgraded (current value: ${current}).` });
      aupSessions.delete(sKey);
      return;
    }

    const { total, pointsUpgradeable } = result;
    const qty = pointsUpgradeable;  // may be less than requested if 99 cap is hit

    session.selectedAttr = presetAttr;
    session.currentValue = current;
    session.baseCost     = base;
    session.scaledCost   = total;
    session.isCore       = isCore;
    session.quantity     = qty;

    const invoker   = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
    const canAfford = invoker.balance >= total;
    const category  = isCore ? "Core ⭐" : "Non-core";

    // Note if qty was silently capped (core attr in strict mode) or 99-capped (any attr)
    const capNote = (isCore && !legacyCoreAttrMode && presetQuantity > 1)
      ? `\n⭐ Core attributes are limited to **1 point per purchase** — quantity set to 1.`
      : qty < effectiveQuantity
        ? `\n⚠️ Only **${qty}** point(s) upgradeable (would hit 99 at ${current + qty}).`
        : "";

    const embed = new EmbedBuilder()
      .setColor(canAfford ? Colors.Green : Colors.Red)
      .setTitle("⚡ Confirm Attribute Upgrade")
      .setDescription(
        `**Player:** ${session.playerName} (${session.playerPosition})\n` +
        `**Attribute:** ${presetAttr}\n` +
        `**Upgrade:** ${current} → **${current + qty}** (+${qty} point${qty !== 1 ? "s" : ""})\n` +
        `**Category:** ${category}\n` +
        `**Total cost:** ${total.toLocaleString()} coins\n` +
        `**Your balance:** ${invoker.balance.toLocaleString()} coins${capNote}\n\n` +
        (canAfford ? `✅ You can afford this upgrade.` : `❌ You need **${(total - invoker.balance).toLocaleString()}** more coins.`)
      );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`aup_confirm:${sKey}`)
        .setLabel(`✅ Confirm (+${qty} point${qty !== 1 ? "s" : ""})`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canAfford),
      new ButtonBuilder()
        .setCustomId(`aup_cancel:${sKey}`)
        .setLabel("✖ Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  // ── Interactive path: no attribute specified — show paginated browser ─────────
  const embed    = buildAttrPage(session, rules, coreSet);
  const dropdown = buildAttrDropdown(session, rules, sKey, coreSet);
  const navRow   = buildNavRow(session, sKey);

  await interaction.editReply({ embeds: [embed], components: [dropdown, navRow] });
}

// ── Handler: page navigation (prev/next) ──────────────────────────────────────
export async function handleAupPageNav(interaction: ButtonInteraction, direction: "prev" | "next"): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  const session = aupSessions.get(sKey);
  if (!session || session.invokerId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Session expired or not yours. Run `/purchase attributeUp` again.", ephemeral: true });
    return;
  }

  const totalPages = Math.ceil(ATTRIBUTES.length / ATTRS_PER_PAGE);
  session.page = direction === "prev"
    ? Math.max(0, session.page - 1)
    : Math.min(totalPages - 1, session.page + 1);

  const season  = await getOrCreateActiveSeason(interaction.guildId!);
  const rules   = await getSeasonRules(season);
  const coreSet = getCoreAttributes(season);

  await interaction.update({
    embeds: [buildAttrPage(session, rules, coreSet)],
    components: [buildAttrDropdown(session, rules, sKey, coreSet), buildNavRow(session, sKey)],
  });
}

// ── Handler: attribute selected from dropdown ─────────────────────────────────
export async function handleAupSel(interaction: StringSelectMenuInteraction): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  const session = aupSessions.get(sKey);
  if (!session || session.invokerId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Session expired or not yours.", ephemeral: true });
    return;
  }

  const attrName   = interaction.values[0]!;
  const current    = lookupAttrValue(session.attributes, attrName);

  const season     = await getOrCreateActiveSeason(interaction.guildId!);
  const rules      = await getSeasonRules(season);
  const coreSet    = getCoreAttributes(season);
  const isCore     = coreSet.has(attrName as any);
  const base       = isCore ? rules.coreAttrCost : rules.nonCoreAttrCost;
  const cost       = scaledCost(base, current);

  if (cost === null) {
    await interaction.reply({ content: `❌ **${attrName}** is already at max (${current}/99) — cannot upgrade further.`, ephemeral: true });
    return;
  }

  // Core attributes: one upgrade per attribute per player per season
  if (isCore && (session.usedCoreAttrs ?? new Set()).has(attrName)) {
    await interaction.reply({
      content: `❌ **${attrName}** ⭐ has already been upgraded for **${session.playerName}** this season. Choose a different core attribute.`,
      ephemeral: true,
    });
    return;
  }

  session.selectedAttr  = attrName;
  session.currentValue  = current;
  session.baseCost      = base;
  session.scaledCost    = cost;
  session.isCore        = isCore;

  // Show confirmation
  const invoker = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
  const canAfford = invoker.balance >= cost;
  const category  = isCore ? "Core" : "Non-core";

  const embed = new EmbedBuilder()
    .setColor(canAfford ? Colors.Green : Colors.Red)
    .setTitle(`⚡ Confirm Attribute Upgrade`)
    .setDescription(
      `**Player:** ${session.playerName} (${session.playerPosition})\n` +
      `**Attribute:** ${attrName}\n` +
      `**Current value:** ${current} → **${current + 1}**\n` +
      `**Category:** ${category}${isCore ? " ⭐" : ""}\n` +
      `**Cost:** ${cost.toLocaleString()} coins\n` +
      `**Your balance:** ${invoker.balance.toLocaleString()} coins\n\n` +
      (canAfford
        ? `✅ You can afford this upgrade.`
        : `❌ You need **${(cost - invoker.balance).toLocaleString()}** more coins.`)
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`aup_confirm:${sKey}`)
      .setLabel("✅ Confirm Purchase")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canAfford),
    new ButtonBuilder()
      .setCustomId(`aup_back:${sKey}`)
      .setLabel("◀ Back to Attributes")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`aup_cancel:${sKey}`)
      .setLabel("✖ Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

// ── Handler: back to attribute list ──────────────────────────────────────────
export async function handleAupBack(interaction: ButtonInteraction): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  const session = aupSessions.get(sKey);
  if (!session || session.invokerId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Session expired.", ephemeral: true });
    return;
  }
  session.selectedAttr = undefined;
  const season  = await getOrCreateActiveSeason(interaction.guildId!);
  const rules   = await getSeasonRules(season);
  const coreSet = getCoreAttributes(season);
  await interaction.update({
    embeds: [buildAttrPage(session, rules, coreSet)],
    components: [buildAttrDropdown(session, rules, sKey, coreSet), buildNavRow(session, sKey)],
  });
}

// ── Handler: cancel ───────────────────────────────────────────────────────────
export async function handleAupCancel(interaction: ButtonInteraction): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  aupSessions.delete(sKey);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(Colors.Grey).setDescription("✖ Attribute upgrade cancelled.")],
    components: [],
  });
}

// ── Handler: confirm purchase ─────────────────────────────────────────────────
export async function handleAupConfirm(interaction: ButtonInteraction): Promise<void> {
  const sKey = interaction.customId.split(":").slice(1).join(":");
  const session = aupSessions.get(sKey);
  if (!session || session.invokerId !== interaction.user.id) {
    await interaction.reply({ content: "❌ Session expired.", ephemeral: true });
    return;
  }

  if (!session.selectedAttr || session.scaledCost === undefined || session.currentValue === undefined) {
    await interaction.reply({ content: "❌ No attribute selected — please select an attribute first.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  try {
    const season  = await getOrCreateActiveSeason(interaction.guildId!);
    const stats   = await getSeasonStats(interaction.user.id, season.id);
    const rules   = await getSeasonRules(season);
    const user    = await getOrCreateUser(interaction.user.id, interaction.user.username, interaction.guildId!);
    const cost    = session.scaledCost;
    const qty     = session.quantity ?? 1;
    const isCore  = session.isCore ?? false;
    const cap     = isCore ? rules.coreAttrCap     : rules.nonCoreAttrCap;
    const used    = isCore ? stats.coreAttrPurchased : stats.nonCoreAttrPurchased;
    const remaining = cap - used;

    // Re-validate core attribute rules (race-condition / stale session protection)
    // Skip when legacy mode is enabled — multi-point and repeat upgrades are allowed.
    if (!session.legacyCoreAttrMode) {
      if (isCore && qty > 1) {
        await interaction.editReply({
          embeds: [errorEmbed("Core Attribute Limit", "Core attributes ⭐ can only be upgraded **1 point at a time**.")],
          components: [],
        });
        aupSessions.delete(sKey);
        return;
      }

      if (isCore) {
        const coreSet        = getCoreAttributes(season);
        const freshUsedCores = await loadUsedCoreAttrs(season.id, session.playerName, session.playerPosition, coreSet);
        if (freshUsedCores.has(session.selectedAttr)) {
          await interaction.editReply({
            embeds: [errorEmbed("Already Upgraded", `**${session.selectedAttr}** ⭐ has already been upgraded for **${session.playerName}** this season.`)],
            components: [],
          });
          aupSessions.delete(sKey);
          return;
        }
      }
    }

    if (user.balance < cost) {
      await interaction.editReply({
        embeds: [errorEmbed("Insufficient Funds", `You need **${cost.toLocaleString()} coins** but only have **${user.balance.toLocaleString()}**.`)],
        components: [],
      });
      aupSessions.delete(sKey);
      return;
    }

    if (remaining < qty) {
      const category = isCore ? "Core" : "Non-core";
      await interaction.editReply({
        embeds: [errorEmbed(`${category} Attribute Cap Reached`, `You only have **${remaining}** ${category.toLowerCase()} upgrade${remaining !== 1 ? "s" : ""} remaining (cap: ${cap}), but this purchase requires **${qty}**.`)],
        components: [],
      });
      aupSessions.delete(sKey);
      return;
    }

    // Deduct coins
    await deductBalance(interaction.user.id, cost, interaction.guildId!);
    await logTransaction(
      interaction.user.id, -cost, "purchase",
      `Attribute upgrade ×${qty} — ${session.selectedAttr} (${session.isCore ? "Core" : "Non-core"}) for ${session.playerName} (${session.playerPosition})`,
      interaction.guildId!,
    );

    // Update season stats (increment by qty, not just 1)
    await db.update(seasonStatsTable).set({
      coreAttrPurchased: isCore
        ? sql`${seasonStatsTable.coreAttrPurchased} + ${qty}`
        : seasonStatsTable.coreAttrPurchased,
      nonCoreAttrPurchased: !isCore
        ? sql`${seasonStatsTable.nonCoreAttrPurchased} + ${qty}`
        : seasonStatsTable.nonCoreAttrPurchased,
    }).where(and(eq(seasonStatsTable.discordId, interaction.user.id), eq(seasonStatsTable.seasonId, season.id)));

    // Record purchase
    const [purchase] = await db.insert(purchasesTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseType: "attribute",
      status: "pending",
      cost,
      attributeName: session.selectedAttr,
      playerName: session.playerName,
      playerPosition: session.playerPosition,
      notes: [
        qty > 1 ? `qty:${qty}` : null,
        session.targetId !== interaction.user.id ? `for:<@${session.targetId}>` : null,
      ].filter(Boolean).join(";") || null,
    }).returning();

    await db.insert(inventoryTable).values({
      discordId: interaction.user.id,
      seasonId: season.id,
      purchaseId: purchase!.id,
      itemType: "attribute",
      attributeName: session.selectedAttr,
      playerName: session.playerName,
      playerPosition: session.playerPosition,
      notes: [
        qty > 1 ? `qty:${qty}` : null,
        session.targetId !== interaction.user.id ? `for:<@${session.targetId}>` : null,
      ].filter(Boolean).join(";") || null,
    });

    // Commissioner notification
    try {
      const channelId =
        await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.TRANSACTIONS)
        ?? await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER)
        ?? process.env["DISCORD_COMMISSIONER_CHANNEL_ID"]!;
      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const category = isCore ? "Core ⭐" : "Non-core";
        const desc = [
          `**User:** ${interaction.user.toString()} (${interaction.user.username})`,
          session.targetId !== interaction.user.id ? `**Player Owner:** <@${session.targetId}>` : null,
          `**Attribute:** ${session.selectedAttr} (${category})`,
          `**Player:** ${session.playerName} (${session.playerPosition})`,
          `**Upgrade:** ${session.currentValue} → ${session.currentValue + qty} (+${qty} point${qty !== 1 ? "s" : ""})`,
          `**Cost:** ${cost.toLocaleString()} coins total`,
          `**Purchase ID:** #${purchase!.id}`,
          ``,
          `Click the button below once this has been applied in-game.`,
        ].filter(Boolean).join("\n");

        const { EmbedBuilder: EB, ActionRowBuilder: ARB, ButtonBuilder: BB, ButtonStyle: BS, Colors: C } = await import("discord.js");
        const notifEmbed = new EB().setColor(C.Orange).setTitle("⚡ Attribute Upgrade Request").setDescription(desc).setTimestamp();
        const notifRow = new ARB<InstanceType<typeof BB>>().addComponents(
          new BB().setCustomId(`approve_purchase:${purchase!.id}:${interaction.user.id}:attribute`).setLabel("✅ Applied in-game").setStyle(BS.Success),
          new BB().setCustomId(`refund_purchase:${purchase!.id}:${interaction.user.id}:attribute`).setLabel("🔄 Refund").setStyle(BS.Danger),
        );
        await (channel as any).send({ embeds: [notifEmbed], components: [notifRow] });
      }
    } catch (err) {
      console.error("Commissioner notification failed:", err);
    }

    aupSessions.delete(sKey);
    const category = isCore ? "Core ⭐" : "Non-core";
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle("✅ Attribute Upgrade Submitted!")
        .setDescription(
          `**${session.selectedAttr}** (${category}) upgrade for **${session.playerName}** (${session.playerPosition}) submitted!\n\n` +
          `**Upgrade:** ${session.currentValue} → ${session.currentValue + qty} (+${qty} point${qty !== 1 ? "s" : ""})\n` +
          `**Cost:** ${cost.toLocaleString()} coins deducted.\n` +
          `**${isCore ? "Core" : "Non-core"} upgrades used this season:** ${used + qty}/${cap}`
        )
      ],
      components: [],
    });

  } catch (err) {
    console.error("attributeUp confirm error:", err);
    await interaction.editReply({
      embeds: [errorEmbed("Purchase Failed", "An unexpected error occurred. Your coins have not been deducted. Please try again.")],
      components: [],
    });
    aupSessions.delete(sKey);
  }
}
