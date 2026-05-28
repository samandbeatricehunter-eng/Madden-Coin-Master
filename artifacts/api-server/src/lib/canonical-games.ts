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

function asInt(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asText(value: unknown): string | null {
  const v = String(value ?? "").trim();
  return v.length ? v : null;
}

export function canonicalWeekNumber(weekType: string, weekNum: number): number {
  const wt = String(weekType || "reg").toLowerCase();
  if (wt === "reg" || wt === "regular" || wt === "season") return weekNum;
  if (weekNum === 1) return 19;
  if (weekNum === 2) return 20;
  if (weekNum === 3) return 21;
  if (weekNum === 4) return 22;
  return weekNum;
}

function weekNumberForGame(game: any, routeWeekNum: number, weekType: string): number {
  if (routeWeekNum > 0) return canonicalWeekNumber(weekType, routeWeekNum);

  // Full-season schedule exports usually carry EA's zero-based weekIndex.
  const idx = asInt(game?.weekIndex ?? game?.week_index ?? game?.weekNum ?? game?.week ?? null, null);
  if (idx === null) return 0;

  const wt = String(weekType || "season").toLowerCase();
  if (wt === "season" || wt === "reg" || wt === "regular") {
    // Madden regular season weekIndex is zero-based in schedule exports.
    return idx >= 0 && idx <= 17 ? idx + 1 : idx;
  }
  return canonicalWeekNumber(wt, idx);
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
  const away = parts.awayTeamId != null && parts.awayTeamId >= 0 ? `t${parts.awayTeamId}` : `u${parts.awayDiscord ?? "unknownAway"}`;
  const home = parts.homeTeamId != null && parts.homeTeamId >= 0 ? `t${parts.homeTeamId}` : `u${parts.homeDiscord ?? "unknownHome"}`;
  return `wk:${parts.recSeasonId}:${parts.weekNumber}:${away}:${home}`;
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
      updated_at timestamp with time zone not null default now(),
      stable_game_key text,
      legacy_season_id bigint,
      guild_id text
    )
  `);
  await db.execute(sql`alter table rec_league_games add column if not exists stable_game_key text`);
  await db.execute(sql`alter table rec_league_games add column if not exists legacy_season_id bigint`);
  await db.execute(sql`alter table rec_league_games add column if not exists guild_id text`);
  await db.execute(sql`
    create unique index if not exists rec_league_games_rec_season_stable_key_idx
    on rec_league_games(rec_season_id, stable_game_key)
    where stable_game_key is not null
  `);
}

export async function getCanonicalSeason(eaLeagueId: number, guildId?: string): Promise<{ recLeagueId: number; recSeasonId: number; legacySeasonId: number; guildId: string }> {
  await ensureCanonicalLeagueLayerApi();

  let resolvedGuildId = String(guildId ?? "").trim();
  if (!resolvedGuildId) {
    const [conn] = await rowsOf<any>(sql`select guild_id from ea_connections where ea_league_id = ${eaLeagueId} limit 1`);
    resolvedGuildId = String(conn?.guild_id ?? "");
  }
  if (!resolvedGuildId) throw new Error(`Cannot resolve guild for EA league ${eaLeagueId}`);

  await db.execute(sql`
    insert into rec_leagues (guild_id, ea_league_id, display_name)
    values (${resolvedGuildId}, ${eaLeagueId}, 'REC League')
    on conflict (guild_id) do update set ea_league_id = coalesce(excluded.ea_league_id, rec_leagues.ea_league_id), updated_at = now()
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
      current_week = excluded.current_week,
      is_active = true,
      completed = false,
      stage = excluded.stage,
      updated_at = now()
  `);

  const [recSeason] = await rowsOf<any>(sql`select id from rec_league_seasons where legacy_season_id = ${season.id} limit 1`);
  return { recLeagueId: Number(league.id), recSeasonId: Number(recSeason.id), legacySeasonId: Number(season.id), guildId: resolvedGuildId };
}

async function loadTeamMap(legacySeasonId: number): Promise<Map<number, any>> {
  const teams = await rowsOf<any>(sql`
    select team_id, full_name, nick_name, discord_id
    from franchise_mca_teams
    where season_id = ${legacySeasonId}
  `);
  return new Map(teams.map(t => [Number(t.team_id), t]));
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
  const teamMap = await loadTeamMap(ctx.legacySeasonId);

  let upserted = 0;
  let h2h = 0;

  for (const g of games) {
    const homeTeamId = asInt(g?.homeTeamId, -1)!;
    const awayTeamId = asInt(g?.awayTeamId, -1)!;
    if (homeTeamId < 0 || awayTeamId < 0) continue;

    const gameWeekNumber = weekNumberForGame(g, weekNum, weekType);
    if (gameWeekNumber <= 0) continue;

    const home = teamMap.get(homeTeamId);
    const away = teamMap.get(awayTeamId);
    const homeDiscord = asText(home?.discord_id);
    const awayDiscord = asText(away?.discord_id);
    const isH2H = Boolean(homeDiscord && awayDiscord);
    if (isH2H) h2h++;

    const homeScore = asInt(g?.homeScore, null);
    const awayScore = asInt(g?.awayScore, null);
    const statusNum = asInt(g?.status ?? g?.scheduleStatus, 0)!;
    const finished = statusNum >= 2 || (homeScore !== null && awayScore !== null && (homeScore > 0 || awayScore > 0));
    const winner =
      finished && awayScore !== null && homeScore !== null && awayScore > homeScore ? awayDiscord :
      finished && awayScore !== null && homeScore !== null && homeScore > awayScore ? homeDiscord :
      null;

    const eaScheduleId = asText(g?.scheduleId ?? g?.gameId ?? g?.id);
    const key = stableGameKey({ recSeasonId: ctx.recSeasonId, weekNumber: gameWeekNumber, awayTeamId, homeTeamId, awayDiscord, homeDiscord, eaScheduleId });

    await db.execute(sql`
      insert into rec_league_games (
        rec_league_id, rec_season_id, legacy_season_id, guild_id, stable_game_key, ea_schedule_id, week_type, week_number, week_index,
        away_team_id, home_team_id, away_team_name, home_team_name,
        away_discord_id, home_discord_id, away_score, home_score,
        winner_discord_id, imported_winner_discord_id, status, is_h2h,
        source_priority, source, confidence_score, imported_at, updated_at
      )
      values (
        ${ctx.recLeagueId}, ${ctx.recSeasonId}, ${ctx.legacySeasonId}, ${ctx.guildId}, ${key}, ${eaScheduleId}, ${weekType}, ${gameWeekNumber}, ${gameWeekNumber},
        ${awayTeamId}, ${homeTeamId}, ${String(away?.full_name ?? away?.nick_name ?? g?.awayTeamName ?? `Team${awayTeamId}`)}, ${String(home?.full_name ?? home?.nick_name ?? g?.homeTeamName ?? `Team${homeTeamId}`)},
        ${awayDiscord}, ${homeDiscord}, ${awayScore}, ${homeScore},
        ${winner}, ${winner}, ${finished ? "finished" : "scheduled"}, ${isH2H},
        100, 'mca_schedule_import', ${finished ? 100 : 80}, now(), now()
      )
      on conflict (rec_season_id, stable_game_key) do update set
        guild_id = excluded.guild_id,
        legacy_season_id = excluded.legacy_season_id,
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
        status = case when excluded.status = 'finished' then 'finished' else coalesce(rec_league_games.status, excluded.status) end,
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

export async function backfillCanonicalGamesFromLegacy(eaLeagueId: number, guildId?: string): Promise<{ gameSchedules: number; franchiseSchedules: number }> {
  const ctx = await getCanonicalSeason(eaLeagueId, guildId);

  const fromGameSchedules = await rowsOf<any>(sql`
    select id, week_index, away_discord_id, home_discord_id, away_team_name, home_team_name, away_score, home_score,
           winner_discord_id, imported_winner_discord_id, status, away_team_id, home_team_id
    from game_schedules
    where guild_id = ${ctx.guildId} and season_id = ${ctx.legacySeasonId}
  `).catch(() => [] as any[]);

  let gameSchedules = 0;
  for (const g of fromGameSchedules) {
    const weekNumber = asInt(g.week_index, 0)!;
    if (weekNumber <= 0) continue;
    const awayTeamId = asInt(g.away_team_id, null);
    const homeTeamId = asInt(g.home_team_id, null);
    const awayDiscord = asText(g.away_discord_id);
    const homeDiscord = asText(g.home_discord_id);
    const awayScore = asInt(g.away_score, null);
    const homeScore = asInt(g.home_score, null);
    const winner = asText(g.imported_winner_discord_id ?? g.winner_discord_id) ?? (
      awayScore !== null && homeScore !== null && awayScore > homeScore ? awayDiscord :
      awayScore !== null && homeScore !== null && homeScore > awayScore ? homeDiscord : null
    );
    const key = stableGameKey({ recSeasonId: ctx.recSeasonId, weekNumber, awayTeamId, homeTeamId, awayDiscord, homeDiscord, eaScheduleId: null });
    await db.execute(sql`
      insert into rec_league_games (
        rec_league_id, rec_season_id, legacy_season_id, guild_id, legacy_game_schedule_id, stable_game_key, week_type, week_number, week_index,
        away_team_id, home_team_id, away_team_name, home_team_name, away_discord_id, home_discord_id, away_score, home_score,
        winner_discord_id, imported_winner_discord_id, status, is_h2h, source_priority, source, confidence_score, imported_at, updated_at
      ) values (
        ${ctx.recLeagueId}, ${ctx.recSeasonId}, ${ctx.legacySeasonId}, ${ctx.guildId}, ${g.id}, ${key}, 'regular', ${weekNumber}, ${weekNumber},
        ${awayTeamId}, ${homeTeamId}, ${String(g.away_team_name ?? 'Away')}, ${String(g.home_team_name ?? 'Home')}, ${awayDiscord}, ${homeDiscord}, ${awayScore}, ${homeScore},
        ${winner}, ${winner}, ${String(g.status ?? '').toLowerCase() === 'finished' || winner ? 'finished' : 'scheduled'}, ${Boolean(awayDiscord && homeDiscord)}, 70, 'legacy_game_schedules_backfill', ${winner ? 90 : 60}, now(), now()
      )
      on conflict (rec_season_id, stable_game_key) do update set
        legacy_game_schedule_id = coalesce(rec_league_games.legacy_game_schedule_id, excluded.legacy_game_schedule_id),
        away_score = coalesce(rec_league_games.away_score, excluded.away_score),
        home_score = coalesce(rec_league_games.home_score, excluded.home_score),
        winner_discord_id = coalesce(rec_league_games.winner_discord_id, excluded.winner_discord_id),
        imported_winner_discord_id = coalesce(rec_league_games.imported_winner_discord_id, excluded.imported_winner_discord_id),
        status = case when excluded.status = 'finished' then 'finished' else rec_league_games.status end,
        updated_at = now()
    `);
    gameSchedules++;
  }

  const fromFranchise = await rowsOf<any>(sql`
    select id, week_index, away_team_id, home_team_id, away_team_name, home_team_name, away_score, home_score, status, processed_game_id
    from franchise_schedule
    where season_id = ${ctx.legacySeasonId}
  `).catch(() => [] as any[]);

  const teamMap = await loadTeamMap(ctx.legacySeasonId);
  let franchiseSchedules = 0;
  for (const g of fromFranchise) {
    const rawWeek = asInt(g.week_index, 0)!;
    const weekNumber = rawWeek >= 0 && rawWeek <= 17 ? rawWeek + 1 : rawWeek;
    if (weekNumber <= 0) continue;
    const awayTeamId = asInt(g.away_team_id, null);
    const homeTeamId = asInt(g.home_team_id, null);
    const away = awayTeamId == null ? null : teamMap.get(awayTeamId);
    const home = homeTeamId == null ? null : teamMap.get(homeTeamId);
    const awayDiscord = asText(away?.discord_id);
    const homeDiscord = asText(home?.discord_id);
    const awayScore = asInt(g.away_score, null);
    const homeScore = asInt(g.home_score, null);
    const winner =
      awayScore !== null && homeScore !== null && awayScore > homeScore ? awayDiscord :
      awayScore !== null && homeScore !== null && homeScore > awayScore ? homeDiscord : null;
    const key = stableGameKey({ recSeasonId: ctx.recSeasonId, weekNumber, awayTeamId, homeTeamId, awayDiscord, homeDiscord, eaScheduleId: asText(g.processed_game_id) });
    await db.execute(sql`
      insert into rec_league_games (
        rec_league_id, rec_season_id, legacy_season_id, guild_id, legacy_franchise_schedule_id, processed_game_id, stable_game_key, week_type, week_number, week_index,
        away_team_id, home_team_id, away_team_name, home_team_name, away_discord_id, home_discord_id, away_score, home_score,
        winner_discord_id, imported_winner_discord_id, status, is_h2h, source_priority, source, confidence_score, imported_at, updated_at
      ) values (
        ${ctx.recLeagueId}, ${ctx.recSeasonId}, ${ctx.legacySeasonId}, ${ctx.guildId}, ${g.id}, ${asText(g.processed_game_id)}, ${key}, 'regular', ${weekNumber}, ${weekNumber},
        ${awayTeamId}, ${homeTeamId}, ${String(g.away_team_name ?? away?.full_name ?? 'Away')}, ${String(g.home_team_name ?? home?.full_name ?? 'Home')}, ${awayDiscord}, ${homeDiscord}, ${awayScore}, ${homeScore},
        ${winner}, ${winner}, ${winner ? 'finished' : 'scheduled'}, ${Boolean(awayDiscord && homeDiscord)}, 60, 'legacy_franchise_schedule_backfill', ${winner ? 85 : 55}, now(), now()
      )
      on conflict (rec_season_id, stable_game_key) do update set
        legacy_franchise_schedule_id = coalesce(rec_league_games.legacy_franchise_schedule_id, excluded.legacy_franchise_schedule_id),
        processed_game_id = coalesce(rec_league_games.processed_game_id, excluded.processed_game_id),
        away_score = coalesce(rec_league_games.away_score, excluded.away_score),
        home_score = coalesce(rec_league_games.home_score, excluded.home_score),
        winner_discord_id = coalesce(rec_league_games.winner_discord_id, excluded.winner_discord_id),
        imported_winner_discord_id = coalesce(rec_league_games.imported_winner_discord_id, excluded.imported_winner_discord_id),
        status = case when excluded.status = 'finished' then 'finished' else rec_league_games.status end,
        updated_at = now()
    `);
    franchiseSchedules++;
  }

  return { gameSchedules, franchiseSchedules };
}
