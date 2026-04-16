import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  Colors, PermissionFlagsBits, TextChannel, AttachmentBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import {
  gameChannelsTable, franchiseMcaTeamsTable, seasonsTable, usersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { buildMatchupBanner, resolveLogoBuf } from "../lib/matchup-image.js";
import { generateMatchupBreakdown } from "../lib/matchup-ai-breakdown.js";
import { globalLogoPath } from "../lib/gcs-reader.js";

export const data = new SlashCommandBuilder()
  .setName("adminrepostbanners")
  .setDescription("Re-post matchup banners and AI breakdowns to all game channels for the current week")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!await isAdminUser(interaction.user.id, interaction.guildId!)) {
    await interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const season  = await getOrCreateActiveSeason(guildId);

  // Resolve the current weekIndex from the season's currentWeek string
  const weekNum = parseInt(season.currentWeek ?? "1", 10);
  // weekIndex is 0-based in the table
  const weekIndex = isNaN(weekNum) ? 0 : weekNum - 1;

  // Find all game channels stored for this season + week
  const channels = await db
    .select()
    .from(gameChannelsTable)
    .where(and(
      eq(gameChannelsTable.seasonId, season.id),
      eq(gameChannelsTable.weekIndex, weekIndex),
    ));

  if (channels.length === 0) {
    await interaction.editReply(
      `❌ No game channels found for Season ${season.seasonNumber} Week ${season.currentWeek}.\n` +
      `Run \`/advanceweek\` first to create channels.`,
    );
    return;
  }

  // Build lookup maps from franchise MCA teams for this season
  const mcaTeams = await db
    .select({
      teamId:    franchiseMcaTeamsTable.teamId,
      fullName:  franchiseMcaTeamsTable.fullName,
      nickName:  franchiseMcaTeamsTable.nickName,
      discordId: franchiseMcaTeamsTable.discordId,
      logoUrl:   franchiseMcaTeamsTable.logoUrl,
    })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id));

  // Index by name and discordId
  const teamByName = new Map<string, typeof mcaTeams[0]>();
  const teamByDiscordId = new Map<string, typeof mcaTeams[0]>();
  for (const t of mcaTeams) {
    teamByName.set(t.fullName.toLowerCase().trim(), t);
    teamByName.set(t.nickName.toLowerCase().trim(), t);
    if (t.discordId) teamByDiscordId.set(t.discordId, t);
  }

  // Map user team names → discordId (for mention tags)
  const userRows = await db
    .select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable)
    .where(eq(usersTable.guildId, guildId));
  const userByTeam = new Map<string, string>();
  for (const u of userRows) {
    if (u.team) userByTeam.set(u.team.toLowerCase().trim(), u.discordId);
  }

  const weekLabel = `Season ${season.seasonNumber} — Week ${season.currentWeek}`;
  const results: string[] = [];
  let bannerOk = 0, breakdownOk = 0, skipped = 0;

  for (const gc of channels) {
    // Fetch the Discord channel
    const ch = interaction.client.channels.cache.get(gc.channelId)
      ?? await interaction.client.channels.fetch(gc.channelId).catch(() => null);

    if (!ch?.isTextBased()) {
      results.push(`⚠️ **${gc.awayTeamName} vs ${gc.homeTeamName}** — channel not found`);
      skipped++;
      continue;
    }
    const tc = ch as TextChannel;

    // Resolve MCA entries — use stored proper names from gameChannelsTable
    const awayMca = teamByName.get(gc.awayTeamName.toLowerCase().trim());
    const homeMca = teamByName.get(gc.homeTeamName.toLowerCase().trim());

    // Resolve discord mentions
    const awayDiscordId = userByTeam.get(gc.awayTeamName.toLowerCase().trim()) ?? "";
    const homeDiscordId = userByTeam.get(gc.homeTeamName.toLowerCase().trim()) ?? "";

    let postedBanner    = false;
    let postedBreakdown = false;

    // ── Banner ────────────────────────────────────────────────────────────────
    const awayGcsPath = awayMca?.logoUrl ?? (awayMca?.teamId != null ? globalLogoPath(awayMca.teamId) : null);
    const homeGcsPath = homeMca?.logoUrl ?? (homeMca?.teamId != null ? globalLogoPath(homeMca.teamId) : null);

    if (awayGcsPath && homeGcsPath) {
      try {
        const [awayBuf, homeBuf] = await Promise.all([
          resolveLogoBuf(awayGcsPath),
          resolveLogoBuf(homeGcsPath),
        ]);
        if (awayBuf && homeBuf) {
          const bannerBuf  = await buildMatchupBanner(awayBuf, homeBuf);
          const attachment = new AttachmentBuilder(bannerBuf, { name: "matchup-banner.png" });
          const bannerEmbed = new EmbedBuilder()
            .setColor(0x7c3aed)
            .setTitle(`${gc.awayTeamName} @ ${gc.homeTeamName}`)
            .setDescription(
              awayDiscordId && homeDiscordId
                ? `<@${awayDiscordId}> **vs** <@${homeDiscordId}>`
                : `**${gc.awayTeamName}** vs **${gc.homeTeamName}**`,
            )
            .setImage("attachment://matchup-banner.png")
            .setFooter({ text: weekLabel });
          await tc.send({ embeds: [bannerEmbed], files: [attachment] });
          postedBanner = true;
          bannerOk++;
        }
      } catch (e) {
        console.error(`[adminrepostbanners] Banner error for ${gc.awayTeamName} vs ${gc.homeTeamName}:`, e);
      }
    }

    // ── AI breakdown ─────────────────────────────────────────────────────────
    if (awayMca?.teamId && homeMca?.teamId) {
      try {
        const breakdownEmbed = await generateMatchupBreakdown({
          seasonId:       season.id,
          awayTeamName:   gc.awayTeamName,
          homeTeamName:   gc.homeTeamName,
          awayTeamId:     awayMca.teamId,
          homeTeamId:     homeMca.teamId,
          awayDiscordId:  awayDiscordId || gc.awayTeamName,
          homeDiscordId:  homeDiscordId || gc.homeTeamName,
          awayDiscordTag: awayDiscordId ? `<@${awayDiscordId}>` : gc.awayTeamName,
          homeDiscordTag: homeDiscordId ? `<@${homeDiscordId}>` : gc.homeTeamName,
          weekLabel,
        });
        await tc.send({ embeds: [breakdownEmbed] });
        postedBreakdown = true;
        breakdownOk++;
      } catch (e) {
        console.error(`[adminrepostbanners] AI breakdown error for ${gc.awayTeamName} vs ${gc.homeTeamName}:`, e);
      }
    }

    const statusBanner    = postedBanner    ? "🖼️ banner" : "❌ no banner";
    const statusBreakdown = postedBreakdown ? "🤖 breakdown" : "❌ no breakdown";
    results.push(`<#${gc.channelId}> — ${statusBanner} · ${statusBreakdown}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summaryEmbed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📤 Repost Results — ${weekLabel}`)
    .setDescription(results.join("\n"))
    .addFields(
      { name: "🖼️ Banners posted",     value: String(bannerOk),    inline: true },
      { name: "🤖 Breakdowns posted",  value: String(breakdownOk), inline: true },
      { name: "⚠️ Skipped",            value: String(skipped),     inline: true },
    )
    .setFooter({ text: bannerOk === 0 ? "No banners? Upload logos via /adminteamlogo setglobal" : "" });

  await interaction.editReply({ embeds: [summaryEmbed] });
}
