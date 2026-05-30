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
);

create index if not exists idx_rec_season_mappings_guild_season on rec_season_mappings(guild_id, season_id);
create index if not exists idx_rec_season_mappings_guild_rec_season on rec_season_mappings(guild_id, rec_season_id);

insert into rec_season_mappings (guild_id, season_id, season_number, rec_season_id, source, confidence_score)
values
  ('1493688089883971735', 7, 2, 5, 'manual_audit_20260529', 100),
  ('1497423447192768612', 15, 2, 7, 'manual_audit_20260529', 100),
  ('1476251181524189438', 3, 3, 3, 'manual_audit_20260529', 100)
on conflict (guild_id, season_id, rec_season_id) do update set
  season_number = excluded.season_number,
  source = excluded.source,
  confidence_score = greatest(rec_season_mappings.confidence_score, excluded.confidence_score),
  updated_at = now();

create or replace view v_canonical_h2h_results as
select
  id as rec_game_id,
  guild_id,
  rec_season_id,
  week_type,
  week_number,
  week_index,
  away_discord_id,
  home_discord_id,
  away_team_name,
  home_team_name,
  away_score,
  home_score,
  coalesce(imported_winner_discord_id, winner_discord_id) as winner_discord_id,
  case
    when coalesce(imported_winner_discord_id, winner_discord_id) = away_discord_id then home_discord_id
    when coalesce(imported_winner_discord_id, winner_discord_id) = home_discord_id then away_discord_id
    when away_score > home_score then home_discord_id
    when home_score > away_score then away_discord_id
    else null
  end as loser_discord_id,
  abs(coalesce(away_score,0) - coalesce(home_score,0)) as point_diff_abs,
  source,
  import_generation,
  imported_at,
  created_at,
  updated_at,
  stable_game_key
from rec_league_games
where is_h2h = true
  and away_discord_id is not null
  and home_discord_id is not null
  and away_discord_id not like 'unlinked_%'
  and home_discord_id not like 'unlinked_%'
  and away_score is not null
  and home_score is not null
  and status in ('finished','completed','completed_pending_import');
