import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, seasonStatsTable, userRecordsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateActiveSeason, getOrCreateUser } from "../lib/db-helpers.js";
import { findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

export const data = new SlashCommandBuilder()
  .setName("setuser")
  .setDescription("Commissioner: Manually set any stat for a user")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  // ── Identifiers (at least one required, validated in code) ─────────────────
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("NFL team name")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Discord user (alternative to team)")
      .setRequired(false)
  )
  // ── Economy ────────────────────────────────────────────────────────────────
  .addIntegerOption(opt =>
    opt.setName("coins")
      .setDescription("Set coin balance to this amount")
      .setRequired(false)
      .setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("legend_total")
      .setDescription("Set all-time legend purchase count")
      .setRequired(false)
      .setMinValue(0)
  )
  // ── Season record ──────────────────────────────────────────────────────────
  .addIntegerOption(opt =>
    opt.setName("wins")
      .setDescription("Set current season wins")
      .setRequired(false)
      .setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("losses")
      .setDescription("Set current season losses")
      .setRequired(false)
      .setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("point_differential")
      .setDescription("Set current season point differential (can be negative)")
      .setRequired(false)
  )
  // ── Season upgrade usage ───────────────────────────────────────────────────
  .addIntegerOption(opt =>
    opt.setName("attributes_used")
      .setDescription("Set attributes purchased this season")
      .setRequired(false)
      .setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("speed_points_used")
      .setDescription("Set speed points purchased this season")
      .setRequired(false)
      .setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("dev_ups_used")
      .setDescription("Set dev upgrades purchased this season")
      .setRequired(false)
      .setMinValue(0)
  )
  .addIntegerOption(opt =>
    opt.setName("age_resets_used")
      .setDescription("Set age resets purchased this season")
      .setRequired(false)
      .setMinValue(0)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const results = NFL_TEAMS
    .filter(t => t.toLowerCase().startsWith(focused))
    .slice(0, 25)
    .map(t => ({ name: t, value: t }));
  await interaction.respond(results);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // ── Resolve target user ────────────────────────────────────────────────────
  const teamName = interaction.options.getString("team")?.trim();
  const targetUser = interaction.options.getUser("user");

  if (!teamName && !targetUser) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Missing Target")
          .setDescription("Provide either a **team** name or **@user**."),
      ],
    });
  }

  let discordId: string;
  let username: string;
  let team: string | null = null;

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ Team Not Found")
            .setDescription(`No user is assigned to the **${teamName}**.`),
        ],
      });
    }
    discordId = found.discordId;
    username = found.discordUsername;
    team = found.team ?? null;
  } else {
    discordId = targetUser!.id;
    username = targetUser!.username;
    await getOrCreateUser(discordId, username);
    const row = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
    team = row[0]?.team ?? null;
  }

  // ── Read options ───────────────────────────────────────────────────────────
  const coins              = interaction.options.getInteger("coins");
  const legendTotal        = interaction.options.getInteger("legend_total");
  const wins               = interaction.options.getInteger("wins");
  const losses             = interaction.options.getInteger("losses");
  const pointDiff          = interaction.options.getInteger("point_differential");
  const attributesUsed     = interaction.options.getInteger("attributes_used");
  const speedPointsUsed    = interaction.options.getInteger("speed_points_used");
  const devUpsUsed         = interaction.options.getInteger("dev_ups_used");
  const ageResetsUsed      = interaction.options.getInteger("age_resets_used");

  const noFieldProvided =
    coins === null && legendTotal === null &&
    wins === null && losses === null && pointDiff === null &&
    attributesUsed === null && speedPointsUsed === null &&
    devUpsUsed === null && ageResetsUsed === null;

  if (noFieldProvided) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Nothing to Set")
          .setDescription("Provide at least one value to update."),
      ],
    });
  }

  const season = await getOrCreateActiveSeason();
  const changes: string[] = [];

  // ── Update economy_users ───────────────────────────────────────────────────
  const userUpdates: Record<string, any> = { updatedAt: new Date() };
  if (coins !== null) {
    userUpdates.balance = coins;
    changes.push(`💰 **Coins** → ${coins.toLocaleString()}`);
  }
  if (legendTotal !== null) {
    userUpdates.totalLegendPurchases = legendTotal;
    changes.push(`🏆 **All-Time Legend Total** → ${legendTotal}`);
  }
  if (Object.keys(userUpdates).length > 1) {
    await db.update(usersTable).set(userUpdates).where(eq(usersTable.discordId, discordId));
  }

  // ── Update user_records (season) ───────────────────────────────────────────
  const recordUpdates: Record<string, any> = { updatedAt: new Date() };
  if (wins !== null)     { recordUpdates.wins = wins;                 changes.push(`✅ **Wins** → ${wins}`); }
  if (losses !== null)   { recordUpdates.losses = losses;             changes.push(`❌ **Losses** → ${losses}`); }
  if (pointDiff !== null){ recordUpdates.pointDifferential = pointDiff; changes.push(`📊 **Point Differential** → ${pointDiff >= 0 ? "+" : ""}${pointDiff}`); }

  if (Object.keys(recordUpdates).length > 1) {
    const existing = await db.select().from(userRecordsTable)
      .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
      .limit(1);

    if (existing.length > 0) {
      await db.update(userRecordsTable).set(recordUpdates)
        .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)));
    } else {
      await db.insert(userRecordsTable).values({
        discordId,
        discordUsername: username,
        team: team ?? undefined,
        seasonId: season.id,
        wins: wins ?? 0,
        losses: losses ?? 0,
        pointDifferential: pointDiff ?? 0,
      });
    }
  }

  // ── Update season_stats (upgrades) ─────────────────────────────────────────
  const statsUpdates: Record<string, any> = {};
  if (attributesUsed !== null)  { statsUpdates.attributesPurchased = attributesUsed;       changes.push(`⚡ **Attributes Used** → ${attributesUsed}`); }
  if (speedPointsUsed !== null) { statsUpdates.speedPointsPurchased = speedPointsUsed;     changes.push(`🏃 **Speed Points Used** → ${speedPointsUsed}`); }
  if (devUpsUsed !== null)      { statsUpdates.devUpsPurchased = devUpsUsed;               changes.push(`📈 **Dev Upgrades Used** → ${devUpsUsed}`); }
  if (ageResetsUsed !== null)   { statsUpdates.ageResetsPurchased = ageResetsUsed;         changes.push(`🔄 **Age Resets Used** → ${ageResetsUsed}`); }

  if (Object.keys(statsUpdates).length > 0) {
    const existingStats = await db.select().from(seasonStatsTable)
      .where(and(eq(seasonStatsTable.discordId, discordId), eq(seasonStatsTable.seasonId, season.id)))
      .limit(1);

    if (existingStats.length > 0) {
      await db.update(seasonStatsTable).set(statsUpdates)
        .where(and(eq(seasonStatsTable.discordId, discordId), eq(seasonStatsTable.seasonId, season.id)));
    } else {
      await db.insert(seasonStatsTable).values({
        discordId,
        seasonId: season.id,
        attributesPurchased: attributesUsed ?? 0,
        speedPointsPurchased: speedPointsUsed ?? 0,
        devUpsPurchased: devUpsUsed ?? 0,
        ageResetsPurchased: ageResetsUsed ?? 0,
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
        .setFooter({ text: `Season ${season.seasonNumber}` })
        .setTimestamp(),
    ],
  });
}
