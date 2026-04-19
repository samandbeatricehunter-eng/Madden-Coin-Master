import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { usersTable, userSavingsTable, userRecordsTable } from "@workspace/db";
import { eq, and, isNotNull, ne, inArray, sum, max } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("globalrecords")
  .setDescription("Leaderboard: every team's cross-server cumulative W/L, playoff, SB records, wallet, and savings");

// Per-embed page size — kept small so each embed stays well under 6000 chars
const PAGE_SIZE = 10;

// Filter that excludes placeholder/unlinked "Open Slot" accounts
const REAL_USER_FILTER = and(
  isNotNull(usersTable.team),
  ne(usersTable.team, ""),
  ne(usersTable.discordUsername, "Open Slot"),
);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId!;

  // ── 1. Fetch ALL real linked users across every guild (global ranking pool) ──
  const allLinkedRows = await db
    .select({ discordId: usersTable.discordId })
    .from(usersTable)
    .where(REAL_USER_FILTER)
    .groupBy(usersTable.discordId);

  const allGlobalIds = allLinkedRows.map(r => r.discordId);

  if (allGlobalIds.length === 0) {
    await interaction.editReply({ content: "📭 No linked teams found anywhere yet." });
    return;
  }

  // ── 2. Fetch this guild's real linked users ───────────────────────────────────
  const thisGuildUsers = await db
    .select({
      discordId:       usersTable.discordId,
      team:            usersTable.team,
      discordUsername: usersTable.discordUsername,
      serverWallet:    usersTable.balance,
    })
    .from(usersTable)
    .where(and(
      eq(usersTable.guildId, guildId),
      REAL_USER_FILTER,
    ));

  if (thisGuildUsers.length === 0) {
    await interaction.editReply({ content: "📭 No linked teams found in this server yet." });
    return;
  }

  const thisGuildIds = thisGuildUsers.map(u => u.discordId);

  // ── 3. Parallel fetches ──────────────────────────────────────────────────────
  const [globalRecordAgg, allServerBalances, savingsRows, sbRows] = await Promise.all([
    db.select({
      discordId:     userRecordsTable.discordId,
      totalWins:     sum(userRecordsTable.wins),
      totalLosses:   sum(userRecordsTable.losses),
      totalPD:       sum(userRecordsTable.pointDifferential),
      totalPOWins:   sum(userRecordsTable.playoffWins),
      totalPOLosses: sum(userRecordsTable.playoffLosses),
    })
      .from(userRecordsTable)
      .where(inArray(userRecordsTable.discordId, allGlobalIds))
      .groupBy(userRecordsTable.discordId),

    db.select({ discordId: usersTable.discordId, totalBalance: sum(usersTable.balance) })
      .from(usersTable)
      .where(inArray(usersTable.discordId, thisGuildIds))
      .groupBy(usersTable.discordId),

    db.select({ discordId: userSavingsTable.discordId, balance: userSavingsTable.balance })
      .from(userSavingsTable)
      .where(inArray(userSavingsTable.discordId, thisGuildIds)),

    db.select({
      discordId:              usersTable.discordId,
      allTimeSuperbowlWins:   max(usersTable.allTimeSuperbowlWins),
      allTimeSuperbowlLosses: max(usersTable.allTimeSuperbowlLosses),
    })
      .from(usersTable)
      .where(inArray(usersTable.discordId, thisGuildIds))
      .groupBy(usersTable.discordId),
  ]);

  // ── 4. Build lookup maps ─────────────────────────────────────────────────────
  const recordMap    = new Map(globalRecordAgg.map(r => [r.discordId, r]));
  const globalWallet = new Map(allServerBalances.map(r => [r.discordId, Number(r.totalBalance ?? 0)]));
  const savingsMap   = new Map(savingsRows.map(s => [s.discordId, s.balance]));
  const sbMap        = new Map(sbRows.map(r => [r.discordId, r]));
  const serverMap    = new Map(thisGuildUsers.map(u => [u.discordId, u]));

  // suppress unused-variable warning — kept for potential future use
  void globalWallet;

  // ── 5. Sort all global IDs by wins → losses → PD ────────────────────────────
  const globalSorted = [...allGlobalIds].sort((a, b) => {
    const recA = recordMap.get(a);
    const recB = recordMap.get(b);
    const wA = Number(recA?.totalWins   ?? 0), wB = Number(recB?.totalWins   ?? 0);
    if (wB !== wA) return wB - wA;
    const lA = Number(recA?.totalLosses ?? 0), lB = Number(recB?.totalLosses ?? 0);
    if (lA !== lB) return lA - lB;
    return Number(recB?.totalPD ?? 0) - Number(recA?.totalPD ?? 0);
  });

  const globalRankMap = new Map<string, number>();
  globalSorted.forEach((id, idx) => globalRankMap.set(id, idx + 1));

  // ── 6. Filter to this guild, sorted by global rank ───────────────────────────
  const displayUsers = thisGuildUsers
    .slice()
    .sort((a, b) => (globalRankMap.get(a.discordId) ?? 9999) - (globalRankMap.get(b.discordId) ?? 9999));

  // ── 7. Build compact 2-line entries ─────────────────────────────────────────
  // Use <@discordId> — Discord renders this as the user's guild nickname automatically.
  const lines = displayUsers.map(u => {
    const rank = globalRankMap.get(u.discordId) ?? "?";
    const rec  = recordMap.get(u.discordId);
    const sb   = sbMap.get(u.discordId);

    const gW  = Number(rec?.totalWins     ?? 0);
    const gL  = Number(rec?.totalLosses   ?? 0);
    const gPD = Number(rec?.totalPD       ?? 0);
    const poW = Number(rec?.totalPOWins   ?? 0);
    const poL = Number(rec?.totalPOLosses ?? 0);
    const sbW = sb?.allTimeSuperbowlWins   ?? 0;
    const sbL = sb?.allTimeSuperbowlLosses ?? 0;

    const pct     = gW + gL > 0 ? `${((gW / (gW + gL)) * 100).toFixed(0)}%` : "—";
    const pdStr   = gPD >= 0 ? `+${gPD}` : `${gPD}`;
    const savings = (savingsMap.get(u.discordId) ?? 0).toLocaleString();
    const wallet  = (serverMap.get(u.discordId)?.serverWallet ?? 0).toLocaleString();

    const extra: string[] = [];
    if (poW + poL > 0) extra.push(`PO: ${poW}-${poL}`);
    if (sbW + sbL > 0) extra.push(`🏆 ${sbW}-${sbL}`);

    const row1 = `**#${rank}** <@${u.discordId}> — ${u.team ?? "?"} · **${gW}W-${gL}L** (${pct}) · PD: ${pdStr}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
    const row2 = `> 💰 ${wallet}🪙 wallet · 🏦 ${savings}🪙 savings`;

    return `${row1}\n${row2}`;
  });

  // ── 8. Paginate and send — first page as editReply, rest as followUps ────────
  const pages = Math.ceil(lines.length / PAGE_SIZE);

  for (let p = 0; p < pages; p++) {
    const chunk = lines.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    const description = chunk.join("\n\n");

    // Safety: trim description to 4000 chars if somehow still too long
    const safeDesc = description.slice(0, 4000);

    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(
        p === 0
          ? `🌐 Global Records — ${interaction.guild!.name} (${displayUsers.length} players)`
          : `🌐 Global Records — continued (${p + 1}/${pages})`,
      )
      .setDescription(safeDesc)
      .setFooter({
        text: [
          "Ranked globally across all REC League servers",
          "W/L · PD · PO · SB totals across every season",
          pages > 1 ? `Page ${p + 1}/${pages}` : "",
        ].filter(Boolean).join("  ·  "),
      })
      .setTimestamp();

    if (p === 0) {
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.followUp({ embeds: [embed] });
    }
  }
}
