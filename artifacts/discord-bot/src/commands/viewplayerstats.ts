import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors,
  ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseMcaTeamsTable, franchiseRostersTable, playerSeasonStatsTable,
  playerXpLogTable, seasonsTable,
} from "@workspace/db";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { requireMcaEnabled } from "../lib/server-settings.js";

// ── Conference detection ────────────────────────────────────────────────────
// Primary: use the `conference` column stored from the MCA leagueteams export
// ("AFC" | "NFC"). Fallback: hard-coded nick/full-name sets for teams imported
// before the conference column existed (rows that still have conference = null).

const NFC_FULL_NAMES = new Set([
  "Dallas Cowboys", "New York Giants", "Philadelphia Eagles", "Washington Commanders",
  "Chicago Bears", "Detroit Lions", "Green Bay Packers", "Minnesota Vikings",
  "Atlanta Falcons", "Carolina Panthers", "New Orleans Saints", "Tampa Bay Buccaneers",
  "Arizona Cardinals", "Los Angeles Rams", "San Francisco 49ers", "Seattle Seahawks",
]);

const NFC_NICK_NAMES = new Set([
  "Giants", "Eagles", "Cowboys", "Commanders",
  "Bears", "Lions", "Packers", "Vikings",
  "Buccaneers", "Falcons", "Panthers", "Saints",
  "Cardinals", "Rams", "49ers", "Seahawks",
]);

function isNfc(conference: string | null, fullName: string, nickName: string): boolean {
  if (conference === "NFC") return true;
  if (conference === "AFC") return false;
  // Fallback for rows without conference data
  return NFC_FULL_NAMES.has(fullName) || NFC_NICK_NAMES.has(nickName);
}

const DEV_LABEL: Record<number, string> = {
  0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor",
};

// EA CDN portrait URL — same pattern used in /viewplayerdetails
function portraitUrl(playerId: number): string {
  return `https://madden-assets-cdn.pulse.ea.com/madden26/portraits/64/${playerId}.png`;
}

// Ordered position groups for a clean dropdown display
const POSITION_ORDER = [
  "QB", "HB", "FB",
  "WR", "TE",
  "LT", "LG", "C", "RG", "RT",
  "LE", "RE", "DT",
  "LOLB", "MLB", "ROLB",
  "CB", "FS", "SS",
  "K", "P",
];

function sortPositions(positions: string[]): string[] {
  const known   = POSITION_ORDER.filter(p => positions.includes(p));
  const unknown = positions.filter(p => !POSITION_ORDER.includes(p)).sort();
  return [...known, ...unknown];
}

// ── Command entry ─────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("viewplayerstats")
  .setDescription("Browse season stats and bio for any player — pick team → position → player");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!await requireMcaEnabled(interaction)) return;

  const season = await getOrCreateActiveSeason(interaction.guildId!);

  const allTeams = await db
    .select({
      teamId:     franchiseMcaTeamsTable.teamId,
      fullName:   franchiseMcaTeamsTable.fullName,
      nickName:   franchiseMcaTeamsTable.nickName,
      conference: franchiseMcaTeamsTable.conference,
    })
    .from(franchiseMcaTeamsTable)
    .where(eq(franchiseMcaTeamsTable.seasonId, season.id))
    .orderBy(franchiseMcaTeamsTable.fullName);

  if (allTeams.length === 0) {
    await interaction.editReply("No teams found for this season. MCA data hasn't been imported yet.");
    return;
  }

  const nfcTeams = allTeams.filter(t => isNfc(t.conference, t.fullName, t.nickName));
  const afcTeams = allTeams.filter(t => !isNfc(t.conference, t.fullName, t.nickName));

  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (nfcTeams.length > 0) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`viewps_team:${season.id}:nfc`)
        .setPlaceholder("🏈 Select NFC Team…")
        .addOptions(
          nfcTeams.slice(0, 25).map(t =>
            new StringSelectMenuOptionBuilder()
              .setLabel(t.fullName)
              .setValue(String(t.teamId)),
          ),
        ),
    ));
  }

  if (afcTeams.length > 0) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`viewps_team:${season.id}:afc`)
        .setPlaceholder("🏈 Select AFC Team…")
        .addOptions(
          afcTeams.slice(0, 25).map(t =>
            new StringSelectMenuOptionBuilder()
              .setLabel(t.fullName)
              .setValue(String(t.teamId)),
          ),
        ),
    ));
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

// ── Step 2: Team selected → show position dropdown ────────────────────────────

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

  // Get distinct positions on this team's roster
  const rows = await db
    .selectDistinct({ position: franchiseRostersTable.position })
    .from(franchiseRostersTable)
    .where(and(
      eq(franchiseRostersTable.seasonId, seasonId),
      eq(franchiseRostersTable.teamId,   teamId),
    ));

  if (rows.length === 0) {
    await interaction.editReply({
      content: "No roster data found for this team. MCA roster hasn't been imported yet.",
      components: [],
    });
    return;
  }

  // Get team name for the heading
  const [teamRow] = await db
    .select({ fullName: franchiseMcaTeamsTable.fullName })
    .from(franchiseMcaTeamsTable)
    .where(and(
      eq(franchiseMcaTeamsTable.seasonId, seasonId),
      eq(franchiseMcaTeamsTable.teamId,   teamId),
    ))
    .limit(1);
  const teamName = teamRow?.fullName ?? "Team";

  const positions = sortPositions(rows.map(r => r.position).filter(Boolean) as string[]);

  const posMenu = new StringSelectMenuBuilder()
    .setCustomId(`viewps_pos:${seasonId}:${teamId}`)
    .setPlaceholder(`Select a position on the ${teamName}…`)
    .addOptions(
      positions.slice(0, 25).map(pos =>
        new StringSelectMenuOptionBuilder()
          .setLabel(pos)
          .setValue(pos),
      ),
    );

  await interaction.editReply({
    content: `**${teamName}** — select a position:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(posMenu)],
    embeds: [],
  });
}

// ── Step 3: Position selected → show player dropdown ─────────────────────────

export async function handlePositionSelect(
  interaction: StringSelectMenuInteraction,
  seasonId: number,
  teamId: number,
) {
  await interaction.deferUpdate();

  const position = interaction.values[0]!;

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
      eq(franchiseRostersTable.position, position),
    ))
    .orderBy(desc(franchiseRostersTable.overall))
    .limit(25);

  if (players.length === 0) {
    await interaction.editReply({
      content: `No **${position}** players found on this roster.`,
      components: [],
    });
    return;
  }

  const teamName = players[0]!.teamName;

  const playerMenu = new StringSelectMenuBuilder()
    .setCustomId(`viewps_player:${seasonId}:${teamId}`)
    .setPlaceholder(`Select a ${teamName} ${position}…`)
    .addOptions(
      players.map(p => {
        const name  = `${p.firstName} ${p.lastName}`.trim() || "(Unknown)";
        const label = name.slice(0, 100);
        const desc  = `${p.overall} OVR · ${DEV_LABEL[p.devTrait] ?? "Normal"}`;
        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setDescription(desc)
          .setValue(String(p.playerId));
      }),
    );

  await interaction.editReply({
    content: `**${teamName} — ${position}s** · Select a player to view their stats:`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(playerMenu)],
    embeds: [],
  });
}

// ── Step 4: Player selected → show stats embed ────────────────────────────────

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

  const [rosterRows, statRows, xpRows] = await Promise.all([
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
    // Most-recent XP log entry for this player this season
    db.select({
      xpEarned: playerXpLogTable.xpEarned,
      xpTotal:  playerXpLogTable.xpTotal,
      weekNum:  playerXpLogTable.weekNum,
    })
      .from(playerXpLogTable)
      .where(and(
        eq(playerXpLogTable.seasonId, seasonId),
        eq(playerXpLogTable.playerId, playerId),
      ))
      .orderBy(desc(playerXpLogTable.loggedAt))
      .limit(1),
  ]);

  const roster  = rosterRows[0];
  const stats   = statRows[0];
  const xpEntry = xpRows[0];

  if (!roster) {
    await interaction.editReply({ content: "Player not found in roster data.", components: [] });
    return;
  }

  const fullName = `${roster.firstName} ${roster.lastName}`.trim() || "(Unknown)";

  // ── Bio block ─────────────────────────────────────────────────────────────
  const attrs = (roster.attributes ?? {}) as Record<string, unknown>;
  const heightIn  = attrs["heightInches"] != null ? Number(attrs["heightInches"])
                  : attrs["height"]       != null ? Number(attrs["height"]) : null;
  const weightLbs = attrs["weight"] != null ? Number(attrs["weight"]) : null;

  const bioLines: string[] = [];
  if (roster.jerseyNum != null) bioLines.push(`**#${roster.jerseyNum}** · ${roster.position}`);
  else                          bioLines.push(roster.position);
  if (roster.overall)           bioLines.push(`**${roster.overall} OVR** · ${DEV_LABEL[roster.devTrait] ?? "Normal"}`);
  if (roster.age != null)       bioLines.push(`Age **${roster.age}**`);
  if (heightIn != null) {
    const ft  = Math.floor(heightIn / 12);
    const ins = heightIn % 12;
    bioLines.push(`**${ft}'${ins}"**${weightLbs != null ? ` · ${weightLbs} lbs` : ""}`);
  } else if (weightLbs != null) {
    bioLines.push(`**${weightLbs} lbs**`);
  }
  if (roster.contractYearsLeft != null) {
    bioLines.push(
      roster.contractYearsLeft === 1
        ? "📋 **Contract Year**"
        : `Contract: **${roster.contractYearsLeft} yrs left**`,
    );
  }

  // ── Season stats block ───────────────────────────────────────────────────
  const pos   = roster.position ?? "";
  const isQB  = pos === "QB";
  const isK   = pos === "K";
  const isP   = pos === "P";
  const statLines: string[] = [];
  if (stats) {
    // ── Passing ─────────────────────────────────────────────────────────────
    if (stats.passYds > 0 || stats.passAtt > 0) {
      const compPct = stats.passAtt > 0
        ? ` (${((stats.passComp / stats.passAtt) * 100).toFixed(1)}% comp)` : "";
      const ypa = stats.passAtt > 0
        ? ` · ${(stats.passYds / stats.passAtt).toFixed(1)} YPA` : "";
      const intsStr   = stats.passInts   > 0 ? ` · ${stats.passInts} INT` : "";
      const sacksStr  = stats.timesSacked > 0 ? ` · ${stats.timesSacked} sacked` : "";
      statLines.push(
        `🎯 **Passing:** ${stats.passYds.toLocaleString()} yds · ${stats.passTDs} TDs${intsStr}` +
        `\n   ${stats.passComp}/${stats.passAtt}${compPct}${ypa}${sacksStr}`,
      );
    }
    // ── Rushing ──────────────────────────────────────────────────────────────
    if (stats.rushYds > 0 || stats.rushAtt > 0) {
      const ypc = stats.rushAtt > 0
        ? ` · ${(stats.rushYds / stats.rushAtt).toFixed(1)} YPC` : "";
      const fumStr = stats.fumbles > 0 ? ` · ${stats.fumbles} fum` : "";
      const label = isQB ? "🏃 **QB Rush:**" : "💨 **Rushing:**";
      statLines.push(
        `${label} ${stats.rushYds.toLocaleString()} yds · ${stats.rushTDs} TDs` +
        `\n   ${stats.rushAtt} carries${ypc}${fumStr}`,
      );
    } else if (isQB && stats.fumbles > 0) {
      statLines.push(`💢 **Fumbles:** ${stats.fumbles}`);
    }
    // ── Receiving ────────────────────────────────────────────────────────────
    if (stats.recYds > 0 || stats.recRec > 0) {
      const ypr = stats.recRec > 0
        ? ` · ${(stats.recYds / stats.recRec).toFixed(1)} YPR` : "";
      statLines.push(
        `🙌 **Receiving:** ${stats.recYds.toLocaleString()} yds · ${stats.recTDs} TDs` +
        `\n   ${stats.recRec} rec${ypr}`,
      );
    }
    if (!isQB && !isK && !isP && stats.fumbles > 0) statLines.push(`💢 **Fumbles:** ${stats.fumbles}`);
    // ── Defense ──────────────────────────────────────────────────────────────
    const tackles = stats.totalTackles > 0
      ? `${stats.totalTackles} total (${stats.tackleSolo} solo · ${stats.tackleAssist} ast)`
      : stats.tackleSolo + stats.tackleAssist > 0
        ? `${stats.tackleSolo} solo · ${stats.tackleAssist} ast` : null;
    if (tackles)                    statLines.push(`🦺 **Tackles:** ${tackles}`);
    if (stats.tacklesForLoss > 0)   statLines.push(`🔻 **TFL:** ${stats.tacklesForLoss}`);
    if (stats.sacks > 0)            statLines.push(`💥 **Sacks:** ${stats.sacks}`);
    if (stats.defInts > 0)          statLines.push(`🫳 **INTs:** ${stats.defInts}`);
    if (stats.forcedFumbles > 0)    statLines.push(`🏈 **Forced Fum:** ${stats.forcedFumbles}`);
    if (stats.defFumblesRec > 0)    statLines.push(`🤲 **Fum Rec:** ${stats.defFumblesRec}`);
    if (stats.defTDs > 0)           statLines.push(`🏆 **Def TDs:** ${stats.defTDs}`);
    // ── Kicking ──────────────────────────────────────────────────────────────
    if (isK && (stats.fgMade > 0 || stats.fgAtt > 0 || stats.xpMade > 0)) {
      const fgPct = stats.fgAtt > 0
        ? ` (${((stats.fgMade / stats.fgAtt) * 100).toFixed(1)}%)` : "";
      const longStr = stats.fgLong > 0 ? ` · Long: ${stats.fgLong}` : "";
      statLines.push(
        `🏟️ **Field Goals:** ${stats.fgMade}/${stats.fgAtt}${fgPct}${longStr}`,
      );
      if (stats.xpAtt > 0) {
        const xpPct = stats.xpAtt > 0
          ? ` (${((stats.xpMade / stats.xpAtt) * 100).toFixed(1)}%)` : "";
        statLines.push(`✅ **Extra Points:** ${stats.xpMade}/${stats.xpAtt}${xpPct}`);
      }
    }
    // ── Punting ──────────────────────────────────────────────────────────────
    if (isP && (stats.puntAtt > 0 || stats.puntYds > 0)) {
      const avg = stats.puntAtt > 0
        ? ` · Avg: ${(stats.puntYds / stats.puntAtt).toFixed(1)}` : "";
      const longStr = stats.puntLong > 0 ? ` · Long: ${stats.puntLong}` : "";
      const in20Str = stats.puntIn20 > 0 ? ` · In-20: ${stats.puntIn20}` : "";
      const tbStr   = stats.puntTouchbacks > 0 ? ` · TB: ${stats.puntTouchbacks}` : "";
      statLines.push(
        `👟 **Punting:** ${stats.puntAtt} punts · ${stats.puntYds.toLocaleString()} yds${avg}${longStr}${in20Str}${tbStr}`,
      );
    }
    // ── Returns ──────────────────────────────────────────────────────────────
    if (stats.krAtt > 0 || stats.krYds > 0) {
      const krAvg = stats.krAtt > 0
        ? ` · ${(stats.krYds / stats.krAtt).toFixed(1)} avg` : "";
      const krTDStr = stats.krTDs > 0 ? ` · ${stats.krTDs} TD` : "";
      statLines.push(`↩️ **KR:** ${stats.krAtt} att · ${stats.krYds} yds${krAvg}${krTDStr}`);
    }
    if (stats.prAtt > 0 || stats.prYds > 0) {
      const prAvg = stats.prAtt > 0
        ? ` · ${(stats.prYds / stats.prAtt).toFixed(1)} avg` : "";
      const prTDStr = stats.prTDs > 0 ? ` · ${stats.prTDs} TD` : "";
      statLines.push(`↩️ **PR:** ${stats.prAtt} att · ${stats.prYds} yds${prAvg}${prTDStr}`);
    }
  }
  if (statLines.length === 0) statLines.push("*(no recorded stats this season)*");

  const [seasonRow] = await db
    .select({ seasonNumber: seasonsTable.seasonNumber })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, seasonId))
    .limit(1);
  const seasonLabel = seasonRow?.seasonNumber ?? seasonId;

  // ── XP block ──────────────────────────────────────────────────────────────
  // xpEntry = most recent log row; xpTotal on the roster row is the live total
  // from the latest export. Show the weekly delta from the log + total from roster.
  const xpTotalLive = roster.xpTotal ?? xpEntry?.xpTotal;
  const xpWeekLabel = xpEntry?.weekNum ? `Week ${xpEntry.weekNum}` : "Last export";

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`${roster.jerseyNum != null ? `#${roster.jerseyNum} ` : ""}${fullName}`)
    .setDescription(`**${roster.teamName || "Free Agent"}**\n${bioLines.join(" · ")}`)
    .setThumbnail(portraitUrl(roster.playerId))
    .addFields({ name: `Season ${seasonLabel} Stats`, value: statLines.join("\n"), inline: false });

  if (xpTotalLive != null || xpEntry) {
    const xpParts: string[] = [];
    if (xpEntry)         xpParts.push(`+${xpEntry.xpEarned.toLocaleString()} XP (${xpWeekLabel})`);
    if (xpTotalLive != null) xpParts.push(`**${xpTotalLive.toLocaleString()} XP total**`);
    embed.addFields({ name: "⚡ Experience", value: xpParts.join(" · "), inline: false });
  }

  embed
    .setFooter({ text: "Stats from MCA franchise export" })
    .setTimestamp();

  await interaction.editReply({ content: null, embeds: [embed], components: [] });
}
