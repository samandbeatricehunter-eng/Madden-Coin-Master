// ── EA portrait CDN ───────────────────────────────────────────────────────────
// Update this value when the league upgrades to a new Madden edition.
// Future: will be driven by the per-guild Madden edition setting.
export const MADDEN_CDN_YEAR = "madden26";

/**
 * Returns the EA CDN URL for a player's portrait.
 * This URL is embedded directly in Discord embed thumbnails.
 * Discord's CDN proxy fetches the image from EA's servers when rendering,
 * which works because Discord's servers are not blocked by EA's CDN.
 * (Direct fetching from Replit's cloud IPs is blocked by EA — only embed use works.)
 */
export function eaPortraitUrl(playerId: number | null | undefined): string | null {
  if (!playerId || playerId <= 0) return null;
  return `https://madden-assets-cdn.pulse.ea.com/${MADDEN_CDN_YEAR}/portraits/64/${playerId}.png`;
}

export const COSTS = {
  legend: 2000,
  training_gold: 1000,
  training_silver: 500,
  training_bronze: 250,
  core_attribute: 25,
  non_core_attribute: 10,
  dev_up: 750,
  age_reset: 1000,
  custom_player_gold: 1000,
  custom_player_silver: 750,
  custom_player_bronze: 500,
  contract_extension: 750,
  salary_reduction: 1250,
  bonus_reduction: 1250,
} as const;

export const LIMITS = {
  coreAttrPerSeason: 5,
  nonCoreAttrPerSeason: 15,
  devUpsPerSeason: 1,
  ageResetsPerSeason: 1,
  legendsPerTeam: 2,
  maxLegendsInInventory: 2,
  customPlayersPerDraft: 1,
  contractExtensionsPerSeason: 1,
  contractExtensionsCareer: 1,
  salaryReductionsPerSeason: 1,
  salaryReductionsCareer: 1,
  bonusReductionsPerSeason: 1,
  bonusReductionsCareer: 1,
  trainingGoldPerSeason: 2,
  trainingSilverPerSeason: 2,
} as const;

// Core attributes: Speed, Acceleration, Change of Direction, Agility, Strength,
// Jumping, Throwing Power, Awareness, Stamina — all others are non-core.
export const CORE_ATTRIBUTES = new Set([
  "Speed",
  "Acceleration",
  "Change of Direction",
  "Agility",
  "Strength",
  "Jumping",
  "Throwing Power",
  "Awareness",
  "Stamina",
]);

export const ATTRIBUTES = [
  "Speed",
  "Acceleration",
  "Agility",
  "Strength",
  "Awareness",
  "Carrying",
  "BC Vision",
  "Break Tackle",
  "Trucking",
  "Stiff Arm",
  "Change of Direction",
  "Spin Move",
  "Juke Move",
  "Catching",
  "Catch in Traffic",
  "Spectacular Catch",
  "Short Route Running",
  "Medium Route Running",
  "Deep Route Running",
  "Release",
  "Jumping",
  "Throwing Power",
  "Short Accuracy",
  "Medium Accuracy",
  "Deep Accuracy",
  "Throw on the Run",
  "Throw Under Pressure",
  "Break Sack",
  "Play Action",
  "Pass Blocking",
  "Pass Block Power",
  "Pass Block Finesse",
  "Run Blocking",
  "Run Block Power",
  "Run Block Finesse",
  "Lead Block",
  "Impact Blocking",
  "Play Recognition",
  "Tackling",
  "Hit Power",
  "Block Shedding",
  "Finesse Moves",
  "Power Moves",
  "Pursuit",
  "Man Coverage",
  "Zone Coverage",
  "Press",
  "Kick/Punt Return",
  "Kicking Power",
  "Kicking Accuracy",
  "Stamina",
  "Toughness",
  "Injury",
  "Long Snap",
] as const;

export const NFL_POSITIONS = [
  "QB", "HB", "FB", "WR", "TE",
  "OL",   // All offensive linemen (LT, LG, C, RG, RT)
  "DL",   // All defensive linemen (DE, DT, LE, RE, NT)
  "LB",   // All linebackers (MLB, OLB, ILB, LOLB, ROLB)
  "DB",   // All defensive backs (CB, FS, SS)
  "K", "P", "KR", "PR", "LS",
] as const;

export type NFLPosition = typeof NFL_POSITIONS[number];

/**
 * Weeks during which legend and custom player purchases are open.
 * Purchases must be submitted before the league advances to Wildcard week.
 * Available any time during weeks 1–18 of the regular season.
 * Values match season.currentWeek (e.g. "18" for regular-season week 18).
 */
export const LEGEND_CUSTOM_PURCHASE_WEEKS: ReadonlySet<string> = new Set([
  "1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18",
]);

export const DEV_UP_TYPES = ["Star", "Superstar"] as const;

export const CUSTOM_PLAYER_TIERS = ["gold", "silver", "bronze"] as const;

export const NFL_TEAMS = [
  "Bears",
  "Bengals",
  "Bills",
  "Broncos",
  "Browns",
  "Buccaneers",
  "Cardinals",
  "Chargers",
  "Chiefs",
  "Colts",
  "Cowboys",
  "Dolphins",
  "Eagles",
  "Falcons",
  "Giants",
  "Jaguars",
  "Jets",
  "Lions",
  "Packers",
  "Panthers",
  "Patriots",
  "Raiders",
  "Rams",
  "Ravens",
  "Saints",
  "Seahawks",
  "Steelers",
  "Texans",
  "Titans",
  "Vikings",
  "Commanders",
  "49ers",
] as const;

export type NFLTeam = typeof NFL_TEAMS[number];

// ── NFL division + conference lookup ──────────────────────────────────────────
// Keys are the canonical team nicknames (same as NFL_TEAMS above).
// Also includes common aliases so alternate team names stored in the DB still match.
export type NflConference = "AFC" | "NFC";
export type NflDivision  = "East" | "North" | "South" | "West";

export const NFL_DIVISION_MAP: Record<string, { conference: NflConference; division: NflDivision }> = {
  // AFC East
  Bills:      { conference: "AFC", division: "East" },
  Dolphins:   { conference: "AFC", division: "East" },
  Patriots:   { conference: "AFC", division: "East" },
  Jets:       { conference: "AFC", division: "East" },
  // AFC North
  Ravens:     { conference: "AFC", division: "North" },
  Bengals:    { conference: "AFC", division: "North" },
  Browns:     { conference: "AFC", division: "North" },
  Steelers:   { conference: "AFC", division: "North" },
  // AFC South
  Texans:     { conference: "AFC", division: "South" },
  Colts:      { conference: "AFC", division: "South" },
  Jaguars:    { conference: "AFC", division: "South" },
  Titans:     { conference: "AFC", division: "South" },
  // AFC West
  Chiefs:     { conference: "AFC", division: "West" },
  Raiders:    { conference: "AFC", division: "West" },
  Broncos:    { conference: "AFC", division: "West" },
  Chargers:   { conference: "AFC", division: "West" },
  // NFC East
  Cowboys:    { conference: "NFC", division: "East" },
  Giants:     { conference: "NFC", division: "East" },
  Eagles:     { conference: "NFC", division: "East" },
  Commanders: { conference: "NFC", division: "East" },
  // NFC North
  Bears:      { conference: "NFC", division: "North" },
  Lions:      { conference: "NFC", division: "North" },
  Packers:    { conference: "NFC", division: "North" },
  Vikings:    { conference: "NFC", division: "North" },
  // NFC South
  Buccaneers: { conference: "NFC", division: "South" },
  Falcons:    { conference: "NFC", division: "South" },
  Panthers:   { conference: "NFC", division: "South" },
  Saints:     { conference: "NFC", division: "South" },
  // NFC West
  Cardinals:  { conference: "NFC", division: "West" },
  Rams:       { conference: "NFC", division: "West" },
  "49ers":    { conference: "NFC", division: "West" },
  Seahawks:   { conference: "NFC", division: "West" },
  // Common aliases
  Niners:     { conference: "NFC", division: "West" },
  "G-Men":    { conference: "NFC", division: "East" },
  "Big Blue": { conference: "NFC", division: "East" },
  Pack:       { conference: "NFC", division: "North" },
  Vikes:      { conference: "NFC", division: "North" },
  Bucs:       { conference: "NFC", division: "South" },
  Aints:      { conference: "NFC", division: "South" },
  Phins:      { conference: "AFC", division: "East" },
  Fins:       { conference: "AFC", division: "East" },
  Pats:       { conference: "AFC", division: "East" },
  Jags:       { conference: "AFC", division: "South" },
  Bolts:      { conference: "AFC", division: "West" },
  "Silver and Black": { conference: "AFC", division: "West" },
  Redskins:   { conference: "NFC", division: "East" },
};

/**
 * Given any team name string (full name "Los Angeles Rams", nickname "Rams",
 * city only "Los Angeles", or alias), returns the conference + division,
 * or null if the team cannot be identified.
 *
 * Strategy: try every trailing word / word-group from the name so that
 * "New England Patriots" → tries "New England Patriots", "England Patriots",
 * "Patriots" — and "Patriots" matches.
 */
export function lookupNflDivision(
  teamName: string,
): { conference: NflConference; division: NflDivision } | null {
  const name = teamName.trim();
  if (!name) return null;

  // Direct match first (e.g., "Rams" or "49ers")
  if (NFL_DIVISION_MAP[name]) return NFL_DIVISION_MAP[name]!;

  // Try each suffix substring (handles "Los Angeles Rams", "New England Patriots", etc.)
  const words = name.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const candidate = words.slice(i).join(" ");
    if (NFL_DIVISION_MAP[candidate]) return NFL_DIVISION_MAP[candidate]!;
  }

  return null;
}
