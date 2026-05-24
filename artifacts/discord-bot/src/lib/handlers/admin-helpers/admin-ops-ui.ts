import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder,
  EmbedBuilder, PermissionFlagsBits,
} from "discord.js";
import { isAdminUser, getOrCreateActiveSeason } from "../../db/db-helpers.js";
import { weekLabel } from "../../helpers/week-helpers.js";
import { buildAdminHubPage } from "../../menu/menu-hub.js";

const data = new SlashCommandBuilder()
  .setName("admin-menu")
  .setDescription("Admin hub — manage week, season, payouts, rules, and all league settings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

// ── Back-compat exports used by lib/admin-operations-handlers.ts ─────────────
// These now delegate to the new selector-based admin hub.

export function buildAdminOpsEmbed(seasonNum?: number, weekStr?: string): EmbedBuilder {
  return buildAdminHubPage(seasonNum, weekStr).embed;
}

export function buildAdminOpsRows(): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  return buildAdminHubPage().rows as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

async function execute(interaction: ChatInputCommandInteraction) {
  const gid  = interaction.guildId!;
  const uid  = interaction.user.id;

  const member = await interaction.guild?.members.fetch(uid).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isBotAdmin     = await isAdminUser(uid, gid);

  if (!isDiscordAdmin && !isBotAdmin) {
    await interaction.reply({
      content: "❌ You don't have permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const season    = await getOrCreateActiveSeason(gid);
  const seasonNum = season.seasonNumber;
  const wkStr     = weekLabel(season.currentWeek);

  const page = buildAdminHubPage(seasonNum, wkStr);
  await interaction.editReply({
    embeds:     [page.embed],
    components: page.rows as any,
  });
}
