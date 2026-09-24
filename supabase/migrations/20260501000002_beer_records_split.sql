-- =============================================================================
-- Migration: 20260501000002_beer_records_split.sql
--
-- Replaces get_beer_records with two focused functions:
--
--   get_best_beers(club_id, year?, min_votes?, limit?)
--     → top-N highest-scoring beers, best first
--
--   get_worst_beers(club_id, year?, min_votes?, limit?)
--     → top-N lowest-scoring beers, worst first
--
-- Both include meeting_rank and meeting_size so the UI can show how each
-- beer placed within its own meeting (e.g. "1st of 9").
--
-- meeting_rank uses RANK() across all scored contributions in the meeting,
-- not just the ones that appear in the result set — so a beer that came 3rd
-- in a 9-beer meeting always shows "3rd of 9" regardless of which list it's on.
-- =============================================================================

drop function if exists get_beer_records(uuid, int, int);


-- =============================================================================
-- get_best_beers
-- Returns the top p_limit highest-scoring qualifying contributions, best first.
-- =============================================================================
create or replace function get_best_beers(
  p_club_id   uuid,
  p_year      int  default null,
  p_min_votes int  default 3,
  p_limit     int  default 20
)
returns table (
  contribution_id  uuid,
  offering_name    text,
  producer         text,
  composite_score  numeric,
  contributor_name text,
  vote_count       bigint,
  held_at          timestamptz,
  meeting_number   integer,
  meeting_rank     bigint,
  meeting_size     bigint
)
language sql security definer stable as $$
  with
  scoped_meetings as (
    select id, held_at, meeting_number
    from   meetings
    where  club_id    = p_club_id
      and  status     = 'completed'
      and  deleted_at is null
      and  (p_year is null or extract(year from held_at)::int = p_year)
  ),
  -- Rank every scored contribution within its meeting.
  -- Computed across the full meeting, not just the qualified subset,
  -- so the rank always reflects true placement on the night.
  meeting_ranks as (
    select
      c.id,
      rank()  over (partition by c.meeting_id order by c.composite_score desc nulls last) as meeting_rank,
      count(*) over (partition by c.meeting_id)                                            as meeting_size
    from contributions c
    join scoped_meetings m on m.id = c.meeting_id
    where c.deleted_at      is null
      and c.composite_score is not null
  ),
  -- Contributions with enough non-self votes to qualify
  qualified as (
    select
      c.id,
      count(v.id) filter (where not v.is_self_vote) as non_self_votes
    from       contributions c
    join       scoped_meetings m on m.id = c.meeting_id
    left join  votes v
               on  v.contribution_id = c.id
               and v.deleted_at      is null
    where c.deleted_at      is null
      and c.composite_score is not null
    group  by c.id
    having count(v.id) filter (where not v.is_self_vote) >= p_min_votes
  )
  select
    c.id              as contribution_id,
    o.name            as offering_name,
    o.producer,
    c.composite_score,
    u.display_name    as contributor_name,
    q.non_self_votes  as vote_count,
    m.held_at,
    m.meeting_number,
    mr.meeting_rank,
    mr.meeting_size
  from       qualified      q
  join       contributions  c  on c.id  = q.id
  join       offerings      o  on o.id  = c.offering_id
  join       scoped_meetings m  on m.id  = c.meeting_id
  join       memberships    ms on ms.id  = c.contributor_id
  join       users          u  on u.id   = ms.user_id
  join       meeting_ranks  mr on mr.id  = c.id
  order by c.composite_score desc
  limit p_limit
$$;


-- =============================================================================
-- get_worst_beers
-- Returns the top p_limit lowest-scoring qualifying contributions, worst first.
-- Identical structure to get_best_beers — only the ORDER BY differs.
-- =============================================================================
create or replace function get_worst_beers(
  p_club_id   uuid,
  p_year      int  default null,
  p_min_votes int  default 3,
  p_limit     int  default 20
)
returns table (
  contribution_id  uuid,
  offering_name    text,
  producer         text,
  composite_score  numeric,
  contributor_name text,
  vote_count       bigint,
  held_at          timestamptz,
  meeting_number   integer,
  meeting_rank     bigint,
  meeting_size     bigint
)
language sql security definer stable as $$
  with
  scoped_meetings as (
    select id, held_at, meeting_number
    from   meetings
    where  club_id    = p_club_id
      and  status     = 'completed'
      and  deleted_at is null
      and  (p_year is null or extract(year from held_at)::int = p_year)
  ),
  meeting_ranks as (
    select
      c.id,
      rank()  over (partition by c.meeting_id order by c.composite_score desc nulls last) as meeting_rank,
      count(*) over (partition by c.meeting_id)                                            as meeting_size
    from contributions c
    join scoped_meetings m on m.id = c.meeting_id
    where c.deleted_at      is null
      and c.composite_score is not null
  ),
  qualified as (
    select
      c.id,
      count(v.id) filter (where not v.is_self_vote) as non_self_votes
    from       contributions c
    join       scoped_meetings m on m.id = c.meeting_id
    left join  votes v
               on  v.contribution_id = c.id
               and v.deleted_at      is null
    where c.deleted_at      is null
      and c.composite_score is not null
    group  by c.id
    having count(v.id) filter (where not v.is_self_vote) >= p_min_votes
  )
  select
    c.id              as contribution_id,
    o.name            as offering_name,
    o.producer,
    c.composite_score,
    u.display_name    as contributor_name,
    q.non_self_votes  as vote_count,
    m.held_at,
    m.meeting_number,
    mr.meeting_rank,
    mr.meeting_size
  from       qualified      q
  join       contributions  c  on c.id  = q.id
  join       offerings      o  on o.id  = c.offering_id
  join       scoped_meetings m  on m.id  = c.meeting_id
  join       memberships    ms on ms.id  = c.contributor_id
  join       users          u  on u.id   = ms.user_id
  join       meeting_ranks  mr on mr.id  = c.id
  order by c.composite_score asc
  limit p_limit
$$;
