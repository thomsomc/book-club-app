-- =============================================================================
-- Migration: 20260501000012_public_club_rls.sql
--
-- Allows unauthenticated (anon) users to read clubs that have explicitly
-- opted into public visibility via settings->>'allow_public_offerings'.
-- Without this, the PublicOfferings page fetches the clubs table and gets
-- null back (RLS blocks it), showing "Club not found" for everyone.
--
-- Only clubs that have set allow_public_offerings = true are exposed.
-- Private clubs and deleted clubs remain invisible to anon users.
-- =============================================================================

create policy "Anon can read clubs with public offerings enabled"
  on clubs
  for select
  to anon
  using (
    deleted_at is null
    and (settings->>'allow_public_offerings')::boolean = true
  );
