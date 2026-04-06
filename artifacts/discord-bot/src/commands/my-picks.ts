import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { db } from "@workspace/db";
import { franchiseDraftPicksTable, usersTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { getServerSettings } from "../lib/server-settings.js";

export const data = new SlashCommandBuilder()
  .setName("my-picks")
  .setDescription("View the draft picks currently on your roster (next 3 classes)");

function ordinal(n: number): string {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

function pickLine(pick: {
  round: number;
  pickNum: number;
  originalTeamName: string | null;
}): string {
  const pickStr = pick.pickNum > 0 ? `, Pick #${pick.pickNum}` : "";
  const origStr = pick.originalTeamName ? ` *(from ${pick.originalTeamName})*` : "";
  return `• ${ordinal(pick.round)} Round${pickStr}${origStr}`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getServerSettings();
  if (!settings.tradeBlockEnabled) {
    await interaction.editReply({ content: "⛔ The trade block / draft pick features are currently disabled." });
    return;
  }

  const season = await getOrCreateActiveSeason();

  const userRow = await db.select({ discordId: usersTable.discordId, team: usersTable.team })
    .from(usersTable)
    .where(eq(usersTable.discordId, interaction.user.id))
    .limit(1);

  if (!userRow[0]) {
    await interaction.editReply({ content: "❌ You're not registered. Use `/register` to get started." });
    return;
  }

  const picks = await db.select()
    .from(franchiseDraftPicksTable)
    .where(
      and(
        eq(franchiseDraftPicksTable.seasonId, season.id),
        eq(franchiseDraftPicksTable.discordId, interaction.user.id),
      ),
    )
    .orderBy(
      asc(franchiseDraftPicksTable.draftYear),
      asc(franchiseDraftPicksTable.round),
      asc(franchiseDraftPicksTable.pickNum),
    );

  if (picks.length === 0) {
    await interaction.editReply({
      content: "📋 No draft picks found for your team this season. This data is imported from the Madden Companion App — ask your commissioner to sync the picks.",
    });
    return;
  }

  // Group by draft year
  const byYear = new Map<number, typeof picks>();
  for (const p of picks) {
    const arr = byYear.get(p.draftYear) ?? [];
    arr.push(p);
    byYear.set(p.draftYear, arr);
  }

  const teamName = userRow[0].team ?? "Your Team";

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`📋 Draft Picks — ${teamName}`)
    .setDescription(`Season ${season.seasonNumber} · ${picks.length} pick${picks.length !== 1 ? "s" : ""} across ${byYear.size} class${byYear.size !== 1 ? "es" : ""}`)
    .setTimestamp();

  const sortedYears = [...byYear.keys()].sort((a, b) => a - b);
  for (const year of sortedYears) {
    const yearPicks = byYear.get(year)!;
    const lines = yearPicks.map(p => pickLine({
      round: p.round,
      pickNum: p.pickNum,
      originalTeamName: p.originalTeamName,
    }));
    embed.addFields({
      name: `🗓️ ${year} Draft`,
      value: lines.join("\n"),
      inline: false,
    });
  }

  embed.setFooter({ text: "Picks imported from the Madden Companion App export" });

  await interaction.editReply({ embeds: [embed] });
}
