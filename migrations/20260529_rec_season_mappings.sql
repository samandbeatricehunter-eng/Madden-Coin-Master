-- Reconcile app season rows with canonical imported rec_league_games seasons.
-- seasons.id is an internal app season row id.
-- rec_league_games.rec_season_id is the canonical imported season generation id.
-- These are intentionally separate namespaces.

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

create index if not exists idx_rec_season_mappings_guild_season
  on rec_season_mappings (guild_id, season_id);

create index if not exists idx_rec_season_mappings_guild_rec_season
  on rec_season_mappings (guild_id, rec_season_id);

insert into rec_season_mappings (guild_id, season_id, season_number, rec_season_id, source, confidence_score)
select s.guild_id, s.id, s.season_number, x.rec_season_id, 'bootstrap_current_active', 100
from seasons s
join lateral (
  select r.rec_season_id
  from rec_league_games r
  where r.guild_id = s.guild_id
    and r.rec_season_id is not null
  group by r.rec_season_id
  order by
    count(*) filter (where r.is_h2h = true and r.status = 'scheduled') desc,
    max(r.imported_at) desc nulls last,
    r.rec_season_id desc
  limit 1
) x on true
where s.is_active = true
on conflict (guild_id, season_id, rec_season_id) do update set
  season_number = excluded.season_number,
  source = excluded.source,
  confidence_score = greatest(rec_season_mappings.confidence_score, excluded.confidence_score),
  updated_at = now();

-- Known mappings discovered during DB audit.
insert into rec_season_mappings (guild_id, season_id, season_number, rec_season_id, source, confidence_score)
values
  ('1493688089883971735', 7, 2, 5, 'manual_audit_20260529', 100),
  ('1497423447192768612', 15, 2, 7, 'manual_audit_20260529', 100),
  ('1476251181524189438', 3, 3, 3, 'manual_audit_20260529', 100)
on conflict (guild_id, season_id, rec_season_id) do update set
  season_number = excluded.season_number,
  source = excluded.source,
  confidence_score = 100,
  updated_at = now();
