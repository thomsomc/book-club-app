-- =============================================================================
-- Migration: 20260501000011_offerings_return_json.sql
--
-- Changes get_club_offerings and get_public_offerings to return jsonb instead
-- of RETURNS TABLE. PostgREST applies its max_rows cap (default 1,000) to
-- set-returning functions, silently truncating large catalogs. Returning a
-- single jsonb array bypasses that cap entirely since PostgREST sees one row.
-- =============================================================================


-- Drop old RETURNS TABLE versions so we can change the return type to jsonb.
-- CREATE OR REPLACE cannot change a function's return type.
drop function if exists get_club_offerings(uuid);
drop function if exists get_public_offerings(text);


-- =============================================================================
-- RPC: get_club_offerings  (returns jsonb)
-- =============================================================================
create or replace function get_club_offerings(p_club_id uuid)
returns jsonb
language plpgsql security definer as $$
declare
  v_result jsonb;
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

  select jsonb_agg(to_jsonb(r))
  into v_result
  from (
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
        u.display_name    as contributor_name
      from offerings      o
      join contributions  c  on c.offering_id = o.id and c.deleted_at is null
      join meetings       m  on m.id = c.meeting_id  and m.deleted_at is null
      left join memberships  mb on mb.id = c.contributor_id
      left join users        u  on u.id  = mb.user_id
      where o.club_id    = p_club_id
        and o.deleted_at is null
    )
    select
      cs.offering_id                                                    as id,
      cs.offering_name                                                  as name,
      cs.offering_producer                                              as producer,
      cs.offering_style                                                 as style,
      cs.offering_abv                                                   as abv,
      cs.offering_category                                              as category,
      cs.offering_external_id                                           as external_id,
      count(*)::integer                                                 as times_brought,
      round(avg(cs.composite_score)::numeric, 2)                       as avg_score,
      round(max(cs.composite_score)::numeric, 2)                       as best_score,
      max(cs.held_at)                                                   as last_brought_at,
      array_agg(distinct cs.contributor_name)
        filter (where cs.contributor_name is not null)                  as contributors
    from contrib_stats cs
    group by
      cs.offering_id,
      cs.offering_name,
      cs.offering_producer,
      cs.offering_style,
      cs.offering_abv,
      cs.offering_category,
      cs.offering_external_id
    order by max(cs.held_at) desc
  ) r;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;


-- =============================================================================
-- RPC: get_public_offerings  (returns jsonb)
-- =============================================================================
create or replace function get_public_offerings(p_slug text)
returns jsonb
language plpgsql security definer as $$
declare
  v_club   clubs;
  v_mask   text;
  v_result jsonb;
begin
  select * into v_club from clubs where slug = p_slug and deleted_at is null;
  if not found then raise exception 'Club not found'; end if;

  if not coalesce((v_club.settings->>'allow_public_offerings')::boolean, false) then
    raise exception 'This club''s offerings list is not publicly accessible';
  end if;

  v_mask := coalesce(nullif(v_club.settings->>'offerings_name_mask', ''), 'hidden');

  select jsonb_agg(to_jsonb(r))
  into v_result
  from (
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
      cs.offering_id                                                    as id,
      cs.offering_name                                                  as name,
      cs.offering_producer                                              as producer,
      cs.offering_style                                                 as style,
      cs.offering_abv                                                   as abv,
      cs.offering_category                                              as category,
      cs.offering_external_id                                           as external_id,
      count(*)::integer                                                 as times_brought,
      round(avg(cs.composite_score)::numeric, 2)                       as avg_score,
      round(max(cs.composite_score)::numeric, 2)                       as best_score,
      max(cs.held_at)                                                   as last_brought_at,
      array_agg(distinct cs.contributor_name)
        filter (where cs.contributor_name is not null)                  as contributors
    from contrib_stats cs
    group by
      cs.offering_id,
      cs.offering_name,
      cs.offering_producer,
      cs.offering_style,
      cs.offering_abv,
      cs.offering_category,
      cs.offering_external_id
    order by max(cs.held_at) desc
  ) r;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

grant execute on function get_public_offerings(text) to anon;
