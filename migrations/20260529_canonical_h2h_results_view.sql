-- Canonical completed H2H result view sourced only from rec_league_games.
-- This is the future source for competitive rating, records, power rankings, and H2H history.

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
