import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { getServerSettings } from "../lib/db/server-settings.js";
import { isAdminUser, getOrCreateUser, getOrCreateActiveSeason } from "../lib/db/db-helpers.js";
import { weekLabel } from "../lib/helpers/week-helpers.js";
import {
  buildMenuHubEmbed, buildMenuHubRows,
  buildUnlinkedMenuEmbed, buildUnlinkedMenuRows,
  buildMenuBannerAttachment,
  type MenuCtx,
} from "../lib/menu/menu-hub.js";
import { getCommOfficeCounts, getGotwUnvotedCount, getGotyStatus } from "../lib/menu/notif-counts.js";

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

  const [commCounts, gotwUnvoted, goty] = await Promise.all([
    (isAdmin || isCommissioner)
      ? getCommOfficeCounts(gid).catch(() => null)
      : Promise.resolve(null),
    getGotwUnvotedCount(uid, season.id).catch(() => 0),
    getGotyStatus(uid, season.id).catch(() => ({ unvoted: 0, active: false })),
  ]);

  const ctx: MenuCtx = {
    settings, isAdmin, isCommissioner, seasonNum, weekStr: wkStr,
    commOfficeTotal: commCounts?.total ?? 0,
    gotwUnvotedCount: gotwUnvoted ?? 0,
    gotyUnvotedCount: goty.unvoted,
    gotyActive: goty.active,
  };

  if (!user.team && !isAdmin && !isCommissioner) {
    await interaction.editReply({
      embeds:     [buildUnlinkedMenuEmbed(seasonNum, wkStr)],
      components: buildUnlinkedMenuRows(),
      files:      buildMenuBannerAttachment(),
    });
    return;
  }

  await interaction.editReply({
    embeds:     [buildMenuHubEmbed(settings, isAdmin, seasonNum, wkStr)],
    components: buildMenuHubRows(ctx),
    files:      buildMenuBannerAttachment(),
  });
}
