/**
 * In-menu GOTW voting (replaces Discord polls).
 *
 * Custom-id prefix: `gotwv_`
 *
 * Surface:
 *   • Menu tile: "🏆 GOTW Vote" → opens current GOTW matchup card
 *   • User picks team via dropdown → vote stored in gotw_votes
 *   • Can change vote until the underlying game schedule flips to "started"
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

async function loadActiveGotw(guildId: string): Promise<typeof gotwHistoryTable.$inferSelect | null> {
  const season = await getOrCreateActiveSeason(guildId);
  // Most-recent GOTW for the active season.
  const rows = await db.select().from(gotwHistoryTable)
    .where(eq(gotwHistoryTable.seasonId, season.id))
    .orderBy(desc(gotwHistoryTable.weekIndex))
    .limit(1);
  return rows[0] ?? null;
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
  if (sched.status === "started" || sched.status === "finished" || sched.status === "completed_imported") {
    return { locked: true, reason: "Voting closed — game has started or finished." };
  }
  if (sched.scheduledAt && sched.scheduledAt.getTime() <= Date.now()) {
    return { locked: true, reason: "Voting closed — scheduled start time has passed." };
  }
  return { locked: false, reason: "" };
}

async function buildView(guildId: string, voterId: string): Promise<{
  embeds:     EmbedBuilder[];
  components: ActionRowBuilder<StringSelectMenuBuilder>[];
  content?:   string;
}> {
  const hist = await loadActiveGotw(guildId);
  if (!hist) {
    return {
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("🏆 GOTW Vote")
        .setDescription("No Game of the Week is currently set.")],
      components: [],
    };
  }
  const sched   = await findMatchedSchedule(hist);
  const lock    = votingLocked(sched);
  const [myVote] = await db.select().from(gotwVotesTable)
    .where(and(
      eq(gotwVotesTable.seasonId,  hist.seasonId),
      eq(gotwVotesTable.weekIndex, hist.weekIndex),
      eq(gotwVotesTable.voterId,   voterId),
    )).limit(1);

  // Tallies (revealed live so the user can see momentum)
  const allVotes = await db.select().from(gotwVotesTable).where(and(
    eq(gotwVotesTable.seasonId, hist.seasonId), eq(gotwVotesTable.weekIndex, hist.weekIndex),
  ));
  const tally1 = allVotes.filter((v) => v.votedForDiscordId === hist.discordId1).length;
  const tally2 = allVotes.filter((v) => v.votedForDiscordId === hist.discordId2).length;

  const embed = new EmbedBuilder()
    .setColor(lock.locked ? Colors.Greyple : Colors.Gold)
    .setTitle(`🏆 Game of the Week — Week ${hist.weekIndex + 1}`)
    .setDescription(
      `<@${hist.discordId1}> **${hist.teamName1}** vs <@${hist.discordId2}> **${hist.teamName2}**\n\n` +
      (myVote ? `Your current vote: **${myVote.votedForDiscordId === hist.discordId1 ? hist.teamName1 : hist.teamName2}**\n` : `_No vote yet._\n`) +
      (lock.locked ? `\n🔒 ${lock.reason}` : `\nChange your vote any time until the game starts.`),
    )
    .addFields(
      { name: hist.teamName1, value: `${tally1} vote${tally1 === 1 ? "" : "s"}`, inline: true },
      { name: hist.teamName2, value: `${tally2} vote${tally2 === 1 ? "" : "s"}`, inline: true },
    );

  if (lock.locked) {
    return { embeds: [embed], components: [] };
  }

  const sel = new StringSelectMenuBuilder()
    .setCustomId(`gotwv_pick:${hist.seasonId}:${hist.weekIndex}`)
    .setPlaceholder(myVote ? "Change your vote" : "Pick a team to win")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel(hist.teamName1).setValue(hist.discordId1)
        .setDefault(myVote?.votedForDiscordId === hist.discordId1),
      new StringSelectMenuOptionBuilder().setLabel(hist.teamName2).setValue(hist.discordId2)
        .setDefault(myVote?.votedForDiscordId === hist.discordId2),
    );

  return {
    embeds:     [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
  };
}

// Called by actions-handlers.ts when user clicks the "🏆 GOTW Vote" tile.
export async function openGotwVote(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId ?? PRIMARY_GUILD_ID;
  const view    = await buildView(guildId, interaction.user.id);
  await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
}

// Top-level dispatcher (called from interactionCreate.ts).
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

    if (interaction.isStringSelectMenu() && id.startsWith("gotwv_pick")) {
      const [, seasonIdStr, weekIdxStr] = id.split(":");
      const seasonId  = parseInt(seasonIdStr ?? "0", 10);
      const weekIndex = parseInt(weekIdxStr  ?? "0", 10);
      const votedFor  = interaction.values[0]!;

      // Lock check
      const hist = await db.select().from(gotwHistoryTable)
        .where(and(eq(gotwHistoryTable.seasonId, seasonId), eq(gotwHistoryTable.weekIndex, weekIndex)))
        .limit(1);
      if (!hist[0]) { await interaction.reply({ content: "GOTW disappeared.", flags: MessageFlags.Ephemeral }); return true; }
      const sched = await findMatchedSchedule(hist[0]);
      const lock  = votingLocked(sched);
      if (lock.locked) {
        await interaction.reply({ content: `🔒 ${lock.reason}`, flags: MessageFlags.Ephemeral });
        return true;
      }

      await db.insert(gotwVotesTable).values({
        seasonId, weekIndex, voterId, votedForDiscordId: votedFor,
      }).onConflictDoUpdate({
        target: [gotwVotesTable.seasonId, gotwVotesTable.weekIndex, gotwVotesTable.voterId],
        set:    { votedForDiscordId: votedFor, updatedAt: new Date() },
      });

      const view = await buildView(guildId, voterId);
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
