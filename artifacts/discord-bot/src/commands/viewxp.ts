import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { playerXpLogTable } from "@workspace/db";
import { eq, and, desc, sum, max, sql } from "drizzle-orm";
import { requireMcaEnabled } from "../lib/server-settings.js";
import { getRosterSeasonId } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("viewxp")
  .setDescription("Show player XP earned by week or season total")
  .addSubcommand(sub =>
    sub.setName("week")
      .setDescription("Top XP earners for a specific week")
      .addIntegerOption(o =>
        o.setName("week").setDescription("Week number (defaults to latest)").setRequired(false).setMinValue(1).setMaxValue(23))
      .addIntegerOption(o =>
        o.setName("top").setDescription("How many players to show (default 15)").setRequired(false).setMinValue(5).setMaxValue(30))
  )
  .addSubcommand(sub =>
    sub.setName("season")
      .setDescription("Season XP leaderboard — total XP earned all year")
      .addIntegerOption(o =>
        o.setName("top").setDescription("How many players to show (default 15)").setRequired(false).setMinValue(5).setMaxValue(30))
  )
  .addSubcommand(sub =>
    sub.setName("player")
      .setDescription("XP history for a specific player")
      .addStringOption(o =>
        o.setName("name").setDescription("Player name").setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  if (!await requireMcaEnabled(interaction)) return;

  const guildId = interaction.guildId!;
  const seasonId = await getRosterSeasonId(guildId);
  if (!seasonId) {
    await interaction.editReply("No active season found.");
    return;
  }

  const sub = interaction.options.getSubcommand();

  // ── /viewxp week ──────────────────────────────────────────────────────────
  if (sub === "week") {
    const topN = interaction.options.getInteger("top") ?? 15;
    let weekNum = interaction.options.getInteger("week");

    // Default to latest week with data
    if (!weekNum) {
      const latest = await db
        .select({ weekNum: playerXpLogTable.weekNum })
        .from(playerXpLogTable)
        .where(and(eq(playerXpLogTable.seasonId, seasonId), sql`${playerXpLogTable.weekNum} IS NOT NULL`))
        .orderBy(desc(playerXpLogTable.weekNum))
        .limit(1);
      weekNum = latest[0]?.weekNum ?? null;
    }

    if (!weekNum) {
      await interaction.editReply("No weekly XP data found yet. XP is tracked automatically on each roster export.");
      return;
    }

    const rows = await db
      .select({
        firstName: playerXpLogTable.firstName,
        lastName:  playerXpLogTable.lastName,
        position:  playerXpLogTable.position,
        teamName:  playerXpLogTable.teamName,
        xpEarned:  playerXpLogTable.xpEarned,
        xpTotal:   playerXpLogTable.xpTotal,
      })
      .from(playerXpLogTable)
      .where(and(
        eq(playerXpLogTable.seasonId, seasonId),
        eq(playerXpLogTable.weekNum,  weekNum),
      ))
      .orderBy(desc(playerXpLogTable.xpEarned))
      .limit(topN);

    if (rows.length === 0) {
      await interaction.editReply(`No XP data for Week ${weekNum}.`);
      return;
    }

    const lines = rows.map((r, i) => {
      const name = `${r.firstName} ${r.lastName}`.trim();
      const rank = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      return `${rank} **${name}** (${r.position}) — **+${r.xpEarned.toLocaleString()} XP** | Total: ${r.xpTotal.toLocaleString()}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`⚡ Week ${weekNum} XP Leaders`)
      .setDescription(lines.join("\n"))
      .setColor(Colors.Gold)
      .setFooter({ text: `Top ${rows.length} XP earners • Week ${weekNum}` });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── /viewxp season ────────────────────────────────────────────────────────
  if (sub === "season") {
    const topN = interaction.options.getInteger("top") ?? 15;

    const rows = await db
      .select({
        firstName:   playerXpLogTable.firstName,
        lastName:    playerXpLogTable.lastName,
        position:    playerXpLogTable.position,
        teamName:    playerXpLogTable.teamName,
        totalEarned: sum(playerXpLogTable.xpEarned),
        latestTotal: max(playerXpLogTable.xpTotal),
      })
      .from(playerXpLogTable)
      .where(eq(playerXpLogTable.seasonId, seasonId))
      .groupBy(
        playerXpLogTable.playerId,
        playerXpLogTable.firstName,
        playerXpLogTable.lastName,
        playerXpLogTable.position,
        playerXpLogTable.teamName,
      )
      .orderBy(desc(sum(playerXpLogTable.xpEarned)))
      .limit(topN);

    if (rows.length === 0) {
      await interaction.editReply("No XP data recorded yet. XP is tracked automatically on each roster export.");
      return;
    }

    const lines = rows.map((r, i) => {
      const name = `${r.firstName} ${r.lastName}`.trim();
      const earned = Number(r.totalEarned ?? 0);
      const total  = Number(r.latestTotal ?? 0);
      const rank = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      return `${rank} **${name}** (${r.position}) — **+${earned.toLocaleString()} XP** | Total: ${total.toLocaleString()}`;
    });

    const embed = new EmbedBuilder()
      .setTitle("⚡ Season XP Leaderboard")
      .setDescription(lines.join("\n"))
      .setColor(Colors.Gold)
      .setFooter({ text: `Top ${rows.length} XP earners this season` });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── /viewxp player ────────────────────────────────────────────────────────
  if (sub === "player") {
    const nameQuery = interaction.options.getString("name", true).trim();
    const [first, ...rest] = nameQuery.split(/\s+/);
    const last = rest.join(" ");

    const rows = await db
      .select({
        weekNum:  playerXpLogTable.weekNum,
        weekType: playerXpLogTable.weekType,
        xpEarned: playerXpLogTable.xpEarned,
        xpTotal:  playerXpLogTable.xpTotal,
        teamName: playerXpLogTable.teamName,
        firstName: playerXpLogTable.firstName,
        lastName:  playerXpLogTable.lastName,
        position:  playerXpLogTable.position,
        loggedAt:  playerXpLogTable.loggedAt,
      })
      .from(playerXpLogTable)
      .where(and(
        eq(playerXpLogTable.seasonId, seasonId),
        sql`LOWER(${playerXpLogTable.firstName}) LIKE LOWER(${"%" + first + "%"})`,
        last ? sql`LOWER(${playerXpLogTable.lastName}) LIKE LOWER(${"%" + last + "%"})` : sql`TRUE`,
      ))
      .orderBy(playerXpLogTable.weekNum);

    if (rows.length === 0) {
      await interaction.editReply(`No XP history found for **${nameQuery}**.`);
      return;
    }

    const p = rows[0]!;
    const name = `${p.firstName} ${p.lastName}`.trim();
    const totalEarned = rows.reduce((s, r) => s + r.xpEarned, 0);
    const latestTotal = rows.at(-1)!.xpTotal;

    const lines = rows.map(r => {
      const wk = r.weekNum ? `Week ${r.weekNum}` : r.loggedAt.toLocaleDateString();
      return `**${wk}** — +${r.xpEarned.toLocaleString()} XP (running total: ${r.xpTotal.toLocaleString()})`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`⚡ ${name} (${p.position}) — XP History`)
      .setDescription(lines.join("\n"))
      .addFields(
        { name: "Season XP Earned", value: totalEarned.toLocaleString(), inline: true },
        { name: "Career Total",     value: latestTotal.toLocaleString(),  inline: true },
        { name: "Team",             value: p.teamName,                    inline: true },
      )
      .setColor(Colors.Gold);

    await interaction.editReply({ embeds: [embed] });
  }
}
