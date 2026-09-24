-- =============================================================================
-- Migration: 20260501000004_realtime_clubs.sql
-- Adds the clubs table to the Supabase Realtime publication so that club
-- setting changes (e.g. blind_voting toggled mid-meeting) propagate instantly
-- to all members on the meeting page without a refresh.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'clubs'
  ) then
    alter publication supabase_realtime add table clubs;
  end if;
end
$$;
