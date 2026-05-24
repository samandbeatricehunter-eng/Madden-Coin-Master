/**
 * In-menu GOTW voting (replaces Discord polls).
 *
 * Custom-id prefix: `gotwv_`
 *
 * Surface:
 *   • Menu tile: "🏆 GOTW Vote" → opens the latest week's matchups.
 *   • For regular season there's one matchup; in the playoffs every H2H game
 *     is a votable GOTW (matchupIndex disambiguates).
 *   • User picks team via dropdown → vote stored in gotw_votes
 *     (one vote per matchup).
 *   • Vote can be changed until the game schedule flips to "started"
 *     (or the schedule's scheduledAt has already passed).
 *   • On winner-confirmation (game-scheduling-handlers.settleGotwForGame),
 *     all correct voters are paid.
 */

import {
  ButtonInteraction, StringSelectMenuInteraction, MessageFlags,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import {
  gotwHistoryTable, gotwVotesTable, gameSchedulesTable, seasonsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getOrCreateActiveSeason, PRIMARY_GUILD_ID } from "../db/db-helpers.js";

async function loadActiveMatchups(guildId: string): Promise<typeof gotwHistoryTable.$inferSelect[]> {
  const season = await getOrCreateActiveSeason(guildId);
  // Find the highest weekIndex with any GOTW row, then return ALL matchups for it.
  const [recent] = await db.select({ weekIndex: gotwHistoryTable.weekIndex })
    .from(gotwHistoryTable)
    .where(eq(gotwHistoryTable.seasonId, season.id))
    .orderBy(desc(gotwHistoryTable.weekIndex))
    .limit(1);
  if (!recent) return [];
  return db.select().from(gotwHistoryTable).where(and(
    eq(gotwHistoryTable.seasonId, season.id),
    eq(gotwHistoryTable.weekIndex, recent.weekIndex),
  )).orderBy(gotwHistoryTable.matchupIndex);
}

async function findMatchedSchedule(hist: typeof gotwHistoryTable.$inferSelect): Promise<typeof gameSchedulesTable.$inferSelect | null> {
  const rows = await db.select().from(gameSchedulesTable)
    .where(and(eq(gameSchedulesTable.seasonId, hist.seasonId), eq(gameSchedulesTable.weekIndex, hist.weekIndex)));
  return rows.find((s) =>
    (s.awayDiscordId === hist.discordId1 && s.homeDiscordId === hist.discordId2) ||
    (s.awayDiscordId === hist.discordId2 && s.homeDiscordId === hist.discordId1),
  ) ?? null;
}

function votingLocked(sched: typeof gameSchedulesTable.$inferSelect | null): { locked: boolean; reason: string } {
  if (!sched) return { locked: false, reason: "" };
  if (["started", "finished", "completed_imported", "fair_sim", "auto_fair_sim", "force_win"].includes(sched.status)) {
    return { locked: true, reason: "Voting closed — game has started, finished, or been resolved." };
  }
  if (sched.scheduledAt && sched.scheduledAt.getTime() <= Date.now()) {
    return { locked: true, reason: "Voting closed — scheduled start time has passed." };
  }
  return { locked: false, reason: "" };
}

async function buildSingleMatchupView(hist: typeof gotwHistoryTable.$inferSelect, voterId: string, weekLabelText: string): Promise<{
  embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder>[];
}> {
  const sched = await findMatchedSchedule(hist);
  const lock  = votingLocked(sched);

  const [myVote] = await db.select().from(gotwVotesTable).where(and(
    eq(gotwVotesTable.seasonId,     hist.seasonId),
    eq(gotwVotesTable.weekIndex,    hist.weekIndex),
    eq(gotwVotesTable.matchupIndex, hist.matchupIndex),
    eq(gotwVotesTable.voterId,      voterId),
  )).limit(1);

  const allVotes = await db.select().from(gotwVotesTable).where(and(
    eq(gotwVotesTable.seasonId,     hist.seasonId),
    eq(gotwVotesTable.weekIndex,    hist.weekIndex),
    eq(gotwVotesTable.matchupIndex, hist.matchupIndex),
  ));
  const tally1 = allVotes.filter(v => v.votedForDiscordId === hist.discordId1).length;
  const tally2 = allVotes.filter(v => v.votedForDiscordId === hist.discordId2).length;

  const embed = new EmbedBuilder()
    .setColor(lock.locked ? Colors.Greyple : Colors.Gold)
    .setTitle(`🏆 Game of the Week — ${weekLabelText}`)
    .setDescription(
      `<@${hist.discordId1}> **${hist.teamName1}** vs <@${hist.discordId2}> **${hist.teamName2}**\n\n` +
      (myVote ? `Your current vote: **${myVote.votedForDiscordId === hist.discordId1 ? hist.teamName1 : hist.teamName2}**\n` : `_No vote yet._\n`) +
      (lock.locked ? `\n🔒 ${lock.reason}` : `\nChange your vote any time until the game starts.`),
    )
    .addFields(
      { name: hist.teamName1, value: `${tally1} vote${tally1 === 1 ? "" : "s"}`, inline: true },
      { name: hist.teamName2, value: `${tally2} vote${tally2 === 1 ? "" : "s"}`, inline: true },
    );

  if (lock.locked) return { embeds: [embed], components: [] };

  const sel = new StringSelectMenuBuilder()
    .setCustomId(`gotwv_pick:${hist.seasonId}:${hist.weekIndex}:${hist.matchupIndex}`)
    .setPlaceholder(myVote ? "Change your vote" : "Pick a team to win")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel(hist.teamName1).setValue(hist.discordId1)
        .setDefault(myVote?.votedForDiscordId === hist.discordId1),
      new StringSelectMenuOptionBuilder().setLabel(hist.teamName2).setValue(hist.discordId2)
        .setDefault(myVote?.votedForDiscordId === hist.discordId2),
    );

  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)] };
}

function weekLabelFor(weekIndex: number): string {
  // Map known playoff weekIndices to friendly labels; otherwise "Week N".
  if (weekIndex === 1018) return "Wild Card";
  if (weekIndex === 1019) return "Divisional";
  if (weekIndex === 1020) return "Conference Championship";
  if (weekIndex === 1022) return "Super Bowl";
  return `Week ${weekIndex + 1}`;
}

async function buildView(guildId: string, voterId: string, pickedMatchupIndex?: number): Promise<{
  embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder>[]; content?: string;
}> {
  const matchups = await loadActiveMatchups(guildId);
  if (matchups.length === 0) {
    return {
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("🏆 GOTW Vote")
        .setDescription("No Game of the Week is currently set.")],
      components: [],
    };
  }

  const weekIndex = matchups[0]!.weekIndex;
  const weekLabelText = weekLabelFor(weekIndex);

  // Only one matchup → render directly.
  if (matchups.length === 1) {
    return buildSingleMatchupView(matchups[0]!, voterId, weekLabelText);
  }

  // Multiple matchups (playoffs) → show picker. If a matchup is selected,
  // also render its vote card below.
  const myVotes = await db.select().from(gotwVotesTable).where(and(
    eq(gotwVotesTable.seasonId,  matchups[0]!.seasonId),
    eq(gotwVotesTable.weekIndex, weekIndex),
    eq(gotwVotesTable.voterId,   voterId),
  ));
  const votedSet = new Set(myVotes.map(v => v.matchupIndex));

  const allScheds = await db.select().from(gameSchedulesTable).where(and(
    eq(gameSchedulesTable.seasonId,  matchups[0]!.seasonId),
    eq(gameSchedulesTable.weekIndex, weekIndex),
  ));
  function lockOf(m: typeof matchups[number]): boolean {
    const sched = allScheds.find(s =>
      (s.awayDiscordId === m.discordId1 && s.homeDiscordId === m.discordId2) ||
      (s.awayDiscordId === m.discordId2 && s.homeDiscordId === m.discordId1),
    ) ?? null;
    return votingLocked(sched).locked;
  }

  const summary = matchups.map(m => {
    const voted = votedSet.has(m.matchupIndex);
    const locked = lockOf(m);
    const flag = locked ? "🔒" : voted ? "✅" : "🟡";
    return `${flag} **${m.teamName1}** vs **${m.teamName2}**`;
  }).join("\n");

  const pickerEmbed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🏆 GOTW Vote — ${weekLabelText}`)
    .setDescription(
      `Pick a matchup to cast or change your vote.\n\n${summary}\n\n` +
      `🟡 = needs vote · ✅ = voted · 🔒 = closed`,
    );

  const picker = new StringSelectMenuBuilder()
    .setCustomId(`gotwv_open:${matchups[0]!.seasonId}:${weekIndex}`)
    .setPlaceholder("Choose a matchup…")
    .addOptions(matchups.slice(0, 25).map(m => {
      const voted = votedSet.has(m.matchupIndex);
      const locked = lockOf(m);
      const tag = locked ? "[CLOSED] " : voted ? "[VOTED] " : "";
      const label = `${tag}${m.teamName1} vs ${m.teamName2}`.slice(0, 100);
      return new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setValue(String(m.matchupIndex))
        .setDefault(pickedMatchupIndex === m.matchupIndex);
    }));

  const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker),
  ];
  const embeds: EmbedBuilder[] = [pickerEmbed];

  if (pickedMatchupIndex !== undefined) {
    const picked = matchups.find(m => m.matchupIndex === pickedMatchupIndex);
    if (picked) {
      const sub = await buildSingleMatchupView(picked, voterId, weekLabelText);
      embeds.push(...sub.embeds);
      components.push(...sub.components);
    }
  }

  return { embeds, components };
}

export async function openGotwVote(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId ?? PRIMARY_GUILD_ID;
  const view    = await buildView(guildId, interaction.user.id);
  await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
}

export async function handleGotwvInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith("gotwv_")) return false;
  const guildId = interaction.guildId ?? PRIMARY_GUILD_ID;
  const voterId = interaction.user.id;

  try {
    if (interaction.isButton() && id.startsWith("gotwv_open")) {
      const view = await buildView(guildId, voterId);
      await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
      return true;
    }

    // Matchup picker (playoffs only) → re-render with selected matchup inline.
    if (interaction.isStringSelectMenu() && id.startsWith("gotwv_open")) {
      const matchupIndex = parseInt(interaction.values[0] ?? "0", 10);
      const view = await buildView(guildId, voterId, matchupIndex);
      await interaction.update(view);
      return true;
    }

    if (interaction.isStringSelectMenu() && id.startsWith("gotwv_pick")) {
      const [, seasonIdStr, weekIdxStr, matchupIdxStr] = id.split(":");
      const seasonId     = parseInt(seasonIdStr   ?? "0", 10);
      const weekIndex    = parseInt(weekIdxStr    ?? "0", 10);
      const matchupIndex = parseInt(matchupIdxStr ?? "0", 10);
      const votedFor     = interaction.values[0]!;

      const [hist] = await db.select().from(gotwHistoryTable).where(and(
        eq(gotwHistoryTable.seasonId,     seasonId),
        eq(gotwHistoryTable.weekIndex,    weekIndex),
        eq(gotwHistoryTable.matchupIndex, matchupIndex),
      )).limit(1);
      if (!hist) { await interaction.reply({ content: "GOTW matchup disappeared.", flags: MessageFlags.Ephemeral }); return true; }

      const sched = await findMatchedSchedule(hist);
      const lock  = votingLocked(sched);
      if (lock.locked) {
        await interaction.reply({ content: `🔒 ${lock.reason}`, flags: MessageFlags.Ephemeral });
        return true;
      }

      await db.insert(gotwVotesTable).values({
        seasonId, weekIndex, matchupIndex, voterId, votedForDiscordId: votedFor,
      }).onConflictDoUpdate({
        target: [gotwVotesTable.seasonId, gotwVotesTable.weekIndex, gotwVotesTable.matchupIndex, gotwVotesTable.voterId],
        set:    { votedForDiscordId: votedFor, updatedAt: new Date() },
      });

      // If we're in multi-matchup mode, keep the picker selection visible.
      const matchups = await loadActiveMatchups(guildId);
      const view = matchups.length > 1
        ? await buildView(guildId, voterId, matchupIndex)
        : await buildView(guildId, voterId);
      await interaction.update(view);
      return true;
    }
  } catch (err) {
    console.error("[gotwv] handler error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ ${err instanceof Error ? err.message : String(err)}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}

// Used by gotw-helpers.seedGotwMatch to be consistent.
void seasonsTable;
