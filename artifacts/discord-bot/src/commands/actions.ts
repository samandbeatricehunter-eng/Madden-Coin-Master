import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { getServerSettings } from "../lib/server-settings.js";
import { isAdminUser, getOrCreateUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "../lib/week-helpers.js";
import {
  buildMenuHubEmbed, buildMenuHubRows,
  buildUnlinkedMenuEmbed, buildUnlinkedMenuRows,
  buildMenuBannerAttachment,
  type MenuCtx,
} from "../lib/menu-hub.js";

const COMMISSIONER_ROLE_NAME = "Commissioner";

export const data = new SlashCommandBuilder()
  .setName("menu")
  .setDescription("League menu — economy, rosters, rankings, payouts, rules — and admin tools for commissioners");

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
  const isCommissioner = member?.roles.cache.some((r) => r.name === COMMISSIONER_ROLE_NAME) ?? false;

  const seasonNum = season.seasonNumber;
  const wkStr     = weekLabel(season.currentWeek);

  const ctx: MenuCtx = { settings, isAdmin, isCommissioner, seasonNum, weekStr: wkStr };

  if (!user.team && !isAdmin && !isCommissioner) {
    await interaction.editReply({
      embeds:     [buildUnlinkedMenuEmbed(seasonNum, wkStr)],
      components: buildUnlinkedMenuRows(),
      files:      [buildMenuBannerAttachment()],
    });
    return;
  }

  await interaction.editReply({
    embeds:     [buildMenuHubEmbed(settings, isAdmin, seasonNum, wkStr)],
    components: buildMenuHubRows(ctx),
    files:      [buildMenuBannerAttachment()],
  });
}
