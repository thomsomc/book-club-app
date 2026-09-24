-- =============================================================================
-- Migration: 20260501000010_fix_offerings_left_join.sql
--
-- Fixes missing offerings in the catalog caused by INNER JOINs on memberships
-- and users. Any offering brought by a former member whose membership has been
-- soft-deleted (deleted_at IS NOT NULL) was silently excluded because the INNER
-- JOIN found no matching row. For a club with 15+ years of history this drops
-- a significant portion of the catalog.
--
-- Fix: LEFT JOIN memberships and users so contributions from departed members
-- still appear. The contributor_name simply comes back as null in those cases,
-- which the frontend already handles gracefully.
-- =============================================================================


-- =============================================================================
-- RPC: get_club_offerings  (left-join fix)
-- =============================================================================
create or replace function get_club_offerings(p_club_id uuid)
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
  contributors    text[]
)
language plpgsql security definer as $$
begin
  if not exists (
    select 1 from memberships
    where club_id  = p_club_id
      and user_id  = auth.uid()
      and status   = 'active'
      and deleted_at is null
  ) then
    raise exception 'You are not an active member of this club';
  end if;

  return query
  with contrib_stats as (
    select
      o.id              as offering_id,
      o.name            as offering_name,
      o.producer        as offering_producer,
      o.style           as offering_style,
      o.abv             as offering_abv,
      o.category        as offering_category,
      o.external_id     as offering_external_id,
      c.composite_score,
      m.held_at,
      -- Left-join so former members' contributions aren't silently dropped;
      -- display_name is null when the membership or user no longer exists.
      u.display_name    as contributor_name
    from offerings      o
    join contributions  c  on c.offering_id = o.id and c.deleted_at is null
    join meetings       m  on m.id = c.meeting_id  and m.deleted_at is null
    left join memberships  mb on mb.id = c.contributor_id  -- no deleted_at filter
    left join users        u  on u.id  = mb.user_id
    where o.club_id    = p_club_id
      and o.deleted_at is null
  )
  select
    cs.offering_id,
    cs.offering_name,
    cs.offering_producer,
    cs.offering_style,
    cs.offering_abv,
    cs.offering_category,
    cs.offering_external_id,
    count(*)::integer                                                as times_brought,
    round(avg(cs.composite_score)::numeric, 2)                      as avg_score,
    round(max(cs.composite_score)::numeric, 2)                      as best_score,
    max(cs.held_at)                                                  as last_brought_at,
    array_agg(distinct cs.contributor_name)
      filter (where cs.contributor_name is not null)                 as contributors
  from contrib_stats cs
  group by
    cs.offering_id,
    cs.offering_name,
    cs.offering_producer,
    cs.offering_style,
    cs.offering_abv,
    cs.offering_category,
    cs.offering_external_id
  order by max(cs.held_at) desc;
end;
$$;


-- =============================================================================
-- RPC: get_public_offerings  (left-join fix)
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
  contributors    text[]
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

  v_mask := coalesce(nullif(v_club.settings->>'offerings_name_mask', ''), 'hidden');

  return query
  with contrib_stats as (
    select
      o.id              as offering_id,
      o.name            as offering_name,
      o.producer        as offering_producer,
      o.style           as offering_style,
      o.abv             as offering_abv,
      o.category        as offering_category,
      o.external_id     as offering_external_id,
      c.composite_score,
      m.held_at,
      _mask_display_name(u.display_name, v_mask) as contributor_name
    from offerings      o
    join contributions  c  on c.offering_id = o.id and c.deleted_at is null
    join meetings       m  on m.id = c.meeting_id  and m.deleted_at is null
    left join memberships  mb on mb.id = c.contributor_id
    left join users        u  on u.id  = mb.user_id
    where o.club_id    = v_club.id
      and o.deleted_at is null
  )
  select
    cs.offering_id,
    cs.offering_name,
    cs.offering_producer,
    cs.offering_style,
    cs.offering_abv,
    cs.offering_category,
    cs.offering_external_id,
    count(*)::integer                                                as times_brought,
    round(avg(cs.composite_score)::numeric, 2)                      as avg_score,
    round(max(cs.composite_score)::numeric, 2)                      as best_score,
    max(cs.held_at)                                                  as last_brought_at,
    array_agg(distinct cs.contributor_name)
      filter (where cs.contributor_name is not null)                 as contributors
  from contrib_stats cs
  group by
    cs.offering_id,
    cs.offering_name,
    cs.offering_producer,
    cs.offering_style,
    cs.offering_abv,
    cs.offering_category,
    cs.offering_external_id
  order by max(cs.held_at) desc;
end;
$$;

grant execute on function get_public_offerings(text) to anon;
