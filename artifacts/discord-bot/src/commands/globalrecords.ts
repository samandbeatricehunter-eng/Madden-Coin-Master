import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { globalUserRecordsTable, usersTable, userSavingsTable } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("globalrecords")
  .setDescription("Leaderboard: every player's cross-server W/L/T record, wallet, and savings");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId!;

  // ── Fetch all global records sorted by most wins ──────────────────────────
  const globalRows = await db
    .select()
    .from(globalUserRecordsTable)
    .orderBy(desc(globalUserRecordsTable.wins));

  if (globalRows.length === 0) {
    await interaction.editReply({
      content: "📭 No global records found yet. Records are created when games are reported.",
    });
    return;
  }

  const allIds = globalRows.map(r => r.discordId);

  // ── Fetch this guild's wallet balances + savings in parallel ─────────────
  const [guildUsers, savingsRows] = await Promise.all([
    db
      .select({ discordId: usersTable.discordId, balance: usersTable.balance, team: usersTable.team })
      .from(usersTable)
      .where(eq(usersTable.guildId, guildId)),

    db
      .select({ discordId: userSavingsTable.discordId, balance: userSavingsTable.balance })
      .from(userSavingsTable)
      .where(inArray(userSavingsTable.discordId, allIds)),
  ]);

  const walletMap  = new Map(guildUsers.map(u => [u.discordId, { balance: u.balance, team: u.team }]));
  const savingsMap = new Map(savingsRows.map(s => [s.discordId, s.balance]));

  // ── Build rows ────────────────────────────────────────────────────────────
  const lines = globalRows.map((r, i) => {
    const wallet  = walletMap.get(r.discordId)?.balance ?? null;
    const team    = walletMap.get(r.discordId)?.team ?? null;
    const savings = savingsMap.get(r.discordId) ?? 0;
    const total   = (wallet ?? 0) + savings;

    const winPct = (r.wins + r.losses + r.ties) > 0
      ? ((r.wins / (r.wins + r.losses + r.ties)) * 100).toFixed(1) + "%"
      : "—";

    const walletStr  = wallet !== null ? `${wallet.toLocaleString()} 🪙` : "*not in server*";
    const totalStr   = wallet !== null ? `${total.toLocaleString()} total` : "";
    const teamStr    = team ? ` | ${team}` : "";

    return (
      `**#${i + 1}** <@${r.discordId}>${teamStr}\n` +
      `┣ **${r.wins}W – ${r.losses}L – ${r.ties}T** (${winPct})\n` +
      `┗ Wallet: ${walletStr}  ·  Savings: ${savings.toLocaleString()} 🪙${totalStr ? `  ·  ${totalStr}` : ""}`
    );
  });

  // ── Split into pages of 10 users per embed (25 line limit per field) ──────
  const pageSize = 10;
  const pages    = Math.ceil(lines.length / pageSize);
  const embeds   = [];

  for (let p = 0; p < pages; p++) {
    const chunk = lines.slice(p * pageSize, (p + 1) * pageSize);
    embeds.push(
      new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(p === 0 ? `🌐 Global Records — All Servers (${globalRows.length} players)` : "🌐 Global Records (continued)")
        .setDescription(chunk.join("\n\n"))
        .setFooter({
          text: `Sorted by all-time wins · Wallet = this server's balance · Savings = cross-server${pages > 1 ? ` · Page ${p + 1}/${pages}` : ""}`,
        })
        .setTimestamp(),
    );
  }

  // Discord allows up to 10 embeds per message
  await interaction.editReply({ embeds: embeds.slice(0, 10) });
}
