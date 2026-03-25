import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits, TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import { userRecordsTable, usersTable, gameLogTable, coinTransactionsTable } from "@workspace/db";
import { eq, and, sql, sum, desc } from "drizzle-orm";
import { getOrCreateUser, getOrCreateActiveSeason, logTransaction } from "../lib/db-helpers.js";
import { findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

// ─── Power Ranking Formula ────────────────────────────────────────────────────
function calcPRScore(wins: number, losses: number, pointDiff: number): number {
  return 0.6 * (wins - losses) + 0.4 * pointDiff;
}

function formatDiff(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

function displayName(username: string, team: string | null | undefined): string {
  return team ? `${team}` : username;
}

// ─── Milestone config ─────────────────────────────────────────────────────────
const WIN_MILESTONES = [
  { wins: 5,  tier: 1, coins: 100,  emoji: "🎯", label: "5 All-Time Wins" },
  { wins: 12, tier: 2, coins: 250,  emoji: "⭐", label: "12 All-Time Wins" },
  { wins: 25, tier: 3, coins: 500,  emoji: "🔥", label: "25 All-Time Wins" },
  { wins: 50, tier: 4, coins: 1000, emoji: "👑", label: "50 All-Time Wins" },
] as const;

// SB bonus indexed by 0-based win count (1st win = index 0)
const SB_BONUSES = [150, 250, 350, 500, 1000] as const;

// ── Shared autocomplete ────────────────────────────────────────────────────────
export async function autocompleteUpdateRecord(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();
  // Both "team" and "opponent" fields use NFL team autocomplete
  const results = NFL_TEAMS
    .filter(t => t.toLowerCase().startsWith(query))
    .slice(0, 25)
    .map(t => ({ name: t, value: t }));
  await interaction.respond(results);
}

// ── /updaterecord ──────────────────────────────────────────────────────────────
export const updateRecordData = new SlashCommandBuilder()
  .setName("updaterecord")
  .setDescription("Commissioner: Record a game result for a player")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("result")
      .setDescription("Win or Loss?")
      .setRequired(true)
      .addChoices(
        { name: "Win", value: "win" },
        { name: "Loss", value: "loss" },
      )
  )
  .addIntegerOption(opt =>
    opt.setName("point_spread")
      .setDescription("Points scored margin (positive = won by this many, negative = lost by this many)")
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName("game_type")
      .setDescription("What kind of game was this?")
      .setRequired(true)
      .addChoices(
        { name: "Regular Season", value: "regular_season" },
        { name: "Playoff",        value: "playoff" },
        { name: "Super Bowl",     value: "superbowl" },
      )
  )
  .addUserOption(opt =>
    opt.setName("user").setDescription("The player (or use team name below)").setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("NFL team name (alternative to @user)")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addStringOption(opt =>
    opt.setName("opponent")
      .setDescription("Opponent team name (for H2H history)")
      .setRequired(false)
      .setAutocomplete(true)
  );

export async function executeUpdateRecord(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user");
  const teamName   = interaction.options.getString("team")?.trim();
  const result     = interaction.options.getString("result", true)    as "win" | "loss";
  const spread     = interaction.options.getInteger("point_spread", true);
  const gameType   = interaction.options.getString("game_type", true) as "regular_season" | "playoff" | "superbowl";
  const opponent   = interaction.options.getString("opponent")?.trim() ?? null;

  if (!targetUser && !teamName) {
    return interaction.editReply({ content: "❌ Please provide either a **@user** or a **team** name." });
  }

  let discordId: string;
  let username: string;
  let team: string | null = null;

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) return interaction.editReply({ content: `❌ No user found for team **${teamName}**.` });
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

  const season = await getOrCreateActiveSeason();

  // ── Build record delta ────────────────────────────────────────────────────
  const isWin  = result === "win";
  const isPO   = gameType === "playoff";
  const isSB   = gameType === "superbowl";

  const existing = await db.select().from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userRecordsTable).set({
      wins:             isWin  ? sql`${userRecordsTable.wins} + 1`             : userRecordsTable.wins,
      losses:           !isWin ? sql`${userRecordsTable.losses} + 1`           : userRecordsTable.losses,
      pointDifferential: sql`${userRecordsTable.pointDifferential} + ${spread}`,
      playoffWins:      (isPO && isWin)  ? sql`${userRecordsTable.playoffWins} + 1`    : userRecordsTable.playoffWins,
      playoffLosses:    (isPO && !isWin) ? sql`${userRecordsTable.playoffLosses} + 1`  : userRecordsTable.playoffLosses,
      superbowlWins:    (isSB && isWin)  ? sql`${userRecordsTable.superbowlWins} + 1`  : userRecordsTable.superbowlWins,
      superbowlLosses:  (isSB && !isWin) ? sql`${userRecordsTable.superbowlLosses} + 1`: userRecordsTable.superbowlLosses,
      discordUsername: username,
      team: team ?? undefined,
      updatedAt: new Date(),
    }).where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)));
  } else {
    await db.insert(userRecordsTable).values({
      discordId,
      discordUsername: username,
      team: team ?? undefined,
      seasonId: season.id,
      wins:           isWin  ? 1 : 0,
      losses:         !isWin ? 1 : 0,
      pointDifferential: spread,
      playoffWins:    (isPO && isWin)  ? 1 : 0,
      playoffLosses:  (isPO && !isWin) ? 1 : 0,
      superbowlWins:  (isSB && isWin)  ? 1 : 0,
      superbowlLosses:(isSB && !isWin) ? 1 : 0,
    });
  }

  // ── Log the individual game ───────────────────────────────────────────────
  await db.insert(gameLogTable).values({
    discordId,
    seasonId: season.id,
    result,
    pointSpread: spread,
    opponentLabel: opponent,
    gameType,
  });

  // ── SB win: update all-time SB count + pay bonus ──────────────────────────
  let sbBonusNote = "";
  if (isSB && isWin) {
    const userRow = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
    const newSBWins = (userRow[0]?.allTimeSuperbowlWins ?? 0) + 1;

    await db.update(usersTable)
      .set({ allTimeSuperbowlWins: newSBWins, updatedAt: new Date() })
      .where(eq(usersTable.discordId, discordId));

    const bonusIdx = Math.min(newSBWins - 1, SB_BONUSES.length - 1);
    const bonus = SB_BONUSES[bonusIdx]!;

    await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${bonus}`, updatedAt: new Date() })
      .where(eq(usersTable.discordId, discordId));

    await logTransaction(discordId, bonus, "addcoins", `Super Bowl bonus — ${ordinal(newSBWins)} SB win`);

    const label = displayName(username, team);
    sbBonusNote = `\n🏆 **Super Bowl Bonus:** +${bonus.toLocaleString()} coins (${ordinal(newSBWins)} SB win)`;

    await announceInGeneral(interaction, new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`🏆 Super Bowl Champion — ${label}!`)
      .setDescription(
        `**${label}** just won the Super Bowl for the ${ordinal(newSBWins)} time!\n\n` +
        `💰 **+${bonus.toLocaleString()} coins** awarded as a bonus!\n` +
        `🎮 All-time Super Bowl wins: **${newSBWins}**`
      )
      .setTimestamp()
    );
  }

  // ── Win milestone check ───────────────────────────────────────────────────
  let milestoneNote = "";
  if (isWin) {
    // Sum all-time wins across all seasons
    const result2 = await db.select({ total: sum(userRecordsTable.wins) })
      .from(userRecordsTable)
      .where(eq(userRecordsTable.discordId, discordId));
    const allTimeWins = Number(result2[0]?.total ?? 0);

    const userRow = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
    const currentTier = userRow[0]?.milestoneTierAwarded ?? 0;

    // Find the highest milestone that should now be awarded
    for (const milestone of [...WIN_MILESTONES].reverse()) {
      if (allTimeWins >= milestone.wins && currentTier < milestone.tier) {
        // Award this milestone (and only this one — the loop finds the highest)
        await db.update(usersTable)
          .set({
            balance: sql`${usersTable.balance} + ${milestone.coins}`,
            milestoneTierAwarded: milestone.tier,
            updatedAt: new Date(),
          })
          .where(eq(usersTable.discordId, discordId));

        await logTransaction(discordId, milestone.coins, "addcoins", `Win milestone bonus — ${milestone.label}`);

        const label = displayName(username, team);
        milestoneNote = `\n${milestone.emoji} **Milestone:** ${milestone.label} → +${milestone.coins.toLocaleString()} coins!`;

        await announceInGeneral(interaction, new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle(`${milestone.emoji} Win Milestone Reached — ${label}!`)
          .setDescription(
            `**${label}** has reached **${milestone.label}** all time!\n\n` +
            `💰 **+${milestone.coins.toLocaleString()} coins** awarded as a bonus!\n` +
            `🏈 Total all-time wins: **${allTimeWins}**`
          )
          .setTimestamp()
        );
        break; // only one milestone per game
      }
    }
  }

  // ── Build confirmation embed ──────────────────────────────────────────────
  const updated = await db.select().from(userRecordsTable)
    .where(and(eq(userRecordsTable.discordId, discordId), eq(userRecordsTable.seasonId, season.id)))
    .limit(1);
  const rec   = updated[0]!;
  const label = displayName(username, team);

  const gameTypeLabel = gameType === "superbowl" ? "Super Bowl" : gameType === "playoff" ? "Playoff" : "Regular Season";

  const embed = new EmbedBuilder()
    .setColor(isWin ? Colors.Green : Colors.Red)
    .setTitle(`${isWin ? "✅ Win" : "❌ Loss"} Recorded — ${label}`)
    .addFields(
      { name: "Game Type",    value: gameTypeLabel,          inline: true },
      { name: "Result",       value: isWin ? "Win" : "Loss", inline: true },
      { name: "Spread",       value: formatDiff(spread),     inline: true },
      { name: "Season Record", value: `**${rec.wins}W - ${rec.losses}L** (${formatDiff(rec.pointDifferential)} pts)`, inline: false },
    )
    .setTimestamp();

  if (rec.playoffWins > 0 || rec.playoffLosses > 0 || rec.superbowlWins > 0 || rec.superbowlLosses > 0) {
    const parts: string[] = [];
    if (rec.playoffWins > 0 || rec.playoffLosses > 0) parts.push(`Playoffs: ${rec.playoffWins}W-${rec.playoffLosses}L`);
    if (rec.superbowlWins > 0 || rec.superbowlLosses > 0) parts.push(`Super Bowl: ${rec.superbowlWins}W-${rec.superbowlLosses}L`);
    embed.addFields({ name: "Postseason Breakdown", value: parts.join(" | "), inline: false });
  }

  if (sbBonusNote || milestoneNote) {
    embed.addFields({ name: "🎉 Bonuses Awarded", value: (sbBonusNote + milestoneNote).trim(), inline: false });
  }

  return interaction.editReply({ embeds: [embed] });
}

// ── General channel announcement helper ───────────────────────────────────────
async function announceInGeneral(interaction: ChatInputCommandInteraction, embed: EmbedBuilder) {
  const channelId = process.env["DISCORD_GENERAL_CHANNEL_ID"];
  if (!channelId) {
    console.warn("⚠️  DISCORD_GENERAL_CHANNEL_ID not set — skipping announcement");
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) {
    await (channel as TextChannel).send({ embeds: [embed] }).catch(console.error);
  }
}

// ── /seasonpr ──────────────────────────────────────────────────────────────────
export const seasonPRData = new SlashCommandBuilder()
  .setName("seasonpr")
  .setDescription("View the current season power rankings for the full league");

export async function executeSeasonPR(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const season = await getOrCreateActiveSeason();
  const records = await db.select().from(userRecordsTable).where(eq(userRecordsTable.seasonId, season.id));

  if (records.length === 0) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle(`📊 Season ${season.seasonNumber} Power Rankings`).setDescription("No games have been recorded yet this season.")],
    });
  }

  const ranked = records.map(r => ({
    ...r,
    gamesPlayed: r.wins + r.losses,
    prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
    label: displayName(r.discordUsername, r.team),
  })).sort((a, b) => b.prScore - a.prScore);

  const medals = ["🥇", "🥈", "🥉"];
  const rows = ranked.map((r, i) => {
    const badge = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gamesPlayed > 0 ? ((r.wins / r.gamesPlayed) * 100).toFixed(1) : "0.0";
    const postseason = [
      r.playoffWins + r.playoffLosses > 0 ? `PO: ${r.playoffWins}W-${r.playoffLosses}L` : "",
      r.superbowlWins + r.superbowlLosses > 0 ? `SB: ${r.superbowlWins}W-${r.superbowlLosses}L` : "",
    ].filter(Boolean).join(" | ");
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${formatDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}${postseason ? ` *(${postseason})*` : ""}`;
  });

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(`🏈 Season ${season.seasonNumber} Power Rankings`)
        .setDescription(rows.join("\n"))
        .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
        .setTimestamp(),
    ],
  });
}

// ── /alltimepr ─────────────────────────────────────────────────────────────────
export const allTimePRData = new SlashCommandBuilder()
  .setName("alltimepr")
  .setDescription("View all-time records and power rankings across all seasons");

export async function executeAllTimePR(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const allRecords = await db.select().from(userRecordsTable);

  if (allRecords.length === 0) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle("📊 All-Time Power Rankings").setDescription("No games have been recorded yet.")],
    });
  }

  const aggregated = new Map<string, {
    username: string; team: string | null;
    wins: number; losses: number; pointDifferential: number;
    playoffWins: number; playoffLosses: number;
    superbowlWins: number; superbowlLosses: number;
  }>();

  for (const rec of allRecords) {
    const ex = aggregated.get(rec.discordId);
    if (ex) {
      ex.wins               += rec.wins;
      ex.losses             += rec.losses;
      ex.pointDifferential  += rec.pointDifferential;
      ex.playoffWins        += rec.playoffWins;
      ex.playoffLosses      += rec.playoffLosses;
      ex.superbowlWins      += rec.superbowlWins;
      ex.superbowlLosses    += rec.superbowlLosses;
      ex.username = rec.discordUsername;
      if (rec.team) ex.team = rec.team;
    } else {
      aggregated.set(rec.discordId, {
        username: rec.discordUsername,
        team: rec.team ?? null,
        wins: rec.wins,
        losses: rec.losses,
        pointDifferential: rec.pointDifferential,
        playoffWins: rec.playoffWins,
        playoffLosses: rec.playoffLosses,
        superbowlWins: rec.superbowlWins,
        superbowlLosses: rec.superbowlLosses,
      });
    }
  }

  const ranked = Array.from(aggregated.values()).map(r => ({
    ...r,
    gamesPlayed: r.wins + r.losses,
    prScore: calcPRScore(r.wins, r.losses, r.pointDifferential),
    label: displayName(r.username, r.team),
  })).sort((a, b) => b.prScore - a.prScore);

  const medals = ["🥇", "🥈", "🥉"];
  const rows = ranked.map((r, i) => {
    const badge = medals[i] ?? `**${ordinal(i + 1)}**`;
    const winPct = r.gamesPlayed > 0 ? ((r.wins / r.gamesPlayed) * 100).toFixed(1) : "0.0";
    const postseason = [
      r.playoffWins + r.playoffLosses > 0 ? `PO: ${r.playoffWins}W-${r.playoffLosses}L` : "",
      r.superbowlWins + r.superbowlLosses > 0 ? `🏆SB: ${r.superbowlWins}W-${r.superbowlLosses}L` : "",
    ].filter(Boolean).join(" | ");
    return `${badge} **${r.label}** — ${r.wins}W-${r.losses}L | ${formatDiff(r.pointDifferential)} pts | ${winPct}% | PR: ${r.prScore.toFixed(1)}${postseason ? ` *(${postseason})*` : ""}`;
  });

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Purple)
        .setTitle("🏆 All-Time Power Rankings")
        .setDescription(rows.join("\n"))
        .setFooter({ text: "PR Score = 60% × (W-L Diff) + 40% × (Point Diff)" })
        .setTimestamp(),
    ],
  });
}
