-- =============================================================================
-- Migration: 20260430000004_offerings.sql
-- RPCs for logging offerings and submitting votes at a meeting.
-- Also enables Supabase Realtime on contributions and votes so the meeting
-- view updates live without polling.
-- =============================================================================


-- =============================================================================
-- Fix the score range: club uses a 5-point scale, not 10.
-- Drop and recreate the check constraint on votes.
-- =============================================================================
alter table votes drop constraint if exists votes_score_check;
alter table votes add constraint votes_score_check check (score >= 0 and score <= 5);


-- =============================================================================
-- RPC: log_offering
-- Any active club member can call this during an active meeting.
-- Looks up the offering in the club catalog first — if found, flags the new
-- contribution as a duplicate (silently). If not found, creates a new offering.
-- Always creates a contribution linking the offering to the meeting.
-- =============================================================================
create or replace function log_offering(
  p_meeting_id  uuid,
  p_name        text,
  p_producer    text    default null,
  p_style       text    default null,
  p_abv         numeric default null
)
returns contributions language plpgsql security definer as $$
declare
  v_meeting      meetings;
  v_membership   memberships;
  v_offering     offerings;
  v_contribution contributions;
  v_is_duplicate boolean := false;
begin
  select * into v_meeting from meetings where id = p_meeting_id;
  if not found then raise exception 'Meeting not found'; end if;
  if v_meeting.status != 'active' then raise exception 'Meeting is not active'; end if;

  select * into v_membership
  from memberships
  where club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  -- Duplicate check: has this club seen this offering before?
  select * into v_offering
  from offerings
  where club_id = v_meeting.club_id
    and lower(trim(name)) = lower(trim(p_name))
    and deleted_at is null
  limit 1;

  if found then
    v_is_duplicate := true;
  else
    insert into offerings (club_id, name, producer, style, abv)
    values (v_meeting.club_id, p_name, p_producer, p_style, p_abv)
    returning * into v_offering;
  end if;

  insert into contributions (
    meeting_id, offering_id, contributor_id, actor_id, is_flagged_duplicate
  )
  values (
    p_meeting_id, v_offering.id, v_membership.id, v_membership.id, v_is_duplicate
  )
  returning * into v_contribution;

  return v_contribution;
end;
$$;


-- =============================================================================
-- RPC: submit_vote
-- Any active club member can vote on any contribution in the same club.
-- Upserts (create or update) the vote, detects self-votes, and immediately
-- recalculates the composite score on the contribution.
-- =============================================================================
create or replace function submit_vote(
  p_contribution_id uuid,
  p_score           numeric
)
returns void language plpgsql security definer as $$
declare
  v_contribution  contributions;
  v_meeting       meetings;
  v_voter         memberships;
  v_contributor   memberships;
  v_is_self_vote  boolean;
  v_composite     numeric;
begin
  if p_score < 0 or p_score > 5 then
    raise exception 'Score must be between 0 and 5';
  end if;

  select * into v_contribution from contributions where id = p_contribution_id;
  if not found then raise exception 'Contribution not found'; end if;

  select * into v_meeting from meetings where id = v_contribution.meeting_id;

  select * into v_voter
  from memberships
  where club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  select * into v_contributor from memberships where id = v_contribution.contributor_id;
  v_is_self_vote := (v_voter.user_id = v_contributor.user_id);

  insert into votes (contribution_id, voter_id, actor_id, score, is_self_vote)
  values (p_contribution_id, v_voter.id, v_voter.id, round(p_score::numeric, 1), v_is_self_vote)
  on conflict (contribution_id, voter_id) do update
    set score = round(p_score::numeric, 1), updated_at = now();

  -- Recompute composite (average of non-self votes)
  select round(avg(score)::numeric, 2) into v_composite
  from votes
  where contribution_id = p_contribution_id and is_self_vote = false;

  update contributions set composite_score = v_composite where id = p_contribution_id;
end;
$$;


-- =============================================================================
-- REALTIME: enable live updates on contributions and votes so the meeting view
-- refreshes automatically when anyone logs an offering or submits a vote.
-- =============================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'contributions'
  ) then
    alter publication supabase_realtime add table contributions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'votes'
  ) then
    alter publication supabase_realtime add table votes;
  end if;
end
$$;
