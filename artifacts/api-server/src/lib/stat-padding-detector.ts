// ── NFL Division lookup map ───────────────────────────────────────────────────
const NFL_DIVISIONS: Record<string, string> = {
  "Buffalo Bills": "AFC East",  "Miami Dolphins": "AFC East",
  "New England Patriots": "AFC East",  "New York Jets": "AFC East",
  "Baltimore Ravens": "AFC North",  "Cleveland Browns": "AFC North",
  "Pittsburgh Steelers": "AFC North",  "Cincinnati Bengals": "AFC North",
  "Houston Texans": "AFC South",  "Indianapolis Colts": "AFC South",
  "Jacksonville Jaguars": "AFC South",  "Tennessee Titans": "AFC South",
  "Kansas City Chiefs": "AFC West",  "Las Vegas Raiders": "AFC West",
  "Denver Broncos": "AFC West",  "Los Angeles Chargers": "AFC West",
  "Dallas Cowboys": "NFC East",  "Philadelphia Eagles": "NFC East",
  "New York Giants": "NFC East",  "Washington Commanders": "NFC East",
  "Washington Football Team": "NFC East",
  "Chicago Bears": "NFC North",  "Detroit Lions": "NFC North",
  "Green Bay Packers": "NFC North",  "Minnesota Vikings": "NFC North",
  "Atlanta Falcons": "NFC South",  "Carolina Panthers": "NFC South",
  "New Orleans Saints": "NFC South",  "Tampa Bay Buccaneers": "NFC South",
  "Arizona Cardinals": "NFC West",  "Los Angeles Rams": "NFC West",
  "San Francisco 49ers": "NFC West",  "Seattle Seahawks": "NFC West",
};

const NFL_NICKNAMES: Record<string, string> = {
  "Bills": "AFC East",     "Dolphins": "AFC East",   "Patriots": "AFC East",  "Jets": "AFC East",
  "Ravens": "AFC North",   "Browns": "AFC North",    "Steelers": "AFC North", "Bengals": "AFC North",
  "Texans": "AFC South",   "Colts": "AFC South",     "Jaguars": "AFC South",  "Titans": "AFC South",
  "Chiefs": "AFC West",    "Raiders": "AFC West",    "Broncos": "AFC West",   "Chargers": "AFC West",
  "Cowboys": "NFC East",   "Eagles": "NFC East",     "Giants": "NFC East",    "Commanders": "NFC East",
  "Bears": "NFC North",    "Lions": "NFC North",     "Packers": "NFC North",  "Vikings": "NFC North",
  "Falcons": "NFC South",  "Panthers": "NFC South",  "Saints": "NFC South",   "Buccaneers": "NFC South",
  "Cardinals": "NFC West", "Rams": "NFC West",       "49ers": "NFC West",     "Seahawks": "NFC West",
};

function getDivision(teamName: string): string | undefined {
  if (!teamName) return undefined;
  if (NFL_DIVISIONS[teamName]) return NFL_DIVISIONS[teamName];
  const lastWord = teamName.split(" ").pop() ?? "";
  if (NFL_NICKNAMES[lastWord]) return NFL_NICKNAMES[lastWord];
  for (const [k, v] of Object.entries(NFL_DIVISIONS)) {
    if (teamName.includes(k) || k.includes(teamName)) return v;
  }
  return undefined;
}

export function areDivisional(team1: string, team2: string): boolean {
  const d1 = getDivision(team1);
  const d2 = getDivision(team2);
  return !!(d1 && d2 && d1 === d2);
}

// ── Structured violation record ───────────────────────────────────────────────
export interface ViolationRecord {
  type: "h2h_blowout" | "cpu_score" | "player_stat";
  description: string;
  teamName: string;
  playerName?: string;
  discordId?: string;
}

/**
 * Check an H2H game's point spread for a blowout violation.
 * Non-divisional threshold: >35 pts. Divisional threshold: >42 pts.
 * Returns a ViolationRecord or null.
 */
export function detectH2HBlowout(
  winnerTeam: string,
  loserTeam: string,
  winnerScore: number,
  loserScore: number,
  weekLabel: string,
  winnerDiscordId?: string,
): ViolationRecord | null {
  const spread     = winnerScore - loserScore;
  const divisional = areDivisional(winnerTeam, loserTeam);
  const threshold  = divisional ? 42 : 35;
  if (spread <= threshold) return null;
  const typeLabel = divisional ? "divisional" : "non-divisional";
  return {
    type: "h2h_blowout",
    description: `⚠️ **H2H Blowout** — ${weekLabel}: **${winnerTeam}** ${winnerScore} — ${loserScore} **${loserTeam}** (+${spread} spread vs ${typeLabel} opponent; threshold: ${threshold})`,
    teamName: winnerTeam,
    discordId: winnerDiscordId,
  };
}

/**
 * Check a CPU-opponent game for both-teams-high-score anomaly (potential stat padding).
 * Both teams scoring 70+ in a single game is flagged.
 */
export function detectCpuScoreAnomaly(
  humanTeam: string,
  cpuTeam: string,
  humanScore: number,
  cpuScore: number,
  weekLabel: string,
  humanDiscordId?: string,
): ViolationRecord | null {
  if (humanScore >= 70 && cpuScore >= 70) {
    return {
      type: "cpu_score",
      description: `🚨 **CPU Stat Padding** — ${weekLabel}: **${humanTeam}** ${humanScore} — ${cpuScore} **${cpuTeam}** (both teams 70+ points)`,
      teamName: humanTeam,
      discordId: humanDiscordId,
    };
  }
  return null;
}

/**
 * Check a single player's per-game stats for egregious individual numbers.
 * Returns an array of ViolationRecords (may be empty).
 */
export function detectPlayerStatViolations(
  playerName: string,
  position: string,
  teamName: string,
  stats: {
    passYds?: number | null;
    passTDs?: number | null;
    rushYds?: number | null;
    recYds?:  number | null;
  },
  weekLabel: string,
): ViolationRecord[] {
  const flags: ViolationRecord[] = [];
  const name    = playerName.trim() || "Unknown Player";
  const teamTag = teamName ? ` (${teamName})` : "";

  if ((stats.passYds ?? 0) >= 700) {
    flags.push({
      type: "player_stat",
      description: `🚨 **Stat Padding** — ${weekLabel}: **${name}**${teamTag} — ${stats.passYds} passing yards in a single game`,
      teamName,
      playerName: name,
    });
  }
  if ((stats.passTDs ?? 0) >= 8) {
    flags.push({
      type: "player_stat",
      description: `🚨 **Stat Padding** — ${weekLabel}: **${name}**${teamTag} — ${stats.passTDs} passing TDs in a single game`,
      teamName,
      playerName: name,
    });
  }
  if ((stats.rushYds ?? 0) >= 500) {
    flags.push({
      type: "player_stat",
      description: `🚨 **Stat Padding** — ${weekLabel}: **${name}**${teamTag} — ${stats.rushYds} rushing yards in a single game`,
      teamName,
      playerName: name,
    });
  }
  if ((stats.recYds ?? 0) >= 500) {
    flags.push({
      type: "player_stat",
      description: `🚨 **Stat Padding** — ${weekLabel}: **${name}**${teamTag} — ${stats.recYds} receiving yards in a single game`,
      teamName,
      playerName: name,
    });
  }
  return flags;
}
