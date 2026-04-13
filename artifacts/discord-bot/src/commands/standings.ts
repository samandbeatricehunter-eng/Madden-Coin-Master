import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { getOrCreateActiveSeason } from "../lib/db-helpers.js";
import { getArticleStandings, type ArticleStanding } from "../lib/gcs-fallback.js";
import { requireMcaEnabled } from "../lib/server-settings.js";

// NFL regular season game total — used for clinch magic-number math
const TOTAL_GAMES = 18;

// ── Clinch helpers ─────────────────────────────────────────────────────────────

function magicNumber(a: ArticleStanding, b: ArticleStanding): number {
  return (TOTAL_GAMES + 1) - a.wins - b.losses;
}

type ClinchStatus = "bye" | "division" | "playoff" | null;

interface StandingRow extends ArticleStanding {
  clinch: ClinchStatus;
}

function annotateClinch(confTeams: ArticleStanding[]): StandingRow[] {
  const DIVISIONS = ["East", "North", "South", "West"] as const;

  const divLeaders = new Map<string, ArticleStanding>();
  for (const div of DIVISIONS) {
    const sorted = confTeams
      .filter(t => t.division === div)
      .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
    if (sorted[0]) divLeaders.set(div, sorted[0]);
  }

  const divWinnerSet = new Set([...divLeaders.values()].map(t => t.teamName));
  const sortedWinners = [...divLeaders.values()].sort(
    (a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential,
  );
  const wildCards = confTeams
    .filter(t => !divWinnerSet.has(t.teamName))
    .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
  const seeds = [...sortedWinners, ...wildCards];

  const clinch = new Map<string, ClinchStatus>(confTeams.map(t => [t.teamName, null]));

  for (const team of confTeams) {
    const div = team.division;
    const leader = div ? divLeaders.get(div) : undefined;
    const isLeader = leader?.teamName === team.teamName;
    if (!isLeader) continue;

    const divRivals = confTeams.filter(t => t.division === div && t.teamName !== team.teamName);
    // Guard: vacuous truth — if no rivals shown yet, don't mark clinched
    const clinchesDiv = divRivals.length > 0 && divRivals.every(rival => magicNumber(team, rival) <= 0);
    if (clinchesDiv) clinch.set(team.teamName, "division");
  }

  const thirdSeed = seeds[2];
  if (thirdSeed) {
    for (let i = 0; i < 2 && i < seeds.length; i++) {
      const team = seeds[i]!;
      if (magicNumber(team, thirdSeed) <= 0) clinch.set(team.teamName, "bye");
    }
  }

  const eighthSeed = seeds[7];
  if (eighthSeed) {
    for (let i = 0; i < 7 && i < seeds.length; i++) {
      const team = seeds[i]!;
      if (clinch.get(team.teamName) !== "bye" && magicNumber(team, eighthSeed) <= 0) {
        clinch.set(team.teamName, "playoff");
      }
    }
  }

  return confTeams.map(t => ({ ...t, clinch: clinch.get(t.teamName) ?? null }));
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

const CLINCH_BADGE: Record<string, string> = {
  bye:      "🌟",
  division: "🏆",
  playoff:  "✅",
};

function clinchNote(status: ClinchStatus): string {
  if (!status) return "";
  const labels: Record<string, string> = {
    bye:      " — Clinched Bye",
    division: " — Clinched Division",
    playoff:  " — Clinched Playoff Spot",
  };
  return (CLINCH_BADGE[status] ?? "") + (labels[status] ?? "");
}

function recordLine(rank: number, t: StandingRow): string {
  const gp = t.wins + t.losses;
  const badge = CLINCH_BADGE[t.clinch ?? ""] ?? "  ";
  const user  = t.discordUsername ? ` *(${t.discordUsername})*` : "";
  const pct   = gp > 0 ? ` (${((t.wins / gp) * 100).toFixed(0)}%)` : "";
  const pd    = t.pointDifferential >= 0 ? `+${t.pointDifferential}` : `${t.pointDifferential}`;
  return `${badge}**${rank}. ${t.teamName}**${user} — ${t.wins}-${t.losses}${pct} | PD ${pd}${clinchNote(t.clinch)}`;
}


function formatPlayoffPicture(seeds: StandingRow[]): string {
  const lines: string[] = [];
  seeds.forEach((t, i) => {
    const label = i < 4 ? `#${i + 1} Div Winner` : `#${i + 1} Wild Card`;
    const badge = CLINCH_BADGE[t.clinch ?? ""] ? ` ${CLINCH_BADGE[t.clinch!]}` : "";
    lines.push(`${label}: **${t.teamName}** (${t.wins}-${t.losses})${badge}`);
  });
  return lines.join("\n");
}

function formatBubble(bubble: StandingRow[], cutline: StandingRow | undefined): string {
  if (!cutline || bubble.length === 0) return "";
  return bubble.map(t => {
    const gb = cutline.wins - t.wins;
    return `• ${t.teamName} (${t.wins}-${t.losses}) — ${gb} win${gb !== 1 ? "s" : ""} back`;
  }).join("\n");
}

const CONF_COLORS: Record<string, number> = {
  AFC: Colors.Blue,
  NFC: Colors.Red,
};

/**
 * Builds the full conference standings embed (division blocks + playoff picture).
 */
function buildConferenceEmbed(
  conf: "AFC" | "NFC",
  annotated: StandingRow[],
  seasonNumber: number,
): EmbedBuilder {
  const DIVISIONS = ["East", "North", "South", "West"] as const;
  const color = CONF_COLORS[conf] ?? Colors.Blurple;

  // ── Seed order (div winners by record, then wild cards by record) ────────────
  const divWinnerSet = new Set<string>();
  for (const div of DIVISIONS) {
    const leader = annotated
      .filter(t => t.division === div)
      .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential)[0];
    if (leader) divWinnerSet.add(leader.teamName);
  }

  const seeds = [
    ...annotated.filter(t => divWinnerSet.has(t.teamName))
      .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential),
    ...annotated.filter(t => !divWinnerSet.has(t.teamName))
      .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential),
  ];

  const playoffSeeds = seeds.slice(0, 7);
  const bubbleTeams  = seeds.slice(7, 10);
  const playoffField = formatPlayoffPicture(playoffSeeds);
  const bubbleField  = formatBubble(bubbleTeams, playoffSeeds[6]);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🏈 ${conf} Standings — Season ${seasonNumber}`)
    .setFooter({ text: "🌟 1st-Rnd Bye  🏆 Clinched Division  ✅ Clinched Playoff Spot" })
    .setTimestamp();

  // ── One field per division (avoids the 1024-char embed field limit) ──────────
  for (const div of DIVISIONS) {
    const divTeams = annotated
      .filter(t => t.division === div)
      .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);
    if (divTeams.length === 0) continue;

    const lines = divTeams.map((t, i) => recordLine(i + 1, t));
    embed.addFields({ name: `${conf} ${div}`, value: lines.join("\n"), inline: false });
  }

  embed.addFields({ name: `📊 ${conf} Playoff Picture`, value: playoffField || "No data", inline: false });

  if (bubbleField) {
    embed.addFields({ name: `⚠️ ${conf} Bubble`, value: bubbleField, inline: false });
  }

  return embed;
}

// ── Command definition ─────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("standings")
  .setDescription("View The R.E.C. League standings by conference and division")
  .addStringOption(opt =>
    opt.setName("conference")
      .setDescription("Which conference to display")
      .setRequired(true)
      .addChoices(
        { name: "AFC", value: "AFC" },
        { name: "NFC", value: "NFC" },
        { name: "ALL — Both Conferences", value: "ALL" },
      ),
  )
  .addStringOption(opt =>
    opt.setName("division")
      .setDescription("(Optional) Show only this division — ignored when ALL is selected")
      .setRequired(false)
      .addChoices(
        { name: "East",  value: "East"  },
        { name: "North", value: "North" },
        { name: "South", value: "South" },
        { name: "West",  value: "West"  },
      ),
  )
  .addBooleanOption(opt =>
    opt.setName("public")
      .setDescription("Post publicly in the channel? (default: only visible to you)")
      .setRequired(false),
  );

// ── Command handler ────────────────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction) {
  const confInput  = interaction.options.getString("conference", true) as "AFC" | "NFC" | "ALL";
  const divFilter  = interaction.options.getString("division") as "East" | "North" | "South" | "West" | null;
  const isPublic   = interaction.options.getBoolean("public") ?? false;

  await interaction.deferReply({ ephemeral: !isPublic });
  if (!await requireMcaEnabled(interaction)) return;

  const season      = await getOrCreateActiveSeason();
  const allStandings = await getArticleStandings(season.id, TOTAL_GAMES);

  // ── ALL — both conferences ──────────────────────────────────────────────────
  if (confInput === "ALL") {
    const afcTeams = allStandings.filter(t => t.conference === "AFC");
    const nfcTeams = allStandings.filter(t => t.conference === "NFC");

    if (afcTeams.length === 0 && nfcTeams.length === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Grey)
            .setTitle(`League Standings — Season ${season.seasonNumber}`)
            .setDescription("No game data found yet for this season.\n\nExport data from the Madden Companion App to populate standings.")
            .setTimestamp(),
        ],
      });
    }

    const embeds: EmbedBuilder[] = [];
    if (afcTeams.length > 0) embeds.push(buildConferenceEmbed("AFC", annotateClinch(afcTeams), season.seasonNumber));
    if (nfcTeams.length > 0) embeds.push(buildConferenceEmbed("NFC", annotateClinch(nfcTeams), season.seasonNumber));

    return interaction.editReply({ embeds });
  }

  // ── Single conference ───────────────────────────────────────────────────────
  const conf     = confInput;
  const confTeams = allStandings.filter(t => t.conference === conf);
  const color     = CONF_COLORS[conf] ?? Colors.Blurple;

  if (confTeams.length === 0) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Grey)
          .setTitle(`${conf} Standings — Season ${season.seasonNumber}`)
          .setDescription("No game data found yet for this season.\n\nExport data from the Madden Companion App to populate standings.")
          .setTimestamp(),
      ],
    });
  }

  const annotated = annotateClinch(confTeams);

  // ── Division-only view ────────────────────────────────────────────────────
  if (divFilter) {
    const divTeams = annotated
      .filter(t => t.division === divFilter)
      .sort((a, b) => b.wins - a.wins || b.pointDifferential - a.pointDifferential);

    if (divTeams.length === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(color)
            .setTitle(`${conf} ${divFilter} Standings — Season ${season.seasonNumber}`)
            .setDescription(`No teams found in the ${conf} ${divFilter}.`)
            .setTimestamp(),
        ],
      });
    }

    const desc = divTeams.map((t, i) => recordLine(i + 1, t)).join("\n");

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle(`🏈 ${conf} ${divFilter} Division Standings — Season ${season.seasonNumber}`)
          .setDescription(desc)
          .setFooter({ text: "🌟 Bye  🏆 Div  ✅ Playoff | W-L% and point differential shown" })
          .setTimestamp(),
      ],
    });
  }

  // ── Full single-conference view ───────────────────────────────────────────
  return interaction.editReply({ embeds: [buildConferenceEmbed(conf, annotated, season.seasonNumber)] });
}
