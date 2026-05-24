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

  await db.insert(serverSettingsTable)
    .values({ guildId })
    .onConflictDoNothing();

  const [created] = await db.select().from(serverSettingsTable)
    .where(eq(serverSettingsTable.guildId, guildId)).limit(1);
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
 */
export async function requireMcaEnabled(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  const settings = await getServerSettings(interaction.guildId!);
  if (settings.mcaImportEnabled) return true;

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
  { key: "devUpgradesEnabled",      label: "Dev Upgrades",       description: "Development upgrade purchases" },
  { key: "ageResetsEnabled",        label: "Age Resets",         description: "Age reset purchases" },
  { key: "contractExtensionsEnabled", label: "Contract Ext",     description: "Contract extension (1YR) purchases" },
  { key: "salaryReductionsEnabled",   label: "Salary Reduction", description: "Player salary reduction purchases" },
  { key: "bonusReductionsEnabled",    label: "Bonus Reduction",  description: "Player bonus reduction purchases" },
  { key: "wagerEnabled",            label: "Wagers",             description: "Coin wager system" },
  { key: "mcaImportEnabled",        label: "MCA Import",         description: "Stat/schedule commands for all users (off = admin-only)" },
];

export const FEATURE_LABELS: Record<FeatureKey, string> =
  Object.fromEntries(FEATURE_META.map(f => [f.key, f.label])) as Record<FeatureKey, string>;

export function buildSettingsEmbed(s: ServerSettings): EmbedBuilder {
  const lines = FEATURE_META.map(f => {
    const val = s[f.key] as boolean;
    const icon = val ? "🟢" : "🔴";
    return `${icon} **${f.label}** — ${f.description}`;
  });

  return new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("⚙️ Server Feature Settings")
    .setDescription(
      "Toggle features on/off. Changes take effect immediately.\n\n" +
      lines.join("\n"),
    )
    .setFooter({ text: "Click a button below to toggle that feature" })
    .setTimestamp();
}

export function buildSettingsRows(s: ServerSettings): ActionRowBuilder<ButtonBuilder>[] {
  const boolFeatures = FEATURE_META.filter(f => typeof s[f.key] === "boolean");

  const chunks: Array<typeof FEATURE_META> = [];
  for (let i = 0; i < boolFeatures.length; i += 5) chunks.push(boolFeatures.slice(i, i + 5));

  const rows = chunks.map(chunk => {
    const row = new ActionRowBuilder<ButtonBuilder>();
    chunk.forEach(f => {
      const val = s[f.key] as boolean;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`settings_toggle:${f.key}`)
          .setLabel(`${val ? "ON" : "OFF"} — ${f.label}`)
          .setStyle(val ? ButtonStyle.Success : ButtonStyle.Danger),
      );
    });
    return row;
  });

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ao_server_settings")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ao_hub_close")
      .setLabel("✖ Close")
      .setStyle(ButtonStyle.Danger),
  );

  return [...rows, navRow];
}
