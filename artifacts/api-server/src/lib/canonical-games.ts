import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createHash } from "crypto";

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
function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function normIdentityPart(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function canonicalPairKey(a: unknown, b: unknown): string {
  const parts = [normIdentityPart(a), normIdentityPart(b)].sort();
  return `${parts[0]}:${parts[1]}`;
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
  await db.execute(sql`alter table rec_league_games add column if not exists identity_key text`);
  await db.execute(sql`alter table rec_league_games add column if not exists source_hash text`);
  await db.execute(sql`alter table rec_league_games add column if not exists last_import_job_id bigint`);
  await db.execute(sql`
    create unique index if not exists rec_league_games_rec_season_stable_key_idx
    on rec_league_games(rec_season_id, stable_game_key)
    where stable_game_key is not null
  `);
  await db.execute(sql`
    create unique index if not exists rec_league_games_rec_season_identity_key_idx
    on rec_league_games(rec_season_id, identity_key)
    where identity_key is not null
  `);
  await db.execute(sql`
    create table if not exists rec_import_jobs (
      id bigserial primary key,
      guild_id text not null,
      ea_league_id bigint,
      import_type text not null,
      week_type text,
      week_number integer,
      stage text not null default 'started',
      status text not null default 'running',
      rows_received integer not null default 0,
      rows_upserted integer not null default 0,
      h2h_rows integer not null default 0,
      payload_hash text,
      error_message text,
      debug_json jsonb not null default '{}'::jsonb,
      created_by_discord_id text,
      started_at timestamptz not null default now(),
      finished_at timestamptz
    )
  `);
  await db.execute(sql`alter table rec_import_jobs add column if not exists stage text not null default 'started'`).catch(() => null);
  await db.execute(sql`alter table rec_import_jobs add column if not exists debug_json jsonb not null default '{}'::jsonb`).catch(() => null);
  await db.execute(sql`alter table rec_import_jobs add column if not exists created_by_discord_id text`).catch(() => null);
  await db.execute(sql`create index if not exists idx_rec_import_jobs_guild_created on rec_import_jobs(guild_id, created_at desc)`).catch(() => null);

  await db.execute(sql`
    create table if not exists rec_import_payloads (
      id bigserial primary key,
      import_job_id bigint references rec_import_jobs(id) on delete cascade,
      guild_id text not null,
      payload_type text not null,
      payload_hash text not null,
      raw_json jsonb not null,
      created_at timestamptz not null default now()
    )
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


type CanonicalGameInput = {
  recLeagueId: number;
  recSeasonId: number;
  legacySeasonId: number;
  guildId: string;
  stableGameKey: string;
  weekType: string;
  weekNumber: number;
  weekIndex: number | null;
  awayTeamId: number | null;
  homeTeamId: number | null;
  awayTeamName: string;
  homeTeamName: string;
  awayDiscordId: string | null;
  homeDiscordId: string | null;
  awayScore: number | null;
  homeScore: number | null;
  winnerDiscordId: string | null;
  importedWinnerDiscordId: string | null;
  status: string;
  isH2h: boolean;
  sourcePriority: number;
  source: string;
  confidenceScore: number;
  importedAtSql?: any;
  legacyGameScheduleId?: number | null;
  legacyFranchiseScheduleId?: number | null;
  eaScheduleId?: string | null;
  processedGameId?: string | null;
  identityKey?: string | null;
  sourceHash?: string | null;
  importJobId?: number | null;
};

async function upsertCanonicalGameByIdentity(input: CanonicalGameInput): Promise<boolean> {
  const updated = await rowsOf<{ id: number }>(sql`
    update rec_league_games
    set
      guild_id = coalesce(rec_league_games.guild_id, ${input.guildId}),
      legacy_season_id = coalesce(rec_league_games.legacy_season_id, ${input.legacySeasonId}),
      rec_league_id = coalesce(rec_league_games.rec_league_id, ${input.recLeagueId}),
      stable_game_key = coalesce(rec_league_games.stable_game_key, ${input.stableGameKey}),
      identity_key = coalesce(rec_league_games.identity_key, ${input.identityKey ?? null}),
      source_hash = coalesce(${input.sourceHash ?? null}, rec_league_games.source_hash),
      last_import_job_id = coalesce(${input.importJobId ?? null}, rec_league_games.last_import_job_id),
      legacy_game_schedule_id = coalesce(rec_league_games.legacy_game_schedule_id, ${input.legacyGameScheduleId ?? null}),
      legacy_franchise_schedule_id = coalesce(rec_league_games.legacy_franchise_schedule_id, ${input.legacyFranchiseScheduleId ?? null}),
      ea_schedule_id = coalesce(rec_league_games.ea_schedule_id, ${input.eaScheduleId ?? null}),
      processed_game_id = coalesce(rec_league_games.processed_game_id, ${input.processedGameId ?? null}),
      week_type = coalesce(rec_league_games.week_type, ${input.weekType}),
      week_index = coalesce(rec_league_games.week_index, ${input.weekIndex}),
      away_team_id = coalesce(rec_league_games.away_team_id, ${input.awayTeamId}),
      home_team_id = coalesce(rec_league_games.home_team_id, ${input.homeTeamId}),
      away_team_name = coalesce(nullif(rec_league_games.away_team_name, ''), ${input.awayTeamName}),
      home_team_name = coalesce(nullif(rec_league_games.home_team_name, ''), ${input.homeTeamName}),
      away_discord_id = coalesce(rec_league_games.away_discord_id, ${input.awayDiscordId}),
      home_discord_id = coalesce(rec_league_games.home_discord_id, ${input.homeDiscordId}),
      away_score = coalesce(${input.awayScore}, rec_league_games.away_score),
      home_score = coalesce(${input.homeScore}, rec_league_games.home_score),
      winner_discord_id = coalesce(${input.winnerDiscordId}, rec_league_games.winner_discord_id),
      imported_winner_discord_id = coalesce(${input.importedWinnerDiscordId}, rec_league_games.imported_winner_discord_id),
      status = case when ${input.status} = 'finished' then 'finished' else coalesce(rec_league_games.status, ${input.status}) end,
      is_h2h = coalesce(rec_league_games.is_h2h, false) or ${input.isH2h},
      source_priority = greatest(coalesce(rec_league_games.source_priority, 0), ${input.sourcePriority}),
      confidence_score = greatest(coalesce(rec_league_games.confidence_score, 0), ${input.confidenceScore}),
      imported_at = coalesce(rec_league_games.imported_at, now()),
      updated_at = now()
    where rec_league_id = ${input.recLeagueId}
      and rec_season_id = ${input.recSeasonId}
      and (
        (identity_key is not null and identity_key = ${input.identityKey ?? null})
        or (stable_game_key is not null and stable_game_key = ${input.stableGameKey})
        or (
          week_number = ${input.weekNumber}
          and coalesce(least(away_discord_id, home_discord_id), away_team_name) =
              coalesce(least(${input.awayDiscordId}, ${input.homeDiscordId}), ${input.awayTeamName})
          and coalesce(greatest(away_discord_id, home_discord_id), home_team_name) =
              coalesce(greatest(${input.awayDiscordId}, ${input.homeDiscordId}), ${input.homeTeamName})
        )
      )
    returning id
  `);

  if (updated.length > 0) return false;

  const inserted = await rowsOf<{ id: number }>(sql`
    insert into rec_league_games (
      rec_league_id, rec_season_id, legacy_season_id, guild_id,
      legacy_game_schedule_id, legacy_franchise_schedule_id, ea_schedule_id, processed_game_id,
      stable_game_key, identity_key, source_hash, last_import_job_id, week_type, week_number, week_index,
      away_team_id, home_team_id, away_team_name, home_team_name,
      away_discord_id, home_discord_id, away_score, home_score,
      winner_discord_id, imported_winner_discord_id, status, is_h2h,
      source_priority, source, confidence_score, imported_at, updated_at
    )
    select
      ${input.recLeagueId}, ${input.recSeasonId}, ${input.legacySeasonId}, ${input.guildId},
      ${input.legacyGameScheduleId ?? null}, ${input.legacyFranchiseScheduleId ?? null}, ${input.eaScheduleId ?? null}, ${input.processedGameId ?? null},
      ${input.stableGameKey}, ${input.identityKey ?? null}, ${input.sourceHash ?? null}, ${input.importJobId ?? null}, ${input.weekType}, ${input.weekNumber}, ${input.weekIndex},
      ${input.awayTeamId}, ${input.homeTeamId}, ${input.awayTeamName}, ${input.homeTeamName},
      ${input.awayDiscordId}, ${input.homeDiscordId}, ${input.awayScore}, ${input.homeScore},
      ${input.winnerDiscordId}, ${input.importedWinnerDiscordId}, ${input.status}, ${input.isH2h},
      ${input.sourcePriority}, ${input.source}, ${input.confidenceScore}, now(), now()
    where not exists (
      select 1 from rec_league_games g
      where g.rec_league_id = ${input.recLeagueId}
        and g.rec_season_id = ${input.recSeasonId}
        and (
          (g.identity_key is not null and g.identity_key = ${input.identityKey ?? null})
          or (g.stable_game_key is not null and g.stable_game_key = ${input.stableGameKey})
          or (
            g.week_number = ${input.weekNumber}
            and coalesce(least(g.away_discord_id, g.home_discord_id), g.away_team_name) =
                coalesce(least(${input.awayDiscordId}, ${input.homeDiscordId}), ${input.awayTeamName})
            and coalesce(greatest(g.away_discord_id, g.home_discord_id), g.home_team_name) =
                coalesce(greatest(${input.awayDiscordId}, ${input.homeDiscordId}), ${input.homeTeamName})
          )
        )
    )
    and not exists (
      select 1 from rec_league_games g
      where g.stable_game_key = ${input.stableGameKey}
    )
    returning id
  `);

  return inserted.length > 0;
}

export async function syncCanonicalGamesFromSchedulePayload(
  body: unknown,
  weekNum: number,
  weekType: string,
  eaLeagueId: number,
  guildId?: string,
  existingImportJobId?: number | null,
): Promise<{ upserted: number; h2h: number; importJobId?: number | null }> {
  const ctx = await getCanonicalSeason(eaLeagueId, guildId);
  const games = extractList(body, "scheduleInfoList", "gameScheduleInfoList", "schedules");
  const teamMap = await loadTeamMap(ctx.legacySeasonId);
  const hash = payloadHash(body);
  let job: { id: number } | null = existingImportJobId ? { id: Number(existingImportJobId) } : null;
  if (!job?.id) {
    [job] = await rowsOf<{ id: number }>(sql`
      insert into rec_import_jobs (guild_id, ea_league_id, import_type, week_type, week_number, stage, status, rows_received, payload_hash)
      values (${ctx.guildId}, ${eaLeagueId}, 'schedule_payload', ${weekType}, ${weekNum}, 'schedule_writing', 'running', ${games.length}, ${hash})
      returning id
    `);
  } else {
    await db.execute(sql`
      update rec_import_jobs
      set stage='schedule_writing', status=case when status='failed' then status else 'running' end, rows_received=${games.length}, payload_hash=${hash}, updated_at=now()
      where id=${job.id}
    `).catch(() => null);
  }
  await db.execute(sql`
    insert into rec_import_payloads (import_job_id, guild_id, payload_type, payload_hash, raw_json)
    values (${job?.id ?? null}, ${ctx.guildId}, 'schedule_payload', ${hash}, ${JSON.stringify(body ?? null)}::jsonb)
  `).catch(() => null);

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
    const identityKey = eaScheduleId ? `ea:${eaScheduleId}` : `wk:${gameWeekNumber}:${canonicalPairKey(awayTeamId ?? awayDiscord ?? away?.full_name, homeTeamId ?? homeDiscord ?? home?.full_name)}`;

    await upsertCanonicalGameByIdentity({
      recLeagueId: ctx.recLeagueId,
      recSeasonId: ctx.recSeasonId,
      legacySeasonId: ctx.legacySeasonId,
      guildId: ctx.guildId,
      stableGameKey: key,
      identityKey,
      sourceHash: hash,
      importJobId: job?.id ?? null,
      eaScheduleId,
      weekType,
      weekNumber: gameWeekNumber,
      weekIndex: gameWeekNumber,
      awayTeamId,
      homeTeamId,
      awayTeamName: String(away?.full_name ?? away?.nick_name ?? g?.awayTeamName ?? `Team${awayTeamId}`),
      homeTeamName: String(home?.full_name ?? home?.nick_name ?? g?.homeTeamName ?? `Team${homeTeamId}`),
      awayDiscordId: awayDiscord,
      homeDiscordId: homeDiscord,
      awayScore,
      homeScore,
      winnerDiscordId: winner,
      importedWinnerDiscordId: winner,
      status: finished ? "finished" : "scheduled",
      isH2h: isH2H,
      sourcePriority: 100,
      source: "mca_schedule_import",
      confidenceScore: finished ? 100 : 80,
    });
    upserted++;
  }

  if (job?.id) {
    await db.execute(sql`
      update rec_import_jobs
      set stage='schedule_done', rows_upserted=${upserted}, h2h_rows=${h2h}, updated_at=now(),
          status=case when ${Boolean(existingImportJobId)} then status else 'completed' end,
          finished_at=case when ${Boolean(existingImportJobId)} then finished_at else now() end
      where id=${job.id}
    `).catch(() => null);
  }
  return { upserted, h2h, importJobId: job?.id ?? null };
}

export async function backfillCanonicalGamesFromLegacy(eaLeagueId: number, guildId?: string): Promise<{ gameSchedules: number; franchiseSchedules: number }> {
  const ctx = await getCanonicalSeason(eaLeagueId, guildId);

  const fromGameSchedules = await rowsOf<any>(sql`
    select id, week_index, away_discord_id, home_discord_id, away_team_name, home_team_name, away_score, home_score,
           winner_discord_id, imported_winner_discord_id, status
    from game_schedules
    where guild_id = ${ctx.guildId} and season_id = ${ctx.legacySeasonId}
  `).catch(() => [] as any[]);

  let gameSchedules = 0;
  for (const g of fromGameSchedules) {
    const weekNumber = asInt(g.week_index, 0)!;
    if (weekNumber <= 0) continue;
    const awayDiscord = asText(g.away_discord_id);
    const homeDiscord = asText(g.home_discord_id);
    const awayScore = asInt(g.away_score, null);
    const homeScore = asInt(g.home_score, null);
    const winner = asText(g.imported_winner_discord_id ?? g.winner_discord_id) ?? (
      awayScore !== null && homeScore !== null && awayScore > homeScore ? awayDiscord :
      awayScore !== null && homeScore !== null && homeScore > awayScore ? homeDiscord : null
    );
    const awayName = String(g.away_team_name ?? "Away");
    const homeName = String(g.home_team_name ?? "Home");
    const key = `legacy-gs:${ctx.recSeasonId}:${g.id}`;

    await upsertCanonicalGameByIdentity({
      recLeagueId: ctx.recLeagueId,
      recSeasonId: ctx.recSeasonId,
      legacySeasonId: ctx.legacySeasonId,
      guildId: ctx.guildId,
      legacyGameScheduleId: Number(g.id),
      stableGameKey: key,
      weekType: "regular",
      weekNumber,
      weekIndex: weekNumber,
      awayTeamId: null,
      homeTeamId: null,
      awayTeamName: awayName,
      homeTeamName: homeName,
      awayDiscordId: awayDiscord,
      homeDiscordId: homeDiscord,
      awayScore,
      homeScore,
      winnerDiscordId: winner,
      importedWinnerDiscordId: winner,
      status: String(g.status ?? "").toLowerCase() === "finished" || winner ? "finished" : "scheduled",
      isH2h: Boolean(awayDiscord && homeDiscord),
      sourcePriority: 70,
      source: "legacy_game_schedules_backfill",
      confidenceScore: winner ? 90 : 60,
    });
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

    await upsertCanonicalGameByIdentity({
      recLeagueId: ctx.recLeagueId,
      recSeasonId: ctx.recSeasonId,
      legacySeasonId: ctx.legacySeasonId,
      guildId: ctx.guildId,
      legacyFranchiseScheduleId: Number(g.id),
      processedGameId: asText(g.processed_game_id),
      stableGameKey: key,
      weekType: "regular",
      weekNumber,
      weekIndex: weekNumber,
      awayTeamId,
      homeTeamId,
      awayTeamName: String(g.away_team_name ?? away?.full_name ?? "Away"),
      homeTeamName: String(g.home_team_name ?? home?.full_name ?? "Home"),
      awayDiscordId: awayDiscord,
      homeDiscordId: homeDiscord,
      awayScore,
      homeScore,
      winnerDiscordId: winner,
      importedWinnerDiscordId: winner,
      status: winner ? "finished" : "scheduled",
      isH2h: Boolean(awayDiscord && homeDiscord),
      sourcePriority: 60,
      source: "legacy_franchise_schedule_backfill",
      confidenceScore: winner ? 85 : 55,
    });
    franchiseSchedules++;
  }

  return { gameSchedules, franchiseSchedules };
}
