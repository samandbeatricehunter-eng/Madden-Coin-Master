import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type ImportedResultSyncSummary = {
  checked: number;
  matched: number;
  updated: number;
  skipped: number;
  errors: string[];
};

type ImportedResultRow = {
  franchise_schedule_id: number;
  season_id: number;
  week_index: number;
  home_team_name: string | null;
  away_team_name: string | null;
  home_score: number | null;
  away_score: number | null;
  processed_game_id: string | null;
  home_discord_id: string | null;
  away_discord_id: string | null;
};

type GameScheduleRow = {
  id: number;
  guild_id: string;
  season_id: number;
  week_index: number;
  home_discord_id: string | null;
  away_discord_id: string | null;
  home_team_name: string | null;
  away_team_name: string | null;
  status: string | null;
  winner_discord_id: string | null;
  imported_winner_discord_id: string | null;
  away_score: number | null;
  home_score: number | null;
};

function normalizeTeamName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchupKeyFromNames(away: string | null | undefined, home: string | null | undefined): string {
  return [normalizeTeamName(away), normalizeTeamName(home)].sort().join("::");
}

function resultWinnerDiscordId(row: ImportedResultRow): string | null {
  if (row.away_score === null || row.home_score === null) return null;
  if (row.away_score === row.home_score) return null;
  return row.away_score > row.home_score ? row.away_discord_id : row.home_discord_id;
}

async function loadImportedResults(limit: number): Promise<ImportedResultRow[]> {
  const result = await db.execute(sql`
    select
      fs.id as franchise_schedule_id,
      fs.season_id,
      fs.week_index,
      fs.home_team_name,
      fs.away_team_name,
      fs.home_score,
      fs.away_score,
      fs.processed_game_id,
      home.discord_id as home_discord_id,
      away.discord_id as away_discord_id
    from franchise_schedule fs
    left join franchise_mca_teams home
      on home.season_id = fs.season_id
     and home.team_id = fs.home_team_id
    left join franchise_mca_teams away
      on away.season_id = fs.season_id
     and away.team_id = fs.away_team_id
    where fs.home_score is not null
      and fs.away_score is not null
      and fs.status in (2, 3)
    order by fs.imported_at desc nulls last, fs.id desc
    limit ${limit}
  `);

  return ((result as any).rows ?? []) as ImportedResultRow[];
}

async function loadCandidateSchedules(seasonId: number, weekIndex: number): Promise<GameScheduleRow[]> {
  const result = await db.execute(sql`
    select
      id,
      guild_id,
      season_id,
      week_index,
      home_discord_id,
      away_discord_id,
      home_team_name,
      away_team_name,
      status,
      winner_discord_id,
      imported_winner_discord_id,
      away_score,
      home_score
    from game_schedules
    where season_id = ${seasonId}
      and week_index = ${weekIndex}
      and coalesce(status, '') not in ('cancelled', 'deleted')
  `);
  return ((result as any).rows ?? []) as GameScheduleRow[];
}

function findMatchingSchedule(imported: ImportedResultRow, candidates: GameScheduleRow[]): GameScheduleRow | null {
  const importedByDiscord = [imported.away_discord_id, imported.home_discord_id]
    .filter(Boolean)
    .sort()
    .join("::");

  if (importedByDiscord) {
    const byUsers = candidates.find((row) => {
      const rowUsers = [row.away_discord_id, row.home_discord_id].filter(Boolean).sort().join("::");
      return rowUsers === importedByDiscord;
    });
    if (byUsers) return byUsers;
  }

  const importedNames = matchupKeyFromNames(imported.away_team_name, imported.home_team_name);
  return candidates.find((row) => matchupKeyFromNames(row.away_team_name, row.home_team_name) === importedNames) ?? null;
}

async function applyImportedResult(schedule: GameScheduleRow, imported: ImportedResultRow): Promise<boolean> {
  const winnerDiscordId = resultWinnerDiscordId(imported);

  const alreadySynced =
    schedule.status === "finished" &&
    schedule.away_score === imported.away_score &&
    schedule.home_score === imported.home_score &&
    (schedule.imported_winner_discord_id ?? null) === (winnerDiscordId ?? null);

  if (alreadySynced) return false;

  await db.execute(sql`
    update game_schedules
    set
      status = 'finished',
      away_score = ${imported.away_score},
      home_score = ${imported.home_score},
      imported_winner_discord_id = ${winnerDiscordId},
      winner_discord_id = coalesce(winner_discord_id, ${winnerDiscordId}),
      finished_at = coalesce(finished_at, now()),
      updated_at = now()
    where id = ${schedule.id}
  `);

  return true;
}

export async function reconcileImportedGameResults(options: { limit?: number } = {}): Promise<ImportedResultSyncSummary> {
  const limit = Math.max(1, Math.min(options.limit ?? 250, 1000));
  const importedRows = await loadImportedResults(limit);
  const summary: ImportedResultSyncSummary = {
    checked: importedRows.length,
    matched: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  const candidatesByWeek = new Map<string, GameScheduleRow[]>();

  for (const imported of importedRows) {
    try {
      const key = `${imported.season_id}:${imported.week_index}`;
      if (!candidatesByWeek.has(key)) {
        candidatesByWeek.set(key, await loadCandidateSchedules(imported.season_id, imported.week_index));
      }

      const candidates = candidatesByWeek.get(key) ?? [];
      const schedule = findMatchingSchedule(imported, candidates);
      if (!schedule) {
        summary.skipped += 1;
        continue;
      }

      summary.matched += 1;
      const changed = await applyImportedResult(schedule, imported);
      if (changed) summary.updated += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return summary;
}
