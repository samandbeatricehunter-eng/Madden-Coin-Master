-- 0020_gameday_discord_stream_option.sql
-- Allows users to mark a game begun with Discord as the stream posting option.
-- External stream URLs remain supported; Discord can be stored without a URL.

alter table if exists gameday_matchup_status
  add column if not exists stream_platform text;

comment on column gameday_matchup_status.stream_platform is
  'Stream posting choice supplied when marking a game begun: discord, external, or null when no stream was posted.';

create index if not exists idx_gameday_matchup_status_stream_platform
  on gameday_matchup_status (guild_id, season_id, week_index, stream_platform);
