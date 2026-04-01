import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  PermissionFlagsBits, ChannelType,
} from "discord.js";
import { db } from "@workspace/db";
import { seasonsTable, franchiseScheduleTable, usersTable, gameChannelsTable, gotwHistoryTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdminUser, getOrCreateActiveSeason, addBalance, logTransaction } from "../lib/db-helpers.js";
import { deleteGotwMessages } from "../lib/gotw-helpers.js";

const MATCHUP_CATEGORY_ID = "1478427821666861272";

export const WEEK_SEQUENCE = [
  "1","2","3","4","5","6","7","8","9","10",
  "11","12","13","14","15","16","17","18",
  "wildcard","divisional","conference","superbowl","offseason",
];

export function weekLabel(week: string): string {
  if (/^\d+$/.test(week)) return `Week ${week}`;
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
        { name: "Offseason",     value: "offseason"   },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member        = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isDiscordAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDbAdmin      = await isAdminUser(interaction.user.id);

  if (!isDiscordAdmin && !isDbAdmin) {
    await interaction.editReply({ content: "❌ You don't have permission to use this command." });
    return;
  }

  const season = await getOrCreateActiveSeason();
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
          await addBalance(gotwRow.discordId1, GOTW_BONUS);
          await logTransaction(gotwRow.discordId1, GOTW_BONUS, "addcoins",
            `GOTW participant bonus — Week ${oldWeekNum}`, "system");

          await addBalance(gotwRow.discordId2, GOTW_BONUS);
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

    // Delete GOTW announcement + poll from Discord
    await deleteGotwMessages(interaction.client, season.id, oldWeekIndex);
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

    // 2. Create channels only for regular-season weeks (1–18)
    const newWeekNum = parseInt(newWeek, 10);
    if (!isNaN(newWeekNum) && newWeekNum >= 1 && newWeekNum <= 18) {
      const weekIndex = newWeekNum - 1; // DB uses 0-based weekIndex

      // Fetch the schedule for this week
      const games = await db.select()
        .from(franchiseScheduleTable)
        .where(and(
          eq(franchiseScheduleTable.seasonId,  season.id),
          eq(franchiseScheduleTable.weekIndex, weekIndex),
        ));

      // Build team name (lowercase) → discordId map
      const allUsers = await db.select({
        discordId: usersTable.discordId,
        team:      usersTable.team,
      }).from(usersTable);

      const teamToDiscord = new Map<string, string>();
      for (const u of allUsers) {
        if (u.team) teamToDiscord.set(u.team.toLowerCase().trim(), u.discordId);
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

        const chanName = `${toChannelName(g.awayTeamName)}-vs-${toChannelName(g.homeTeamName)}`;

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
            `🏈 **${g.awayTeamName} vs ${g.homeTeamName}** — Week ${newWeekNum}\n` +
            `<@${awayDiscordId}> <@${homeDiscordId}>\n` +
            `Good luck this week!`,
          );

          // Store the channel ID so we can delete it next advance
          await db.insert(gameChannelsTable).values({
            seasonId:     season.id,
            weekIndex,
            channelId:    newChannel.id,
            awayTeamName: g.awayTeamName,
            homeTeamName: g.homeTeamName,
          });

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
}
