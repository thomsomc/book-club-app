-- =============================================================================
-- Migration: 20260501000001_stats_rpcs.sql
--
-- Server-side aggregation functions for the Stats / Leaderboard page.
-- All heavy computation stays in PostgreSQL — the client receives only the
-- final results, keeping payloads tiny and row-limit concerns irrelevant.
--
-- Functions (all accept an optional year filter; null = all time):
--
--   get_member_stats(club_id, year?)
--     → leaderboard: wins, avg composite score, total beers contributed
--
--   get_nostradamus_stats(club_id, year?, min_votes?)
--     → voter accuracy: avg absolute delta from group consensus, sorted
--       closest first so row 0 = Nostradamus, last row = Nostradumbass
--
--   get_beer_records(club_id, year?, min_votes?)
--     → every qualifying contribution sorted best→worst; caller takes
--       first row for "Best Beer" and last row for "Worst Beer"
-- =============================================================================


-- =============================================================================
-- get_member_stats
--
-- Returns one row per member who contributed at least once in the period.
-- avg_composite is NULL for members below the 5-beer minimum so the UI
-- can omit that column for them without special-casing the value.
-- Wins honour ties — all contributors at the top score share the win.
-- =============================================================================
create or replace function get_member_stats(
  p_club_id  uuid,
  p_year     int  default null
)
returns table (
  membership_id      uuid,
  display_name       text,
  wins               bigint,
  contribution_count bigint,
  avg_composite      numeric
)
language sql security definer stable as $$
  with

  -- Scope: only completed meetings in the requested year (or all time)
  scoped_meetings as (
    select id, counts_for_record
    from   meetings
    where  club_id    = p_club_id
      and  status     = 'completed'
      and  deleted_at is null
      and  (p_year is null or extract(year from held_at)::int = p_year)
  ),

  -- For each record-counting meeting, the highest composite score achieved
  meeting_top_scores as (
    select c.meeting_id, max(c.composite_score) as top_score
    from   contributions c
    join   scoped_meetings m on m.id = c.meeting_id
    where  m.counts_for_record = true
      and  c.deleted_at        is null
      and  c.composite_score   is not null
    group  by c.meeting_id
  ),

  -- Every contribution that tied for the top score in its meeting
  -- (multiple winners are allowed — they each get a win)
  winning_contributions as (
    select c.contributor_id
    from   contributions c
    join   meeting_top_scores mts
           on  mts.meeting_id = c.meeting_id
           and mts.top_score  = c.composite_score
    where  c.deleted_at is null
  ),

  -- Win tally per member
  win_counts as (
    select contributor_id, count(*) as wins
    from   winning_contributions
    group  by contributor_id
  ),

  -- Total contributions and average composite score per member.
  -- avg() ignores NULLs natively, so unscored contributions don't skew the mean.
  contrib_stats as (
    select
      c.contributor_id,
      count(*)               as contribution_count,
      avg(c.composite_score) as avg_score
    from contributions c
    join scoped_meetings m on m.id = c.meeting_id
    where c.deleted_at is null
    group by c.contributor_id
  )

  select
    ms.id                                      as membership_id,
    u.display_name,
    coalesce(wc.wins, 0)                       as wins,
    coalesce(cs.contribution_count, 0)         as contribution_count,
    -- Suppress avg for members below the minimum contribution threshold
    -- so one-off appearances don't top the avg-score leaderboard
    case
      when coalesce(cs.contribution_count, 0) >= 5
      then round(cs.avg_score::numeric, 2)
    end                                        as avg_composite
  from       memberships  ms
  join       users        u  on u.id  = ms.user_id
  left join  win_counts   wc on wc.contributor_id = ms.id
  left join  contrib_stats cs on cs.contributor_id = ms.id
  where ms.club_id    = p_club_id
    and ms.deleted_at is null
    -- Only members who actually contributed in this period
    and (wc.contributor_id is not null or cs.contributor_id is not null)
  order by wins desc nulls last, avg_composite desc nulls last
$$;


-- =============================================================================
-- get_nostradamus_stats
--
-- For every non-self vote cast in the period, computes the absolute difference
-- between the voter's score and the contribution's composite score (the group
-- consensus). Returns one row per qualifying voter, sorted closest→furthest.
--
-- p_min_votes: minimum non-self votes cast to appear in the ranking.
--   Default 20 — below that, one outlier vote can dominate the average.
-- =============================================================================
create or replace function get_nostradamus_stats(
  p_club_id   uuid,
  p_year      int  default null,
  p_min_votes int  default 20
)
returns table (
  membership_id  uuid,
  display_name   text,
  avg_delta      numeric,
  votes_cast     bigint
)
language sql security definer stable as $$
  with scoped_meetings as (
    select id
    from   meetings
    where  club_id    = p_club_id
      and  status     = 'completed'
      and  deleted_at is null
      and  (p_year is null or extract(year from held_at)::int = p_year)
  )
  select
    v.voter_id                                               as membership_id,
    u.display_name,
    round(avg(abs(v.score - c.composite_score))::numeric, 4) as avg_delta,
    count(*)                                                 as votes_cast
  from       votes        v
  join       contributions c  on c.id  = v.contribution_id
  join       scoped_meetings  m  on m.id  = c.meeting_id
  join       memberships  ms on ms.id = v.voter_id
  join       users        u  on u.id  = ms.user_id
  where v.deleted_at      is null
    and c.deleted_at      is null
    and v.is_self_vote    = false
    and c.composite_score is not null
  group  by v.voter_id, u.display_name
  having count(*) >= p_min_votes
  order  by avg_delta asc   -- closest first → row 0 = Nostradamus, last = Nostradumbass
$$;


-- =============================================================================
-- get_beer_records
--
-- Returns every contribution in the period that received at least p_min_votes
-- non-self-votes, sorted by composite score descending (best first).
--
-- The caller uses row 0 as "Best Beer" and the last row as "Worst Beer".
-- Returning the full sorted list lets the UI show a top-N or bottom-N list
-- in the future without any changes here.
--
-- p_min_votes: minimum non-self-votes to qualify (club rule: 3).
-- =============================================================================
create or replace function get_beer_records(
  p_club_id   uuid,
  p_year      int  default null,
  p_min_votes int  default 3
)
returns table (
  contribution_id  uuid,
  offering_name    text,
  producer         text,
  composite_score  numeric,
  contributor_name text,
  vote_count       bigint,
  held_at          timestamptz,
  meeting_number   integer
)
language sql security definer stable as $$
  with scoped_meetings as (
    select id, held_at, meeting_number
    from   meetings
    where  club_id    = p_club_id
      and  status     = 'completed'
      and  deleted_at is null
      and  (p_year is null or extract(year from held_at)::int = p_year)
  ),

  -- Count non-self votes per contribution and apply the minimum threshold
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
    m.meeting_number
  from       qualified     q
  join       contributions c  on c.id  = q.id
  join       offerings     o  on o.id  = c.offering_id
  join       scoped_meetings m on m.id = c.meeting_id
  join       memberships  ms on ms.id  = c.contributor_id
  join       users         u  on u.id  = ms.user_id
  order by c.composite_score desc   -- best first; last row = worst
$$;
