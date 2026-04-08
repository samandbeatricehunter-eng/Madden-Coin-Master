import {
  EmbedBuilder, Colors,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ButtonBuilder, ButtonStyle,
} from "discord.js";
import { db } from "@workspace/db";
import { customPlayerSettingsTable, customArchetypesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { CustomPlayerSession, PackageTier, DevTrait } from "./custom-player-session.js";
import { pointsUsed, pointCostForRaise } from "./custom-player-session.js";

// ── Positions ─────────────────────────────────────────────────────────────────
export const ALL_POSITIONS = ["QB","RB","FB","WR","TE","OL","DL","LB","CB","FS","SS","K","P"] as const;
export type Position = typeof ALL_POSITIONS[number];
export const KP_POSITIONS = new Set(["K","P"]);

// ── Dev trait costs ────────────────────────────────────────────────────────────
export const DEV_TRAIT_COST: Record<DevTrait, number> = {
  normal:     0,
  star:       75,
  superstar:  150,
};

export const DEV_TRAIT_LABEL: Record<DevTrait, string> = {
  normal:     "Normal",
  star:       "Star (+75 coins)",
  superstar:  "Superstar (+150 coins)",
};

// ── Height / Weight ranges ─────────────────────────────────────────────────────
// Heights in total inches (e.g. 70 = 5'10")
interface HWRange { hMin: number; hMax: number; wMin: number; wMax: number; }

export const HW_RANGES: Record<string, HWRange> = {
  QB:  { hMin: 70, hMax: 76, wMin: 190, wMax: 250 },
  RB:  { hMin: 68, hMax: 74, wMin: 180, wMax: 250 },
  FB:  { hMin: 69, hMax: 72, wMin: 210, wMax: 250 },
  WR:  { hMin: 69, hMax: 75, wMin: 170, wMax: 235 },
  TE:  { hMin: 74, hMax: 78, wMin: 230, wMax: 255 },
  OL:  { hMin: 73, hMax: 78, wMin: 270, wMax: 350 },
  // OL sub-positions — T (LT/RT) are taller/heavier, G (LG/RG) middle, C slightly shorter/lighter
  LT:  { hMin: 75, hMax: 79, wMin: 295, wMax: 350 },
  RT:  { hMin: 75, hMax: 79, wMin: 295, wMax: 350 },
  LG:  { hMin: 73, hMax: 78, wMin: 275, wMax: 340 },
  RG:  { hMin: 73, hMax: 78, wMin: 275, wMax: 340 },
  C:   { hMin: 73, hMax: 77, wMin: 270, wMax: 330 },
  DL:  { hMin: 73, hMax: 77, wMin: 270, wMax: 340 },
  LB:  { hMin: 71, hMax: 75, wMin: 215, wMax: 260 },
  CB:  { hMin: 69, hMax: 74, wMin: 180, wMax: 230 },
  FS:  { hMin: 69, hMax: 74, wMin: 180, wMax: 230 },
  SS:  { hMin: 69, hMax: 74, wMin: 180, wMax: 230 },
  K:   { hMin: 68, hMax: 76, wMin: 170, wMax: 240 },
  P:   { hMin: 70, hMax: 77, wMin: 180, wMax: 245 },
};

export function inchesToDisplay(totalInches: number): string {
  return `${Math.floor(totalInches / 12)}'${totalInches % 12}"`;
}

export function heightOptions(position: string): Array<{ label: string; value: string }> {
  const r = HW_RANGES[position] ?? HW_RANGES.QB;
  const opts: Array<{ label: string; value: string }> = [];
  for (let h = r.hMin; h <= r.hMax; h++) {
    opts.push({ label: inchesToDisplay(h), value: String(h) });
  }
  return opts;
}

export function weightOptions(position: string): Array<{ label: string; value: string }> {
  const r = HW_RANGES[position] ?? HW_RANGES.QB;
  const opts: Array<{ label: string; value: string }> = [];
  for (let w = r.wMin; w <= r.wMax; w += 5) {
    opts.push({ label: `${w} lbs`, value: String(w) });
  }
  return opts;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
export async function getSettings() {
  const [row] = await db.select().from(customPlayerSettingsTable).limit(1);
  if (row) return row;
  // Upsert defaults
  const [inserted] = await db.insert(customPlayerSettingsTable)
    .values({})
    .onConflictDoNothing()
    .returning();
  return inserted ?? {
    id: 1, bronzePoints: 35, silverPoints: 70, goldPoints: 100,
    bronzeCost: 0, silverCost: 0, goldCost: 0, kpPoints: 50, kpCost: 0,
    updatedAt: new Date(),
  };
}

export function packagePoints(tier: PackageTier, s: Awaited<ReturnType<typeof getSettings>>): number {
  if (tier === "kp")     return s.kpPoints;
  if (tier === "bronze") return s.bronzePoints;
  if (tier === "silver") return s.silverPoints;
  return s.goldPoints;
}

export function packageCost(tier: PackageTier, s: Awaited<ReturnType<typeof getSettings>>): number {
  if (tier === "kp")     return s.kpCost;
  if (tier === "bronze") return s.bronzeCost;
  if (tier === "silver") return s.silverCost;
  return s.goldCost;
}

export function packageLabel(tier: PackageTier): string {
  if (tier === "kp") return "Bronze (K/P Default)";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

// ── Action rows ───────────────────────────────────────────────────────────────
export function positionSelectRow(sessionId: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ccp_pos:${sessionId}`)
      .setPlaceholder("Select a position…")
      .addOptions(ALL_POSITIONS.map(p =>
        new StringSelectMenuOptionBuilder().setLabel(p).setValue(p),
      )),
  );
}

export function olSubPositionSelectRow(sessionId: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ccp_ol_pos:${sessionId}`)
      .setPlaceholder("Select OL position…")
      .addOptions([
        new StringSelectMenuOptionBuilder().setLabel("LT — Left Tackle").setValue("LT"),
        new StringSelectMenuOptionBuilder().setLabel("LG — Left Guard").setValue("LG"),
        new StringSelectMenuOptionBuilder().setLabel("C — Center").setValue("C"),
        new StringSelectMenuOptionBuilder().setLabel("RG — Right Guard").setValue("RG"),
        new StringSelectMenuOptionBuilder().setLabel("RT — Right Tackle").setValue("RT"),
      ]),
  );
}

export async function archetypeSelectRow(position: string, sessionId: string) {
  const archs = await db.select()
    .from(customArchetypesTable)
    .where(eq(customArchetypesTable.position, position));
  const active = archs.filter(a => a.isActive);
  if (active.length === 0) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ccp_arch:${sessionId}`)
      .setPlaceholder("Select an archetype…")
      .addOptions(active.map(a =>
        new StringSelectMenuOptionBuilder().setLabel(a.name).setValue(String(a.id)),
      )),
  );
}

export function devTraitSelectRow(sessionId: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ccp_dev:${sessionId}`)
      .setPlaceholder("Select development trait…")
      .addOptions([
        new StringSelectMenuOptionBuilder().setLabel("Normal").setValue("normal"),
        new StringSelectMenuOptionBuilder().setLabel("Star (+75 coins)").setValue("star"),
        new StringSelectMenuOptionBuilder().setLabel("Superstar (+150 coins)").setValue("superstar"),
      ]),
  );
}

export function packageSelectRow(sessionId: string, settings: Awaited<ReturnType<typeof getSettings>>) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ccp_pkg:${sessionId}`)
      .setPlaceholder("Select creation package…")
      .addOptions([
        new StringSelectMenuOptionBuilder()
          .setLabel(`Bronze — ${settings.bronzePoints} pts${settings.bronzeCost > 0 ? ` (+${settings.bronzeCost} coins)` : ""}`)
          .setValue("bronze"),
        new StringSelectMenuOptionBuilder()
          .setLabel(`Silver — ${settings.silverPoints} pts${settings.silverCost > 0 ? ` (+${settings.silverCost} coins)` : ""}`)
          .setValue("silver"),
        new StringSelectMenuOptionBuilder()
          .setLabel(`Gold — ${settings.goldPoints} pts${settings.goldCost > 0 ? ` (+${settings.goldCost} coins)` : ""}`)
          .setValue("gold"),
      ]),
  );
}

// ── Attribute allocation UI ────────────────────────────────────────────────────
export function attrAllocEmbed(session: CustomPlayerSession): EmbedBuilder {
  const used     = pointsUsed(session.attributes, session.attributeBases);
  const remaining = session.packagePoints - used;
  const sel      = session.selectedAttr;

  const lines = session.attributeOrder.map(attr => {
    const val  = session.attributes[attr] ?? 0;
    const base = session.attributeBases[attr] ?? val;
    const diff = val - base;
    const indicator = attr === sel ? " ◄" : "";
    const diffStr   = diff > 0 ? ` (+${diff})` : "";
    return `**${attr}**: ${val}${diffStr}${indicator}`;
  });

  // Next cost for selected attr
  let costNote = "";
  if (sel) {
    const cur  = session.attributes[sel] ?? 0;
    if (cur < 99) costNote = `\nNext +1 on **${sel}**: costs **${pointCostForRaise(cur)}** pt${pointCostForRaise(cur) === 1 ? "" : "s"}`;
  }

  const embed = new EmbedBuilder()
    .setColor(remaining < 0 ? Colors.Red : Colors.Blue)
    .setTitle(`🏗️ Attribute Allocation — ${session.position} / ${session.archetypeName}`)
    .setDescription(lines.join("   ") + costNote)
    .addFields(
      { name: "Points Remaining", value: `**${remaining}** / ${session.packagePoints}`, inline: true },
      { name: "Package",          value: packageLabel(session.packageTier!), inline: true },
      { name: "Dev Trait",        value: DEV_TRAIT_LABEL[session.devTrait!] ?? "Normal", inline: true },
    )
    .setFooter({ text: "Select an attribute then use +/− to adjust. Cannot go below base or above 99." });
  return embed;
}

export function attrAllocRows(session: CustomPlayerSession) {
  const rows: ActionRowBuilder<any>[] = [];
  const sessionId = Object.keys({}).length; // placeholder — caller passes sessionId

  // Row 1: attribute picker (up to 25 options)
  const attrOptions = session.attributeOrder.slice(0, 25).map(attr => {
    const val  = session.attributes[attr] ?? 0;
    const base = session.attributeBases[attr] ?? val;
    const diff = val - base;
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${attr}: ${val}${diff > 0 ? ` (+${diff})` : ""}`)
      .setValue(attr)
      .setDefault(attr === session.selectedAttr);
  });

  return attrOptions; // caller assembles rows with correct sessionId
}

export function buildAttrRows(session: CustomPlayerSession, sessionId: string) {
  const used      = pointsUsed(session.attributes, session.attributeBases);
  const remaining = session.packagePoints - used;
  const sel       = session.selectedAttr;

  const rows: ActionRowBuilder<any>[] = [];

  // Row 1: attribute select
  const attrOptions = session.attributeOrder.slice(0, 25).map(attr => {
    const val  = session.attributes[attr] ?? 0;
    const base = session.attributeBases[attr] ?? val;
    const diff = val - base;
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${attr}: ${val}${diff > 0 ? ` (+${diff})` : ""}`)
      .setValue(attr)
      .setDefault(attr === sel);
  });
  rows.push(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ccp_attr_sel:${sessionId}`)
        .setPlaceholder("Select attribute to edit…")
        .addOptions(attrOptions),
    ),
  );

  // Row 2: +/- buttons
  const selVal  = sel ? (session.attributes[sel] ?? 0) : null;
  const selBase = sel ? (session.attributeBases[sel] ?? 0) : null;
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ccp_attr_minus5:${sessionId}`)
        .setLabel("−5")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!sel || (selVal! - 5 < selBase!)),
      new ButtonBuilder()
        .setCustomId(`ccp_attr_minus1:${sessionId}`)
        .setLabel("−1")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!sel || selVal! <= selBase!),
      new ButtonBuilder()
        .setCustomId(`ccp_attr_plus1:${sessionId}`)
        .setLabel("+1")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!sel || selVal! >= 99 || remaining < pointCostForRaise(selVal ?? 0)),
      new ButtonBuilder()
        .setCustomId(`ccp_attr_plus5:${sessionId}`)
        .setLabel("+5")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!sel || selVal! >= 95 || remaining < 1),
      new ButtonBuilder()
        .setCustomId(`ccp_submit_attrs:${sessionId}`)
        .setLabel("✅ Submit Attributes")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(remaining < 0),
    ),
  );

  return rows;
}

// ── Commissioner embed + rows ─────────────────────────────────────────────────
export function buildCommissionerEmbed(playerId: number, session: CustomPlayerSession): EmbedBuilder {
  const heightStr  = `${session.heightFt}'${session.heightIn}"`;
  const devLabel   = { normal: "Normal", star: "Star", superstar: "Superstar" }[session.devTrait!] ?? "Normal";
  const attrLines  = session.attributeOrder
    .map(a => `**${a}**: ${session.attributes[a]}`)
    .join("  ");

  return new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("🏈 Custom Player Submitted")
    .addFields(
      { name: "Name",             value: `${session.firstName} ${session.lastName}`, inline: true },
      { name: "Position",         value: session.position!,   inline: true },
      { name: "Jersey #",         value: String(session.jerseyNumber ?? "?"), inline: true },
      { name: "Height",           value: heightStr,           inline: true },
      { name: "Weight",           value: `${session.weightLbs} lbs`, inline: true },
      { name: "College",          value: session.college!,    inline: true },
      { name: "Dominant Hand",    value: session.dominantHand === "left" ? "Left" : "Right", inline: true },
      { name: "Dev Trait",        value: devLabel,            inline: true },
      { name: "Package",          value: packageLabel(session.packageTier!), inline: true },
      { name: "Archetype",        value: session.archetypeName!, inline: true },
      { name: "Total Cost",       value: `${session.totalCost} coins`, inline: true },
      { name: "Submitted By",     value: `<@${session.userId}>`, inline: true },
      { name: "Attributes",       value: attrLines || "—" },
    )
    .setTimestamp()
    .setFooter({ text: `Player ID: ${playerId}` });
}

export function buildCommissionerRows(playerId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ccp_applied:${playerId}`)
      .setLabel("✅ Applied in Game")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ccp_refund:${playerId}`)
      .setLabel("💰 Refund")
      .setStyle(ButtonStyle.Danger),
  );
}

// ── Archetype paged-browser UI ────────────────────────────────────────────────
// Shows one archetype at a time with Prev/Next navigation and a Pick button.

export function buildArchetypeNavRows(
  sessionId: string,
  currentIdx: number,
  total: number,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ccp_arch_prev:${sessionId}`)
      .setLabel("◀  Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentIdx <= 0),
    new ButtonBuilder()
      .setCustomId("ccp_arch_page_indicator")
      .setLabel(`${currentIdx + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`ccp_arch_next:${sessionId}`)
      .setLabel("Next  ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentIdx >= total - 1),
    new ButtonBuilder()
      .setCustomId(`ccp_arch_pick:${sessionId}`)
      .setLabel("✅  Choose This Archetype")
      .setStyle(ButtonStyle.Success),
  );
  return [row];
}

// ── Format archetype for display ──────────────────────────────────────────────
export function formatArchetypeEmbed(
  position: string,
  name: string,
  attributes: Record<string, number>,
): EmbedBuilder {
  const lines = Object.entries(attributes)
    .map(([attr, val]) => `**${attr}**: ${val}`)
    .join("   ");

  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`${position} — ${name}`)
    .setDescription(lines || "No attributes defined.");
}
