create table if not exists rec_competitive_ratings_cache (
  guild_id text not null,
  season_id integer not null,
  discord_id text not null,
  display_name text not null default '',
  team text,
  competitive_rating integer not null default 50,
  rating_rank integer,
  strength_of_schedule numeric(6,2),
  schedule_rank integer,
  h2h_games integer not null default 0,
  h2h_schedule_games integer not null default 0,
  label text not null default 'No H2H Opponents — easiest schedule possible.',
  computed_at timestamptz not null default now(),
  primary key (guild_id, season_id, discord_id)
);

create index if not exists rec_comp_ratings_rating_idx
  on rec_competitive_ratings_cache (guild_id, season_id, competitive_rating desc);

create index if not exists rec_comp_ratings_sos_idx
  on rec_competitive_ratings_cache (guild_id, season_id, strength_of_schedule desc);
