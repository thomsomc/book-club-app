-- =============================================================================
-- Migration: 20260501000006_contributor_controls.sql
--
-- Allows owners/admins to specify or change who physically brought an offering.
--
-- 1. log_offering gets an optional p_contributor_membership_id param so the
--    host can indicate "Matt brought this" at the moment of entry.
-- 2. change_contributor lets the host correct the contributor after the fact.
--    It also recalculates is_self_vote on every existing vote for the
--    contribution and recomputes composite_score, since a contributor change
--    changes whose vote is a self-vote and therefore what counts toward the score.
-- =============================================================================


-- =============================================================================
-- RPC: log_offering  (updated — adds optional contributor override)
-- =============================================================================
create or replace function log_offering(
  p_meeting_id                uuid,
  p_name                      text,
  p_producer                  text    default null,
  p_style                     text    default null,
  p_abv                       numeric default null,
  p_contributor_membership_id uuid    default null
)
returns contributions language plpgsql security definer as $$
declare
  v_meeting         meetings;
  v_actor           memberships;   -- the person actually calling the RPC
  v_contributor     memberships;   -- who brought the beer (may differ from actor)
  v_offering        offerings;
  v_contribution    contributions;
  v_is_duplicate    boolean := false;
  v_next_position   integer;
begin
  select * into v_meeting from meetings where id = p_meeting_id;
  if not found then raise exception 'Meeting not found'; end if;
  if v_meeting.status != 'active' then raise exception 'Meeting is not active'; end if;

  -- Resolve the caller
  select * into v_actor
  from memberships
  where club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  -- Resolve the contributor (defaults to the caller)
  if p_contributor_membership_id is not null then
    -- Only owners/admins may log on behalf of someone else
    if v_actor.role not in ('owner', 'admin') then
      raise exception 'Only owners and admins can log an offering on behalf of another member';
    end if;
    select * into v_contributor
    from memberships
    where id = p_contributor_membership_id
      and club_id = v_meeting.club_id
      and status = 'active';
    if not found then raise exception 'Contributor must be an active member of this club'; end if;
  else
    v_contributor := v_actor;
  end if;

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

  -- Next position = highest existing position + 1
  select coalesce(max(presentation_order), 0) + 1
  into   v_next_position
  from   contributions
  where  meeting_id = p_meeting_id and deleted_at is null;

  insert into contributions (
    meeting_id, offering_id, contributor_id, actor_id,
    is_flagged_duplicate, presentation_order
  )
  values (
    p_meeting_id, v_offering.id, v_contributor.id, v_actor.id,
    v_is_duplicate, v_next_position
  )
  returning * into v_contribution;

  return v_contribution;
end;
$$;


-- =============================================================================
-- RPC: change_contributor
-- Owner/admin only. Updates who brought an offering after it was logged.
-- Recalculates is_self_vote on every existing vote (because the self-vote
-- determination depends on the contributor's identity), then recomputes
-- composite_score so the displayed average immediately reflects the change.
-- =============================================================================
create or replace function change_contributor(
  p_contribution_id           uuid,
  p_contributor_membership_id uuid
)
returns void language plpgsql security definer as $$
declare
  v_contribution  contributions;
  v_meeting       meetings;
  v_new_contrib   memberships;
begin
  select * into v_contribution from contributions where id = p_contribution_id and deleted_at is null;
  if not found then raise exception 'Contribution not found'; end if;

  select * into v_meeting from meetings where id = v_contribution.meeting_id;

  if not exists (
    select 1 from memberships
    where club_id = v_meeting.club_id
      and user_id = auth.uid()
      and role    in ('owner', 'admin')
      and status  = 'active'
  ) then
    raise exception 'Only owners and admins can change the contributor';
  end if;

  -- Verify the new contributor is an active member of this club
  select * into v_new_contrib
  from memberships
  where id = p_contributor_membership_id
    and club_id = v_meeting.club_id
    and status  = 'active';
  if not found then raise exception 'Contributor must be an active member of this club'; end if;

  -- Update the contributor on the contribution
  update contributions
  set contributor_id = p_contributor_membership_id
  where id = p_contribution_id;

  -- Recalculate is_self_vote for every existing vote on this contribution.
  -- A vote is a self-vote when the voter's user_id matches the new contributor's user_id.
  update votes v
  set    is_self_vote = (vm.user_id = v_new_contrib.user_id)
  from   memberships vm
  where  v.contribution_id = p_contribution_id
    and  v.voter_id = vm.id;

  -- Recompute composite_score (average of non-self votes)
  update contributions
  set composite_score = (
    select round(avg(score)::numeric, 2)
    from   votes
    where  contribution_id = p_contribution_id
      and  is_self_vote    = false
  )
  where id = p_contribution_id;
end;
$$;
