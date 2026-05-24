/**
 * In-menu GOTY voting (replaces Discord poll).
 *
 * Round lifecycle:
 *   - Seeded by wildcard-automation when advancing to wildcard week:
 *     scrape last 100 messages from GOTY channel, dedupe, insert as candidates,
 *     create gotyRounds row with voteEndsAt = now + 24h, status='open'.
 *   - Users vote via /menu → "🎮 GOTY Vote" tile.
 *   - When voteEndsAt passes, the next view-load triggers finalize:
 *     top-2 candidates win, each candidate's submitter is paid GOTY_WINNER coins,
 *     round status flips to 'finalized'.
 *
 * Custom-id prefix: `gotyv_`
 */

import {
  ButtonInteraction, StringSelectMenuInteraction, MessageFlags,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  EmbedBuilder, Colors,
  type Client,
} from "discord.js";
import { db } from "@workspace/db";
import {
  gotyRoundsTable, gotyCandidatesTable, gotyVotesTable,
} from "@workspace/db";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { getOrCreateActiveSeason, PRIMARY_GUILD_ID, addBalance, logTransaction } from "../db/db-helpers.js";
import { getPayoutValue, PAYOUT_KEYS } from "../economy/payout-config.js";

async function finalizeIfDue(client: Client, seasonId: number, guildId: string): Promise<void> {
  // Atomic claim — only one tick performs the finalization.
  const claimed = await db.update(gotyRoundsTable)
    .set({ status: "finalized", finalizedAt: new Date() })
    .where(and(
      eq(gotyRoundsTable.seasonId, seasonId),
      eq(gotyRoundsTable.status, "open"),
      sql`${gotyRoundsTable.voteEndsAt} <= now()`,
    ))
    .returning({ seasonId: gotyRoundsTable.seasonId });
  if (claimed.length === 0) return;

  // Tally and pay top-2 candidates' submitters.
  const tallies = await db
    .select({ candidateId: gotyVotesTable.candidateId, cnt: sql<number>`count(*)::int` })
    .from(gotyVotesTable)
    .where(eq(gotyVotesTable.seasonId, seasonId))
    .groupBy(gotyVotesTable.candidateId)
    .orderBy(desc(sql<number>`count(*)`))
    .limit(2);

  if (tallies.length === 0) return;

  const candidates = await db.select().from(gotyCandidatesTable)
    .where(eq(gotyCandidatesTable.seasonId, seasonId));
  const candMap = new Map(candidates.map(c => [c.id, c]));
  const gotyCoins = await getPayoutValue(PAYOUT_KEYS.GOTY_WINNER, guildId);
  if (gotyCoins <= 0) return;

  for (const t of tallies) {
    const cand = candMap.get(t.candidateId);
    if (!cand?.authorId) continue;
    await addBalance(cand.authorId, gotyCoins, guildId);
    await logTransaction(cand.authorId, gotyCoins, "addcoins",
      `GOTY Award Winner — Season ${seasonId}`, guildId, "auto");
    try {
      const u = await client.users.fetch(cand.authorId).catch(() => null);
      await u?.send(
        `🎮 **Your GOTY submission won!**\n+${gotyCoins} 🪙 coins have been added to your balance.\n\n` +
        `_Submission:_ ${cand.text.slice(0, 200)}`,
      ).catch(() => {});
    } catch { /* ignore */ }
  }
}

async function buildView(client: Client, guildId: string, voterId: string): Promise<{
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<StringSelectMenuBuilder>[];
}> {
  const season = await getOrCreateActiveSeason(guildId);
  const [round] = await db.select().from(gotyRoundsTable).where(eq(gotyRoundsTable.seasonId, season.id)).limit(1);

  if (!round) {
    return {
      embeds: [new EmbedBuilder().setColor(Colors.Greyple).setTitle("🎮 Game of the Year Vote")
        .setDescription("No GOTY vote is currently active.")],
      components: [],
    };
  }

  // Auto-finalize if past deadline
  if (round.status === "open" && round.voteEndsAt.getTime() <= Date.now()) {
    await finalizeIfDue(client, season.id, guildId);
  }

  const [latest] = await db.select().from(gotyRoundsTable).where(eq(gotyRoundsTable.seasonId, season.id)).limit(1);
  const r = latest!;
  const candidates = await db.select().from(gotyCandidatesTable)
    .where(eq(gotyCandidatesTable.seasonId, season.id))
    .orderBy(gotyCandidatesTable.idx);

  const votes = await db.select({ candidateId: gotyVotesTable.candidateId })
    .from(gotyVotesTable)
    .where(eq(gotyVotesTable.seasonId, season.id));
  const tally = new Map<number, number>();
  for (const v of votes) tally.set(v.candidateId, (tally.get(v.candidateId) ?? 0) + 1);

  const [myVote] = await db.select().from(gotyVotesTable).where(and(
    eq(gotyVotesTable.seasonId, season.id), eq(gotyVotesTable.voterId, voterId),
  )).limit(1);

  const isOpen = r.status === "open" && r.voteEndsAt.getTime() > Date.now();
  const endsTs = Math.floor(r.voteEndsAt.getTime() / 1000);

  const lines = candidates
    .slice()
    .sort((a, b) => (tally.get(b.id) ?? 0) - (tally.get(a.id) ?? 0))
    .slice(0, 25)
    .map((c, i) => {
      const n   = tally.get(c.id) ?? 0;
      const me  = myVote?.candidateId === c.id ? " ⭐" : "";
      const txt = c.text.length > 90 ? c.text.slice(0, 87) + "…" : c.text;
      return `**${i + 1}.** ${txt} — \`${n}\`${me}`;
    });

  const desc =
    (isOpen ? `🕒 Voting ends <t:${endsTs}:R>\n` : `🔒 **Voting closed** (status: ${r.status})\n`) +
    (myVote ? "Your current pick is marked ⭐. Change any time until close.\n" : "_You haven't voted yet._\n") +
    (lines.length > 0 ? "\n" + lines.join("\n") : "\n*No candidates available.*");

  const embed = new EmbedBuilder()
    .setColor(isOpen ? Colors.Gold : Colors.Greyple)
    .setTitle(`🎮 Game of the Year — Season ${season.seasonNumber}`)
    .setDescription(desc);

  if (!isOpen || candidates.length === 0) {
    return { embeds: [embed], components: [] };
  }

  const opts = candidates.slice(0, 25).map(c => {
    const label = c.text.length > 90 ? c.text.slice(0, 87) + "…" : c.text;
    return new StringSelectMenuOptionBuilder()
      .setLabel(label.slice(0, 100))
      .setValue(String(c.id))
      .setDefault(myVote?.candidateId === c.id);
  });

  const sel = new StringSelectMenuBuilder()
    .setCustomId(`gotyv_pick:${season.id}`)
    .setPlaceholder(myVote ? "Change your vote" : "Pick your GOTY")
    .addOptions(opts);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
  };
}

export async function openGotyVote(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId ?? PRIMARY_GUILD_ID;
  const view    = await buildView(interaction.client, guildId, interaction.user.id);
  await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
}

export async function handleGotyvInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith("gotyv_")) return false;
  const guildId = interaction.guildId ?? PRIMARY_GUILD_ID;
  const voterId = interaction.user.id;

  try {
    if (interaction.isButton() && id.startsWith("gotyv_open")) {
      const view = await buildView(interaction.client, guildId, voterId);
      await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (interaction.isStringSelectMenu() && id.startsWith("gotyv_pick")) {
      const [, seasonIdStr] = id.split(":");
      const seasonId   = parseInt(seasonIdStr ?? "0", 10);
      const candidateId = parseInt(interaction.values[0] ?? "0", 10);

      const [round] = await db.select().from(gotyRoundsTable).where(eq(gotyRoundsTable.seasonId, seasonId)).limit(1);
      if (!round || round.status !== "open" || round.voteEndsAt.getTime() <= Date.now()) {
        await interaction.reply({ content: "🔒 Voting is closed.", flags: MessageFlags.Ephemeral });
        return true;
      }

      await db.insert(gotyVotesTable).values({
        seasonId, candidateId, voterId,
      }).onConflictDoUpdate({
        target: [gotyVotesTable.seasonId, gotyVotesTable.voterId],
        set:    { candidateId, updatedAt: new Date() },
      });

      const view = await buildView(interaction.client, guildId, voterId);
      await interaction.update(view);
      return true;
    }
  } catch (err) {
    console.error("[gotyv] handler error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `❌ ${err instanceof Error ? err.message : String(err)}`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
  return true;
}

// Called by isNull (re-export) — silence unused-import warnings.
void isNull;
