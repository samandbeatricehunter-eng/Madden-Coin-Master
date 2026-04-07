import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
} from "discord.js";
import { db } from "@workspace/db";
import { playerSeasonStatsTable, franchiseRostersTable } from "@workspace/db";
import { eq, and, or, ilike, desc, sql } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("playerstats")
  .setDescription("Look up season stats for any player in the league")
  .addStringOption(o => o
    .setName("player")
    .setDescription("Player name (first, last, or full name — partial match supported)")
    .setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const query = interaction.options.getString("player", true).trim();
  if (query.length < 2) {
    await interaction.editReply("Please enter at least 2 characters.");
    return;
  }

  const season = await getOrCreateActiveSeason();

  // Search by first name OR last name OR full name
  const words    = query.split(/\s+/);
  const first    = words[0]!;
  const last     = words[words.length - 1]!;

  const matches = await db
    .select()
    .from(playerSeasonStatsTable)
    .where(and(
      eq(playerSeasonStatsTable.seasonId, season.id),
      or(
        ilike(playerSeasonStatsTable.firstName, `%${first}%`),
        ilike(playerSeasonStatsTable.lastName,  `%${last}%`),
        // full-name concat match
        ilike(sql`${playerSeasonStatsTable.firstName} || ' ' || ${playerSeasonStatsTable.lastName}`, `%${query}%`),
      ),
    ))
    .orderBy(
      desc(sql`
        ${playerSeasonStatsTable.passYds} + ${playerSeasonStatsTable.rushYds} +
        ${playerSeasonStatsTable.recYds}  + (${playerSeasonStatsTable.sacks} * 100) +
        (${playerSeasonStatsTable.defInts} * 100) + ${playerSeasonStatsTable.totalTackles}
      `),
    )
    .limit(5);

  if (matches.length === 0) {
    await interaction.editReply(`No players found matching **"${query}"** in Season ${(season as any).seasonNumber ?? season.id}.`);
    return;
  }

  // Pull roster details (OVR, dev trait, age, jersey) for each match
  const rosterRows = await db
    .select({
      playerId: franchiseRostersTable.playerId,
      overall:  franchiseRostersTable.overall,
      devTrait: franchiseRostersTable.devTrait,
      age:      franchiseRostersTable.age,
      jerseyNum: franchiseRostersTable.jerseyNum,
      contractYearsLeft: franchiseRostersTable.contractYearsLeft,
    })
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, season.id),
      eq(franchiseRostersTable.teamName, matches[0]!.teamName),
    ));

  const rosterMap = new Map(rosterRows.map(r => [r.playerId, r]));

  const DEV_LABEL: Record<number, string> = {
    0: "Normal", 1: "Impact", 2: "Star", 3: "Superstar", 4: "X-Factor",
  };

  const embeds: EmbedBuilder[] = [];

  for (const p of matches.slice(0, 3)) {
    const roster = rosterMap.get(p.playerId);

    const statLines: string[] = [];

    // Passing
    if (p.passYds > 0) {
      statLines.push(`🎯 **Passing:** ${p.passYds.toLocaleString()} yds · ${p.passTDs} TDs`);
    }
    // Rushing
    if (p.rushYds > 0) {
      statLines.push(`💨 **Rushing:** ${p.rushYds.toLocaleString()} yds · ${p.rushTDs} TDs`);
    }
    // Receiving
    if (p.recYds > 0) {
      statLines.push(`🙌 **Receiving:** ${p.recYds.toLocaleString()} yds · ${p.recTDs} TDs`);
    }
    // Defense
    if (p.sacks > 0) {
      statLines.push(`💥 **Sacks:** ${p.sacks}`);
    }
    if (p.defInts > 0) {
      statLines.push(`🫳 **Interceptions:** ${p.defInts}`);
    }
    const tackles = p.totalTackles > 0 ? p.totalTackles : p.tackleSolo + p.tackleAssist;
    if (tackles > 0) {
      const detail = p.totalTackles > 0
        ? `${p.totalTackles} total`
        : `${p.tackleSolo} solo · ${p.tackleAssist} ast`;
      statLines.push(`🦺 **Tackles:** ${detail}`);
    }

    if (statLines.length === 0) {
      statLines.push("*(no recorded stats this season)*");
    }

    const titleParts: string[] = [`${p.firstName} ${p.lastName}`];
    if (roster?.jerseyNum) titleParts.push(`#${roster.jerseyNum}`);

    const metaParts: string[] = [`${p.position}`];
    if (roster?.overall)  metaParts.push(`${roster.overall} OVR`);
    if (roster?.devTrait !== undefined) metaParts.push(DEV_LABEL[roster.devTrait] ?? "Normal");
    if (roster?.age)       metaParts.push(`Age ${roster.age}`);
    if (roster?.contractYearsLeft !== undefined && roster.contractYearsLeft !== null) {
      metaParts.push(roster.contractYearsLeft === 1 ? "📋 Contract Year" : `${roster.contractYearsLeft} yrs left`);
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(titleParts.join(" · "))
      .setDescription(`**${p.teamName}** · ${metaParts.join(" · ")}`)
      .addFields({
        name:  `Season ${(season as any).seasonNumber ?? season.id} Stats`,
        value: statLines.join("\n"),
      })
      .setFooter({ text: "Stats sourced from MCA franchise export" })
      .setTimestamp();

    embeds.push(embed);
  }

  const note = matches.length > 3
    ? `\n*(${matches.length} players matched — showing top 3 by activity. Be more specific to narrow results.)*`
    : matches.length > 1
    ? `\n*(${matches.length} players matched — showing all)*`
    : "";

  await interaction.editReply({ embeds, content: note || undefined });
}
