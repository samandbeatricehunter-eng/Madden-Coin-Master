import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getOrCreateActiveSeason } from "../db/db-helpers.js";

async function rowsOf<T = any>(q: any): Promise<T[]> {
  const result = await db.execute(q);
  return ((result as any).rows ?? result) as T[];
}

export async function ensureRecSeasonMappingsSchema(): Promise<void> {
  await db.execute(sql`
    create table if not exists rec_season_mappings (
      id bigserial primary key,
      guild_id text not null,
      season_id integer not null references seasons(id) on delete cascade,
      season_number integer,
      rec_season_id bigint not null,
      source text not null default 'auto',
      confidence_score integer not null default 100,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (guild_id, season_id, rec_season_id)
    )
  `);
  await db.execute(sql`create index if not exists idx_rec_season_mappings_guild_season on rec_season_mappings(guild_id, season_id)`).catch(() => null);
  await db.execute(sql`create index if not exists idx_rec_season_mappings_guild_rec_season on rec_season_mappings(guild_id, rec_season_id)`).catch(() => null);
}

export async function resolveActiveSeasonContext(guildId: string): Promise<{
  seasonId: number;
  seasonNumber: number | null;
  currentWeek: string | null;
  recSeasonIds: number[];
}> {
  await ensureRecSeasonMappingsSchema();
  const activeSeason = await getOrCreateActiveSeason(guildId);
  const seasonId = Number(activeSeason.id);
  const seasonNumber = Number((activeSeason as any).seasonNumber ?? (activeSeason as any).season_number ?? NaN);
  const currentWeek = String((activeSeason as any).currentWeek ?? (activeSeason as any).current_week ?? "") || null;

  let mapped = await rowsOf<{ rec_season_id: number }>(sql`
    select rec_season_id
    from rec_season_mappings
    where guild_id=${guildId}
      and season_id=${seasonId}
    order by confidence_score desc, updated_at desc
  `).catch(() => []);

  if (!mapped.length) {
    const candidates = await rowsOf<{ rec_season_id: number }>(sql`
      select rec_season_id
      from rec_league_games
      where guild_id=${guildId}
        and rec_season_id is not null
      group by rec_season_id
      order by
        count(*) filter (where is_h2h=true and status='scheduled') desc,
        max(imported_at) desc nulls last,
        rec_season_id desc
      limit 1
    `).catch(() => []);

    for (const row of candidates) {
      await db.execute(sql`
        insert into rec_season_mappings (guild_id, season_id, season_number, rec_season_id, source, confidence_score)
        values (${guildId}, ${seasonId}, ${Number.isFinite(seasonNumber) ? seasonNumber : null}, ${row.rec_season_id}, 'auto_resolved', 90)
        on conflict (guild_id, season_id, rec_season_id) do update set
          updated_at=now(),
          confidence_score=greatest(rec_season_mappings.confidence_score, excluded.confidence_score)
      `).catch(() => null);
    }
    mapped = candidates;
  }

  return {
    seasonId,
    seasonNumber: Number.isFinite(seasonNumber) ? seasonNumber : null,
    currentWeek,
    recSeasonIds: [...new Set(mapped.map((r) => Number(r.rec_season_id)).filter(Number.isFinite))],
  };
}

export async function resolvePanelRecSeasonIds(row: { guild_id: string; season_id: number; away_discord_id?: string | null; home_discord_id?: string | null; week_index?: number | null }): Promise<number[]> {
  await ensureRecSeasonMappingsSchema();
  let mapped = await rowsOf<{ rec_season_id: number }>(sql`
    select rec_season_id
    from rec_season_mappings
    where guild_id=${row.guild_id}
      and season_id=${row.season_id}
    order by confidence_score desc, updated_at desc
  `).catch(() => []);

  if (!mapped.length && row.away_discord_id && row.home_discord_id) {
    mapped = await rowsOf<{ rec_season_id: number }>(sql`
      select rec_season_id
      from rec_league_games
      where guild_id=${row.guild_id}
        and is_h2h=true
        and rec_season_id is not null
        and (
          (away_discord_id=${row.away_discord_id} and home_discord_id=${row.home_discord_id})
          or
          (away_discord_id=${row.home_discord_id} and home_discord_id=${row.away_discord_id})
        )
      group by rec_season_id
      order by
        count(*) filter (where abs(week_index - ${Number(row.week_index ?? 0)}) <= 2) desc,
        max(imported_at) desc nulls last,
        rec_season_id desc
      limit 1
    `).catch(() => []);

    for (const rec of mapped) {
      await db.execute(sql`
        insert into rec_season_mappings (guild_id, season_id, rec_season_id, source, confidence_score)
        values (${row.guild_id}, ${row.season_id}, ${rec.rec_season_id}, 'auto_panel_lookup', 90)
        on conflict (guild_id, season_id, rec_season_id) do update set
          updated_at=now(),
          confidence_score=greatest(rec_season_mappings.confidence_score, excluded.confidence_score)
      `).catch(() => null);
    }
  }

  return [...new Set(mapped.map((r) => Number(r.rec_season_id)).filter(Number.isFinite))];
}
