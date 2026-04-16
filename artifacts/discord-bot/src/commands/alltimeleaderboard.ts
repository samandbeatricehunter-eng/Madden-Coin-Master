import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userRecordsTable } from "@workspace/db";
import { inArray, sum, max } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("alltimeleaderboard")
  .setDescription("All-time global top 25 — every player ever ranked across all servers, with or without a current team");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  // ── 1. Get every discordId that ever had a recorded season ──────────────────
  const allUserRows = await db
    .selectDistinct({ discordId: userRecordsTable.discordId })
    .from(userRecordsTable);

  if (allUserRows.length === 0) {
    await interaction.editReply({ content: "📭 No records found yet." });
    return;
  }

  const allIds = allUserRows.map(r => r.discordId);

  // ── 2. Aggregate records + SB data in parallel ───────────────────────────────
  const [recordAgg, sbRows] = await Promise.all([
    db.select({
      discordId:     userRecordsTable.discordId,
      totalWins:     sum(userRecordsTable.wins),
      totalLosses:   sum(userRecordsTable.losses),
      totalPD:       sum(userRecordsTable.pointDifferential),
      totalPOWins:   sum(userRecordsTable.playoffWins),
      totalPOLosses: sum(userRecordsTable.playoffLosses),
    })
      .from(userRecordsTable)
      .groupBy(userRecordsTable.discordId),

    // MAX across guild rows to avoid double-counting multi-guild users
    db.select({
      discordId:              usersTable.discordId,
      allTimeSuperbowlWins:   max(usersTable.allTimeSuperbowlWins),
      allTimeSuperbowlLosses: max(usersTable.allTimeSuperbowlLosses),
    })
      .from(usersTable)
      .where(inArray(usersTable.discordId, allIds))
      .groupBy(usersTable.discordId),
  ]);

  // ── 3. Build lookup maps ─────────────────────────────────────────────────────
  const recordMap = new Map(recordAgg.map(r => [r.discordId, r]));
  const sbMap     = new Map(sbRows.map(r => [r.discordId, r]));

  // ── 4. Sort all players: wins desc → losses asc → PD desc ───────────────────
  const sorted = [...recordAgg].sort((a, b) => {
    const wA = Number(a.totalWins   ?? 0);
    const wB = Number(b.totalWins   ?? 0);
    if (wB !== wA) return wB - wA;
    const lA = Number(a.totalLosses ?? 0);
    const lB = Number(b.totalLosses ?? 0);
    if (lA !== lB) return lA - lB;
    return Number(b.totalPD ?? 0) - Number(a.totalPD ?? 0);
  });

  // ── 5. Take top 25 ───────────────────────────────────────────────────────────
  const top25 = sorted.slice(0, 25);

  // ── 6. Try to resolve display names for those in this guild ─────────────────
  const displayNames = new Map<string, string>();
  try {
    const members = await interaction.guild!.members.fetch({ user: top25.map(u => u.discordId) });
    for (const [id, member] of members) {
      displayNames.set(id, member.displayName);
    }
  } catch {
    // Fallback — will show "Unknown User" for those not in this server
  }

  // ── 7. Build display lines ───────────────────────────────────────────────────
  const lines = top25.map((u, i) => {
    const rec      = recordMap.get(u.discordId);
    const sb       = sbMap.get(u.discordId);

    const gWins    = Number(rec?.totalWins     ?? 0);
    const gLosses  = Number(rec?.totalLosses   ?? 0);
    const gPD      = Number(rec?.totalPD       ?? 0);
    const poWins   = Number(rec?.totalPOWins   ?? 0);
    const poLosses = Number(rec?.totalPOLosses ?? 0);
    const sbWins   = sb?.allTimeSuperbowlWins   ?? 0;
    const sbLosses = sb?.allTimeSuperbowlLosses ?? 0;

    const gamesPlayed = gWins + gLosses;
    const winPct      = gamesPlayed > 0
      ? ((gWins / gamesPlayed) * 100).toFixed(1) + "%"
      : "—";
    const pdStr = gPD >= 0 ? `+${gPD}` : `${gPD}`;

    const displayName = displayNames.get(u.discordId) ?? "Unknown User";

    const postseasonParts = [
      poWins + poLosses > 0 ? `PO: ${poWins}W-${poLosses}L` : "",
      sbWins + sbLosses > 0 ? `🏆SB: ${sbWins}W-${sbLosses}L` : "",
    ].filter(Boolean).join("  ·  ");

    return [
      `**#${i + 1} ${displayName}** — <@${u.discordId}>`,
      `┣ 🪪 Discord ID: \`${u.discordId}\``,
      `┣ 🌐 **${gWins}W – ${gLosses}L** (${winPct})  ·  📊 PD: **${pdStr}**${postseasonParts ? `  ·  ${postseasonParts}` : ""}`,
      `┗ `,
    ].join("\n").replace(/┗ \n?$/, "┗ ─────────────────────");
  });

  // ── 8. Paginate at 5 per embed (each entry is multi-line) ───────────────────
  const pageSize = 5;
  const pages    = Math.ceil(lines.length / pageSize);
  const embeds   = [];

  for (let p = 0; p < pages; p++) {
    const chunk = lines.slice(p * pageSize, (p + 1) * pageSize);
    embeds.push(
      new EmbedBuilder()
        .setColor(Colors.DarkGold)
        .setTitle(
          p === 0
            ? `🏆 All-Time Global Leaderboard — Top ${top25.length}`
            : "🏆 All-Time Global Leaderboard (continued)",
        )
        .setDescription(chunk.join("\n\n"))
        .setFooter({
          text: [
            "Includes every player across all REC League servers — active or not",
            "Sorted by: W desc → L asc → Point Differential desc",
            pages > 1 ? `Page ${p + 1}/${pages}` : "",
          ].filter(Boolean).join("  ·  "),
        })
        .setTimestamp(),
    );
  }

  await interaction.editReply({ embeds: embeds.slice(0, 10) });
}
