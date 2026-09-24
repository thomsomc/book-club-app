-- =============================================================================
-- Migration: 20260501000005_host_controls.sql
--
-- Phase 2 host controls: edit offerings, proxy vote entry, and reordering.
--
-- Also updates log_offering to auto-assign presentation_order so new
-- contributions have a defined position from the moment they are logged.
-- =============================================================================


-- =============================================================================
-- RPC: log_offering  (updated — now assigns presentation_order)
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
  v_meeting       meetings;
  v_membership    memberships;
  v_offering      offerings;
  v_contribution  contributions;
  v_is_duplicate  boolean := false;
  v_next_position integer;
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

  -- Next position = highest existing position + 1 (or 1 if this is the first)
  select coalesce(max(presentation_order), 0) + 1
  into   v_next_position
  from   contributions
  where  meeting_id = p_meeting_id and deleted_at is null;

  insert into contributions (
    meeting_id, offering_id, contributor_id, actor_id,
    is_flagged_duplicate, presentation_order
  )
  values (
    p_meeting_id, v_offering.id, v_membership.id, v_membership.id,
    v_is_duplicate, v_next_position
  )
  returning * into v_contribution;

  return v_contribution;
end;
$$;


-- =============================================================================
-- RPC: edit_offering
-- Owner/admin can correct the name, producer, style, or ABV of an offering
-- that was already logged to a meeting. Touches contributions.updated_at so
-- the Realtime subscription triggers a reload on all open clients.
-- =============================================================================
create or replace function edit_offering(
  p_contribution_id uuid,
  p_name            text,
  p_producer        text    default null,
  p_style           text    default null,
  p_abv             numeric default null
)
returns void language plpgsql security definer as $$
declare
  v_contribution contributions;
  v_meeting      meetings;
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
    raise exception 'Only owners and admins can edit offerings';
  end if;

  -- Update the offering record in the catalog
  update offerings
  set name     = p_name,
      producer = p_producer,
      style    = p_style,
      abv      = p_abv
  where id = v_contribution.offering_id;

  -- Touch the contribution so the Realtime "contributions" channel fires,
  -- causing all open clients to call loadContributions() and pick up the new name.
  update contributions set updated_at = now() where id = p_contribution_id;
end;
$$;


-- =============================================================================
-- RPC: proxy_vote
-- Owner/admin can submit or update a vote on behalf of another member.
-- Uses the actor_id / voter_id split that already exists in the votes table:
--   voter_id = the member whose score this represents
--   actor_id = the admin who physically entered it
-- =============================================================================
create or replace function proxy_vote(
  p_contribution_id     uuid,
  p_voter_membership_id uuid,
  p_score               numeric
)
returns void language plpgsql security definer as $$
declare
  v_contribution contributions;
  v_meeting      meetings;
  v_actor        memberships;
  v_voter        memberships;
  v_contributor  memberships;
  v_is_self_vote boolean;
  v_composite    numeric;
begin
  if p_score < 0 or p_score > 5 then
    raise exception 'Score must be between 0 and 5';
  end if;

  select * into v_contribution from contributions where id = p_contribution_id;
  if not found then raise exception 'Contribution not found'; end if;

  select * into v_meeting from meetings where id = v_contribution.meeting_id;
  if v_meeting.status != 'active' then raise exception 'Meeting is not active'; end if;

  -- Caller must be owner or admin
  select * into v_actor
  from memberships
  where club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;
  if v_actor.role not in ('owner', 'admin') then
    raise exception 'Only owners and admins can enter proxy votes';
  end if;

  -- Resolve the target voter
  select * into v_voter from memberships where id = p_voter_membership_id;
  if not found then raise exception 'Voter membership not found'; end if;

  -- Detect self-vote (contributor voting for their own offering)
  select * into v_contributor from memberships where id = v_contribution.contributor_id;
  v_is_self_vote := (v_voter.user_id = v_contributor.user_id);

  -- Upsert: create or overwrite the vote
  insert into votes (contribution_id, voter_id, actor_id, score, is_self_vote)
  values (p_contribution_id, p_voter_membership_id, v_actor.id, round(p_score::numeric, 1), v_is_self_vote)
  on conflict (contribution_id, voter_id) do update
    set score      = round(p_score::numeric, 1),
        actor_id   = v_actor.id,
        updated_at = now();

  -- Recompute composite (average of non-self votes, same as submit_vote)
  select round(avg(score)::numeric, 2) into v_composite
  from votes
  where contribution_id = p_contribution_id and is_self_vote = false;

  update contributions set composite_score = v_composite where id = p_contribution_id;
end;
$$;


-- =============================================================================
-- RPC: move_contribution
-- Owner/admin can reorder offerings within a meeting by swapping presentation_order
-- values with the neighbor above or below. If presentation_order has never been
-- set for this meeting's contributions, it is initialised from created_at first.
-- =============================================================================
create or replace function move_contribution(
  p_contribution_id uuid,
  p_direction       text   -- 'up' or 'down'
)
returns void language plpgsql security definer as $$
declare
  v_contribution contributions;
  v_meeting      meetings;
  v_current_pos  integer;
  v_neighbor_id  uuid;
  v_neighbor_pos integer;
begin
  if p_direction not in ('up', 'down') then
    raise exception 'Direction must be ''up'' or ''down''';
  end if;

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
    raise exception 'Only owners and admins can reorder offerings';
  end if;

  -- Lazily initialise presentation_order from created_at for any meeting that
  -- was created before this migration (no positions assigned yet).
  if exists (
    select 1 from contributions
    where meeting_id = v_contribution.meeting_id
      and deleted_at is null
      and presentation_order is null
  ) then
    with ordered as (
      select id,
             row_number() over (order by created_at) as pos
      from   contributions
      where  meeting_id = v_contribution.meeting_id and deleted_at is null
    )
    update contributions c
    set    presentation_order = o.pos
    from   ordered o
    where  c.id = o.id;
  end if;

  -- Re-read current position after potential initialisation
  select presentation_order into v_current_pos from contributions where id = p_contribution_id;

  -- Find the nearest neighbor in the requested direction
  if p_direction = 'up' then
    select id, presentation_order
    into   v_neighbor_id, v_neighbor_pos
    from   contributions
    where  meeting_id = v_contribution.meeting_id
      and  deleted_at is null
      and  presentation_order < v_current_pos
    order  by presentation_order desc
    limit  1;
  else
    select id, presentation_order
    into   v_neighbor_id, v_neighbor_pos
    from   contributions
    where  meeting_id = v_contribution.meeting_id
      and  deleted_at is null
      and  presentation_order > v_current_pos
    order  by presentation_order asc
    limit  1;
  end if;

  -- Already at the boundary — nothing to do
  if v_neighbor_id is null then return; end if;

  -- Swap
  update contributions set presentation_order = v_neighbor_pos where id = p_contribution_id;
  update contributions set presentation_order = v_current_pos  where id = v_neighbor_id;
end;
$$;
