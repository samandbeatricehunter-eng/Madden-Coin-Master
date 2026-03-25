import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, seasonStatsTable, userRecordsTable } from "@workspace/db";
import { eq, and, sum } from "drizzle-orm";
import { getOrCreateActiveSeason, getOrCreateUser } from "../lib/db-helpers.js";
import { findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

// Milestone thresholds — keep in sync with records.ts
const WIN_MILESTONE_THRESHOLDS = [
  { wins: 50, tier: 4 },
  { wins: 25, tier: 3 },
  { wins: 12, tier: 2 },
  { wins: 5,  tier: 1 },
];

/** Determine which milestone tier a given all-time win count qualifies for */
function calcMilestoneTier(allTimeWins: number): number {
  for (const m of WIN_MILESTONE_THRESHOLDS) {
    if (allTimeWins >= m.wins) return m.tier;
  }
  return 0;
}

export const data = new SlashCommandBuilder()
  .setName("setuser")
  .setDescription("Commissioner: Manually set any stat for a user")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  // ── Identifiers ────────────────────────────────────────────────────────────
  .addStringOption(opt =>
    opt.setName("team").setDescription("NFL team name").setRequired(false).setAutocomplete(true)
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("Discord user (alternative to team)").setRequired(false)
  )
  // ── Economy ────────────────────────────────────────────────────────────────
  .addIntegerOption(opt =>
    opt.setName("coins").setDescription("Set coin balance to this amount").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("legend_total").setDescription("Set all-time legend purchase count").setRequired(false).setMinValue(0)
  )
  // ── Season record (regular + playoffs count toward wins/losses) ────────────
  .addIntegerOption(opt =>
    opt.setName("wins").setDescription("Set current season regular season wins").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("losses").setDescription("Set current season regular season losses").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("point_differential").setDescription("Set current season point differential").setRequired(false)
  )
  // ── Postseason record ──────────────────────────────────────────────────────
  .addIntegerOption(opt =>
    opt.setName("playoff_wins").setDescription("Set current season playoff wins").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("playoff_losses").setDescription("Set current season playoff losses").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("superbowl_wins").setDescription("Set current season Super Bowl wins").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("superbowl_losses").setDescription("Set current season Super Bowl losses").setRequired(false).setMinValue(0)
  )
  // ── All-time SB wins (for bonus tier tracking) ─────────────────────────────
  .addIntegerOption(opt =>
    opt.setName("all_time_sb_wins")
      .setDescription("Set all-time Super Bowl wins (for bonus tier tracking)")
      .setRequired(false)
      .setMinValue(0)
  )
  // ── Season upgrade usage ───────────────────────────────────────────────────
  .addIntegerOption(opt =>
    opt.setName("attributes_used").setDescription("Set attributes purchased this season").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("speed_points_used").setDescription("Set speed points purchased this season").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("dev_ups_used").setDescription("Set dev upgrades purchased this season").setRequired(false).setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("age_resets_used").setDescription("Set age resets purchased this season").setRequired(false).setMinValue(0)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  await interaction.respond(
    NFL_TEAMS.filter(t => t.toLowerCase().startsWith(focused)).slice(0, 25).map(t => ({ name: t, value: t }))
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const teamName   = interaction.options.getString("team")?.trim();
  const targetUser = interaction.options.getUser("user");

  if (!teamName && !targetUser) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Missing Target").setDescription("Provide either a **team** name or **@user**.")],
    });
  }

  let discordId: string;
  let username: string;
  let team: string | null = null;

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Team Not Found").setDescription(`No user is assigned to the **${teamName}**.`)],
      });
    }
    discordId = found.discordId;
    username  = found.discordUsername;
    team      = found.team ?? null;
  } else {
    discordId = targetUser!.id;
    username  = targetUser!.username;
    await getOrCreateUser(discordId, username);
    const row = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
    team = row[0]?.team ?? null;
  }

  // ── Read all options ───────────────────────────────────────────────────────
  const coins            = interaction.options.getInteger("coins");
  const legendTotal      = interaction.options.getInteger("legend_total");
  const wins             = interaction.options.getInteger("wins");
  const losses           = interaction.options.getInteger("losses");
  const pointDiff        = interaction.options.getInteger("point_differential");
  const playoffWins      = interaction.options.getInteger("playoff_wins");
  const playoffLosses    = interaction.options.getInteger("playoff_losses");
  const superbowlWins    = interaction.options.getInteger("superbowl_wins");
  const superbowlLosses  = interaction.options.getInteger("superbowl_losses");
  const allTimeSbWins    = interaction.options.getInteger("all_time_sb_wins");
  const attributesUsed   = interaction.options.getInteger("attributes_used");
  const speedPointsUsed  = interaction.options.getInteger("speed_points_used");
  const devUpsUsed       = interaction.options.getInteger("dev_ups_used");
  const ageResetsUsed    = interaction.options.getInteger("age_resets_used");

  const noFieldProvided =
    coins === null && legendTotal === null &&
    wins === null && losses === null && pointDiff === null &&
    playoffWins === null && playoffLosses === null &&
    superbowlWins === null && superbowlLosses === null &&
    allTimeSbWins === null &&
    attributesUsed === null && speedPointsUsed === null &&
    devUpsUsed === null && ageResetsUsed === null;

  if (noFieldProvided) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle("❌ Nothing to Set").setDescription("Provide at least one value to update.")],
    });
  }

  const season  = await getOrCreateActiveSeason();
  const changes: string[] = [];

  // ── Update economy_users ───────────────────────────────────────────────────
  const userUpdates: Record<string, any> = { updatedAt: new Date() };
  if (coins !== null)       { userUpdates.balance = coins;                      changes.push(`💰 **Coins** → ${coins.toLocaleString()}`); }
  if (legendTotal !== null) { userUpdates.totalLegendPurchases = legendTotal;   changes.push(`🏆 **All-Time Legend Total** → ${legendTotal}`); }
  if (allTimeSbWins !== null) { userUpdates.allTimeSuperbowlWins = allTimeSbWins; changes.push(`🏆 **All-Time SB Wins** → ${allTimeSbWins}`); }
  if (Object.keys(userUpdates).length > 1) {
    await db.update(usersTable).set(userUpdates).where(eq(usersTable.discordId, discordId));
  }

  // ── Update user_records (season) ───────────────────────────────────────────
  const hasRecordField = wins !== null || losses !== null || pointDiff !== null ||
    playoffWins !== null || playoffLosses !== null ||
    superbowlWins !== null || superbowlLosses !== null;

  if (hasRecordField) {
    const recordUpdates: Record<string, any> = { updatedAt: new Date() };
    if (wins !== null)            { recordUpdates.wins = wins;                       changes.push(`✅ **Season Wins** → ${wins}`); }
    if (losses !== null)          { recordUpdates.losses = losses;                   changes.push(`❌ **Season Losses** → ${losses}`); }
    if (pointDiff !== null)       { recordUpdates.pointDifferential = pointDiff;     changes.push(`📊 **Point Differential** → ${pointDiff >= 0 ? "+" : ""}${pointDiff}`); }
    if (playoffWins !== null)     { recordUpdates.playoffWins = playoffWins;         changes.push(`🏈 **Playoff Wins** → ${playoffWins}`); }
    if (playoffLosses !== null)   { recordUpdates.playoffLosses = playoffLosses;     changes.push(`🏈 **Playoff Losses** → ${playoffLosses}`); }
    if (superbowlWins !== null)   { recordUpdates.superbowlWins = superbowlWins;     changes.push(`🏆 **SB Wins (season)** → ${superbowlWins}`); }
    if (superbowlLosses !== null) { recordUpdates.superbowlLosses = superbowlLosses; changes.push(`🏆 **SB Losses (season)** → ${superbowlLosses}`); }

    const existing = await db.select().from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id))).limit(1);

    if (existing.length > 0) {
      await db.update(userRecordsTable).set(recordUpdates)
        .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)));
    } else {
      await db.insert(userRecordsTable).values({
        discordId,
        discordUsername: username,
        team: team ?? undefined,
        seasonId: season.id,
        wins:           wins           ?? 0,
        losses:         losses         ?? 0,
        pointDifferential: pointDiff   ?? 0,
        playoffWins:    playoffWins    ?? 0,
        playoffLosses:  playoffLosses  ?? 0,
        superbowlWins:  superbowlWins  ?? 0,
        superbowlLosses: superbowlLosses ?? 0,
      });
    }

    // ── Silently update the milestone tier to match new all-time win total ───
    // (no announcement — these wins pre-existed the bot)
    if (wins !== null || playoffWins !== null || superbowlWins !== null) {
      const totals = await db.select({ totalWins: sum(userRecordsTable.wins) })
        .from(userRecordsTable).where(eq(userRecordsTable.discordId, discordId));
      const allTimeWins = Number(totals[0]?.totalWins ?? 0);
      const correctTier = calcMilestoneTier(allTimeWins);
      await db.update(usersTable)
        .set({ milestoneTierAwarded: correctTier, updatedAt: new Date() })
        .where(eq(usersTable.discordId, discordId));
      changes.push(`🎯 **Milestone tier** synced to ${correctTier} (${allTimeWins} all-time wins — no payout issued)`);
    }
  }

  // ── Update season_stats (upgrades) ─────────────────────────────────────────
  const statsUpdates: Record<string, any> = {};
  if (attributesUsed !== null)  { statsUpdates.attributesPurchased  = attributesUsed;   changes.push(`⚡ **Attributes Used** → ${attributesUsed}`); }
  if (speedPointsUsed !== null) { statsUpdates.speedPointsPurchased  = speedPointsUsed; changes.push(`🏃 **Speed Points Used** → ${speedPointsUsed}`); }
  if (devUpsUsed !== null)      { statsUpdates.devUpsPurchased       = devUpsUsed;      changes.push(`📈 **Dev Upgrades Used** → ${devUpsUsed}`); }
  if (ageResetsUsed !== null)   { statsUpdates.ageResetsPurchased    = ageResetsUsed;   changes.push(`🔄 **Age Resets Used** → ${ageResetsUsed}`); }

  if (Object.keys(statsUpdates).length > 0) {
    const existingStats = await db.select().from(seasonStatsTable)
      .where(and(eq(seasonStatsTable.discordId, discordId), eq(seasonStatsTable.seasonId, season.id))).limit(1);
    if (existingStats.length > 0) {
      await db.update(seasonStatsTable).set(statsUpdates)
        .where(and(eq(seasonStatsTable.discordId, discordId), eq(seasonStatsTable.seasonId, season.id)));
    } else {
      await db.insert(seasonStatsTable).values({
        discordId,
        seasonId: season.id,
        attributesPurchased:  attributesUsed   ?? 0,
        speedPointsPurchased: speedPointsUsed  ?? 0,
        devUpsPurchased:      devUpsUsed       ?? 0,
        ageResetsPurchased:   ageResetsUsed    ?? 0,
        legendsPurchasedThisSeason: 0,
      });
    }
  }

  const label = team ? `${team} (${username})` : username;
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`✅ Stats Updated — ${label}`)
        .setDescription(changes.join("\n"))
        .setFooter({ text: `Season ${season.seasonNumber} | Milestone payouts suppressed for manually set wins` })
        .setTimestamp(),
    ],
  });
}
