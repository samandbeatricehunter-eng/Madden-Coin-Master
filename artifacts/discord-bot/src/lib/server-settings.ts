import { db } from "@workspace/db";
import { serverSettingsTable, type ServerSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";

export type { ServerSettings };

const GUILD_KEY = "global";

export async function getServerSettings(): Promise<ServerSettings> {
  const [settings] = await db.select().from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, GUILD_KEY)).limit(1);
  if (settings) return settings;
  const [created] = await db.insert(serverSettingsTable)
    .values({ guildId: GUILD_KEY }).returning();
  return created!;
}

export type FeatureKey = keyof Omit<ServerSettings, "id" | "guildId" | "updatedAt">;

export async function toggleFeature(feature: FeatureKey): Promise<ServerSettings> {
  const current = await getServerSettings();
  const currentValue = current[feature] as boolean;
  const [updated] = await db.update(serverSettingsTable)
    .set({ [feature]: !currentValue, updatedAt: new Date() })
    .where(eq(serverSettingsTable.guildId, GUILD_KEY))
    .returning();
  return updated!;
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
    FEATURE_META.slice(0, 4),
    FEATURE_META.slice(4, 8),
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
