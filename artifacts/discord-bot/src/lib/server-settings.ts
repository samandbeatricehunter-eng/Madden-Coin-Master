import { db } from "@workspace/db";
import { serverSettingsTable, type ServerSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChatInputCommandInteraction, PermissionFlagsBits,
} from "discord.js";
import { isAdminUser } from "./db-helpers.js";

export type { ServerSettings };

export async function getServerSettings(guildId: string): Promise<ServerSettings> {
  const [settings] = await db.select().from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId)).limit(1);
  if (settings) return settings;

  // No per-guild row yet. Seed from the "global" row (legacy primary-guild data)
  // so previously configured settings aren't silently reset to defaults.
  const [globalRow] = await db.select().from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, "global")).limit(1);

  const seed = globalRow
    ? {
        guildId,
        coinEconomy:              globalRow.coinEconomy,
        legendsEnabled:           globalRow.legendsEnabled,
        customSuperstarsEnabled:  globalRow.customSuperstarsEnabled,
        attributeUpgradesEnabled: globalRow.attributeUpgradesEnabled,
        devUpgradesEnabled:       globalRow.devUpgradesEnabled,
        ageResetsEnabled:         globalRow.ageResetsEnabled,
        wagerEnabled:             globalRow.wagerEnabled,
        tradeBlockEnabled:        globalRow.tradeBlockEnabled,
        mcaImportEnabled:         globalRow.mcaImportEnabled,
        legacyCoreAttrMode:       globalRow.legacyCoreAttrMode,
        maxSeasons:               globalRow.maxSeasons,
      }
    : { guildId };

  const [created] = await db.insert(serverSettingsTable).values(seed).returning();
  return created!;
}

export type FeatureKey = keyof Omit<ServerSettings, "id" | "guildId" | "updatedAt">;

export async function toggleFeature(feature: FeatureKey, guildId: string): Promise<ServerSettings> {
  const current = await getServerSettings(guildId);
  const currentValue = current[feature] as boolean;
  const [updated] = await db.update(serverSettingsTable)
    .set({ [feature]: !currentValue, updatedAt: new Date() })
    .where(eq(serverSettingsTable.guildId, guildId))
    .returning();
  return updated!;
}

/**
 * Call after `deferReply`. Returns true if the command should proceed.
 * Returns false (and edits the reply with an error) when MCA import is
 * disabled and the caller is not an admin.
 */
export async function requireMcaEnabled(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  const settings = await getServerSettings(interaction.guildId!);
  if (settings.mcaImportEnabled) return true;

  // Admins bypass the gate
  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);
  if (isDiscordAdmin || isDbAdmin) return true;

  const msg =
    "❌ **MCA Import is currently disabled.**\n" +
    "This command relies on live MCA data which the commissioner is managing manually. " +
    "Please ask a commissioner for this information.";

  try {
    await interaction.editReply({ content: msg });
  } catch {
    await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
  return false;
}

export const FEATURE_META: Array<{ key: FeatureKey; label: string; description: string }> = [
  { key: "coinEconomy",             label: "Coin Economy",       description: "Master toggle — all economy features" },
  { key: "legendsEnabled",          label: "Legends",            description: "Legends in store & slash commands" },
  { key: "customSuperstarsEnabled", label: "Custom Superstars",  description: "Custom superstar purchases" },
  { key: "attributeUpgradesEnabled",label: "Attr Upgrades",      description: "Attribute upgrade purchases" },
  { key: "devUpgradesEnabled",      label: "Dev Upgrades",       description: "Development upgrade purchases" },
  { key: "ageResetsEnabled",        label: "Age Resets",         description: "Age reset purchases" },
  { key: "wagerEnabled",            label: "Wagers",             description: "Coin wager system" },
  { key: "tradeBlockEnabled",       label: "Trade Block",        description: "Trade block listings & ISO" },
  { key: "mcaImportEnabled",        label: "MCA Import",         description: "Stat/schedule commands for all users (off = admin-only)" },
  { key: "legacyCoreAttrMode",      label: "Legacy Core Attrs",  description: "Allow multi-point & repeat core upgrades per player (off = strict 1pt/attr/player/season)" },
];

export const FEATURE_LABELS: Record<FeatureKey, string> =
  Object.fromEntries(FEATURE_META.map(f => [f.key, f.label])) as Record<FeatureKey, string>;

export function buildSettingsEmbed(s: ServerSettings): EmbedBuilder {
  const lines = FEATURE_META.map(f => {
    const val = s[f.key] as boolean;
    const icon = val ? "🟢" : "🔴";
    return `${icon} **${f.label}** — ${f.description}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("⚙️ Server Feature Settings")
    .setDescription(
      "Toggle features on/off. Changes take effect immediately.\n\n" +
      lines.join("\n"),
    )
    .setFooter({ text: "Click a button below to toggle that feature" })
    .setTimestamp();

  return embed;
}

export function buildSettingsRows(s: ServerSettings): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>();
  const row2 = new ActionRowBuilder<ButtonBuilder>();
  const row3 = new ActionRowBuilder<ButtonBuilder>();

  const chunks = [
    FEATURE_META.slice(0, 5),
    FEATURE_META.slice(5, 10),
  ];

  chunks[0]!.forEach(f => {
    const val = s[f.key] as boolean;
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`settings_toggle:${f.key}`)
        .setLabel(`${val ? "ON" : "OFF"} — ${f.label}`)
        .setStyle(val ? ButtonStyle.Success : ButtonStyle.Danger),
    );
  });

  chunks[1]!.forEach(f => {
    const val = s[f.key] as boolean;
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`settings_toggle:${f.key}`)
        .setLabel(`${val ? "ON" : "OFF"} — ${f.label}`)
        .setStyle(val ? ButtonStyle.Success : ButtonStyle.Danger),
    );
  });

  row3.addComponents(
    new ButtonBuilder()
      .setCustomId("settings_done")
      .setLabel("Close Settings")
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3];
}
