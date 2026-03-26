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
