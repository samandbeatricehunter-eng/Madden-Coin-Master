import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, ChannelType, TextChannel,
  ActionRowBuilder, ButtonBuilder, ComponentType,
} from "discord.js";
import { db } from "@workspace/db";
import {
  seasonsTable, franchiseScheduleTable, usersTable, gameChannelsTable,
  gotwHistoryTable, franchiseMcaTeamsTable, leagueTwitterTable,
  playerSeasonStatsTable, playerStatWeekProcessedTable,
  gameLogTable, userRecordsTable, statPaddingViolationsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason, addBalance, logTransaction, getGuildChannel, CHANNEL_KEYS } from "../lib/db-helpers.js";
import { generateFranchiseArticle, generateWeekPreview } from "../lib/franchise-article.js";
import { runWildcardAutomation, runOffseasonHistoricalPost } from "../lib/wildcard-automation.js";
import { runEosAutoPost } from "../lib/eos-auto-post.js";
import { getPayoutValue, PAYOUT_KEYS } from "../lib/payout-config.js";
import { sendArticleChunked } from "../lib/send-article.js";
import { runWeeklyMatchupsFlow } from "../lib/weekly-matchups-runner.js";
import { postFullSeasonScheduleToChannel } from "../lib/season-schedule-post.js";
import { PLAYOFF_WEEK_META, runPlayoffMatchupsFlow, payoutPlayoffRoundResults } from "../lib/playoff-matchups-runner.js";
import { autoPayoutPlayoffGotw, purgeChannel } from "../lib/gotw-helpers.js";
import { triggerWeekAdvanceTweets } from "../lib/league-twitter.js";
import { checkAndNotifyWaitlist } from "./waitlist.js";
import { buildMatchupBanner, resolveLogoBuf } from "../lib/matchup-image.js";
import { generateMatchupBreakdown } from "../lib/matchup-ai-breakdown.js";
import { globalLogoPath, guildLogoPath } from "../lib/gcs-reader.js";
import { AttachmentBuilder } from "discord.js";

const MATCHUP_CATEGORY_ID  = "1478427821666861272";
const ANNOUNCE_CHANNEL_ID  = "1484689142515368188"; // general announcements / rule-change channel

// Channels wiped completely when advancing to offseason (excludes ANNOUNCE_CHANNEL_ID which is posted to, not just wiped)
const OFFSEASON_WIPE_CHANNEL_IDS = [
  "1486034589808853114",
  "1477507190104527011",
  "1485643704206229638",
  "1486369417309978644",
  "1477717664804896899",
  "1478777175128932463",
  "1478947361014288445",
  "1484689142515368188",
  "1492213174697726033", // league-twitter channel
];

export const WEEK_SEQUENCE = [
  "1","2","3","4","5","6","7","8","9","10",
  "11","12","13","14","15","16","17","18",
  "wildcard","divisional","conference","superbowl","offseason","training_camp",
];

export function weekLabel(week: string): string {
  if (/^\d+$/.test(week)) return `Week ${week}`;
  if (week === "training_camp") return "Training Camp";
  return week.charAt(0).toUpperCase() + week.slice(1);
}

function toChannelName(teamName: string): string {
  return teamName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");
}

export const data = new SlashCommandBuilder()
  .setName("advanceweek")
  .setDescription("Advance or set the current league week (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("week")
      .setDescription("The week to set")
      .setRequired(false)
      .addChoices(
        { name: "Week 1",        value: "1"  },
        { name: "Week 2",        value: "2"  },
        { name: "Week 3",        value: "3"  },
        { name: "Week 4",        value: "4"  },
        { name: "Week 5",        value: "5"  },
        { name: "Week 6",        value: "6"  },
        { name: "Week 7",        value: "7"  },
        { name: "Week 8",        value: "8"  },
        { name: "Week 9",        value: "9"  },
        { name: "Week 10",       value: "10" },
        { name: "Week 11",       value: "11" },
        { name: "Week 12",       value: "12" },
        { name: "Week 13",       value: "13" },
        { name: "Week 14",       value: "14" },
        { name: "Week 15",       value: "15" },
        { name: "Week 16",       value: "16" },
        { name: "Week 17",       value: "17" },
        { name: "Week 18",       value: "18" },
        { name: "Wildcard",      value: "wildcard"    },
        { name: "Divisional",    value: "divisional"  },
        { name: "Conference",    value: "conference"  },
        { name: "Super Bowl",    value: "superbowl"   },
        { name: "Offseason",       value: "offseason"     },
        { name: "Training Camp",   value: "training_camp" },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member        = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id, interaction.guildId!);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const season = await getOrCreateActiveSeason(interaction.guildId!);
  const chosenWeek = interaction.options.getString("week");

  let newWeek: string;
  if (chosenWeek) {
    newWeek = chosenWeek;
  } else {
    const currentIdx = WEEK_SEQUENCE.indexOf(season.currentWeek ?? "1");
    const nextIdx    = currentIdx === -1 ? 0 : Math.min(currentIdx + 1, WEEK_SEQUENCE.length - 1);
    newWeek = WEEK_SEQUENCE[nextIdx]!;
  }

  await db.update(seasonsTable)
    .set({ currentWeek: newWeek })
    .where(eq(seasonsTable.id, season.id));

  // Declare channelLines early so both GOTW bonus and channel lifecycle can append to it
  const channelLines: string[] = [];

  // ── Wipe preseason stats when advancing from Training Camp → Week 1 ─────────
  let preseasonWipeNote = "";
  if (season.currentWeek === "training_camp" && newWeek === "1") {
    try {
      await Promise.all([
        db.delete(playerSeasonStatsTable)      .where(eq(playerSeasonStatsTable.seasonId,      season.id)),
        db.delete(playerStatWeekProcessedTable).where(eq(playerStatWeekProcessedTable.seasonId, season.id)),
        db.delete(gameLogTable)                .where(eq(gameLogTable.seasonId,                 season.id)),
        db.delete(userRecordsTable)            .where(eq(userRecordsTable.seasonId,              season.id)),
        db.delete(statPaddingViolationsTable)  .where(eq(statPaddingViolationsTable.seasonId,   season.id)),
      ]);
      preseasonWipeNote =
        "✅ Preseason stats cleared (player stats, game logs, W/L records, and violation flags have been reset for the regular season).";
      console.log(`[advanceweek] Preseason stats wiped for season ${season.id}`);
    } catch (err) {
      preseasonWipeNote = "⚠️ Preseason stat wipe partially failed — check logs.";
      console.error("[advanceweek] Preseason stat wipe error:", err);
    }
  }

  // ── GOTW bonus + cleanup for the week we're leaving ──────────────────────
  const oldWeekNum = parseInt(season.currentWeek ?? "1", 10);
  if (!isNaN(oldWeekNum) && oldWeekNum >= 1 && oldWeekNum <= 18) {
    const oldWeekIndex = oldWeekNum - 1;

    try {
      // Look up confirmed GOTW for this week
      const [gotwRow] = await db.select()
        .from(gotwHistoryTable)
        .where(and(
          eq(gotwHistoryTable.seasonId,  season.id),
          eq(gotwHistoryTable.weekIndex, oldWeekIndex),
        ))
        .limit(1);

      if (gotwRow) {
        // Find the actual game in the schedule — match by team names (case-insensitive)
        const scheduleGames = await db.select()
          .from(franchiseScheduleTable)
          .where(and(
            eq(franchiseScheduleTable.seasonId,  season.id),
            eq(franchiseScheduleTable.weekIndex, oldWeekIndex),
          ));

        const gotwGame = scheduleGames.find(g =>
          g.awayTeamName.toLowerCase().trim() === gotwRow.teamName1.toLowerCase().trim() &&
          g.homeTeamName.toLowerCase().trim() === gotwRow.teamName2.toLowerCase().trim()
        );

        // Only award if status = 3 (H2H user-played — not CPU-simmed)
        if (gotwGame && gotwGame.status === 3) {
          const GOTW_BONUS = 10;
          await addBalance(gotwRow.discordId1, GOTW_BONUS, interaction.guildId!);
          await logTransaction(gotwRow.discordId1, GOTW_BONUS, "addcoins",
            `GOTW participant bonus — Week ${oldWeekNum}`, "system");

          await addBalance(gotwRow.discordId2, GOTW_BONUS, interaction.guildId!);
          await logTransaction(gotwRow.discordId2, GOTW_BONUS, "addcoins",
            `GOTW participant bonus — Week ${oldWeekNum}`, "system");

          channelLines.push(
            `🏆 GOTW bonus: **+${GOTW_BONUS} coins** awarded to <@${gotwRow.discordId1}> & <@${gotwRow.discordId2}>`,
          );

          // Notify both players via DM
          for (const discordId of [gotwRow.discordId1, gotwRow.discordId2]) {
            try {
              const user = await interaction.client.users.fetch(discordId);
              await user.send(
                `🏆 **GOTW Bonus!** You participated in this week's Game of the Week and earned **+${GOTW_BONUS} coins**!`
              ).catch(() => {});
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      console.error("[advanceweek] GOTW bonus error:", err);
    }

    // GOTW channel is fully cleared by /weeklymatchups instead
  }

  // ── Playoff payouts — fires when leaving a playoff week ──────────────────────
  // 1. Record playoff W/L + issue per-win coins and elimination bonus
  // 2. Pay all correct GOTW voters (10 coins each)
  const leavingPlayoffMeta = PLAYOFF_WEEK_META[season.currentWeek ?? ""];
  if (leavingPlayoffMeta) {
    // 1. Playoff W/L records + coin payouts
    try {
      const roundPayoutSummary = await payoutPlayoffRoundResults(
        interaction.client,
        season,
        season.currentWeek!,
      );
      if (roundPayoutSummary) channelLines.push(roundPayoutSummary);
    } catch (err) {
      console.error("[advanceweek] Playoff round payout error:", err);
    }

    // 2. GOTW correct-guess payouts
    try {
      const payoutSummary = await autoPayoutPlayoffGotw(
        interaction.client,
        season.id,
        leavingPlayoffMeta.weekIndex,
        season.currentWeek!,
      );
      if (payoutSummary) channelLines.push(payoutSummary);
    } catch (err) {
      console.error("[advanceweek] Playoff GOTW payout error:", err);
    }
  }

  const oldLabel = weekLabel(season.currentWeek ?? "1");
  const newLabel = weekLabel(newWeek);

  // ── Channel lifecycle ──────────────────────────────────────────────────────
  const guild = interaction.guild;

  if (guild) {
    // 1. Delete all previously tracked game channels for this season
    const oldChannels = await db.select()
      .from(gameChannelsTable)
      .where(eq(gameChannelsTable.seasonId, season.id));

    let deleted = 0;
    for (const row of oldChannels) {
      try {
        const ch = guild.channels.cache.get(row.channelId)
          ?? await guild.channels.fetch(row.channelId).catch(() => null);
        if (ch) {
          await ch.delete("Advance week — removing previous week's matchup channels");
          deleted++;
        }
      } catch (_) {}
    }

    if (oldChannels.length > 0) {
      await db.delete(gameChannelsTable)
        .where(eq(gameChannelsTable.seasonId, season.id));
      if (deleted > 0) channelLines.push(`🗑️ Removed **${deleted}** previous matchup channel${deleted !== 1 ? "s" : ""}`);
    }

    // 2. Create channels for regular-season weeks (1–18) and all playoff rounds.
    //    Offseason: no new channels created (old superbowl channels already deleted above).
    const newWeekNum = parseInt(newWeek, 10);
    let channelWeekIndex: number | null = null;
    let channelWeekDisplayLabel = weekLabel(newWeek);

    if (!isNaN(newWeekNum) && newWeekNum >= 1 && newWeekNum <= 18) {
      channelWeekIndex = newWeekNum - 1; // DB uses 0-based weekIndex
    } else if (PLAYOFF_WEEK_META[newWeek]) {
      channelWeekIndex = PLAYOFF_WEEK_META[newWeek]!.weekIndex;
    }
    // offseason: channelWeekIndex stays null → no channels created

    if (channelWeekIndex !== null) {
      const weekIndex = channelWeekIndex;

      // Fetch the schedule for this week
      const games = await db.select()
        .from(franchiseScheduleTable)
        .where(and(
          eq(franchiseScheduleTable.seasonId,  season.id),
          eq(franchiseScheduleTable.weekIndex, weekIndex),
        ));

      // Build team name (lowercase) → discordId map using the MCA teams table,
      // which already has alias-resolved discordIds from the franchise import.
      // This handles Madden CFM custom names like "G-Men", "Bolts", "Vikes", etc.
      const mcaTeams = await db.select({
        fullName:  franchiseMcaTeamsTable.fullName,
        nickName:  franchiseMcaTeamsTable.nickName,
        discordId: franchiseMcaTeamsTable.discordId,
        teamId:    franchiseMcaTeamsTable.teamId,
        logoUrl:   franchiseMcaTeamsTable.logoUrl,
      }).from(franchiseMcaTeamsTable)
        .where(eq(franchiseMcaTeamsTable.seasonId, season.id));

      const teamToDiscord = new Map<string, string>();
      const teamToMca     = new Map<string, typeof mcaTeams[0]>();
      for (const t of mcaTeams) {
        // Index by every name variant the game might send:
        //   fullName  → "Las Vegas Raiders"
        //   nickName  → "Raiders"
        //   teamId    → "1" (numeric string, last resort)
        const keys = [
          t.fullName.toLowerCase().trim(),
          t.nickName.toLowerCase().trim(),
          String(t.teamId),
        ];
        for (const key of keys) {
          if (!teamToMca.has(key)) teamToMca.set(key, t);
          if (t.discordId && !teamToDiscord.has(key)) teamToDiscord.set(key, t.discordId);
        }
      }


      // Fallback: also include usersTable.team mappings for any teams not in
      // the MCA teams table yet (e.g. before /franchiseupdate has been run).
      const allUsers = await db.select({
        discordId: usersTable.discordId,
        team:      usersTable.team,
      }).from(usersTable).where(eq(usersTable.guildId, interaction.guildId!));
      for (const u of allUsers) {
        if (u.team && !teamToDiscord.has(u.team.toLowerCase().trim())) {
          teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
        }
      }

      // Build a reverse map: discordId → proper NFL team name (from usersTable.team).
      // This is used for channel names so we never use Madden nicknames like "G-Men".
      const discordIdToProperTeam = new Map<string, string>();
      for (const u of allUsers) {
        if (u.team) discordIdToProperTeam.set(u.discordId, u.team);
      }

      // Filter to H2H games only: both teams must have a registered user
      const h2hGames = games.filter(g => {
        const awayId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim());
        const homeId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim());
        return awayId && homeId;
      });

      if (h2hGames.length === 0 && games.length > 0) {
        channelLines.push("📭 No H2H matchups found in schedule for this week — no channels created");
      } else if (games.length === 0) {
        channelLines.push("📭 No schedule data found for this week — run `/franchiseupdate` first");
      }

      let created = 0;
      for (const g of h2hGames) {
        const awayDiscordId = teamToDiscord.get(g.awayTeamName.toLowerCase().trim())!;
        const homeDiscordId = teamToDiscord.get(g.homeTeamName.toLowerCase().trim())!;

        // Use the proper NFL team name from usersTable for channel names,
        // falling back to the schedule name if no mapping is found.
        const awayProper = discordIdToProperTeam.get(awayDiscordId) ?? g.awayTeamName;
        const homeProper = discordIdToProperTeam.get(homeDiscordId) ?? g.homeTeamName;

        const chanName = `${toChannelName(awayProper)}-vs-${toChannelName(homeProper)}`;

        try {
          // Create the channel under the matchup category
          const newChannel = await guild.channels.create({
            name:   chanName,
            type:   ChannelType.GuildText,
            parent: MATCHUP_CATEGORY_ID,
          });

          // Sync permissions with the parent category
          await newChannel.lockPermissions();

          // Tag both users in the channel
          await newChannel.send(
            `🏈 **${awayProper} vs ${homeProper}** — ${channelWeekDisplayLabel}\n` +
            `<@${awayDiscordId}> <@${homeDiscordId}>\n` +
            `Good luck this week!`,
          );

          // Store the channel ID so we can delete it next advance
          await db.insert(gameChannelsTable).values({
            seasonId:     season.id,
            weekIndex,
            channelId:    newChannel.id,
            awayTeamName: awayProper,
            homeTeamName: homeProper,
          });

          // ── Matchup banner + AI breakdown (fire-and-forget so they don't block advance) ──
          (async () => {
            try {
              const awayMca = teamToMca.get(g.awayTeamName.toLowerCase().trim());
              const homeMca = teamToMca.get(g.homeTeamName.toLowerCase().trim());

              // ── Banner: guild-specific GCS path > global default GCS path ──────
              const awayGcsPath = awayMca?.logoUrl ?? (awayMca?.teamId ? globalLogoPath(awayMca.teamId) : null);
              const homeGcsPath = homeMca?.logoUrl ?? (homeMca?.teamId ? globalLogoPath(homeMca.teamId) : null);

              if (awayGcsPath && homeGcsPath) {
                const [awayBuf, homeBuf] = await Promise.all([
                  resolveLogoBuf(awayGcsPath),
                  resolveLogoBuf(homeGcsPath),
                ]);
                if (awayBuf && homeBuf) {
                  const bannerBuf  = await buildMatchupBanner(awayBuf, homeBuf);
                  const attachment = new AttachmentBuilder(bannerBuf, { name: "matchup-banner.png" });
                  const bannerEmbed = new EmbedBuilder()
                    .setColor(0x7c3aed)
                    .setTitle(`${awayProper} @ ${homeProper}`)
                    .setDescription(`<@${awayDiscordId}> **vs** <@${homeDiscordId}>`)
                    .setImage("attachment://matchup-banner.png")
                    .setFooter({ text: channelWeekDisplayLabel });
                  await newChannel.send({ embeds: [bannerEmbed], files: [attachment] });
                }
              }

              // ── AI breakdown (always, regardless of logo availability) ────────
              if (awayMca?.teamId && homeMca?.teamId) {
                const breakdownEmbed = await generateMatchupBreakdown({
                  seasonId:       season.id,
                  awayTeamName:   awayProper,
                  homeTeamName:   homeProper,
                  awayTeamId:     awayMca.teamId,
                  homeTeamId:     homeMca.teamId,
                  awayDiscordId,
                  homeDiscordId,
                  awayDiscordTag: `<@${awayDiscordId}>`,
                  homeDiscordTag: `<@${homeDiscordId}>`,
                  weekLabel:      channelWeekDisplayLabel,
                });
                await newChannel.send({ embeds: [breakdownEmbed] });
              }
            } catch (postErr) {
              console.error(`[advanceweek] Failed to post banner/breakdown for ${chanName}:`, postErr);
            }
          })();

          created++;
        } catch (chErr) {
          console.error(`[advanceweek] Failed to create channel for ${chanName}:`, chErr);
          channelLines.push(`⚠️ Could not create channel for **${g.awayTeamName} vs ${g.homeTeamName}**`);
        }
      }

      if (created > 0) {
        channelLines.push(`✅ Created **${created}** matchup channel${created !== 1 ? "s" : ""} under <#${MATCHUP_CATEGORY_ID}>`);
      }
    }
  }

  // ── Build reply embed ──────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("📅 League Week Updated")
    .addFields(
      { name: "Previous Week", value: oldLabel,         inline: true },
      { name: "Current Week",  value: `**${newLabel}**`, inline: true },
    )
    .setTimestamp();

  if (channelLines.length > 0) {
    embed.addFields({ name: "📺 Matchup Channels", value: channelLines.join("\n") });
  }

  if (preseasonWipeNote) {
    embed.addFields({ name: "🧹 Preseason Data Cleared", value: preseasonWipeNote });
  }

  if (newWeek === "wildcard") {
    embed.addFields({
      name: "⚠️ Wildcard Week — Action Required",
      value: [
        "Before games begin, complete these steps:",
        "**1.** `/admin-playoffs setnfcseeds` — Register NFC seeds 1–7",
        "**2.** `/admin-playoffs setafcseeds` — Register AFC seeds 1–7",
        "**3.** `/admin-playoffs divisionbonus` — Award +25 coins to all 8 division winners",
        "",
        "Seeds 1–4 in each conference earn **+75 coins/playoff win**.",
        "Seeds 5–7 (wildcard entrants) earn **+100 coins/playoff win**.",
        "All playoff losers receive **+50 coins** upon elimination.",
      ].join("\n"),
    });
    embed.setColor(Colors.Yellow);
  }

  await interaction.editReply({ embeds: [embed] });

  // ── League Twitter burst — fires on every week advance, never on a timer ──────
  // Runs fully async so the interaction reply is never delayed.
  triggerWeekAdvanceTweets(interaction.client, interaction.guildId!);

  // ── Franchise articles — recap of completed week + preview of new week ───────
  // Skip the recap when advancing TO Week 1 — there is nothing to recap at the
  // start of a new season (no completed games in the current season yet).
  if (!isNaN(oldWeekNum) && oldWeekNum >= 1 && oldWeekNum <= 18 && newWeek !== "1" && guild) {
    const headlinesChannelId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.HEADLINES);
    const headlinesChannel = headlinesChannelId
      ? (interaction.client.channels.cache.get(headlinesChannelId) ?? await interaction.client.channels.fetch(headlinesChannelId).catch(() => null))
      : null;

    if (headlinesChannel && headlinesChannel.isTextBased()) {
      // Fire both articles async — recap first, then preview. Don't block the interaction reply.
      (async () => {
        const tc = headlinesChannel as import("discord.js").TextChannel;
        const completedWeekIndex = oldWeekNum - 1; // 0-based

        // ── 1. Recap of the week that just completed ──────────────────────────
        try {
          const recapArticle = await generateFranchiseArticle(
            season.id,
            season.seasonNumber,
            completedWeekIndex,
            newLabel,
          );
          await sendArticleChunked(
            tc,
            `@everyone\n📰 **REC League — Week ${oldWeekNum} Recap**\n\n`,
            recapArticle,
          );
        } catch (err) {
          console.error("[advanceweek] Failed to generate recap article:", err);
          try {
            await tc.send({
              content: `📰 **REC League — Week ${oldWeekNum} Recap**\n\n_The AI recap could not be generated for this week. Check back next advance._`,
            });
          } catch { /* nothing we can do */ }
        }

        // ── 2. Preview of the new week (only for regular-season weeks) ────────
        const newWeekNum = parseInt(newWeek, 10);
        if (!isNaN(newWeekNum) && newWeekNum >= 1 && newWeekNum <= 18) {
          try {
            const previewArticle = await generateWeekPreview(
              season.id,
              season.seasonNumber,
              newWeekNum - 1, // 0-based
            );
            await sendArticleChunked(
              tc,
              `@everyone\n📋 **REC League — Week ${newWeekNum} Preview**\n\n`,
              previewArticle,
            );
          } catch (err) {
            console.error("[advanceweek] Failed to generate preview article:", err);
            try {
              await tc.send({
                content: `📋 **REC League — Week ${newWeekNum} Preview**\n\n_The AI preview could not be generated for this week._`,
              });
            } catch { /* nothing we can do */ }
          }
        }
      })();
    }
  }

  // ── Wildcard automation — fires when advancing from Week 18 → Wildcard ────────
  if (newWeek === "wildcard" && season.currentWeek === "18") {
    (async () => {
      try {
        await runWildcardAutomation(interaction.client, season.id, season.seasonNumber, interaction.guild);
      } catch (err) {
        console.error("[advanceweek] Wildcard automation error:", err);
      }
    })();
  }

  // ── EOS payout auto-post — fires whenever advancing to Wildcard ───────────────
  if (newWeek === "wildcard") {
    (async () => {
      try {
        // Block EOS if stat reimport safe mode is active
        const safeModeActive = (await getPayoutValue(PAYOUT_KEYS.STAT_SAFE_MODE)) > 0;
        if (safeModeActive) {
          await interaction.followUp({
            content: "⚠️ **EOS payouts are blocked** — stat reimport safe mode is currently active. Disable it with `/admin-stat-reimport disable` before advancing to Wildcard week to run EOS payouts.",
            ephemeral: true,
          }).catch(() => {});
          return;
        }
        const result = await runEosAutoPost(interaction.client, season.id);
        const lines = [
          `📋 **End-of-Season Payout Summaries Posted** to the commissioner log.`,
          `• **${result.posted}** user payout${result.posted !== 1 ? "s" : ""} queued for approval`,
        ];
        if (result.skipped > 0)  lines.push(`• **${result.skipped}** already had records for this season (skipped)`);
        if (result.errors > 0)   lines.push(`• ⚠️ **${result.errors}** failed — check bot console`);
        lines.push("Use the **Edit Amount** buttons in the commissioner log to adjust sacks, INTs, PPG, and individual bonuses before approving.");
        await interaction.followUp({ content: lines.join("\n"), ephemeral: true });
      } catch (err) {
        console.error("[advanceweek] EOS auto-post error:", err);
        await interaction.followUp({
          content: `⚠️ EOS auto-post failed: ${err}`,
          ephemeral: true,
        }).catch(() => {});
      }
    })();
  }

  // ── Offseason — post season/all-time records + wipe channels + announcement ────
  if (newWeek === "offseason") {
    (async () => {
      try {
        await runOffseasonHistoricalPost(interaction.client, season.id, season.seasonNumber);
      } catch (err) {
        console.error("[advanceweek] Offseason historical post error:", err);
      }

      // Wipe all specified channels (old messages need 1-by-1 delete due to Discord 14-day limit)
      for (const chId of OFFSEASON_WIPE_CHANNEL_IDS) {
        try {
          const ch = interaction.client.channels.cache.get(chId)
            ?? await interaction.client.channels.fetch(chId).catch(() => null);
          if (ch?.isTextBased()) {
            await purgeChannel(ch as TextChannel).catch(err =>
              console.error(`[advanceweek] Offseason wipe error (${chId}):`, err),
            );
          }
        } catch (err) {
          console.error(`[advanceweek] Could not wipe channel ${chId}:`, err);
        }
      }

      // Wipe league twitter DB rows for the ending season
      try {
        await db.delete(leagueTwitterTable).where(eq(leagueTwitterTable.seasonId, season.id));
      } catch (err) {
        console.error("[advanceweek] Failed to wipe league twitter DB rows:", err);
      }

      // Post rule-change voting announcement to the announce channel
      try {
        const announceCh = interaction.client.channels.cache.get(ANNOUNCE_CHANNEL_ID)
          ?? await interaction.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `📣 **The rule change voting period has begun!**\n\n` +
              `If you are requesting a specific rule change to be voted on by the league, ` +
              `please post it in the **League Announcements** channel immediately to be considered.\n\n` +
              `⚠️ This opportunity **ends once the Draft has begun**. Get your proposals in now!`,
          });
        }
      } catch (err) {
        console.error("[advanceweek] Offseason announcement error:", err);
      }
    })();
  }

  // ── Training Camp — post announcement ─────────────────────────────────────────
  if (newWeek === "training_camp") {
    (async () => {
      try {
        const announceCh = interaction.client.channels.cache.get(ANNOUNCE_CHANNEL_ID)
          ?? await interaction.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `🏕️ **Training Camp has begun!**\n\n` +
              `The offseason is over — it's time to build your roster and get ready for the upcoming season.\n\n` +
              `📋 All attribute upgrades, dev upgrades, and store purchases are now open for the new season. ` +
              `Use your coins wisely before Week 1 kicks off!`,
          });
        }
      } catch (err) {
        console.error("[advanceweek] Training Camp announcement error:", err);
      }
    })();
  }

  // ── New season — announce + post full season schedule ────────────────────────
  if (newWeek === "1" && (!season.currentWeek || season.currentWeek === "offseason" || season.currentWeek === "training_camp")) {
    (async () => {
      // Season start announcement
      try {
        const announceCh = interaction.client.channels.cache.get(ANNOUNCE_CHANNEL_ID)
          ?? await interaction.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
        if (announceCh?.isTextBased()) {
          await (announceCh as TextChannel).send({
            content:
              `@everyone\n` +
              `🏈 **A new season has begun!**\n\n` +
              `We have officially advanced to **Season ${season.seasonNumber}**.\n` +
              `Good luck to everyone this season — let's get to work! 💪`,
          });
        }
      } catch (err) {
        console.error("[advanceweek] New season announcement error:", err);
      }

      // Clear playoff seeds/conference from previous season — prevents stale
      // Season 2 seeds from leaking into Season 3 Twitter context and standings.
      try {
        await db.update(usersTable).set({ playoffSeed: null, playoffConference: null });
        console.log("[advanceweek] Cleared playoff seeds for new season");
      } catch (err) {
        console.error("[advanceweek] Failed to clear playoff seeds:", err);
      }

      // Remove "Refund" buttons from legend & custom player commissioner log
      // messages — once a new season begins (draft occurred), these purchases
      // are non-refundable so the Refund action should no longer be visible.
      try {
        const commId = await getGuildChannel(interaction.guildId!, CHANNEL_KEYS.COMMISSIONER);
        if (commId) {
          const commCh = interaction.client.channels.cache.get(commId)
            ?? await interaction.client.channels.fetch(commId).catch(() => null);
          if (commCh?.isTextBased()) {
            const messages = await (commCh as TextChannel).messages.fetch({ limit: 100 });
            for (const msg of messages.values()) {
              if (!msg.components.length || !msg.editable) continue;

              const NON_REFUNDABLE = new Set(["legend", "custom_player"]);
              let modified = false;

              const newRows: ReturnType<typeof ButtonBuilder.from>[][] = [];
              for (const row of msg.components) {
                if (row.type !== ComponentType.ActionRow) continue;
                const kept: ReturnType<typeof ButtonBuilder.from>[] = [];
                for (const c of (row as any).components ?? []) {
                  if (c.type !== ComponentType.Button) {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                    continue;
                  }
                  const id: string = c.customId ?? "";
                  if (!id.startsWith("refund_purchase:")) {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                    continue;
                  }
                  const purchaseType: string = id.split(":")[3] ?? "";
                  if (NON_REFUNDABLE.has(purchaseType) || purchaseType.startsWith("custom_player")) {
                    modified = true;
                  } else {
                    kept.push(ButtonBuilder.from(c.toJSON?.() ?? c));
                  }
                }
                if (kept.length > 0) newRows.push(kept);
              }

              if (modified) {
                const actionRows = newRows.map(btns =>
                  new ActionRowBuilder<ButtonBuilder>().addComponents(btns)
                );
                await msg.edit({ components: actionRows }).catch(() => null);
              }
            }
            console.log("[advanceweek] Refund buttons removed from commissioner channel for new season");
          }
        }
      } catch (err) {
        console.error("[advanceweek] Refund button removal error:", err);
      }

      // Auto-post full 18-week schedule to schedule channel
      try {
        const postedWeeks = await postFullSeasonScheduleToChannel(
          interaction.client,
          season.id,
          season.seasonNumber ?? season.id,
        );
        if (postedWeeks > 0) {
          await interaction.followUp({
            content: `📅 Full Season ${season.seasonNumber} schedule (${postedWeeks} weeks) posted.`,
            ephemeral: true,
          }).catch(() => {});
        } else {
          await interaction.followUp({
            content: `⚠️ Could not auto-post season schedule — no schedule data found. Run \`/franchiseupdate\` then \`/postfullseasonschedule\` manually.`,
            ephemeral: true,
          }).catch(() => {});
        }
      } catch (err) {
        console.error("[advanceweek] Auto season schedule post error:", err);
        await interaction.followUp({
          content: `⚠️ Season schedule auto-post failed: ${err}. Run \`/postfullseasonschedule\` manually.`,
          ephemeral: true,
        }).catch(() => {});
      }
    })();
  }

  // ── Auto-run weekly matchups flow for regular-season advances ─────────────
  // Fires when advancing TO a regular season week (1–18).
  // Pays GOTW voters for the week we just LEFT (oldWeekNum), clears channels,
  // posts new matchups, and sends admin an ephemeral GOTW prompt.
  const _newWeekNum = parseInt(newWeek, 10);
  if (!isNaN(_newWeekNum) && _newWeekNum >= 1 && _newWeekNum <= 18) {
    (async () => {
      try {
        await runWeeklyMatchupsFlow({
          client:          interaction.client,
          guild:           interaction.guild,
          season,
          displayWeekNum:  _newWeekNum,
          payoutWeekIndex: (!isNaN(oldWeekNum) && oldWeekNum >= 1) ? oldWeekNum - 1 : null,
          replyFn: async ({ content, components }) => {
            await interaction.followUp({
              content,
              components: components ?? [],
              ephemeral:  true,
            });
          },
        });
      } catch (err) {
        console.error("[advanceweek] Weekly matchups flow error:", err);
        try {
          await interaction.followUp({
            content: `⚠️ Advance week completed, but the weekly matchups flow failed: ${err}`,
            ephemeral: true,
          });
        } catch { /* nothing we can do */ }
      }
    })();
  }

  // ── Playoff matchups flow — fires when advancing TO any playoff week ───────────
  // Posts matchup embed, clears GOTW channel, creates one poll per H2H matchup.
  // Does NOT fire for offseason.
  if (PLAYOFF_WEEK_META[newWeek]) {
    (async () => {
      try {
        const summary = await runPlayoffMatchupsFlow(
          interaction.client,
          season,
          newWeek,
          interaction.guildId!,
        );
        await interaction.followUp({ content: summary, ephemeral: true }).catch(() => {});
      } catch (err) {
        console.error("[advanceweek] Playoff matchups flow error:", err);
        try {
          await interaction.followUp({
            content: `⚠️ Advance week completed, but the playoff matchups flow failed: ${err}`,
            ephemeral: true,
          });
        } catch { /* nothing we can do */ }
      }
    })();
  }

  // ── Waitlist scan — notify waitlisted users if teams are open ────────────────
  checkAndNotifyWaitlist(
    interaction.client,
    interaction.guild,
    interaction.guildId!,
  ).catch(err => console.error("[advanceweek] Waitlist scan error:", err));
}
