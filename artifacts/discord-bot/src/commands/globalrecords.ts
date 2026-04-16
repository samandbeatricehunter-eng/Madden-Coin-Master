import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userSavingsTable, userRecordsTable } from "@workspace/db";
import { eq, and, isNotNull, ne, inArray, sum, max } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("globalrecords")
  .setDescription("Leaderboard: every team's cross-server cumulative W/L, playoff, SB records, wallet, and savings");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId!;

  // ── 1. Fetch all users in this guild that have a team linked ───────────────
  // Exclude null AND empty-string teams at the DB level so unlinked users never appear.
  const filteredUsers = await db
    .select({ discordId: usersTable.discordId, team: usersTable.team, serverWallet: usersTable.balance })
    .from(usersTable)
    .where(and(
      eq(usersTable.guildId, guildId),
      isNotNull(usersTable.team),
      ne(usersTable.team, ""),
    ));

  if (filteredUsers.length === 0) {
    await interaction.editReply({ content: "📭 No linked teams found in this server yet." });
    return;
  }

  const allIds = filteredUsers.map(u => u.discordId);

  // ── 2. Parallel fetches ────────────────────────────────────────────────────
  const [recordAgg, allServerBalances, savingsRows, sbRows] = await Promise.all([
    // Aggregate W/L/PD/playoff across ALL seasons and ALL guilds per user
    db.select({
      discordId:        userRecordsTable.discordId,
      totalWins:        sum(userRecordsTable.wins),
      totalLosses:      sum(userRecordsTable.losses),
      totalPD:          sum(userRecordsTable.pointDifferential),
      totalPOWins:      sum(userRecordsTable.playoffWins),
      totalPOLosses:    sum(userRecordsTable.playoffLosses),
    })
      .from(userRecordsTable)
      .where(inArray(userRecordsTable.discordId, allIds))
      .groupBy(userRecordsTable.discordId),

    // Sum wallet balance across every guild for each user
    db.select({ discordId: usersTable.discordId, totalBalance: sum(usersTable.balance) })
      .from(usersTable)
      .where(inArray(usersTable.discordId, allIds))
      .groupBy(usersTable.discordId),

    db.select({ discordId: userSavingsTable.discordId, balance: userSavingsTable.balance })
      .from(userSavingsTable)
      .where(inArray(userSavingsTable.discordId, allIds)),

    // All-time SB data from usersTable — MAX across all guilds per user
    // (usersTable has one row per guild; a user in 2 guilds would otherwise
    //  have the last row overwrite the first in a plain Map)
    db.select({
      discordId:              usersTable.discordId,
      allTimeSuperbowlWins:   max(usersTable.allTimeSuperbowlWins),
      allTimeSuperbowlLosses: max(usersTable.allTimeSuperbowlLosses),
    })
      .from(usersTable)
      .where(inArray(usersTable.discordId, allIds))
      .groupBy(usersTable.discordId),
  ]);

  // ── 3. Build lookup maps ───────────────────────────────────────────────────
  const recordMap    = new Map(recordAgg.map(r => [r.discordId, r]));
  const globalWallet = new Map(allServerBalances.map(r => [r.discordId, Number(r.totalBalance ?? 0)]));
  const savingsMap   = new Map(savingsRows.map(s => [s.discordId, s.balance]));
  const sbMap        = new Map(sbRows.map(r => [r.discordId, r]));
  const serverMap    = new Map(filteredUsers.map(u => [u.discordId, u]));

  // ── 4. Fetch guild member display names ────────────────────────────────────
  const displayNames = new Map<string, string>();
  try {
    const members = await interaction.guild!.members.fetch({ user: allIds });
    for (const [id, member] of members) {
      displayNames.set(id, member.displayName);
    }
  } catch {
    // Fallback to stored team name
  }

  // ── 5. Sort by global wins desc, then losses asc ───────────────────────────
  const sorted = [...filteredUsers].sort((a, b) => {
    const wA = Number(recordMap.get(a.discordId)?.totalWins ?? 0);
    const wB = Number(recordMap.get(b.discordId)?.totalWins ?? 0);
    if (wB !== wA) return wB - wA;
    return Number(recordMap.get(a.discordId)?.totalLosses ?? 0)
         - Number(recordMap.get(b.discordId)?.totalLosses ?? 0);
  });

  // ── 6. Build display lines ─────────────────────────────────────────────────
  const lines = sorted.map((u, i) => {
    const rec        = recordMap.get(u.discordId);
    const sb         = sbMap.get(u.discordId);

    const gWins      = Number(rec?.totalWins     ?? 0);
    const gLosses    = Number(rec?.totalLosses   ?? 0);
    const poWins     = Number(rec?.totalPOWins   ?? 0);
    const poLosses   = Number(rec?.totalPOLosses ?? 0);
    const sbWins     = sb?.allTimeSuperbowlWins   ?? 0;
    const sbLosses   = sb?.allTimeSuperbowlLosses ?? 0;

    const gamesPlayed = gWins + gLosses;
    const winPct      = gamesPlayed > 0
      ? ((gWins / gamesPlayed) * 100).toFixed(1) + "%"
      : "—";

    const serverWallet = serverMap.get(u.discordId)?.serverWallet ?? 0;
    const globalW      = globalWallet.get(u.discordId) ?? 0;
    const savings      = savingsMap.get(u.discordId) ?? 0;
    const displayName  = displayNames.get(u.discordId) ?? u.team ?? "Unknown";
    const teamStr      = u.team ? ` — ${u.team}` : "";

    const postseasonParts = [
      poWins + poLosses > 0 ? `PO: ${poWins}W-${poLosses}L` : "",
      sbWins + sbLosses > 0 ? `🏆SB: ${sbWins}W-${sbLosses}L` : "",
    ].filter(Boolean).join("  ·  ");

    return [
      `**#${i + 1} ${displayName}** (<@${u.discordId}>)${teamStr}`,
      `┣ 🌐 **${gWins}W – ${gLosses}L** (${winPct} global)${postseasonParts ? `  ·  ${postseasonParts}` : ""}`,
      `┣ 💰 Server: **${serverWallet.toLocaleString()} 🪙**  ·  Global: **${globalW.toLocaleString()} 🪙**`,
      `┗ 🏦 Savings: **${savings.toLocaleString()} 🪙**`,
    ].join("\n");
  });

  // ── 7. Paginate at 8 users per embed ──────────────────────────────────────
  const pageSize = 8;
  const pages    = Math.ceil(lines.length / pageSize);
  const embeds   = [];

  for (let p = 0; p < pages; p++) {
    const chunk = lines.slice(p * pageSize, (p + 1) * pageSize);
    embeds.push(
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(
          p === 0
            ? `🌐 Global Records — ${interaction.guild!.name} (${sorted.length} players)`
            : "🌐 Global Records (continued)",
        )
        .setDescription(chunk.join("\n\n"))
        .setFooter({
          text: [
            "W/L + playoff + SB totals across all REC League servers",
            "Global Wallet = coins across all servers",
            "Savings = cross-server savings account",
            pages > 1 ? `Page ${p + 1}/${pages}` : "",
          ].filter(Boolean).join("  ·  "),
        })
        .setTimestamp(),
    );
  }

  await interaction.editReply({ embeds: embeds.slice(0, 10) });
}
