-- =============================================================================
-- Migration: 20260501000000_realtime_meetings.sql
-- Adds the meetings table to the Supabase Realtime publication so that when
-- a host starts or ends a meeting, all members viewing that meeting page
-- instantly see the status change without needing to refresh.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'meetings'
  ) then
    alter publication supabase_realtime add table meetings;
  end if;
end
$$;
