import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

function extractList(body: unknown, ...keys: string[]): any[] {
  if (!body || typeof body !== "object") return [];
  for (const key of keys) {
    const val = (body as any)[key];
    if (Array.isArray(val)) return val;
  }
  return [];
}

export function canonicalWeekNumber(weekType: string, weekNum: number): number {
  const wt = String(weekType || "reg").toLowerCase();
  if (wt === "reg" || wt === "regular" || wt === "season") return weekNum;
  if (wt === "pre" || wt === "preseason") return weekNum;
  if (weekNum === 1) return 19;
  if (weekNum === 2) return 20;
  if (weekNum === 3) return 21;
  if (weekNum === 4) return 22;
  return weekNum;
}

function stableGameKey(parts: {
  recSeasonId: number;
  weekNumber: number;
  awayTeamId: number | null;
  homeTeamId: number | null;
  awayDiscord: string | null;
  homeDiscord: string | null;
  eaScheduleId?: string | null;
}): string {
  const ea = String(parts.eaScheduleId ?? "").trim();
  if (ea) return `ea:${parts.recSeasonId}:${ea}`;

  const away = parts.awayTeamId != null && parts.awayTeamId >= 0
    ? `t${parts.awayTeamId}`
    : `u${parts.awayDiscord ?? "unknownAway"}`;
  const home = parts.homeTeamId != null && parts.homeTeamId >= 0
    ? `t${parts.homeTeamId}`
    : `u${parts.homeDiscord ?? "unknownHome"}`;

  return `wk:${parts.recSeasonId}:${parts.weekNumber}:${away}:${home}`;
}

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

export async function ensureCanonicalLeagueLayerApi(): Promise<void> {
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

  await db.execute(sql`
    create unique index if not exists rec_league_games_stable_key_idx
    on rec_league_games(rec_season_id, stable_game_key)
    where stable_game_key is not null
  `).catch(() => null);

  await db.execute(sql`create index if not exists rec_league_games_guild_season_week_idx on rec_league_games(guild_id, rec_season_id, week_number)`).catch(() => null);
  await db.execute(sql`create index if not exists rec_league_games_legacy_season_week_idx on rec_league_games(legacy_season_id, week_number)`).catch(() => null);

  await ensureCanonicalView().catch(() => null);
}

export async function getCanonicalSeason(
  eaLeagueId: number,
  guildId?: string,
): Promise<{ recLeagueId: number; recSeasonId: number; legacySeasonId: number; guildId: string }> {
  await ensureCanonicalLeagueLayerApi();

  let resolvedGuildId = String(guildId ?? "").trim();
  if (!resolvedGuildId) {
    const [conn] = await rowsOf<any>(sql`select guild_id from ea_connections where ea_league_id = ${eaLeagueId} limit 1`);
    resolvedGuildId = String(conn?.guild_id ?? "").trim();
  }
  if (!resolvedGuildId) throw new Error(`Cannot resolve guild for EA league ${eaLeagueId}`);

  await db.execute(sql`
    insert into rec_leagues (guild_id, ea_league_id, display_name)
    values (${resolvedGuildId}, ${eaLeagueId}, 'REC League')
    on conflict (guild_id) do update set
      ea_league_id = coalesce(excluded.ea_league_id, rec_leagues.ea_league_id),
      updated_at = now()
  `);

  const [season] = await rowsOf<any>(sql`
    select id, season_number, current_week, is_active, started_at
    from seasons
    where guild_id = ${resolvedGuildId} and is_active = true
    order by id desc
    limit 1
  `);
  if (!season) throw new Error(`No active season found for guild ${resolvedGuildId}`);

  const [league] = await rowsOf<any>(sql`select id from rec_leagues where guild_id = ${resolvedGuildId} limit 1`);

  await db.execute(sql`
    insert into rec_league_seasons (rec_league_id, legacy_season_id, season_number, current_week, is_active, completed, started_at, stage)
    values (${league.id}, ${season.id}, ${Number(season.season_number ?? 1)}, ${season.current_week ?? null}, true, false, ${season.started_at ?? null},
      case
        when lower(coalesce(${season.current_week ?? ""},'')) in ('wildcard','divisional','conference','superbowl') then 'postseason'
        when lower(coalesce(${season.current_week ?? ""},'')) = 'offseason' then 'offseason'
        else 'regular'
      end)
    on conflict (legacy_season_id) do update set
      rec_league_id = excluded.rec_league_id,
      season_number = excluded.season_number,
      current_week = excluded.current_week,
      is_active = true,
      completed = false,
      stage = excluded.stage,
      updated_at = now()
  `);

  const [recSeason] = await rowsOf<any>(sql`select id from rec_league_seasons where legacy_season_id = ${season.id} limit 1`);

  return {
    recLeagueId: Number(league.id),
    recSeasonId: Number(recSeason.id),
    legacySeasonId: Number(season.id),
    guildId: resolvedGuildId,
  };
}

export async function repairCanonicalOwnershipForGuild(guildId: string): Promise<{ updated: number }> {
  await ensureCanonicalLeagueLayerApi();

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

  return { updated: Number((result as any).rowCount ?? 0) };
}

export async function syncCanonicalGamesFromSchedulePayload(
  body: unknown,
  weekNum: number,
  weekType: string,
  eaLeagueId: number,
  guildId?: string,
): Promise<{ upserted: number; h2h: number }> {
  const ctx = await getCanonicalSeason(eaLeagueId, guildId);
  const games = extractList(body, "scheduleInfoList", "gameScheduleInfoList", "schedules");
  const weekNumber = canonicalWeekNumber(weekType, weekNum);

  const teams = await rowsOf<any>(sql`
    select team_id, full_name, nick_name, discord_id
    from franchise_mca_teams
    where season_id = ${ctx.legacySeasonId}
  `);
  const teamMap = new Map(teams.map(t => [Number(t.team_id), t]));

  let upserted = 0;
  let h2h = 0;

  for (const g of games) {
    const homeTeamId = Number(g?.homeTeamId ?? -1);
    const awayTeamId = Number(g?.awayTeamId ?? -1);
    if (homeTeamId < 0 || awayTeamId < 0) continue;

    const home = teamMap.get(homeTeamId);
    const away = teamMap.get(awayTeamId);
    const homeDiscord = String(home?.discord_id ?? "").trim() || null;
    const awayDiscord = String(away?.discord_id ?? "").trim() || null;
    const isH2H = Boolean(homeDiscord && awayDiscord);
    if (isH2H) h2h++;

    const homeScore = g?.homeScore != null ? Number(g.homeScore) : null;
    const awayScore = g?.awayScore != null ? Number(g.awayScore) : null;
    const statusNum = Number(g?.status ?? g?.scheduleStatus ?? 0);
    const finished = statusNum >= 2 || (homeScore != null && awayScore != null && (homeScore > 0 || awayScore > 0));
    const winner =
      finished && awayScore != null && homeScore != null && awayScore > homeScore ? awayDiscord :
      finished && awayScore != null && homeScore != null && homeScore > awayScore ? homeDiscord :
      null;

    const key = stableGameKey({
      recSeasonId: ctx.recSeasonId,
      weekNumber,
      awayTeamId,
      homeTeamId,
      awayDiscord,
      homeDiscord,
      eaScheduleId: String(g?.scheduleId ?? "").trim() || null,
    });

    await db.execute(sql`
      insert into rec_league_games (
        rec_league_id, rec_season_id, guild_id, legacy_season_id,
        stable_game_key, ea_schedule_id, week_type, week_number, week_index,
        away_team_id, home_team_id, away_team_name, home_team_name,
        away_discord_id, home_discord_id, away_score, home_score,
        winner_discord_id, imported_winner_discord_id, status, is_h2h,
        source_priority, source, confidence_score, imported_at, updated_at
      )
      values (
        ${ctx.recLeagueId}, ${ctx.recSeasonId}, ${ctx.guildId}, ${ctx.legacySeasonId},
        ${key}, ${String(g?.scheduleId ?? "").trim() || null}, ${weekType}, ${weekNumber}, ${weekNumber},
        ${awayTeamId}, ${homeTeamId}, ${String(away?.full_name ?? away?.nick_name ?? g?.awayTeamName ?? `Team${awayTeamId}`)}, ${String(home?.full_name ?? home?.nick_name ?? g?.homeTeamName ?? `Team${homeTeamId}`)},
        ${awayDiscord}, ${homeDiscord}, ${awayScore}, ${homeScore},
        ${winner}, ${winner}, ${finished ? "finished" : "scheduled"}, ${isH2H},
        100, 'mca_schedule_import', ${finished ? 100 : 80}, now(), now()
      )
      on conflict (rec_season_id, stable_game_key) do update set
        guild_id = coalesce(rec_league_games.guild_id, excluded.guild_id),
        legacy_season_id = coalesce(rec_league_games.legacy_season_id, excluded.legacy_season_id),
        rec_league_id = excluded.rec_league_id,
        ea_schedule_id = coalesce(excluded.ea_schedule_id, rec_league_games.ea_schedule_id),
        away_team_id = coalesce(excluded.away_team_id, rec_league_games.away_team_id),
        home_team_id = coalesce(excluded.home_team_id, rec_league_games.home_team_id),
        away_team_name = excluded.away_team_name,
        home_team_name = excluded.home_team_name,
        away_discord_id = coalesce(excluded.away_discord_id, rec_league_games.away_discord_id),
        home_discord_id = coalesce(excluded.home_discord_id, rec_league_games.home_discord_id),
        away_score = coalesce(excluded.away_score, rec_league_games.away_score),
        home_score = coalesce(excluded.home_score, rec_league_games.home_score),
        winner_discord_id = coalesce(excluded.winner_discord_id, rec_league_games.winner_discord_id),
        imported_winner_discord_id = coalesce(excluded.imported_winner_discord_id, rec_league_games.imported_winner_discord_id),
        status = case when excluded.status = 'finished' then 'finished' else rec_league_games.status end,
        is_h2h = excluded.is_h2h,
        source_priority = greatest(rec_league_games.source_priority, excluded.source_priority),
        confidence_score = greatest(rec_league_games.confidence_score, excluded.confidence_score),
        imported_at = coalesce(excluded.imported_at, rec_league_games.imported_at),
        updated_at = now()
    `);
    upserted++;
  }

  return { upserted, h2h };
}
