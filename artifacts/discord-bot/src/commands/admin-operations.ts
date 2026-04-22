import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
} from "discord.js";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { weekLabel } from "../lib/week-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("admin-menu")
  .setDescription("Admin hub — manage week, season, payouts, rules, and all league settings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export function buildAdminOpsEmbed(seasonNum?: number, weekStr?: string): EmbedBuilder {
  const header = (seasonNum != null && weekStr)
    ? `**Season ${seasonNum} · ${weekStr}**\n\n`
    : "";
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("⚙️ Admin Operations Hub")
    .setDescription(header +
      "**📅 Set Week** — Change the current week without triggering auto-actions.\n" +
      "**⏩ Advance Week** — Advance to next week with full auto-actions (matchups, GOTW, articles, playoffs).\n" +
      "**🔢 Set Season** — Jump the active season to a specific number.\n" +
      "**💰 Payouts** — Open the payout management hub.\n\n" +

      "**📋 Post Matchups/GOTW** — Manually post matchup embeds and GOTW poll for the current week.\n" +
      "**🎮 Post Game Channels** — Repost banners and AI breakdowns to all game channels.\n" +
      "**📰 Post Custom Article** — Generate and post a one-off AI article to headlines.\n" +
      "**🐦 Rerun Media Cycle** — Re-trigger the league Twitter burst for the current week.\n" +
      "**📜 Rerun Season Historical** — Rebuild the historical records channel for this season.\n\n" +

      "**🏈 League Data** — EA connection, data import, and season data tools.\n" +
      "**👤 User Data** — Manage individual user economy, records, and links.\n" +
      "**🏪 Store Settings** — Archetypes, legend templates, prices, and caps.\n" +
      "**⚙️ Server Settings** — Toggle features, initialize server, manage rules/admins/waitlist.\n\n" +

      "**🔧 Troubleshoot** — Repair and maintenance tools.\n" +
      "**🐛 Report Bug** — Submit a bug report to the commissioner log."
    )
    .setFooter({ text: "Admin Operations Hub — selections expire after 15 minutes" })
    .setTimestamp();
}

export function buildAdminOpsRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_set_week").setLabel("📅 Set Week").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_advance_week").setLabel("⏩ Advance Week").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_set_season_num").setLabel("🔢 Set Season").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ao_payouts").setLabel("💰 Payouts").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_post_matchups").setLabel("📋 Post Matchups/GOTW").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_post_game_channels").setLabel("🎮 Post Game Channels").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_post_custom_article").setLabel("📰 Post Custom Article").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_rerun_media").setLabel("🐦 Rerun Media Cycle").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ao_rerun_hist").setLabel("📜 Rerun Season Historical").setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_league_data").setLabel("🏈 League Data").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_user_data").setLabel("👤 User Data").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_store_settings").setLabel("🏪 Store Settings").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("ao_server_settings").setLabel("⚙️ Server Settings").setStyle(ButtonStyle.Success),
  );
  const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ao_troubleshoot").setLabel("🔧 Troubleshoot").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ao_report_bug").setLabel("🐛 Report Bug").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ao_hub_close").setLabel("✖ Close Menu").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2, row3, row4];
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const gid  = interaction.guildId!;
  const uid  = interaction.user.id;

  const member = await interaction.guild?.members.fetch(uid).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isBotAdmin     = await isAdminUser(uid, gid);

  if (!isDiscordAdmin && !isBotAdmin) {
    await interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
    return;
  }

  const season = await getOrCreateActiveSeason(gid).catch(() => null);
  const wkStr  = season ? weekLabel(season.currentWeek) : undefined;
  await interaction.reply({
    embeds: [buildAdminOpsEmbed(season?.seasonNumber ?? undefined, wkStr)],
    components: buildAdminOpsRows(),
    ephemeral: true,
  });
}
