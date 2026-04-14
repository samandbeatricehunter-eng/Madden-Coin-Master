import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { legendsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { LIMITS } from "../lib/constants.js";
import { getOrCreateActiveSeason, getSeasonRules } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";
import { getSettings as getCustomPlayerSettings, packageCost, packagePoints } from "../lib/custom-player-helpers.js";

// ── Attribute groups by position ───────────────────────────────────────────────
const ATTR_GROUPS = {
  // ── OFFENSE ────────────────────────────────────────────────────────────────
  "🏈 QB": [
    "Throwing Power ⭐",
    "Short Accuracy ⭐",
    "Medium Accuracy",
    "Deep Accuracy",
    "Throw on the Run",
    "Throw Under Pressure",
    "Break Sack",
    "Play Action",
  ],
  "🏃 HB": [
    "Carrying",
    "BC Vision",
    "Break Tackle",
    "Trucking",
    "Stiff Arm",
    "Change of Direction ⭐",
    "Spin Move",
    "Juke Move",
  ],
  "📡 WR / TE": [
    "Catching",
    "Catch in Traffic",
    "Spectacular Catch",
    "Short Route Running",
    "Medium Route Running",
    "Deep Route Running",
    "Release",
  ],
  "🧱 OL": [
    "Pass Blocking",
    "Pass Block Power",
    "Pass Block Finesse",
    "Run Blocking",
    "Run Block Power",
    "Run Block Finesse",
    "Lead Block",
    "Impact Blocking",
  ],
  // ── DEFENSE ────────────────────────────────────────────────────────────────
  "💥 DL / Pass Rush": [
    "Power Moves",
    "Finesse Moves",
    "Block Shedding",
    "Tackling",
    "Hit Power",
    "Pursuit",
  ],
  "🤼 LB": [
    "Play Recognition",
    "Pursuit",
    "Tackling",
    "Hit Power",
    "Block Shedding",
    "Finesse Moves",
    "Man Coverage",
    "Zone Coverage",
  ],
  "🎯 DB / Coverage": [
    "Man Coverage",
    "Zone Coverage",
    "Press",
    "Play Recognition",
    "Jumping ⭐",
    "Tackling",
    "Hit Power",
    "Catch in Traffic",
  ],
} as const;

const UNIVERSAL_ATTRS = "Speed ⭐ • Acceleration ⭐ • Agility ⭐ • Strength ⭐ • Jumping ⭐ • Awareness ⭐ • Stamina ⭐ • Toughness • Injury";
const SPECIAL_TEAMS_ATTRS = "Kicking Power • Kicking Accuracy • Kick/Punt Return • Long Snap";

const OFFENSE_KEYS = ["🏈 QB", "🏃 HB", "📡 WR / TE", "🧱 OL"] as const;
const DEFENSE_KEYS = ["💥 DL / Pass Rush", "🤼 LB", "🎯 DB / Coverage"] as const;

// ── Command ────────────────────────────────────────────────────────────────────
export const data = new SlashCommandBuilder()
  .setName("viewstore")
  .setDescription("View all available items in the store");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings();

  if (!settings.coinEconomy) {
    await interaction.editReply({ content: "❌ The coin economy is currently disabled by the commissioners." });
    return;
  }

  const season     = await getOrCreateActiveSeason(interaction.guildId!);
  const rules      = await getSeasonRules(season);
  const cpSettings = await getCustomPlayerSettings();

  const availableLegends = settings.legendsEnabled
    ? await db.select().from(legendsTable).where(eq(legendsTable.isAvailable, true)).orderBy(asc(legendsTable.position), asc(legendsTable.name))
    : [];

  // ── Build embed ──────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("🏪 Madden League Store")
    .setTimestamp();

  // ── Legends ──────────────────────────────────────────────────────────────────
  if (settings.legendsEnabled) {
    const legendList = availableLegends.length > 0
      ? availableLegends.map(l => `• **${l.name}** (${l.position})${l.description ? ` — ${l.description}` : ""}`).join("\n")
      : "No legends currently available.";
    embed.addFields({
      name: `🏆 Legends — ${rules.legendCost.toLocaleString()} coins each`,
      value: legendList.length > 1024 ? legendList.substring(0, 1020) + "..." : legendList,
    });
  }

  // ── Attribute Upgrades ────────────────────────────────────────────────────────
  if (settings.attributeUpgradesEnabled) {
    const pricingNote = rules.coreAttrCost !== rules.nonCoreAttrCost
      ? [
          `⭐ **Core attrs:** ${rules.coreAttrCost} coins/pt — cap **${rules.coreAttrCap}/season**`,
          `**Non-core:** ${rules.nonCoreAttrCost} coins/pt — cap **${rules.nonCoreAttrCap}/season**`,
          `*(⭐ = core attribute)*`,
        ].join("\n")
      : `**${rules.coreAttrCost} coins/pt** — cap ${rules.coreAttrCap}/season\n*(⭐ = core attribute)*`;

    // Pricing header
    embed.addFields({ name: "⚡ Attribute Upgrades", value: pricingNote });

    // ── Offense section ─────────────────────────────────────────────────────────
    embed.addFields({ name: "\u200B", value: "**─────────── 🏈  O F F E N S E  ───────────**" });

    for (const key of OFFENSE_KEYS) {
      const attrs = ATTR_GROUPS[key as keyof typeof ATTR_GROUPS];
      embed.addFields({
        name: key,
        value: (attrs as readonly string[]).join("\n"),
        inline: true,
      });
    }

    // ── Defense section ─────────────────────────────────────────────────────────
    embed.addFields({ name: "\u200B", value: "**─────────── 🛡️  D E F E N S E  ───────────**" });

    for (const key of DEFENSE_KEYS) {
      const attrs = ATTR_GROUPS[key as keyof typeof ATTR_GROUPS];
      embed.addFields({
        name: key,
        value: (attrs as readonly string[]).join("\n"),
        inline: true,
      });
    }

    // ── Universal + Special Teams ───────────────────────────────────────────────
    embed.addFields(
      { name: "\u200B", value: "**─────────── 🌍  UNIVERSAL + SPECIAL TEAMS  ───────────**" },
      { name: "🌍 Universal (All Positions)", value: UNIVERSAL_ATTRS,   inline: true },
      { name: "🦵 Special Teams",             value: SPECIAL_TEAMS_ATTRS, inline: true },
    );
  }

  // ── Dev Ups ───────────────────────────────────────────────────────────────────
  if (settings.devUpgradesEnabled) {
    embed.addFields({
      name: `📈 Development Upgrade — ${rules.devUpsCost} coins each`,
      value: `Upgrade a player's development trait. **Limit: ${rules.devUpsCap}/season.**\nSpecify player name and position with \`/purchase devup\`.`,
    });
  }

  // ── Age Resets ────────────────────────────────────────────────────────────────
  if (settings.ageResetsEnabled) {
    embed.addFields({
      name: `🔄 Age Reset — ${rules.ageResetCost} coins each`,
      value: `Reset a player's age. **Limit: ${rules.ageResetsCap}/season.**\nSpecify player name and position with \`/purchase agereset\`.`,
    });
  }

  // ── Custom Players ────────────────────────────────────────────────────────────
  if (settings.customSuperstarsEnabled) {
    const cpLines: string[] = [
      `• **Gold** — ${packageCost("gold", cpSettings)} coins (${packagePoints("gold", cpSettings)} creation pts)`,
      `• **Silver** — ${packageCost("silver", cpSettings)} coins (${packagePoints("silver", cpSettings)} creation pts)`,
      `• **Bronze** — ${packageCost("bronze", cpSettings)} coins (${packagePoints("bronze", cpSettings)} creation pts)`,
      `• **K/P** — ${packageCost("kp", cpSettings)} coins (${packagePoints("kp", cpSettings)} creation pts)`,
    ];
    embed.addFields({
      name: "🎨 Custom Players",
      value: cpLines.join("\n"),
    });
  }

  if (!embed.data.fields?.length) {
    embed.setDescription("*No store items are currently enabled.*");
  }

  embed.setFooter({ text: `Season ${season.seasonNumber} rates • Use /purchase to buy • Legends + Custom Players combined cap: ${LIMITS.maxLegendsPlusCustomPlayers}` });

  return interaction.editReply({ embeds: [embed] });
}
