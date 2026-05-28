import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export type CanonicalGame = {
  id: number;
  guild_id: string;
  resolved_guild_id?: string;
  league_guild_id?: string;
  rec_league_id: number;
  rec_season_id: number;
  legacy_season_id: number | null;
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

async function ensureCanonicalView(): Promise<void> {
  await db.execute(sql`drop view if exists v_rec_active_league_games`).catch(() => null);
  await db.execute(sql`
    create view v_rec_active_league_games as
    select
      g.id,
      g.rec_league_id,
      g.rec_season_id,
      g.legacy_game_schedule_id,
      g.legacy_franchise_schedule_id,
      g.ea_schedule_id,
      g.processed_game_id,
      g.week_type,
      g.week_number,
      g.week_index,
      g.away_team_id,
      g.home_team_id,
      g.away_team_name,
      g.home_team_name,
      g.away_discord_id,
      g.home_discord_id,
      g.away_score,
      g.home_score,
      g.winner_discord_id,
      g.imported_winner_discord_id,
      g.status,
      g.is_h2h,
      g.source_priority,
      g.source,
      g.import_generation,
      g.confidence_score,
      g.conflict_notes,
      g.imported_at,
      g.created_at,
      g.updated_at,
      g.stable_game_key,
      coalesce(g.legacy_season_id, s.legacy_season_id) as legacy_season_id,
      coalesce(g.guild_id, l.guild_id) as guild_id,
      l.guild_id as league_guild_id,
      s.season_number,
      s.current_week,
      s.stage,
      s.is_active as season_is_active
    from rec_league_games g
    join rec_league_seasons s on s.id = g.rec_season_id
    join rec_leagues l on l.id = s.rec_league_id
    where s.is_active = true  `);
}

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
      guild_id text,
      legacy_season_id bigint,
      legacy_game_schedule_id bigint,
      legacy_franchise_schedule_id bigint,
      stable_game_key text,
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

  await db.execute(sql`alter table rec_league_games add column if not exists guild_id text`).catch(() => null);
  await db.execute(sql`alter table rec_league_games add column if not exists legacy_season_id bigint`).catch(() => null);
  await db.execute(sql`alter table rec_league_games add column if not exists stable_game_key text`).catch(() => null);
  await db.execute(sql`create unique index if not exists rec_league_games_stable_key_idx on rec_league_games(rec_season_id, stable_game_key) where stable_game_key is not null`).catch(() => null);

  await db.execute(sql`
    update rec_league_games g
    set
      guild_id = coalesce(g.guild_id, l.guild_id),
      legacy_season_id = coalesce(g.legacy_season_id, s.legacy_season_id),
      rec_league_id = coalesce(g.rec_league_id, s.rec_league_id),
      updated_at = now()
    from rec_league_seasons s
    join rec_leagues l on l.id = s.rec_league_id
    where g.rec_season_id = s.id
      and (g.guild_id is null or g.legacy_season_id is null or g.rec_league_id is null)
  `).catch(() => null);

  await db.execute(sql`create index if not exists rec_league_games_guild_season_week_idx on rec_league_games(guild_id, rec_season_id, week_number)`).catch(() => null);
  await db.execute(sql`create index if not exists rec_league_games_legacy_season_week_idx on rec_league_games(legacy_season_id, week_number)`).catch(() => null);

  await db.execute(sql`
    alter table media_goty_candidates
      add column if not exists rec_game_id bigint,
      add column if not exists game_status_at_nomination text,
      add column if not exists nominated_week_number integer
  `).catch(() => null);

  await ensureCanonicalView().catch(() => null);
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
      rec_league_id = excluded.rec_league_id,
      season_number = excluded.season_number,
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

  await repairCanonicalOwnershipForGuild(guildId).catch(() => null);

  return {
    recLeagueId: Number(league.id),
    recSeasonId: Number(recSeason.id),
    legacySeasonId: Number(season.id),
    currentWeek: season.current_week ?? null,
  };
}

export async function repairCanonicalOwnershipForGuild(guildId: string): Promise<{ updated: number; backfilledFromGameSchedules: number }> {
  await ensureCanonicalLeagueLayer();

  const result = await db.execute(sql`
    update rec_league_games g
    set
      guild_id = l.guild_id,
      legacy_season_id = s.legacy_season_id,
      rec_league_id = s.rec_league_id,
      updated_at = now()
    from rec_league_seasons s
    join rec_leagues l on l.id = s.rec_league_id
    where g.rec_season_id = s.id
      and l.guild_id = ${guildId}
      and (g.guild_id is distinct from l.guild_id or g.legacy_season_id is distinct from s.legacy_season_id or g.rec_league_id is distinct from s.rec_league_id)
  `);

  const ctx = await refreshCanonicalLeagueSeasonNoRepair(guildId);
  const backfill = await db.execute(sql`
    insert into rec_league_games (
      rec_league_id, rec_season_id, guild_id, legacy_season_id,
      legacy_game_schedule_id, stable_game_key,
      week_type, week_number, week_index,
      away_team_name, home_team_name, away_discord_id, home_discord_id,
      away_score, home_score, winner_discord_id, imported_winner_discord_id,
      status, is_h2h, source_priority, source, confidence_score, imported_at, updated_at
    )
    select
      ${ctx.recLeagueId}, ${ctx.recSeasonId}, ${guildId}, ${ctx.legacySeasonId},
      gs.id,
      'legacy-gs:' || ${ctx.recSeasonId} || ':' || gs.id,
      'regular',
      gs.week_index,
      gs.week_index,
      gs.away_team_name,
      gs.home_team_name,
      nullif(gs.away_discord_id,''),
      nullif(gs.home_discord_id,''),
      gs.away_score,
      gs.home_score,
      coalesce(nullif(gs.imported_winner_discord_id,''), nullif(gs.winner_discord_id,'')),
      nullif(gs.imported_winner_discord_id,''),
      coalesce(nullif(gs.status,''),'scheduled'),
      (nullif(gs.away_discord_id,'') is not null and nullif(gs.home_discord_id,'') is not null),
      85,
      'legacy_game_schedules_backfill',
      case when gs.away_score is not null and gs.home_score is not null then 90 else 70 end,
      coalesce(gs.imported_result_synced_at, gs.updated_at, gs.created_at),
      now()
    from game_schedules gs
    where gs.guild_id = ${guildId}
      and gs.season_id = ${ctx.legacySeasonId}
      and gs.week_index is not null
      and gs.away_team_name is not null
      and gs.home_team_name is not null
    on conflict (rec_season_id, stable_game_key) do update set
      guild_id = excluded.guild_id,
      legacy_season_id = excluded.legacy_season_id,
      legacy_game_schedule_id = coalesce(rec_league_games.legacy_game_schedule_id, excluded.legacy_game_schedule_id),
      away_discord_id = coalesce(rec_league_games.away_discord_id, excluded.away_discord_id),
      home_discord_id = coalesce(rec_league_games.home_discord_id, excluded.home_discord_id),
      away_score = coalesce(rec_league_games.away_score, excluded.away_score),
      home_score = coalesce(rec_league_games.home_score, excluded.home_score),
      winner_discord_id = coalesce(rec_league_games.winner_discord_id, excluded.winner_discord_id),
      imported_winner_discord_id = coalesce(rec_league_games.imported_winner_discord_id, excluded.imported_winner_discord_id),
      status = case when excluded.status = 'finished' then 'finished' else rec_league_games.status end,
      is_h2h = rec_league_games.is_h2h or excluded.is_h2h,
      updated_at = now()
  `).catch(() => ({ rowCount: 0 } as any));

  await ensureCanonicalView().catch(() => null);

  return {
    updated: Number((result as any).rowCount ?? 0),
    backfilledFromGameSchedules: Number((backfill as any).rowCount ?? 0),
  };
}

async function refreshCanonicalLeagueSeasonNoRepair(guildId: string): Promise<{ recLeagueId: number; recSeasonId: number; legacySeasonId: number; currentWeek: string | null }> {
  const [season] = await rowsOf<any>(sql`
    select id, season_number, current_week
    from seasons
    where guild_id = ${guildId} and is_active = true
    order by id desc
    limit 1
  `);
  const [league] = await rowsOf<any>(sql`select id from rec_leagues where guild_id = ${guildId} limit 1`);
  const [recSeason] = await rowsOf<any>(sql`select id from rec_league_seasons where legacy_season_id = ${season.id} limit 1`);
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

function guildPredicate(guildId: string): any {
  return sql`coalesce(guild_id, resolved_guild_id, league_guild_id) = ${guildId}`;
}

export async function listCanonicalWeeksForGoty(guildId: string): Promise<number[]> {
  const ctx = await refreshCanonicalLeagueSeason(guildId);
  const current = activeWeekNumber(ctx.currentWeek);
  const rows = await rowsOf<{ week_number: number }>(sql`
    select distinct week_number::int as week_number
    from v_rec_active_league_games
    where ${guildPredicate(guildId)}
      and rec_season_id = ${ctx.recSeasonId}
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
  const ctx = await refreshCanonicalLeagueSeason(guildId);
  return await rowsOf<CanonicalGame>(sql`
    select *
    from v_rec_active_league_games
    where ${guildPredicate(guildId)}
      and rec_season_id = ${ctx.recSeasonId}
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
  if (!Number.isFinite(recGameId)) return null;
  const rows = await rowsOf<CanonicalGame>(sql`
    select *
    from v_rec_active_league_games
    where ${guildPredicate(guildId)}
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
