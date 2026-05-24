import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder, PermissionFlagsBits,
} from "discord.js";
import { getServerSettings } from "../lib/server-settings.js";
import type { ServerSettings } from "../lib/server-settings.js";
import { isAdminUser, getOrCreateUser, getOrCreateActiveSeason, getSeasonRules } from "../lib/db-helpers.js";
import { weekLabel } from "../lib/week-helpers.js";
import { buildUserProfilePages } from "../lib/user-stats-embed.js";
import {
  buildMenuHubEmbed, buildMenuHubRows,
  buildUnlinkedMenuEmbed, buildUnlinkedMenuRows,
} from "../lib/menu-hub.js";

export const data = new SlashCommandBuilder()
  .setName("menu")
  .setDescription("League menu — economy, rosters, rankings, payouts, rules — and admin tools for commissioners");

// ── Back-compat exports used by lib/actions-handlers.ts ──────────────────────
// These now delegate to the new selector-based hub.

export function buildActionsHubEmbed(
  settings: ServerSettings,
  isAdmin: boolean,
  seasonNum?: number,
  weekStr?: string,
): EmbedBuilder {
  return buildMenuHubEmbed(settings, isAdmin, seasonNum, weekStr);
}

export function buildActionsHubRows(
  settings: ServerSettings,
  isAdmin: boolean,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  return buildMenuHubRows(settings, isAdmin);
}

export function buildUnlinkedHubEmbed(seasonNum?: number, weekStr?: string): EmbedBuilder {
  return buildUnlinkedMenuEmbed(seasonNum, weekStr);
}

export function buildUnlinkedHubRows(): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  return buildUnlinkedMenuRows();
}

// ── Slash command execute ────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const gid = interaction.guildId!;
  const uid = interaction.user.id;

  await interaction.deferReply({ ephemeral: true });

  const [settings, member, user, season] = await Promise.all([
    getServerSettings(gid),
    interaction.guild?.members.fetch(uid).catch(() => null),
    getOrCreateUser(uid, interaction.user.username, gid),
    getOrCreateActiveSeason(gid),
  ]);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(uid, gid);
  const isAdmin        = isDiscordAdmin || isDbAdmin;

  const seasonNum = season.seasonNumber;
  const wkStr     = weekLabel(season.currentWeek);

  // ── Unlinked user — show welcome hub ───────────────────────────────────────
  if (!user.team && !isAdmin) {
    await interaction.editReply({
      embeds:     [buildUnlinkedMenuEmbed(seasonNum, wkStr)],
      components: buildUnlinkedMenuRows(),
    });
    return;
  }

  // ── Linked user — main hub + profile pages ────────────────────────────────
  const rules = await getSeasonRules(season);
  const profilePages = await buildUserProfilePages(
    uid, gid, user, season, settings, rules,
    interaction.user.displayAvatarURL(),
    (member as import("discord.js").GuildMember | null)?.nickname
      ?? interaction.user.displayName
      ?? interaction.user.username,
  );

  await interaction.editReply({
    embeds:     [buildMenuHubEmbed(settings, isAdmin, seasonNum, wkStr), ...profilePages],
    components: buildMenuHubRows(settings, isAdmin),
  });
}
