import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { globalUserRecordsTable, usersTable, userSavingsTable } from "@workspace/db";
import { eq, and, isNotNull, inArray, sum } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("globalrecords")
  .setDescription("Leaderboard: every team's cross-server W/L/T record, global wallet, and savings");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId!;

  // ── 1. Fetch all users in this guild that have a team linked ───────────────
  const serverUsers = await db
    .select({ discordId: usersTable.discordId, team: usersTable.team, serverWallet: usersTable.balance })
    .from(usersTable)
    .where(and(eq(usersTable.guildId, guildId), isNotNull(usersTable.team)));

  const filteredUsers = serverUsers.filter(u => u.team !== null && u.team !== "");

  if (filteredUsers.length === 0) {
    await interaction.editReply({
      content: "📭 No linked teams found in this server yet.",
    });
    return;
  }

  const allIds = filteredUsers.map(u => u.discordId);

  // ── 2. Parallel fetches: global records, all-server balances, savings ──────
  const [globalRows, allServerBalances, savingsRows] = await Promise.all([
    db.select()
      .from(globalUserRecordsTable)
      .where(inArray(globalUserRecordsTable.discordId, allIds)),

    // Sum wallet balance across EVERY guild for each user → cumulative global wallet
    db.select({ discordId: usersTable.discordId, totalBalance: sum(usersTable.balance) })
      .from(usersTable)
      .where(inArray(usersTable.discordId, allIds))
      .groupBy(usersTable.discordId),

    db.select({ discordId: userSavingsTable.discordId, balance: userSavingsTable.balance })
      .from(userSavingsTable)
      .where(inArray(userSavingsTable.discordId, allIds)),
  ]);

  // ── 3. Build lookup maps ───────────────────────────────────────────────────
  const globalMap    = new Map(globalRows.map(r => [r.discordId, r]));
  const globalWallet = new Map(allServerBalances.map(r => [r.discordId, Number(r.totalBalance ?? 0)]));
  const savingsMap   = new Map(savingsRows.map(s => [s.discordId, s.balance]));
  const serverMap    = new Map(filteredUsers.map(u => [u.discordId, u]));

  // ── 4. Fetch guild member display names (server nicknames) ─────────────────
  const displayNames = new Map<string, string>();
  try {
    const members = await interaction.guild!.members.fetch({ user: allIds });
    for (const [id, member] of members) {
      displayNames.set(id, member.displayName);
    }
  } catch {
    // Fallback: use stored team name if member fetch fails
  }

  // ── 5. Sort by global wins desc, then losses asc ───────────────────────────
  const sorted = [...filteredUsers].sort((a, b) => {
    const ga = globalMap.get(a.discordId);
    const gb = globalMap.get(b.discordId);
    const wA = ga?.wins ?? 0;
    const wB = gb?.wins ?? 0;
    if (wB !== wA) return wB - wA;
    return (ga?.losses ?? 0) - (gb?.losses ?? 0);
  });

  // ── 6. Build display lines ─────────────────────────────────────────────────
  const lines = sorted.map((u, i) => {
    const gr           = globalMap.get(u.discordId);
    const gWins        = gr?.wins   ?? 0;
    const gLosses      = gr?.losses ?? 0;
    const gTies        = gr?.ties   ?? 0;
    const gamesPlayed  = gWins + gLosses + gTies;
    const winPct       = gamesPlayed > 0
      ? ((gWins / gamesPlayed) * 100).toFixed(1) + "%"
      : "—";

    const serverWallet = serverMap.get(u.discordId)?.serverWallet ?? 0;
    const globalW      = globalWallet.get(u.discordId) ?? 0;
    const savings      = savingsMap.get(u.discordId) ?? 0;
    const displayName  = displayNames.get(u.discordId) ?? u.team ?? `<@${u.discordId}>`;
    const teamStr      = u.team ? ` — ${u.team}` : "";

    return (
      `**#${i + 1} ${displayName}**${teamStr}\n` +
      `┣ 🌐 **${gWins}W – ${gLosses}L – ${gTies}T** (${winPct} global)\n` +
      `┣ 💰 Server Wallet: **${serverWallet.toLocaleString()} 🪙**  ·  Global Wallet: **${globalW.toLocaleString()} 🪙**\n` +
      `┗ 🏦 Savings: **${savings.toLocaleString()} 🪙**`
    );
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
            "Sorted by global wins",
            "Global Wallet = coins across all REC League servers",
            "Savings = cross-server savings account",
            pages > 1 ? `Page ${p + 1}/${pages}` : "",
          ].filter(Boolean).join("  ·  "),
        })
        .setTimestamp(),
    );
  }

  await interaction.editReply({ embeds: embeds.slice(0, 10) });
}
