import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { resolveActiveSeasonContext, resolvePanelRecSeasonIds } from "./season-mapping-service.js";

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export function resolveCurrentWeekIndex(currentWeek: unknown): number | null {
  if (typeof currentWeek === "number" && Number.isFinite(currentWeek)) return Math.max(0, Math.floor(currentWeek));
  if (typeof currentWeek === "string") {
    const trimmed = currentWeek.trim().toLowerCase();
    const n = Number(trimmed);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    if (trimmed === "training_camp" || trimmed === "offseason") return null;
  }
  return null;
}

export type H2HOpponentRow = { user_id: string; opponent_id: string; week_index: number | null; week_number: number | null };

export async function getCurrentSeasonH2HOpponents(guildId: string): Promise<{ seasonId: number; recSeasonIds: number[]; rows: H2HOpponentRow[] }> {
  const ctx = await resolveActiveSeasonContext(guildId);
  const rows = await rowsOf<H2HOpponentRow>(sql`
    with mapped_seasons as (
      select rec_season_id
      from rec_season_mappings
      where guild_id=${guildId}
        and season_id=${ctx.seasonId}
    ),
    raw_games as (
      select trim(away_discord_id) as away, trim(home_discord_id) as home, week_index, week_number
      from rec_league_games
      where guild_id=${guildId}
        and rec_season_id in (select rec_season_id from mapped_seasons)
        and week_index between 0 and 18
        and is_h2h = true
        and away_discord_id is not null
        and home_discord_id is not null
        and trim(away_discord_id) <> ''
        and trim(home_discord_id) <> ''
        and away_discord_id not like 'unlinked_%'
        and home_discord_id not like 'unlinked_%'
    ),
    pairs as (
      select away as user_id, home as opponent_id, week_index, week_number from raw_games
      union all
      select home as user_id, away as opponent_id, week_index, week_number from raw_games
    )
    select user_id, opponent_id, min(week_index) as week_index, min(week_number) as week_number
    from pairs
    where user_id is not null
      and opponent_id is not null
      and user_id <> opponent_id
    group by user_id, opponent_id
  `).catch(() => []);
  return { seasonId: ctx.seasonId, recSeasonIds: ctx.recSeasonIds, rows };
}

export async function getCompletedH2HResults(): Promise<Array<{ away: string; home: string; away_score: number; home_score: number; winner: string | null }>> {
  return rowsOf<any>(sql`
    select away_discord_id as away,
           home_discord_id as home,
           away_score,
           home_score,
           coalesce(imported_winner_discord_id, winner_discord_id) as winner
    from rec_league_games
    where guild_id in ('1493688089883971735','1476251181524189438','1497423447192768612')
      and is_h2h = true
      and away_discord_id is not null
      and home_discord_id is not null
      and away_discord_id not like 'unlinked_%'
      and home_discord_id not like 'unlinked_%'
      and away_score is not null
      and home_score is not null
      and status in ('finished','completed','completed_pending_import')
    order by imported_at asc nulls first, updated_at asc nulls first, id asc
  `).then((rows) => rows.map((r:any) => ({
    away: String(r.away).trim(),
    home: String(r.home).trim(),
    away_score: Number(r.away_score),
    home_score: Number(r.home_score),
    winner: r.winner ? String(r.winner).trim() : null,
  }))).catch(() => []);
}

export async function findRecGameForPanel(row: { id: number; guild_id: string; season_id: number; week_index: number; away_discord_id?: string | null; home_discord_id?: string | null; away_team_name?: string | null; home_team_name?: string | null }): Promise<number | null> {
  if (!row.away_discord_id || !row.home_discord_id) return null;
  const recSeasonIds = await resolvePanelRecSeasonIds(row);
  const found = await rowsOf<{ id: number }>(sql`
    select id
    from rec_league_games
    where guild_id=${row.guild_id}
      and rec_season_id in (
        select rec_season_id from rec_season_mappings where guild_id=${row.guild_id} and season_id=${row.season_id}
      )
      and is_h2h=true
      and (
        (away_discord_id=${row.away_discord_id} and home_discord_id=${row.home_discord_id})
        or
        (away_discord_id=${row.home_discord_id} and home_discord_id=${row.away_discord_id})
      )
      and abs(week_index - ${row.week_index}) <= 2
    order by
      case when week_index = ${row.week_index} then 0 else 1 end,
      abs(week_index - ${row.week_index}) asc,
      imported_at desc nulls last,
      updated_at desc nulls last,
      id desc
    limit 1
  `).catch(() => []);

  if (process.env.DEBUG_GAMEDAY_PANEL_SYNC === "true") {
    console.log("[gameday-panel-sync] rec lookup", { panelId: row.id, matchedBy: found[0]?.id ? "mapped_rec_season_user_week" : null, recGameId: found[0]?.id ?? null, recSeasonIds });
  }

  return found[0]?.id ? Number(found[0].id) : null;
}


export async function getCurrentSeasonRemainingH2HOpponents(guildId: string): Promise<{ seasonId: number; recSeasonIds: number[]; currentWeekIndex: number | null; rows: H2HOpponentRow[] }> {
  const ctx = await resolveActiveSeasonContext(guildId);
  const currentWeekIndex = resolveCurrentWeekIndex(ctx.currentWeek);
  const rows = await rowsOf<H2HOpponentRow>(sql`
    with mapped_seasons as (
      select rec_season_id
      from rec_season_mappings
      where guild_id=${guildId}
        and season_id=${ctx.seasonId}
    ),
    raw_games as (
      select trim(away_discord_id) as away, trim(home_discord_id) as home, week_index, week_number
      from rec_league_games
      where guild_id=${guildId}
        and rec_season_id in (select rec_season_id from mapped_seasons)
        and week_index between 0 and 18
        and (${currentWeekIndex}::integer is null or week_index >= ${currentWeekIndex})
        and is_h2h = true
        and away_discord_id is not null
        and home_discord_id is not null
        and trim(away_discord_id) <> ''
        and trim(home_discord_id) <> ''
        and away_discord_id not like 'unlinked_%'
        and home_discord_id not like 'unlinked_%'
    ),
    pairs as (
      select away as user_id, home as opponent_id, week_index, week_number from raw_games
      union all
      select home as user_id, away as opponent_id, week_index, week_number from raw_games
    )
    select user_id, opponent_id, min(week_index) as week_index, min(week_number) as week_number
    from pairs
    where user_id is not null
      and opponent_id is not null
      and user_id <> opponent_id
    group by user_id, opponent_id
  `).catch(() => []);
  return { seasonId: ctx.seasonId, recSeasonIds: ctx.recSeasonIds, currentWeekIndex, rows };
}
