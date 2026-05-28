
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export type CanonicalGame = {
  id: number;
  guild_id: string;
  rec_league_id: number;
  rec_season_id: number;
  legacy_game_schedule_id: number | null;
  legacy_franchise_schedule_id: number | null;
  week_number: number;
  week_index: number | null;
  away_team_name: string;
  home_team_name: string;
  away_discord_id: string | null;
  home_discord_id: string | null;
  away_score: number | null;
  home_score: number | null;
  winner_discord_id: string | null;
  status: string;
  is_h2h: boolean;
  source: string;
  confidence_score: number;
};

export async function ensureCanonicalLeagueLayer(): Promise<void> {
  await db.execute(sql`
    create table if not exists rec_leagues (
      id bigserial primary key,
      guild_id text not null unique,
      ea_league_id bigint,
      display_name text,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);
  await db.execute(sql`
    create table if not exists rec_league_seasons (
      id bigserial primary key,
      rec_league_id bigint not null references rec_leagues(id) on delete cascade,
      legacy_season_id bigint unique,
      season_number integer not null,
      current_week text,
      stage text not null default 'regular',
      is_active boolean not null default false,
      completed boolean not null default false,
      started_at timestamp with time zone,
      ended_at timestamp with time zone,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now(),
      unique(rec_league_id, season_number)
    )
  `);
  await db.execute(sql`
    create table if not exists rec_league_games (
      id bigserial primary key,
      rec_league_id bigint not null references rec_leagues(id) on delete cascade,
      rec_season_id bigint not null references rec_league_seasons(id) on delete cascade,
      legacy_game_schedule_id bigint,
      legacy_franchise_schedule_id bigint,
      ea_schedule_id text,
      processed_game_id text,
      week_type text not null default 'regular',
      week_number integer not null,
      week_index integer,
      away_team_id bigint,
      home_team_id bigint,
      away_team_name text not null,
      home_team_name text not null,
      away_discord_id text,
      home_discord_id text,
      away_score integer,
      home_score integer,
      winner_discord_id text,
      imported_winner_discord_id text,
      status text not null default 'scheduled',
      is_h2h boolean not null default false,
      source_priority integer not null default 50,
      source text not null default 'canonical',
      import_generation bigint,
      confidence_score integer not null default 50,
      conflict_notes text,
      imported_at timestamp with time zone,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    )
  `);
  await db.execute(sql`
    alter table media_goty_candidates
      add column if not exists rec_game_id bigint,
      add column if not exists game_status_at_nomination text,
      add column if not exists nominated_week_number integer
  `).catch(() => null);
}

export async function refreshCanonicalLeagueSeason(guildId: string): Promise<{ recLeagueId: number; recSeasonId: number; legacySeasonId: number; currentWeek: string | null }> {
  await ensureCanonicalLeagueLayer();
  await db.execute(sql`
    insert into rec_leagues (guild_id, display_name)
    values (${guildId}, 'REC League')
    on conflict (guild_id) do update set updated_at = now()
  `);

  const [season] = await rowsOf<any>(sql`
    select id, guild_id, season_number, current_week, is_active, started_at
    from seasons
    where guild_id = ${guildId}
      and is_active = true
    order by id desc
    limit 1
  `);
  if (!season) throw new Error(`No active season found for guild ${guildId}`);

  const [league] = await rowsOf<any>(sql`select id from rec_leagues where guild_id = ${guildId} limit 1`);
  await db.execute(sql`
    insert into rec_league_seasons (
      rec_league_id, legacy_season_id, season_number, current_week, is_active, completed, started_at, stage
    )
    values (
      ${league.id}, ${season.id}, ${Number(season.season_number ?? 1)}, ${season.current_week ?? null}, true, false, ${season.started_at ?? null},
      case
        when lower(coalesce(${season.current_week ?? ""},'')) in ('wildcard','divisional','conference','superbowl') then 'postseason'
        when lower(coalesce(${season.current_week ?? ""},'')) = 'offseason' then 'offseason'
        else 'regular'
      end
    )
    on conflict (legacy_season_id) do update set
      current_week = excluded.current_week,
      is_active = true,
      completed = false,
      stage = excluded.stage,
      updated_at = now()
  `);

  const [recSeason] = await rowsOf<any>(sql`
    select id
    from rec_league_seasons
    where legacy_season_id = ${season.id}
    limit 1
  `);
  return { recLeagueId: Number(league.id), recSeasonId: Number(recSeason.id), legacySeasonId: Number(season.id), currentWeek: season.current_week ?? null };
}

export function activeWeekNumber(currentWeek: string | null | undefined): number | null {
  const raw = String(currentWeek ?? "").toLowerCase().trim();
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 18) return n;
  if (raw === "wildcard") return 19;
  if (raw === "divisional") return 20;
  if (raw === "conference") return 21;
  if (raw === "superbowl") return 22;
  return null;
}

export async function listCanonicalWeeksForGoty(guildId: string): Promise<number[]> {
  const ctx = await refreshCanonicalLeagueSeason(guildId);
  const current = activeWeekNumber(ctx.currentWeek);
  const rows = await rowsOf<{ week_number: number }>(sql`
    select distinct week_number::int as week_number
    from v_rec_active_league_games
    where guild_id = ${guildId}
      and is_h2h = true
      and away_discord_id is not null
      and home_discord_id is not null
      and week_number between 1 and coalesce(${current}, 22)
    order by week_number asc
    limit 25
  `);
  return rows.map(r => Number(r.week_number)).filter(n => Number.isInteger(n));
}

export async function listCanonicalGamesForGoty(guildId: string, weekNumber: number): Promise<CanonicalGame[]> {
  await refreshCanonicalLeagueSeason(guildId);
  return await rowsOf<CanonicalGame>(sql`
    select *
    from v_rec_active_league_games
    where guild_id = ${guildId}
      and week_number = ${weekNumber}
      and is_h2h = true
      and away_discord_id is not null
      and home_discord_id is not null
    order by
      case when status = 'finished' then 0 else 1 end,
      away_team_name asc,
      home_team_name asc
    limit 25
  `);
}

export async function getCanonicalGame(guildId: string, recGameId: number): Promise<CanonicalGame | null> {
  const rows = await rowsOf<CanonicalGame>(sql`
    select *
    from v_rec_active_league_games
    where guild_id = ${guildId}
      and id = ${recGameId}
    limit 1
  `);
  return rows[0] ?? null;
}

export function displayWeekLabel(weekNumber: number): string {
  if (weekNumber === 19) return "Wild Card";
  if (weekNumber === 20) return "Divisional Round";
  if (weekNumber === 21) return "Conference Championship";
  if (weekNumber === 22) return "Super Bowl";
  return `Week ${weekNumber}`;
}
