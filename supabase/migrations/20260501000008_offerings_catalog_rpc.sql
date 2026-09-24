-- =============================================================================
-- Migration: 20260501000008_offerings_catalog_rpc.sql
--
-- Searchable offerings catalog for the "Beers" tab and public share URL.
--
-- 1. pg_trgm + GIN indexes on offerings.name and offerings.producer.
--    These aren't needed by the current client-side Fuse.js search, but they
--    make any future server-side ILIKE / similarity query instant, and are the
--    foundation for barcode/photo search (which will look up external IDs or
--    run text queries against the catalog).
--
-- 2. get_club_offerings(p_club_id) — authenticated path for club members.
--    Returns full contributor names. RLS check: caller must be an active member.
--
-- 3. get_public_offerings(p_slug) — public path for the share URL.
--    Only works when clubs.settings.allow_public_offerings = true.
--    Applies server-side name masking per clubs.settings.offerings_name_mask:
--      'hidden'           — no contributor shown
--      'initials'         — "M.T."
--      'first_last_initial' — "Matt T."
--      'full'             — full name (default when public but unmasked)
--    Callable by the anon role so no auth token is required.
-- =============================================================================


-- Fuzzy-search foundation for future server-side / barcode queries
create extension if not exists pg_trgm;

create index if not exists offerings_name_trgm_idx
  on offerings using gin(name gin_trgm_ops);

create index if not exists offerings_producer_trgm_idx
  on offerings using gin(coalesce(producer, '') gin_trgm_ops);


-- =============================================================================
-- Shared helper: mask a display_name string based on the club's setting.
-- Returns null when setting is 'hidden' so callers can filter it out.
-- =============================================================================
create or replace function _mask_display_name(p_name text, p_mask text)
returns text language sql immutable as $$
  select case p_mask
    when 'hidden' then
      null
    when 'initials' then
      -- "Matt Thomson" → "M.T."
      left(split_part(p_name, ' ', 1), 1) || '.' ||
      case when split_part(p_name, ' ', 2) <> ''
           then left(split_part(p_name, ' ', 2), 1) || '.'
           else '' end
    when 'first_last_initial' then
      -- "Matt Thomson" → "Matt T."
      split_part(p_name, ' ', 1) ||
      case when split_part(p_name, ' ', 2) <> ''
           then ' ' || left(split_part(p_name, ' ', 2), 1) || '.'
           else '' end
    else
      -- 'full' or any unrecognised value: show the name as-is
      p_name
  end
$$;


-- =============================================================================
-- RPC: get_club_offerings
-- Authenticated members view — full contributor names, no masking.
-- Returns one row per unique offering that was brought at least once.
-- Ordered by most-recently-brought first so fresh beers surface to the top.
-- =============================================================================
create or replace function get_club_offerings(p_club_id uuid)
returns table (
  id              uuid,
  name            text,
  producer        text,
  style           text,
  abv             numeric,
  category        text,
  external_id     text,    -- reserved for barcode / Open Brewery DB linkage
  times_brought   integer,
  avg_score       numeric,
  best_score      numeric,
  last_brought_at timestamptz,
  contributors    text[]   -- full display names
)
language plpgsql security definer as $$
begin
  -- Caller must be an active member of this club
  if not exists (
    select 1 from memberships
    where club_id = p_club_id
      and user_id = auth.uid()
      and status  = 'active'
      and deleted_at is null
  ) then
    raise exception 'You are not an active member of this club';
  end if;

  return query
  with contrib_stats as (
    -- One row per (offering × contributor), so we can aggregate both
    -- numerical stats and the contributor list in a single pass.
    select
      o.id                                              as offering_id,
      o.name,
      o.producer,
      o.style,
      o.abv,
      o.category,
      o.external_id,
      c.composite_score,
      m.held_at,
      u.display_name                                    as contributor_name
    from offerings o
    join contributions c  on c.offering_id = o.id and c.deleted_at is null
    join meetings     m   on m.id = c.meeting_id and m.deleted_at is null
    join memberships  mb  on mb.id = c.contributor_id and mb.deleted_at is null
    join users        u   on u.id = mb.user_id
    where o.club_id = p_club_id
      and o.deleted_at is null
  )
  select
    offering_id,
    name,
    producer,
    style,
    abv,
    category,
    external_id,
    count(*)::integer                                                   as times_brought,
    round(avg(composite_score)::numeric, 2)                            as avg_score,
    round(max(composite_score)::numeric, 2)                            as best_score,
    max(held_at)                                                        as last_brought_at,
    array_agg(distinct contributor_name)
      filter (where contributor_name is not null)                       as contributors
  from contrib_stats
  group by offering_id, name, producer, style, abv, category, external_id
  order by max(held_at) desc;
end;
$$;


-- =============================================================================
-- RPC: get_public_offerings
-- Public path — no auth required, but club must opt in.
-- Applies server-side name masking so raw names never leave the database
-- for public requests (even if the JS bundle is inspected).
-- =============================================================================
create or replace function get_public_offerings(p_slug text)
returns table (
  id              uuid,
  name            text,
  producer        text,
  style           text,
  abv             numeric,
  category        text,
  external_id     text,
  times_brought   integer,
  avg_score       numeric,
  best_score      numeric,
  last_brought_at timestamptz,
  contributors    text[]   -- masked per offerings_name_mask setting
)
language plpgsql security definer as $$
declare
  v_club clubs;
  v_mask text;
begin
  select * into v_club from clubs where slug = p_slug and deleted_at is null;
  if not found then raise exception 'Club not found'; end if;

  if not coalesce((v_club.settings->>'allow_public_offerings')::boolean, false) then
    raise exception 'This club''s offerings list is not publicly accessible';
  end if;

  -- Default mask when unset: hide names (safest public default)
  v_mask := coalesce(nullif(v_club.settings->>'offerings_name_mask', ''), 'hidden');

  return query
  with contrib_stats as (
    select
      o.id                                                              as offering_id,
      o.name,
      o.producer,
      o.style,
      o.abv,
      o.category,
      o.external_id,
      c.composite_score,
      m.held_at,
      _mask_display_name(u.display_name, v_mask)                       as contributor_name
    from offerings o
    join contributions c  on c.offering_id = o.id and c.deleted_at is null
    join meetings     m   on m.id = c.meeting_id and m.deleted_at is null
    join memberships  mb  on mb.id = c.contributor_id and mb.deleted_at is null
    join users        u   on u.id = mb.user_id
    where o.club_id = v_club.id
      and o.deleted_at is null
  )
  select
    offering_id,
    name,
    producer,
    style,
    abv,
    category,
    external_id,
    count(*)::integer                                                   as times_brought,
    round(avg(composite_score)::numeric, 2)                            as avg_score,
    round(max(composite_score)::numeric, 2)                            as best_score,
    max(held_at)                                                        as last_brought_at,
    array_agg(distinct contributor_name)
      filter (where contributor_name is not null)                       as contributors
  from contrib_stats
  group by offering_id, name, producer, style, abv, category, external_id
  order by max(held_at) desc;
end;
$$;

-- Allow unauthenticated (anon) callers to invoke the public RPC
grant execute on function get_public_offerings(text) to anon;
grant execute on function _mask_display_name(text, text) to anon;
