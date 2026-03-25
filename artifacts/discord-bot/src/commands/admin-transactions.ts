import {
  SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits,
} from "discord.js";
import { db } from "@workspace/db";
import { coinTransactionsTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { findUserByTeam } from "../lib/user-data.js";
import { NFL_TEAMS } from "../lib/constants.js";

const TX_ICONS: Record<string, string> = {
  purchase:           "🛒",
  purchase_refund:    "🔄",
  addcoins:           "➕",
  removecoins:        "➖",
  sendcoins_sent:     "📤",
  sendcoins_received: "📥",
  season_adjustment:  "📅",
  setbalance:         "⚙️",
};

export const data = new SlashCommandBuilder()
  .setName("transactions")
  .setDescription("Commissioner: View the last 10 transactions for a user")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName("team")
      .setDescription("NFL team name")
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addUserOption(opt =>
    opt.setName("user")
      .setDescription("Discord user (alternative to team)")
      .setRequired(false)
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const results = NFL_TEAMS
    .filter(t => t.toLowerCase().startsWith(focused))
    .slice(0, 25)
    .map(t => ({ name: t, value: t }));
  await interaction.respond(results);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const teamName = interaction.options.getString("team")?.trim();
  const targetUser = interaction.options.getUser("user");

  if (!teamName && !targetUser) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle("❌ Missing Target")
          .setDescription("Provide either a **team** name or **@user**."),
      ],
    });
  }

  let discordId: string;
  let label: string;

  if (teamName) {
    const found = await findUserByTeam(teamName);
    if (!found) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ Team Not Found")
            .setDescription(`No user is assigned to the **${teamName}**.`),
        ],
      });
    }
    discordId = found.discordId;
    label = `${found.team ?? found.discordUsername} (${found.discordUsername})`;
  } else {
    discordId = targetUser!.id;
    const row = await db.select().from(usersTable).where(eq(usersTable.discordId, discordId)).limit(1);
    label = row[0]?.team
      ? `${row[0].team} (${targetUser!.username})`
      : targetUser!.username;
  }

  const txs = await db.select()
    .from(coinTransactionsTable)
    .where(eq(coinTransactionsTable.discordId, discordId))
    .orderBy(desc(coinTransactionsTable.createdAt))
    .limit(10);

  if (txs.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Blue)
          .setTitle(`📒 Transactions — ${label}`)
          .setDescription("No transactions recorded yet."),
      ],
    });
  }

  // Balance summary
  const totalIn  = txs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalOut = txs.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);

  const rows = txs.map(tx => {
    const icon = TX_ICONS[tx.type] ?? "•";
    const sign = tx.amount >= 0 ? `+${tx.amount.toLocaleString()}` : tx.amount.toLocaleString();
    const ts = `<t:${Math.floor(tx.createdAt.getTime() / 1000)}:d>`;
    return `${icon} **${sign} coins** — ${tx.description} *(${ts})*`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`📒 Last ${txs.length} Transactions — ${label}`)
    .setDescription(rows.join("\n"))
    .addFields(
      { name: "Total In (shown)", value: `+${totalIn.toLocaleString()} coins`, inline: true },
      { name: "Total Out (shown)", value: `${totalOut.toLocaleString()} coins`, inline: true },
    )
    .setFooter({ text: "Showing most recent 10 transactions" })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}
