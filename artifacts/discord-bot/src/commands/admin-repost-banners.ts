import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder,
  Colors, PermissionFlagsBits, TextChannel, AttachmentBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import {
  gameChannelsTable, franchiseMcaTeamsTable, usersTable, defaultTeamLogosTable,
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

  const weekNum   = parseInt(season.currentWeek ?? "1", 10);
  const weekIndex = isNaN(weekNum) ? 0 : weekNum - 1;

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

  // ── MCA team lookup (guild-specific logo overrides + teamId for AI breakdown) ─
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

  const mcaByName      = new Map<string, typeof mcaTeams[0]>();
  const mcaByDiscordId = new Map<string, typeof mcaTeams[0]>();
  for (const t of mcaTeams) {
    mcaByName.set(t.fullName.toLowerCase().trim(), t);
    mcaByName.set(t.nickName.toLowerCase().trim(), t);
    if (t.discordId) mcaByDiscordId.set(t.discordId, t);
  }

  // ── Global default logos (fallback when MCA lookup misses or no guild override) ─
  // These are uploaded via /adminteamlogo setglobal and stored in defaultTeamLogosTable
  const defaultLogos = await db
    .select({
      teamId:   defaultTeamLogosTable.teamId,
      fullName: defaultTeamLogosTable.fullName,
      nickName: defaultTeamLogosTable.nickName,
      logoUrl:  defaultTeamLogosTable.logoUrl,
    })
    .from(defaultTeamLogosTable);

  const defaultByName = new Map<string, string>(); // name → GCS path
  const defaultById   = new Map<number, string>(); // teamId → GCS path
  for (const d of defaultLogos) {
    defaultByName.set(d.fullName.toLowerCase().trim(), d.logoUrl);
    defaultByName.set(d.nickName.toLowerCase().trim(), d.logoUrl);
    defaultById.set(d.teamId, d.logoUrl);
  }

  /** Resolve the best GCS logo path for a team name.
   *  Falls back to discordId lookup when the name isn't indexed in the MCA map
   *  (happens when usersTable.team doesn't match the Madden CFM fullName/nickName).
   */
  function resolveLogoPath(teamName: string, discordId?: string): string | null {
    const key = teamName.toLowerCase().trim();
    const mca = mcaByName.get(key) ?? (discordId ? mcaByDiscordId.get(discordId) : undefined);

    // 1. Guild-specific logo override
    if (mca?.logoUrl) return mca.logoUrl;

    // 2. defaultTeamLogosTable match by MCA teamId (works for standard 0–31 range)
    if (mca?.teamId != null) {
      const byId = defaultById.get(mca.teamId);
      if (byId) return byId;
    }

    // 3. Exact name / nickname match in defaultTeamLogosTable
    const exact = defaultByName.get(key);
    if (exact) return exact;

    // 4. Partial: stored name contains a known nickname
    for (const d of defaultLogos) {
      if (key.includes(d.nickName.toLowerCase().trim())) return d.logoUrl;
    }

    // 5. Last resort: constructed GCS path — only valid for standard teamIds 0–31
    if (mca?.teamId != null && mca.teamId <= 31) return globalLogoPath(mca.teamId);

    return null;
  }

  // ── User team → discordId map (for mention tags) ──────────────────────────
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
    const ch = interaction.client.channels.cache.get(gc.channelId)
      ?? await interaction.client.channels.fetch(gc.channelId).catch(() => null);

    if (!ch?.isTextBased()) {
      results.push(`⚠️ **${gc.awayTeamName} vs ${gc.homeTeamName}** — channel not found`);
      skipped++;
      continue;
    }
    const tc = ch as TextChannel;

    const awayDiscordId = userByTeam.get(gc.awayTeamName.toLowerCase().trim()) ?? "";
    const homeDiscordId = userByTeam.get(gc.homeTeamName.toLowerCase().trim()) ?? "";

    // ── Delete existing bot messages (banner + AI breakdown) ─────────────────
    // Only scan the most recent 100 messages — bot posts are always recent
    try {
      const botId           = interaction.client.user!.id;
      const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const fetched         = await tc.messages.fetch({ limit: 100 });
      const botMsgs         = fetched.filter(m => m.author.id === botId);

      const fresh = botMsgs.filter(m => m.createdTimestamp > fourteenDaysAgo);
      const stale = botMsgs.filter(m => m.createdTimestamp <= fourteenDaysAgo);

      if (fresh.size === 1) {
        await fresh.first()!.delete().catch(() => {});
      } else if (fresh.size > 1) {
        await tc.bulkDelete(fresh).catch(() => {});
      }
      for (const msg of stale.values()) {
        await msg.delete().catch(() => {});
      }
    } catch (e) {
      console.error(`[adminrepostbanners] Cleanup error for ${gc.awayTeamName} vs ${gc.homeTeamName}:`, e);
    }

    let postedBanner    = false;
    let postedBreakdown = false;

    // ── Banner ────────────────────────────────────────────────────────────────
    const awayGcsPath = resolveLogoPath(gc.awayTeamName, awayDiscordId || undefined);
    const homeGcsPath = resolveLogoPath(gc.homeTeamName, homeDiscordId || undefined);

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
        } else {
          console.warn(`[adminrepostbanners] Logo buffer null — away: ${awayGcsPath}, home: ${homeGcsPath}`);
        }
      } catch (e) {
        console.error(`[adminrepostbanners] Banner error for ${gc.awayTeamName} vs ${gc.homeTeamName}:`, e);
      }
    } else {
      console.warn(`[adminrepostbanners] No logo path — away: "${gc.awayTeamName}" (${awayGcsPath}), home: "${gc.homeTeamName}" (${homeGcsPath})`);
    }

    // ── AI breakdown ─────────────────────────────────────────────────────────
    // Name lookup first; fall back to discordId when usersTable.team ≠ MCA fullName/nickName
    const awayMca = mcaByName.get(gc.awayTeamName.toLowerCase().trim())
      ?? (awayDiscordId ? mcaByDiscordId.get(awayDiscordId) : undefined);
    const homeMca = mcaByName.get(gc.homeTeamName.toLowerCase().trim())
      ?? (homeDiscordId ? mcaByDiscordId.get(homeDiscordId) : undefined);

    let breakdownStatus = "❌ no breakdown (no MCA roster data)";
    if (awayMca?.teamId != null && homeMca?.teamId != null) {
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
        breakdownStatus = "🤖 breakdown";
      } catch (e) {
        console.error(`[adminrepostbanners] AI breakdown error for ${gc.awayTeamName} vs ${gc.homeTeamName}:`, e);
        breakdownStatus = "❌ no breakdown (generation error)";
      }
    }

    const statusBanner = postedBanner
      ? "🖼️ banner"
      : `❌ no banner (paths: ${awayGcsPath ?? "none"} / ${homeGcsPath ?? "none"})`;
    results.push(`<#${gc.channelId}> — ${statusBanner} · ${breakdownStatus}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summaryEmbed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📤 Repost Results — ${weekLabel}`)
    .setDescription(results.join("\n").slice(0, 4096))
    .addFields(
      { name: "🖼️ Banners posted",    value: String(bannerOk),    inline: true },
      { name: "🤖 Breakdowns posted", value: String(breakdownOk), inline: true },
      { name: "⚠️ Skipped",           value: String(skipped),     inline: true },
    );

  await interaction.editReply({ embeds: [summaryEmbed] });
}
