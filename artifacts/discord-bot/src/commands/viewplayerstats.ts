import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseMcaTeamsTable, franchiseRostersTable, playerSeasonStatsTable,
  seasonsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { requireMcaEnabled } from "../lib/server-settings.js";

// ── Conference membership (matched against franchiseMcaTeamsTable.nickName) ──
const NFC_NICKS = new Set([
  "Giants", "Eagles", "Cowboys", "Commanders",
  "Bears", "Lions", "Packers", "Vikings",
  "Buccaneers", "Falcons", "Panthers", "Saints",
  "Cardinals", "Rams", "49ers", "Seahawks",
]);

const DEV_LABEL: Record<number, string> = {
  0: "Normal", 1: "Impact", 2: "Star", 3: "Superstar", 4: "X-Factor",
};

export const data = new SlashCommandBuilder()
  .setName("viewplayerstats")
  .setDescription("Browse season stats and bio for any player — pick team then player from dropdowns");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!await requireMcaEnabled(interaction)) return;

  const season = await getOrCreateActiveSeason();

  const allTeams = await db
    .select({
      teamId:   franchiseMcaTeamsTable.teamId,
      fullName: franchiseMcaTeamsTable.fullName,
      nickName: franchiseMcaTeamsTable.nickName,
    })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id))
    .orderBy(franchiseMcaTeamsTable.fullName);

  if (allTeams.length === 0) {
    await interaction.editReply("No teams found for this season. MCA data hasn't been imported yet.");
    return;
  }

  const nfcTeams = allTeams.filter(t => NFC_NICKS.has(t.nickName));
  const afcTeams = allTeams.filter(t => !NFC_NICKS.has(t.nickName));

  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (nfcTeams.length > 0) {
    const nfcMenu = new StringSelectMenuBuilder()
      .setCustomId(`viewps_team:${season.id}:nfc`)
      .setPlaceholder("🏈 Select NFC Team…")
      .addOptions(
        nfcTeams.slice(0, 25).map(t =>
          new StringSelectMenuOptionBuilder()
            .setLabel(t.fullName)
            .setValue(String(t.teamId)),
        ),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(nfcMenu));
  }

  if (afcTeams.length > 0) {
    const afcMenu = new StringSelectMenuBuilder()
      .setCustomId(`viewps_team:${season.id}:afc`)
      .setPlaceholder("🏈 Select AFC Team…")
      .addOptions(
        afcTeams.slice(0, 25).map(t =>
          new StringSelectMenuOptionBuilder()
            .setLabel(t.fullName)
            .setValue(String(t.teamId)),
        ),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(afcMenu));
  }

  if (rows.length === 0) {
    await interaction.editReply("No teams available.");
    return;
  }

  await interaction.editReply({
    content: "**Select a team to browse its players:**",
    components: rows,
  });
}

// ── Shared handler: team selected → show player select ────────────────────────
export async function handleTeamSelect(
  interaction: StringSelectMenuInteraction,
  seasonId: number,
) {
  await interaction.deferUpdate();

  const teamId = Number(interaction.values[0]);
  if (isNaN(teamId)) {
    await interaction.editReply({ content: "Invalid team selection.", components: [] });
    return;
  }

  const players = await db
    .select({
      playerId:  franchiseRostersTable.playerId,
      firstName: franchiseRostersTable.firstName,
      lastName:  franchiseRostersTable.lastName,
      position:  franchiseRostersTable.position,
      overall:   franchiseRostersTable.overall,
      devTrait:  franchiseRostersTable.devTrait,
      teamName:  franchiseRostersTable.teamName,
    })
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, seasonId),
      eq(franchiseRostersTable.teamId,   teamId),
    ))
    .orderBy(desc(franchiseRostersTable.overall))
    .limit(25);

  if (players.length === 0) {
    await interaction.editReply({
      content: "No roster data found for this team. MCA roster hasn't been imported yet.",
      components: [],
    });
    return;
  }

  const teamName = players[0]!.teamName;

  const playerMenu = new StringSelectMenuBuilder()
    .setCustomId(`viewps_player:${seasonId}:${teamId}`)
    .setPlaceholder(`Select a ${teamName} player…`)
    .addOptions(
      players.map(p => {
        const name  = `${p.firstName} ${p.lastName}`.trim() || "(Unknown)";
        const label = `${p.position} · ${name}`.slice(0, 100);
        const desc  = `${p.overall} OVR · ${DEV_LABEL[p.devTrait] ?? "Normal"}`;
        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setDescription(desc)
          .setValue(String(p.playerId));
      }),
    );

  await interaction.editReply({
    content: `**${teamName}** — select a player to view their stats:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(playerMenu)],
  });
}

// ── Shared handler: player selected → show stats embed ───────────────────────
export async function handlePlayerSelect(
  interaction: StringSelectMenuInteraction,
  seasonId: number,
  teamId: number,
) {
  await interaction.deferUpdate();

  const playerId = Number(interaction.values[0]);
  if (isNaN(playerId)) {
    await interaction.editReply({ content: "Invalid player selection.", components: [] });
    return;
  }

  // Pull roster bio and season stats in parallel
  const [rosterRows, statRows] = await Promise.all([
    db.select()
      .from(franchiseRostersTable)
      .where(and(
        eq(franchiseRostersTable.seasonId, seasonId),
        eq(franchiseRostersTable.teamId,   teamId),
        eq(franchiseRostersTable.playerId, playerId),
      ))
      .limit(1),
    db.select()
      .from(playerSeasonStatsTable)
      .where(and(
        eq(playerSeasonStatsTable.seasonId, seasonId),
        eq(playerSeasonStatsTable.playerId, playerId),
      ))
      .limit(1),
  ]);

  const roster = rosterRows[0];
  const stats  = statRows[0];

  if (!roster) {
    await interaction.editReply({ content: "Player not found in roster data.", components: [] });
    return;
  }

  const fullName = `${roster.firstName} ${roster.lastName}`.trim() || "(Unknown)";

  // ── Bio / contract block ──────────────────────────────────────────────────
  const attrs = (roster.attributes ?? {}) as Record<string, unknown>;
  const heightIn = attrs["heightInches"] != null ? Number(attrs["heightInches"]) :
                   attrs["height"]       != null ? Number(attrs["height"])       : null;
  const weightLbs = attrs["weight"] != null ? Number(attrs["weight"]) : null;

  const bioLines: string[] = [];
  if (roster.jerseyNum != null)          bioLines.push(`**#${roster.jerseyNum}** · ${roster.position}`);
  else                                   bioLines.push(roster.position);
  if (roster.overall)                    bioLines.push(`**${roster.overall} OVR** · ${DEV_LABEL[roster.devTrait] ?? "Normal"}`);
  if (roster.age != null)                bioLines.push(`Age **${roster.age}**`);
  if (heightIn != null) {
    const ft  = Math.floor(heightIn / 12);
    const ins = heightIn % 12;
    bioLines.push(`**${ft}'${ins}"**${weightLbs != null ? ` · ${weightLbs} lbs` : ""}`);
  } else if (weightLbs != null) {
    bioLines.push(`**${weightLbs} lbs**`);
  }
  if (roster.contractYearsLeft != null) {
    bioLines.push(roster.contractYearsLeft === 1 ? "📋 **Contract Year**" : `Contract: **${roster.contractYearsLeft} yrs left**`);
  }

  // ── Season stats block ───────────────────────────────────────────────────
  const statLines: string[] = [];
  if (stats) {
    // Passing
    if (stats.passYds > 0 || stats.passAtt > 0) {
      const compPct = stats.passAtt > 0
        ? ` (${((stats.passComp / stats.passAtt) * 100).toFixed(1)}% comp)`
        : "";
      const ypa = stats.passAtt > 0
        ? ` · ${(stats.passYds / stats.passAtt).toFixed(1)} YPA`
        : "";
      statLines.push(
        `🎯 **Passing:** ${stats.passYds.toLocaleString()} yds · ${stats.passTDs} TDs` +
        `\n   ${stats.passComp}/${stats.passAtt}${compPct}${ypa}`,
      );
    }
    // Rushing
    if (stats.rushYds > 0 || stats.rushAtt > 0) {
      const ypc = stats.rushAtt > 0
        ? ` · ${(stats.rushYds / stats.rushAtt).toFixed(1)} YPC`
        : "";
      statLines.push(
        `💨 **Rushing:** ${stats.rushYds.toLocaleString()} yds · ${stats.rushTDs} TDs` +
        `\n   ${stats.rushAtt} carries${ypc}`,
      );
    }
    // Receiving
    if (stats.recYds > 0 || stats.recRec > 0) {
      const ypr = stats.recRec > 0
        ? ` · ${(stats.recYds / stats.recRec).toFixed(1)} YPR`
        : "";
      statLines.push(
        `🙌 **Receiving:** ${stats.recYds.toLocaleString()} yds · ${stats.recTDs} TDs` +
        `\n   ${stats.recRec} rec${ypr}`,
      );
    }
    // Defense
    if (stats.sacks > 0)        statLines.push(`💥 **Sacks:** ${stats.sacks}`);
    if (stats.defInts > 0)      statLines.push(`🫳 **INTs:** ${stats.defInts}`);
    const tackles = stats.totalTackles > 0
      ? `${stats.totalTackles} total`
      : stats.tackleSolo + stats.tackleAssist > 0
        ? `${stats.tackleSolo} solo · ${stats.tackleAssist} ast`
        : null;
    if (tackles)                 statLines.push(`🦺 **Tackles:** ${tackles}`);
  }

  if (statLines.length === 0) {
    statLines.push("*(no recorded stats this season)*");
  }

  // ── Season number label ──────────────────────────────────────────────────
  const [seasonRow] = await db
    .select({ seasonNumber: seasonsTable.seasonNumber })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, seasonId))
    .limit(1);
  const seasonLabel = seasonRow?.seasonNumber ?? seasonId;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`${roster.jerseyNum != null ? `#${roster.jerseyNum} ` : ""}${fullName}`)
    .setDescription(`**${roster.teamName || "Free Agent"}**\n${bioLines.join(" · ")}`)
    .addFields(
      { name: `Season ${seasonLabel} Stats`, value: statLines.join("\n"), inline: false },
    )
    .setFooter({ text: "Stats from MCA franchise export · Use /playerstats to search by name" })
    .setTimestamp();

  await interaction.editReply({ content: null, embeds: [embed], components: [] });
}
