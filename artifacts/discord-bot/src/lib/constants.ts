export const COSTS = {
  legend: 1000,
  core_attribute: 25,
  non_core_attribute: 10,
  dev_up: 250,
  age_reset: 250,
  custom_player_gold: 300,
  custom_player_silver: 200,
  custom_player_bronze: 100,
} as const;

export const LIMITS = {
  coreAttrPerSeason: 16,
  nonCoreAttrPerSeason: 32,
  devUpsPerSeason: 2,      // permanent default (season 3+)
  ageResetsPerSeason: 2,   // permanent default (season 3+)
  legendsAllTime: 4,
  maxLegendsInInventory: 4,
  maxLegendsPlusCustomPlayers: 7,
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
export const NFL_DIVISION_MAP: Record<string, { conference: "AFC" | "NFC"; division: "East" | "North" | "South" | "West" }> = {
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
