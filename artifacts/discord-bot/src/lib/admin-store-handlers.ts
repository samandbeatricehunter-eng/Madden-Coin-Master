/**
 * admin-store-handlers.ts
 * All interaction handlers for /admin-store-settings
 * Button prefix: ss_   Select prefix: ss_   Modal prefix: ss_modal_
 */

import {
  ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction,
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import {
  customArchetypesTable, legendsTable, legendTemplatesTable,
  seasonsTable, serverSettingsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason, getSeasonRules } from "./db-helpers.js";
import { getServerSettings } from "./server-settings.js";
import { ALL_POSITIONS } from "./custom-player-helpers.js";

// ── Types & Session ────────────────────────────────────────────────────────────

interface ArchSession {
  flow: "arch";
  guildId: string;
  position: string;
  archIdx: number;
  archetypes: Array<{ id: number; name: string; attributes: Record<string, number> }>;
  editGroupIdx: number | null;
  expiresAt: number;
}

interface LtSession {
  flow: "lt";
  guildId: string;
  position: string;
  legendId: number | null;
  legendName: string;
  model: string | null;
  template: Record<string, number> | null;
  editGroupIdx: number | null;
  expiresAt: number;
}

type SsSession = ArchSession | LtSession;

const SESSION_TTL = 15 * 60 * 1000;
const sessions = new Map<string, SsSession>();

function sessionKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

function getSession(guildId: string, userId: string): SsSession | null {
  const key = sessionKey(guildId, userId);
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(key); return null; }
  return s;
}

function setSession(guildId: string, userId: string, data: Omit<SsSession, "expiresAt">) {
  sessions.set(sessionKey(guildId, userId), { ...data, expiresAt: Date.now() + SESSION_TTL } as SsSession);
}

function clearSession(guildId: string, userId: string) {
  sessions.delete(sessionKey(guildId, userId));
}


// ── Constants ─────────────────────────────────────────────────────────────────

const EDIT_GROUPS: Array<{ label: string; attrs: string[] }> = [
  { label: "🏃 Athletic — Speed & Mobility",  attrs: ["Speed","Acceleration","Agility","ChangeOfDirection","Jumping"] },
  { label: "💪 Athletic — Endurance",          attrs: ["Strength","Stamina","Toughness","Injury"] },
  { label: "🏈 Ball Carrier — Rushing",        attrs: ["Carrying","BCVision","BreakTackle","Trucking","StiffArm"] },
  { label: "🔄 Ball Carrier — Evasion",        attrs: ["SpinMove","JukeMove","Awareness"] },
  { label: "🙌 Receiving — Routes",            attrs: ["Catching","CatchInTraffic","SpectacularCatch","ShortRouteRunning","MedRouteRunning"] },
  { label: "🚀 Receiving — Deep & Release",    attrs: ["DeepRouteRunning","Release"] },
  { label: "🎯 Passing — Arm",                 attrs: ["ThrowingPower","ShortAccuracy","MedAccuracy","DeepAccuracy","ThrowOnRun"] },
  { label: "🧠 Passing — Pocket",              attrs: ["ThrowUnderPressure","BreakSack","PlayAction"] },
  { label: "🛡️ Blocking — Pass",               attrs: ["PassBlocking","PassBlockPower","PassBlockFinesse","RunBlocking","RunBlockPower"] },
  { label: "💥 Blocking — Run",                attrs: ["RunBlockFinesse","LeadBlock","ImpactBlocking"] },
  { label: "🔰 Defense — Pressure",            attrs: ["PlayRecognition","Tackling","HitPower","BlockShedding","FinesseMoves"] },
  { label: "🎪 Defense — Coverage",            attrs: ["PowerMoves","Pursuit","ManCoverage","ZoneCoverage","Press"] },
  { label: "🦵 Special Teams",                 attrs: ["KickReturn","KickingPower","KickingAccuracy","LongSnap"] },
];

const MODEL_OPTIONS = [
  { label: "📊 Realistic Rookie",  value: "realistic_rookie", description: "Base realistic ratings for a rookie version" },
  { label: "⭐ 88 OVR SuperStar",  value: "88_ovr",           description: "Attribute template for an 88 OVR SuperStar" },
  { label: "🌟 99 OVR SuperStar",  value: "99_ovr",           description: "Attribute template for a 99 OVR SuperStar" },
];

const MODEL_LABEL: Record<string, string> = {
  realistic_rookie: "📊 Realistic Rookie",
  "88_ovr":         "⭐ 88 OVR SuperStar",
  "99_ovr":         "🌟 99 OVR SuperStar",
};

// ── Admin check ───────────────────────────────────────────────────────────────

async function checkAdmin(guildId: string, userId: string, interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(userId)
    ?? await interaction.guild?.members.fetch(userId).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin = await isAdminUser(userId, guildId);
  return isDiscordAdmin || isDbAdmin;
}

// ── Hub ────────────────────────────────────────────────────────────────────────

function buildHubEmbed() {
  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏪 Store & Purchase Settings")
    .setDescription(
      "Select a category to view and edit:\n\n" +
      "📋 **Archetypes** — Browse and edit custom player archetype attributes\n" +
      "⭐ **Legend Templates** — Set base attribute templates for each legend model"
    )
    .setFooter({ text: "Changes take effect immediately" });
}

function buildHubComponents() {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_arch").setLabel("📋 Archetypes").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ss_lt").setLabel("⭐ Legend Templates").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

// ── Helpers: Archetype Flow ────────────────────────────────────────────────────

function buildAttrViewFields(attrs: Record<string, number>) {
  const fields: { name: string; value: string; inline: boolean }[] = [];
  const seen = new Set<string>();
  const ATTR_GROUPS: Record<string, string[]> = {
    "🏃 Athletic":      ["Speed","Acceleration","Agility","ChangeOfDirection","Jumping","Strength","Stamina","Toughness","Injury"],
    "🏈 Ball Carrier":  ["Carrying","BCVision","BreakTackle","Trucking","StiffArm","SpinMove","JukeMove","Awareness"],
    "🙌 Receiving":     ["Catching","CatchInTraffic","SpectacularCatch","ShortRouteRunning","MedRouteRunning","DeepRouteRunning","Release"],
    "🎯 Passing":       ["ThrowingPower","ShortAccuracy","MedAccuracy","DeepAccuracy","ThrowOnRun","ThrowUnderPressure","BreakSack","PlayAction"],
    "🛡️ Blocking":      ["PassBlocking","PassBlockPower","PassBlockFinesse","RunBlocking","RunBlockPower","RunBlockFinesse","LeadBlock","ImpactBlocking"],
    "🔰 Defense":       ["PlayRecognition","Tackling","HitPower","BlockShedding","FinesseMoves","PowerMoves","Pursuit","ManCoverage","ZoneCoverage","Press"],
    "🦵 Special Teams": ["KickReturn","KickingPower","KickingAccuracy","LongSnap"],
  };
  for (const [groupName, attrNames] of Object.entries(ATTR_GROUPS)) {
    const lines: string[] = [];
    for (const a of attrNames) {
      if (a in attrs) { lines.push(`**${a}:** ${attrs[a]}`); seen.add(a); }
    }
    if (lines.length) fields.push({ name: groupName, value: lines.join("  ·  "), inline: false });
  }
  const extras = Object.entries(attrs).filter(([k]) => !seen.has(k));
  if (extras.length) fields.push({ name: "Other", value: extras.map(([k,v]) => `**${k}:** ${v}`).join("  ·  "), inline: false });
  return fields;
}

function buildArchEmbed(session: ArchSession): EmbedBuilder {
  const arch = session.archetypes[session.archIdx]!;
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`📋 ${session.position} · ${arch.name}  (${session.archIdx + 1} / ${session.archetypes.length})`)
    .setDescription("All attribute ratings for this archetype. Click **Edit Attributes** to modify a group.");
  const fields = buildAttrViewFields(arch.attributes);
  embed.addFields(fields);
  return embed;
}

function buildArchComponents(session: ArchSession) {
  const total = session.archetypes.length;
  const idx = session.archIdx;

  const posSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ss_arch_pos")
      .setPlaceholder(`Position: ${session.position}`)
      .addOptions(
        ALL_POSITIONS.map(p =>
          new StringSelectMenuOptionBuilder().setLabel(p).setValue(p).setDefault(p === session.position)
        )
      )
  );

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_arch_prev").setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(idx <= 0),
    new ButtonBuilder().setCustomId("ss_arch_indicator").setLabel(`${idx + 1} / ${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId("ss_arch_next").setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(idx >= total - 1),
    new ButtonBuilder().setCustomId("ss_arch_edit").setLabel("✏️ Edit Attributes").setStyle(ButtonStyle.Primary),
  );

  const bottomRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_cancel").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
  );

  return [posSelect, navRow, bottomRow];
}

function buildArchGroupSelectComponents(session: ArchSession) {
  const arch = session.archetypes[session.archIdx]!;
  const relevant = EDIT_GROUPS.filter(g => g.attrs.some(a => a in arch.attributes));

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ss_arch_edit_group")
      .setPlaceholder("Select an attribute group to edit…")
      .addOptions(
        relevant.map((g, i) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(g.label.replace(/\S+\s/, "")) // strip emoji for label
            .setEmoji(g.label.split(" ")[0]!)
            .setValue(String(EDIT_GROUPS.indexOf(g)))
        )
      )
  );

  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_arch_back_to_view").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  return [selectRow, backRow];
}

// ── Helpers: Legend Template Flow ─────────────────────────────────────────────

function buildLtEmbed(session: LtSession): EmbedBuilder {
  if (!session.legendId || !session.model) {
    return new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle("⭐ Legend Templates")
      .setDescription("Select a position to get started.");
  }
  if (!session.template) {
    return new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle(`⭐ ${session.legendName} — ${MODEL_LABEL[session.model] ?? session.model}`)
      .setDescription("⚠️ **No template set for this model yet.**\nClick **Create Template** to set base attributes.");
  }
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`⭐ ${session.legendName} — ${MODEL_LABEL[session.model] ?? session.model}`)
    .setDescription("Base attribute template for this legend model. Click **Edit Attributes** to modify a group.");
  embed.addFields(buildAttrViewFields(session.template));
  return embed;
}

function buildLtPosSelectComponents() {
  const posSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ss_lt_pos")
      .setPlaceholder("Select a position…")
      .addOptions(
        ALL_POSITIONS.map(p =>
          new StringSelectMenuOptionBuilder().setLabel(p).setValue(p)
        )
      )
  );
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_cancel").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
  );
  return [posSelect, backRow];
}

function buildLtLegendSelectComponents(legends: Array<{ id: number; name: string }>, session: LtSession) {
  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ss_lt_legend")
      .setPlaceholder(`Pick a legend for position ${session.position}…`)
      .addOptions(
        legends.map(l =>
          new StringSelectMenuOptionBuilder().setLabel(l.name).setValue(String(l.id))
        )
      )
  );
  const posSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ss_lt_pos")
      .setPlaceholder(`Position: ${session.position}`)
      .addOptions(
        ALL_POSITIONS.map(p =>
          new StringSelectMenuOptionBuilder().setLabel(p).setValue(p).setDefault(p === session.position)
        )
      )
  );
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_cancel").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
  );
  return [selectRow, posSelect, backRow];
}

function buildLtModelSelectComponents(session: LtSession) {
  const modelSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ss_lt_model")
      .setPlaceholder(`Select model for ${session.legendName}…`)
      .addOptions(
        MODEL_OPTIONS.map(m =>
          new StringSelectMenuOptionBuilder()
            .setLabel(m.label.replace(/\S+\s/, ""))
            .setDescription(m.description)
            .setEmoji(m.label.split(" ")[0]!)
            .setValue(m.value)
        )
      )
  );
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_lt_back_to_pos").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
  return [modelSelect, backRow];
}

function buildLtViewComponents(session: LtSession) {
  const hasTemplate = session.template !== null;
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(hasTemplate
      ? [new ButtonBuilder().setCustomId("ss_lt_edit").setLabel("✏️ Edit Attributes").setStyle(ButtonStyle.Primary)]
      : [new ButtonBuilder().setCustomId("ss_lt_create").setLabel("➕ Create Template").setStyle(ButtonStyle.Success)]
    ),
    new ButtonBuilder().setCustomId("ss_lt_back_to_model").setLabel("← Change Model").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ss_cancel").setLabel("🏪 Hub").setStyle(ButtonStyle.Secondary),
  );
  return [btnRow];
}

function buildLtGroupSelectComponents(session: LtSession) {
  const attrs = session.template ?? {};
  const relevant = EDIT_GROUPS.filter(g => g.attrs.some(a => a in attrs));
  const options = (relevant.length ? relevant : EDIT_GROUPS).map(g =>
    new StringSelectMenuOptionBuilder()
      .setLabel(g.label.replace(/\S+\s/, ""))
      .setEmoji(g.label.split(" ")[0]!)
      .setValue(String(EDIT_GROUPS.indexOf(g)))
  );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ss_lt_edit_group")
      .setPlaceholder("Select an attribute group to edit…")
      .addOptions(options)
  );
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_lt_back_to_view").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );
  return [selectRow, backRow];
}

// ── Helpers: Prices & Caps ─────────────────────────────────────────────────────

async function buildPcEmbed(guildId: string): Promise<EmbedBuilder> {
  const { COSTS, LIMITS } = await import("./constants.js");
  const season = await getOrCreateActiveSeason(guildId);
  const rules = await getSeasonRules(season);
  const settings = await getServerSettings(guildId);

  const allTimeLegend = LIMITS.legendsPerTeam;
  const legendsPerSeason = season.legendsPerSeasonCapOverride ?? 2;
  const customPerSeason  = season.customPlayersPerSeasonCapOverride ?? "—";
  const salaryCareer = settings.salaryReductionCareerCap ?? "—";
  const bonusCareer  = settings.bonusReductionCareerCap  ?? "—";

  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("💰 Prices & Caps — Current Settings")
    .setDescription(`Season #${season.seasonNumber} overrides. Blank = using global defaults.`)
    .addFields(
      {
        name: "Prices",
        value: [
          `**Legend:** ${rules.legendCost} coins`,
          `**Custom Gold:** ${rules.customGoldCost} coins`,
          `**Custom Silver:** ${rules.customSilverCost} coins`,
          `**Custom Bronze:** ${rules.customBronzeCost} coins`,
          `**Dev Up:** ${rules.devUpsCost} coins`,
          `**Age Reset:** ${rules.ageResetCost} coins`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Per-Season Caps",
        value: [
          `**Legends/Season:** ${legendsPerSeason}`,
          `**Custom Players/Season:** ${customPerSeason}`,
          `**Dev Ups/Season:** ${rules.devUpsCap}`,
          `**Age Resets/Season:** ${rules.ageResetsCap}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "All-Time & Global Caps",
        value: `**Legends (All-Time):** ${allTimeLegend}`,
        inline: false,
      },
      {
        name: "📋 Contract & Roster Mod Prices",
        value: [
          `**Contract Extension (1YR):** ${rules.contractExtensionCost} coins`,
          `**Salary Reduction:** ${rules.salaryReductionCost} coins`,
          `**Bonus Reduction:** ${rules.bonusReductionCost} coins`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "📋 Contract & Roster Mod Caps",
        value: [
          `**Contract Ext/Season:** ${rules.contractExtensionCap}`,
          `**Salary Red/Season:** ${rules.salaryReductionCap}`,
          `**Salary Red Career (per player):** ${salaryCareer}`,
          `**Bonus Red/Season:** ${rules.bonusReductionCap}`,
          `**Bonus Red Career (per player):** ${bonusCareer}`,
        ].join("\n"),
        inline: true,
      },
    )
    .setFooter({ text: "Click a button below to edit a category" });
}

function buildPcComponents() {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_pc_legend_prices").setLabel("⭐ Legend & Custom Prices").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ss_pc_upgrade_prices").setLabel("📈 Upgrade Prices").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ss_pc_contract_prices").setLabel("📋 Contract & Roster Prices").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_pc_season_caps").setLabel("📅 Per-Season Caps").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ss_pc_alltime_caps").setLabel("🏆 All-Time Caps").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ss_pc_contract_caps").setLabel("📋 Contract & Roster Caps").setStyle(ButtonStyle.Success),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_cancel").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ss_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2, row3];
}

// ── Handler: Common ────────────────────────────────────────────────────────────

export async function handleSsClose(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  clearSession(interaction.guildId!, interaction.user.id);
  await interaction.deleteReply().catch(() => null);
}

export async function handleSsCancel(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  clearSession(interaction.guildId!, interaction.user.id);
  await interaction.editReply({ embeds: [buildHubEmbed()], components: buildHubComponents() });
}

// ── Handler: Archetype Flow ────────────────────────────────────────────────────

export async function handleSsArch(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  if (!await checkAdmin(interaction.guildId!, interaction.user.id, interaction)) {
    await interaction.followUp({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("📋 Archetypes — Select Position")
    .setDescription("Pick a position to browse and edit its archetypes.");

  const posSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ss_arch_pos")
      .setPlaceholder("Select a position…")
      .addOptions(ALL_POSITIONS.map(p => new StringSelectMenuOptionBuilder().setLabel(p).setValue(p)))
  );
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ss_cancel").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ss_close").setLabel("✖ Close").setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [posSelect, backRow] });
}

export async function handleSsArchPos(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const position = interaction.values[0]!;

  const rows = await db.select()
    .from(customArchetypesTable)
    .where(and(eq(customArchetypesTable.guildId, guildId), eq(customArchetypesTable.position, position)));

  if (!rows.length) {
    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle(`📋 ${position} — No Archetypes Found`)
      .setDescription("No archetypes have been seeded for this position yet.\nRun `/admin-customarchetypes seed-defaults` to add them.");
    const posSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ss_arch_pos")
        .setPlaceholder(`Position: ${position}`)
        .addOptions(ALL_POSITIONS.map(p => new StringSelectMenuOptionBuilder().setLabel(p).setValue(p).setDefault(p === position)))
    );
    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ss_cancel").setLabel("← Back to Hub").setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [posSelect, backRow] }); return;
  }

  const archetypes = rows.map(r => ({
    id: r.id,
    name: r.name,
    attributes: r.attributes as Record<string, number>,
  }));

  const session: ArchSession = { flow: "arch", guildId, position, archIdx: 0, archetypes, editGroupIdx: null, expiresAt: 0 };
  setSession(guildId, interaction.user.id, session);
  await interaction.editReply({ embeds: [buildArchEmbed(session)], components: buildArchComponents(session) });
}

export async function handleSsArchPrev(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "arch") { await interaction.editReply({ content: "Session expired. Run the command again.", components: [] }); return; }
  s.archIdx = Math.max(0, s.archIdx - 1);
  setSession(interaction.guildId!, interaction.user.id, s);
  await interaction.editReply({ embeds: [buildArchEmbed(s)], components: buildArchComponents(s) });
}

export async function handleSsArchNext(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "arch") { await interaction.editReply({ content: "Session expired. Run the command again.", components: [] }); return; }
  s.archIdx = Math.min(s.archetypes.length - 1, s.archIdx + 1);
  setSession(interaction.guildId!, interaction.user.id, s);
  await interaction.editReply({ embeds: [buildArchEmbed(s)], components: buildArchComponents(s) });
}

export async function handleSsArchEdit(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "arch") { await interaction.editReply({ content: "Session expired.", components: [] }); return; }

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`✏️ Edit Archetype — ${s.archetypes[s.archIdx]!.name}`)
    .setDescription("Select an attribute group to edit (up to 5 attributes per group).");
  await interaction.editReply({ embeds: [embed], components: buildArchGroupSelectComponents(s) });
}

export async function handleSsArchBackToView(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "arch") { await interaction.editReply({ content: "Session expired.", components: [] }); return; }
  await interaction.editReply({ embeds: [buildArchEmbed(s)], components: buildArchComponents(s) });
}

export async function handleSsArchEditGroup(interaction: StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;
  const s = getSession(guildId, interaction.user.id);
  if (!s || s.flow !== "arch") { await interaction.reply({ content: "Session expired.", ephemeral: true }); return; }

  const groupIdx = parseInt(interaction.values[0]!, 10);
  const group = EDIT_GROUPS[groupIdx];
  if (!group) { await interaction.reply({ content: "Invalid group.", ephemeral: true }); return; }

  s.editGroupIdx = groupIdx;
  setSession(guildId, interaction.user.id, s);

  const arch = s.archetypes[s.archIdx]!;
  const modal = new ModalBuilder()
    .setCustomId(`ss_modal_arch_edit`)
    .setTitle(`✏️ ${arch.name} — ${group.label.replace(/\S+\s/, "")}`);

  const presentAttrs = group.attrs.filter(a => a in arch.attributes);
  const attrsToShow = presentAttrs.length ? presentAttrs : group.attrs.slice(0, 5);

  modal.addComponents(
    ...attrsToShow.map(attr =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(attr)
          .setLabel(attr)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(3)
          .setValue(String(arch.attributes[attr] ?? 0))
      )
    )
  );
  await interaction.showModal(modal);
}

export async function handleSsArchEditModal(interaction: ModalSubmitInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const s = getSession(guildId, interaction.user.id);
  if (!s || s.flow !== "arch") { await interaction.editReply({ content: "Session expired.", components: [] }); return; }

  const groupIdx = s.editGroupIdx;
  if (groupIdx === null) { await interaction.editReply({ content: "No group selected.", components: [] }); return; }
  const group = EDIT_GROUPS[groupIdx]!;

  const arch = s.archetypes[s.archIdx]!;
  const updates: Record<string, number> = { ...arch.attributes };
  for (const attr of group.attrs) {
    const val = getFieldSafe(interaction, attr);
    if (val !== undefined) {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num >= 0 && num <= 99) updates[attr] = num;
    }
  }

  await db.update(customArchetypesTable)
    .set({ attributes: updates, updatedAt: new Date() })
    .where(eq(customArchetypesTable.id, arch.id));

  arch.attributes = updates;
  s.archetypes[s.archIdx] = arch;
  s.editGroupIdx = null;
  setSession(guildId, interaction.user.id, s);

  await interaction.editReply({ embeds: [buildArchEmbed(s)], components: buildArchComponents(s) });
}

// ── Handler: Legend Template Flow ─────────────────────────────────────────────

export async function handleSsLt(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  if (!await checkAdmin(interaction.guildId!, interaction.user.id, interaction)) {
    await interaction.followUp({ content: "❌ Admin only.", ephemeral: true }); return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("⭐ Legend Templates — Select Position")
    .setDescription("Pick a position to view legends and their attribute templates.");
  await interaction.editReply({ embeds: [embed], components: buildLtPosSelectComponents() });
}

export async function handleSsLtPos(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const position = interaction.values[0]!;

  const legends = await db.select({ id: legendsTable.id, name: legendsTable.name })
    .from(legendsTable)
    .where(and(eq(legendsTable.guildId, guildId), eq(legendsTable.position, position)));

  const session: LtSession = {
    flow: "lt", guildId, position, legendId: null, legendName: "", model: null, template: null, editGroupIdx: null, expiresAt: 0,
  };
  setSession(guildId, interaction.user.id, session);

  if (!legends.length) {
    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle(`⭐ ${position} — No Legends Found`)
      .setDescription("No legends have been added for this position yet.\nAdd them via `/admin-legends add`.");
    await interaction.editReply({ embeds: [embed], components: buildLtPosSelectComponents() }); return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`⭐ ${position} Legends — Select a Legend`)
    .setDescription("Pick a legend to view and edit its attribute templates.");
  await interaction.editReply({ embeds: [embed], components: buildLtLegendSelectComponents(legends, session) });
}

export async function handleSsLtLegend(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const legendId = parseInt(interaction.values[0]!, 10);

  const [legend] = await db.select({ id: legendsTable.id, name: legendsTable.name, position: legendsTable.position })
    .from(legendsTable)
    .where(and(eq(legendsTable.id, legendId), eq(legendsTable.guildId, guildId)));

  const s = getSession(guildId, interaction.user.id);
  if (!s || s.flow !== "lt") {
    const session: LtSession = {
      flow: "lt", guildId, position: legend?.position ?? "", legendId, legendName: legend?.name ?? "", model: null, template: null, editGroupIdx: null, expiresAt: 0,
    };
    setSession(guildId, interaction.user.id, session);
  } else {
    s.legendId = legendId;
    s.legendName = legend?.name ?? "";
    s.model = null;
    s.template = null;
    s.editGroupIdx = null;
    setSession(guildId, interaction.user.id, s);
  }

  const updatedSession = getSession(guildId, interaction.user.id) as LtSession;
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`⭐ ${updatedSession.legendName} — Select Model`)
    .setDescription("Pick which model template to view or edit.");
  await interaction.editReply({ embeds: [embed], components: buildLtModelSelectComponents(updatedSession) });
}

export async function handleSsLtModel(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const model = interaction.values[0]!;

  const s = getSession(guildId, interaction.user.id);
  if (!s || s.flow !== "lt" || !s.legendId) {
    await interaction.editReply({ content: "Session expired. Run the command again.", components: [] }); return;
  }

  const [existing] = await db.select()
    .from(legendTemplatesTable)
    .where(and(
      eq(legendTemplatesTable.guildId, guildId),
      eq(legendTemplatesTable.legendId, s.legendId),
      eq(legendTemplatesTable.model, model),
    ));

  s.model = model;
  s.template = existing ? (existing.attributes as Record<string, number>) : null;
  setSession(guildId, interaction.user.id, s);

  await interaction.editReply({ embeds: [buildLtEmbed(s)], components: buildLtViewComponents(s) });
}

export async function handleSsLtBackToPos(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "lt") { await interaction.editReply({ content: "Session expired.", components: [] }); return; }

  const legends = await db.select({ id: legendsTable.id, name: legendsTable.name })
    .from(legendsTable)
    .where(and(eq(legendsTable.guildId, interaction.guildId!), eq(legendsTable.position, s.position)));

  s.legendId = null; s.legendName = ""; s.model = null; s.template = null;
  setSession(interaction.guildId!, interaction.user.id, s);

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`⭐ ${s.position} Legends — Select a Legend`)
    .setDescription("Pick a legend to view and edit its attribute templates.");
  await interaction.editReply({ embeds: [embed], components: buildLtLegendSelectComponents(legends, s) });
}

export async function handleSsLtBackToModel(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "lt" || !s.legendId) { await interaction.editReply({ content: "Session expired.", components: [] }); return; }
  s.model = null; s.template = null;
  setSession(interaction.guildId!, interaction.user.id, s);
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`⭐ ${s.legendName} — Select Model`)
    .setDescription("Pick which model template to view or edit.");
  await interaction.editReply({ embeds: [embed], components: buildLtModelSelectComponents(s) });
}

export async function handleSsLtEdit(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "lt" || !s.legendId || !s.model) { await interaction.editReply({ content: "Session expired.", components: [] }); return; }
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`✏️ Edit ${s.legendName} — ${MODEL_LABEL[s.model] ?? s.model}`)
    .setDescription("Select an attribute group to edit.");
  await interaction.editReply({ embeds: [embed], components: buildLtGroupSelectComponents(s) });
}

export async function handleSsLtCreate(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "lt" || !s.legendId || !s.model) { await interaction.editReply({ content: "Session expired.", components: [] }); return; }
  s.template = {};
  setSession(interaction.guildId!, interaction.user.id, s);
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`✏️ Create Template — ${s.legendName} — ${MODEL_LABEL[s.model] ?? s.model}`)
    .setDescription("Select an attribute group to begin setting values.");
  await interaction.editReply({ embeds: [embed], components: buildLtGroupSelectComponents(s) });
}

export async function handleSsLtBackToView(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const s = getSession(interaction.guildId!, interaction.user.id);
  if (!s || s.flow !== "lt" || !s.legendId || !s.model) { await interaction.editReply({ content: "Session expired.", components: [] }); return; }
  await interaction.editReply({ embeds: [buildLtEmbed(s)], components: buildLtViewComponents(s) });
}

export async function handleSsLtEditGroup(interaction: StringSelectMenuInteraction) {
  const guildId = interaction.guildId!;
  const s = getSession(guildId, interaction.user.id);
  if (!s || s.flow !== "lt" || !s.legendId || !s.model) { await interaction.reply({ content: "Session expired.", ephemeral: true }); return; }

  const groupIdx = parseInt(interaction.values[0]!, 10);
  const group = EDIT_GROUPS[groupIdx];
  if (!group) { await interaction.reply({ content: "Invalid group.", ephemeral: true }); return; }
  s.editGroupIdx = groupIdx;
  setSession(guildId, interaction.user.id, s);

  const attrs = s.template ?? {};
  const modal = new ModalBuilder()
    .setCustomId("ss_modal_lt_edit")
    .setTitle(`⭐ ${s.legendName} — ${group.label.replace(/\S+\s/, "")}`);

  modal.addComponents(
    ...group.attrs.map(attr =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(attr)
          .setLabel(attr)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMinLength(0)
          .setMaxLength(3)
          .setValue(String(attrs[attr] ?? ""))
          .setPlaceholder("0–99")
      )
    )
  );
  await interaction.showModal(modal);
}

export async function handleSsLtEditModal(interaction: ModalSubmitInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const s = getSession(guildId, interaction.user.id);
  if (!s || s.flow !== "lt" || !s.legendId || !s.model) { await interaction.editReply({ content: "Session expired.", components: [] }); return; }

  const groupIdx = s.editGroupIdx;
  if (groupIdx === null) { await interaction.editReply({ content: "No group selected.", components: [] }); return; }
  const group = EDIT_GROUPS[groupIdx]!;

  const merged: Record<string, number> = { ...(s.template ?? {}) };
  for (const attr of group.attrs) {
    const val = getFieldSafe(interaction, attr)?.trim();
    if (val !== undefined && val !== "") {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num >= 0 && num <= 99) merged[attr] = num;
    }
  }
  s.template = merged;
  s.editGroupIdx = null;
  setSession(guildId, interaction.user.id, s);

  // Upsert to DB
  await db.insert(legendTemplatesTable)
    .values({
      guildId,
      legendId: s.legendId,
      legendName: s.legendName,
      position: s.position,
      model: s.model,
      attributes: merged,
    })
    .onConflictDoUpdate({
      target: [legendTemplatesTable.legendId, legendTemplatesTable.model],
      set: { attributes: merged, legendName: s.legendName, position: s.position, updatedAt: new Date() },
    });

  await interaction.editReply({ embeds: [buildLtEmbed(s)], components: buildLtViewComponents(s) });
}

// ── Handler: Prices & Caps ─────────────────────────────────────────────────────

export async function handleSsPc(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  if (!await checkAdmin(interaction.guildId!, interaction.user.id, interaction)) {
    await interaction.followUp({ content: "❌ Admin only.", ephemeral: true }); return;
  }
  const embed = await buildPcEmbed(interaction.guildId!);
  await interaction.editReply({ embeds: [embed], components: buildPcComponents() });
}

export async function handleSsPcLegendPrices(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const { COSTS } = await import("./constants.js");
  const season = await getOrCreateActiveSeason(guildId);
  const rules = await getSeasonRules(season);

  const modal = new ModalBuilder()
    .setCustomId("ss_modal_pc_legend_prices")
    .setTitle("⭐ Legend & Custom Player Prices")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("legendCost").setLabel("Legend Cost (coins)").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(rules.legendCost))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("customGoldCost").setLabel("Custom Gold Cost (coins)").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(rules.customGoldCost))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("customSilverCost").setLabel("Custom Silver Cost (coins)").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(rules.customSilverCost))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("customBronzeCost").setLabel("Custom Bronze Cost (coins)").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(rules.customBronzeCost))
      ),
    );
  await interaction.showModal(modal);
}

export async function handleSsPcUpgradePrices(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);
  const rules = await getSeasonRules(season);

  const modal = new ModalBuilder()
    .setCustomId("ss_modal_pc_upgrade_prices")
    .setTitle("📈 Upgrade Prices")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("devUpsCost").setLabel("Dev Up Cost (coins)").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(rules.devUpsCost))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("ageResetCost").setLabel("Age Reset Cost (coins)").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(rules.ageResetCost))
      ),
    );
  await interaction.showModal(modal);
}

export async function handleSsPcSeasonCaps(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const { LIMITS } = await import("./constants.js");
  const season = await getOrCreateActiveSeason(guildId);
  const rules = await getSeasonRules(season);

  const legendsPerSeason = season.legendsPerSeasonCapOverride ?? 2;
  const customPerSeason  = season.customPlayersPerSeasonCapOverride ?? 0;

  const modal = new ModalBuilder()
    .setCustomId("ss_modal_pc_season_caps")
    .setTitle("📅 Per-Season Caps")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("legendsPerSeason").setLabel("Legends per Season Cap").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(legendsPerSeason))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("customPlayersPerSeason").setLabel("Custom Players per Season Cap").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(customPerSeason))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("devUpsCap").setLabel("Dev Ups per Season Cap").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(rules.devUpsCap))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("ageResetsCap").setLabel("Age Resets per Season Cap").setStyle(TextInputStyle.Short)
          .setRequired(true).setValue(String(rules.ageResetsCap))
      ),
    );
  await interaction.showModal(modal);
}

export async function handleSsPcAlltimeCaps(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const { LIMITS } = await import("./constants.js");
  const season = await getOrCreateActiveSeason(guildId);
  const rules = await getSeasonRules(season);
  const settings = await getServerSettings(guildId);

  const modal = new ModalBuilder()
    .setCustomId("ss_modal_pc_alltime_caps")
    .setTitle("🏆 All-Time Caps")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("allTimeLegendCap").setLabel("All-Time Legends Cap (total ever)")
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setValue(String(LIMITS.legendsPerTeam))
      ),
    );
  await interaction.showModal(modal);
}

// ── Modal Submissions: Prices & Caps ──────────────────────────────────────────

function parseNum(val: string | undefined | null): number | null {
  if (!val || val.trim() === "") return null;
  const n = parseInt(val.trim(), 10);
  return isNaN(n) || n < 0 ? null : n;
}

function getFieldSafe(interaction: ModalSubmitInteraction, fieldId: string): string | undefined {
  try { return interaction.fields.getTextInputValue(fieldId); } catch { return undefined; }
}

export async function handleSsPcLegendPricesModal(interaction: ModalSubmitInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);

  const legendCost       = parseNum(getFieldSafe(interaction, "legendCost"));
  const customGoldCost   = parseNum(getFieldSafe(interaction, "customGoldCost"));
  const customSilverCost = parseNum(getFieldSafe(interaction, "customSilverCost"));
  const customBronzeCost = parseNum(getFieldSafe(interaction, "customBronzeCost"));

  await db.update(seasonsTable).set({
    ...(legendCost !== null       ? { legendCostOverride:       legendCost       } : {}),
    ...(customGoldCost !== null   ? { customGoldCostOverride:   customGoldCost   } : {}),
    ...(customSilverCost !== null ? { customSilverCostOverride: customSilverCost } : {}),
    ...(customBronzeCost !== null ? { customBronzeCostOverride: customBronzeCost } : {}),
  }).where(eq(seasonsTable.id, season.id));

  const embed = await buildPcEmbed(guildId);
  embed.setDescription(`✅ Legend & Custom Prices updated.\n${embed.data.description ?? ""}`);
  await interaction.editReply({ embeds: [embed], components: buildPcComponents() });
}

export async function handleSsPcUpgradePricesModal(interaction: ModalSubmitInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);

  const devUpsCost   = parseNum(getFieldSafe(interaction, "devUpsCost"));
  const ageResetCost = parseNum(getFieldSafe(interaction, "ageResetCost"));

  await db.update(seasonsTable).set({
    ...(devUpsCost !== null    ? { devUpsCostOverride:    devUpsCost    } : {}),
    ...(ageResetCost !== null  ? { ageResetsCostOverride: ageResetCost  } : {}),
  }).where(eq(seasonsTable.id, season.id));

  const embed = await buildPcEmbed(guildId);
  embed.setDescription(`✅ Upgrade Prices updated.\n${embed.data.description ?? ""}`);
  await interaction.editReply({ embeds: [embed], components: buildPcComponents() });
}

export async function handleSsPcSeasonCapsModal(interaction: ModalSubmitInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);

  const legendsPerSeason = parseNum(getFieldSafe(interaction, "legendsPerSeason"));
  const customPerSeason  = parseNum(getFieldSafe(interaction, "customPlayersPerSeason"));
  const devUpsCap        = parseNum(getFieldSafe(interaction, "devUpsCap"));
  const ageResetsCap     = parseNum(getFieldSafe(interaction, "ageResetsCap"));

  await db.update(seasonsTable).set({
    ...(legendsPerSeason !== null ? { legendsPerSeasonCapOverride:       legendsPerSeason } : {}),
    ...(customPerSeason !== null  ? { customPlayersPerSeasonCapOverride: customPerSeason  } : {}),
    ...(devUpsCap !== null        ? { devUpsCapOverride:                 devUpsCap        } : {}),
    ...(ageResetsCap !== null     ? { ageResetsCapOverride:              ageResetsCap     } : {}),
  }).where(eq(seasonsTable.id, season.id));

  const embed = await buildPcEmbed(guildId);
  embed.setDescription(`✅ Per-Season Caps updated.\n${embed.data.description ?? ""}`);
  await interaction.editReply({ embeds: [embed], components: buildPcComponents() });
}

export async function handleSsPcAlltimeCapsModal(interaction: ModalSubmitInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const season = await getOrCreateActiveSeason(guildId);

  const allTimeLegendCap = parseNum(getFieldSafe(interaction, "allTimeLegendCap"));

  if (allTimeLegendCap !== null) {
    await db.update(serverSettingsTable)
      .set({ allTimeLegendCap, updatedAt: new Date() })
      .where(eq(serverSettingsTable.guildId, guildId));
  }

  const embed = await buildPcEmbed(guildId);
  embed.setDescription(`✅ All-Time Caps updated.\n${embed.data.description ?? ""}`);
  await interaction.editReply({ embeds: [embed], components: buildPcComponents() });
}

// ── Contract & Roster Mod Prices ──────────────────────────────────────────────

export async function handleSsPcContractPrices(interaction: ButtonInteraction) {
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);
  const rules   = await getSeasonRules(season);

  const modal = new ModalBuilder()
    .setCustomId("ss_modal_pc_contract_prices")
    .setTitle("📋 Contract & Roster Mod Prices")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("contractExtensionCost")
          .setLabel("Contract Extension (1YR) Cost (coins)")
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setValue(String(rules.contractExtensionCost))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("salaryReductionCost")
          .setLabel("Salary Reduction Cost (coins)")
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setValue(String(rules.salaryReductionCost))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("bonusReductionCost")
          .setLabel("Bonus Reduction Cost (coins)")
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setValue(String(rules.bonusReductionCost))
      ),
    );
  await interaction.showModal(modal);
}

export async function handleSsPcContractCaps(interaction: ButtonInteraction) {
  const guildId  = interaction.guildId!;
  const [season, settings] = await Promise.all([
    getOrCreateActiveSeason(guildId),
    getServerSettings(guildId),
  ]);
  const rules = await getSeasonRules(season);

  const modal = new ModalBuilder()
    .setCustomId("ss_modal_pc_contract_caps")
    .setTitle("📋 Contract & Roster Mod Caps")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("contractExtensionCap")
          .setLabel("Contract Extensions per Season (per user)")
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setValue(String(rules.contractExtensionCap))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("salaryReductionCap")
          .setLabel("Salary Reductions per Season (per user)")
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setValue(String(rules.salaryReductionCap))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("salaryReductionCareerCap")
          .setLabel("Salary Red Career Cap/player (blank=unlimited)")
          .setStyle(TextInputStyle.Short).setRequired(false)
          .setValue(settings.salaryReductionCareerCap != null ? String(settings.salaryReductionCareerCap) : "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("bonusReductionCap")
          .setLabel("Bonus Reductions per Season (per user)")
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setValue(String(rules.bonusReductionCap))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("bonusReductionCareerCap")
          .setLabel("Bonus Red Career Cap/player (blank=unlimited)")
          .setStyle(TextInputStyle.Short).setRequired(false)
          .setValue(settings.bonusReductionCareerCap != null ? String(settings.bonusReductionCareerCap) : "")
      ),
    );
  await interaction.showModal(modal);
}

export async function handleSsPcContractPricesModal(interaction: ModalSubmitInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const contractExtensionCost = parseNum(getFieldSafe(interaction, "contractExtensionCost"));
  const salaryReductionCost   = parseNum(getFieldSafe(interaction, "salaryReductionCost"));
  const bonusReductionCost    = parseNum(getFieldSafe(interaction, "bonusReductionCost"));

  await db.update(seasonsTable).set({
    ...(contractExtensionCost !== null ? { contractExtensionCostOverride: contractExtensionCost } : {}),
    ...(salaryReductionCost   !== null ? { salaryReductionCostOverride:   salaryReductionCost   } : {}),
    ...(bonusReductionCost    !== null ? { bonusReductionCostOverride:     bonusReductionCost    } : {}),
  }).where(eq(seasonsTable.id, season.id));

  const embed = await buildPcEmbed(guildId);
  embed.setDescription(`✅ Contract & Roster Prices updated.\n${embed.data.description ?? ""}`);
  await interaction.editReply({ embeds: [embed], components: buildPcComponents() });
}

export async function handleSsPcContractCapsModal(interaction: ModalSubmitInteraction) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  const contractExtensionCap   = parseNum(getFieldSafe(interaction, "contractExtensionCap"));
  const salaryReductionCap     = parseNum(getFieldSafe(interaction, "salaryReductionCap"));
  const bonusReductionCap      = parseNum(getFieldSafe(interaction, "bonusReductionCap"));

  // Career caps: blank = null (unlimited); parse separately
  const rawSalaryCareer = getFieldSafe(interaction, "salaryReductionCareerCap")?.trim();
  const rawBonusCareer  = getFieldSafe(interaction, "bonusReductionCareerCap")?.trim();
  const salaryReductionCareerCap = rawSalaryCareer ? parseNum(rawSalaryCareer) : null;
  const bonusReductionCareerCap  = rawBonusCareer  ? parseNum(rawBonusCareer)  : null;

  // Season-level caps → seasons table
  await db.update(seasonsTable).set({
    ...(contractExtensionCap !== null ? { contractExtensionCapOverride: contractExtensionCap } : {}),
    ...(salaryReductionCap   !== null ? { salaryReductionCapOverride:   salaryReductionCap   } : {}),
    ...(bonusReductionCap    !== null ? { bonusReductionCapOverride:     bonusReductionCap    } : {}),
  }).where(eq(seasonsTable.id, season.id));

  // Career caps → server_settings (always write — null clears cap, number sets it)
  // Only update if the field was touched (non-undefined raw value)
  const settingsUpdate: Record<string, number | null> = {};
  if (rawSalaryCareer !== undefined) settingsUpdate["salaryReductionCareerCap"] = salaryReductionCareerCap;
  if (rawBonusCareer  !== undefined) settingsUpdate["bonusReductionCareerCap"]  = bonusReductionCareerCap;
  if (Object.keys(settingsUpdate).length > 0) {
    await db.update(serverSettingsTable)
      .set({ ...settingsUpdate, updatedAt: new Date() })
      .where(eq(serverSettingsTable.guildId, guildId));
  }

  const embed = await buildPcEmbed(guildId);
  embed.setDescription(`✅ Contract & Roster Caps updated.\n${embed.data.description ?? ""}`);
  await interaction.editReply({ embeds: [embed], components: buildPcComponents() });
}

