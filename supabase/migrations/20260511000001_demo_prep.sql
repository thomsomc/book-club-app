-- =============================================================================
-- Migration: 20260511000001_demo_prep.sql
--
-- Changes for demo prep:
--   1. delete_contribution (new) — soft-delete an offering during a meeting
--   2. edit_offering (updated)   — meeting host can now edit, not just owner/admin
--   3. change_contributor (upd.) — meeting host allowed
--   4. move_contribution (upd.)  — meeting host allowed
--   5. proxy_vote (updated)      — meeting host allowed
--   6. log_offering (updated)    — pre-logging during 'scheduled' meetings
--                                  allowed for owner/admin/host; host may also
--                                  specify the contributor via the override param
-- =============================================================================


-- =============================================================================
-- RPC: delete_contribution (new)
-- Soft-deletes an offering. Callable by owner, admin, or the meeting's
-- designated host while the meeting is active or scheduled.
-- =============================================================================
create or replace function delete_contribution(p_contribution_id uuid)
returns void language plpgsql security definer as $$
declare
  v_contribution contributions;
  v_meeting      meetings;
  v_actor        memberships;
begin
  select * into v_contribution
  from   contributions
  where  id = p_contribution_id and deleted_at is null;
  if not found then raise exception 'Contribution not found'; end if;

  select * into v_meeting from meetings where id = v_contribution.meeting_id;
  if v_meeting.status not in ('active', 'scheduled') then
    raise exception 'Offerings can only be removed during active or scheduled meetings';
  end if;

  select * into v_actor
  from   memberships
  where  club_id = v_meeting.club_id
    and  user_id = auth.uid()
    and  status  = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  if v_actor.role not in ('owner', 'admin')
     and (v_meeting.host_membership_id is null or v_actor.id != v_meeting.host_membership_id)
  then
    raise exception 'Only owners, admins, or the host can remove offerings';
  end if;

  update contributions set deleted_at = now() where id = p_contribution_id;
end;
$$;


-- =============================================================================
-- RPC: edit_offering (updated — host can now edit)
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
  v_actor        memberships;
begin
  select * into v_contribution from contributions where id = p_contribution_id and deleted_at is null;
  if not found then raise exception 'Contribution not found'; end if;

  select * into v_meeting from meetings where id = v_contribution.meeting_id;

  select * into v_actor
  from   memberships
  where  club_id = v_meeting.club_id
    and  user_id = auth.uid()
    and  status  = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  if v_actor.role not in ('owner', 'admin')
     and (v_meeting.host_membership_id is null or v_actor.id != v_meeting.host_membership_id)
  then
    raise exception 'Only owners, admins, or the host can edit offerings';
  end if;

  update offerings
  set name     = p_name,
      producer = p_producer,
      style    = p_style,
      abv      = p_abv
  where id = v_contribution.offering_id;

  -- Touch so the Realtime contributions channel fires a reload on all clients
  update contributions set updated_at = now() where id = p_contribution_id;
end;
$$;


-- =============================================================================
-- RPC: change_contributor (updated — host can now change contributor)
-- =============================================================================
create or replace function change_contributor(
  p_contribution_id           uuid,
  p_contributor_membership_id uuid
)
returns void language plpgsql security definer as $$
declare
  v_contribution  contributions;
  v_meeting       meetings;
  v_actor         memberships;
  v_new_contrib   memberships;
begin
  select * into v_contribution from contributions where id = p_contribution_id and deleted_at is null;
  if not found then raise exception 'Contribution not found'; end if;

  select * into v_meeting from meetings where id = v_contribution.meeting_id;

  select * into v_actor
  from   memberships
  where  club_id = v_meeting.club_id
    and  user_id = auth.uid()
    and  status  = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  if v_actor.role not in ('owner', 'admin')
     and (v_meeting.host_membership_id is null or v_actor.id != v_meeting.host_membership_id)
  then
    raise exception 'Only owners, admins, or the host can change the contributor';
  end if;

  select * into v_new_contrib
  from   memberships
  where  id      = p_contributor_membership_id
    and  club_id = v_meeting.club_id
    and  status  = 'active';
  if not found then raise exception 'Contributor must be an active member of this club'; end if;

  update contributions
  set    contributor_id = p_contributor_membership_id
  where  id = p_contribution_id;

  -- Recalculate is_self_vote for every existing vote on this contribution
  update votes v
  set    is_self_vote = (vm.user_id = v_new_contrib.user_id)
  from   memberships vm
  where  v.contribution_id = p_contribution_id
    and  v.voter_id = vm.id;

  -- Recompute composite_score (average of non-self votes)
  update contributions
  set    composite_score = (
    select round(avg(score)::numeric, 2)
    from   votes
    where  contribution_id = p_contribution_id
      and  is_self_vote    = false
  )
  where  id = p_contribution_id;
end;
$$;


-- =============================================================================
-- RPC: proxy_vote (updated — host can now enter proxy votes)
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

  select * into v_actor
  from   memberships
  where  club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  if v_actor.role not in ('owner', 'admin')
     and (v_meeting.host_membership_id is null or v_actor.id != v_meeting.host_membership_id)
  then
    raise exception 'Only owners, admins, or the host can enter proxy votes';
  end if;

  select * into v_voter from memberships where id = p_voter_membership_id;
  if not found then raise exception 'Voter membership not found'; end if;

  select * into v_contributor from memberships where id = v_contribution.contributor_id;
  v_is_self_vote := (v_voter.user_id = v_contributor.user_id);

  insert into votes (contribution_id, voter_id, actor_id, score, is_self_vote)
  values (p_contribution_id, p_voter_membership_id, v_actor.id, round(p_score::numeric, 1), v_is_self_vote)
  on conflict (contribution_id, voter_id) do update
    set score      = round(p_score::numeric, 1),
        actor_id   = v_actor.id,
        updated_at = now();

  select round(avg(score)::numeric, 2) into v_composite
  from   votes
  where  contribution_id = p_contribution_id and is_self_vote = false;

  update contributions set composite_score = v_composite where id = p_contribution_id;
end;
$$;


-- =============================================================================
-- RPC: move_contribution (updated — host can now reorder)
-- =============================================================================
create or replace function move_contribution(
  p_contribution_id uuid,
  p_direction       text   -- 'up' or 'down'
)
returns void language plpgsql security definer as $$
declare
  v_contribution contributions;
  v_meeting      meetings;
  v_actor        memberships;
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

  select * into v_actor
  from   memberships
  where  club_id = v_meeting.club_id
    and  user_id = auth.uid()
    and  status  = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  if v_actor.role not in ('owner', 'admin')
     and (v_meeting.host_membership_id is null or v_actor.id != v_meeting.host_membership_id)
  then
    raise exception 'Only owners, admins, or the host can reorder offerings';
  end if;

  -- Lazily initialise presentation_order for meetings created before this migration
  if exists (
    select 1 from contributions
    where  meeting_id = v_contribution.meeting_id
      and  deleted_at is null
      and  presentation_order is null
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

  select presentation_order into v_current_pos from contributions where id = p_contribution_id;

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

  if v_neighbor_id is null then return; end if;

  update contributions set presentation_order = v_neighbor_pos where id = p_contribution_id;
  update contributions set presentation_order = v_current_pos  where id = v_neighbor_id;
end;
$$;


-- =============================================================================
-- RPC: log_offering (updated)
--   • Accepts 'scheduled' status so the host can pre-log before the meeting
--     starts (regular members still blocked until 'active')
--   • Host may now specify p_contributor_membership_id, same as owner/admin
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
  v_actor           memberships;
  v_contributor     memberships;
  v_offering        offerings;
  v_contribution    contributions;
  v_is_duplicate    boolean := false;
  v_next_position   integer;
begin
  select * into v_meeting from meetings where id = p_meeting_id;
  if not found then raise exception 'Meeting not found'; end if;

  if v_meeting.status not in ('active', 'scheduled') then
    raise exception 'Meeting must be active or scheduled to log offerings';
  end if;

  select * into v_actor
  from   memberships
  where  club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  -- During a scheduled meeting only owner/admin/host may pre-log
  if v_meeting.status = 'scheduled' then
    if v_actor.role not in ('owner', 'admin')
       and (v_meeting.host_membership_id is null or v_actor.id != v_meeting.host_membership_id)
    then
      raise exception 'Only owners, admins, or the host can pre-log offerings before the meeting starts';
    end if;
  end if;

  -- Resolve the contributor (defaults to caller; only owner/admin/host may override)
  if p_contributor_membership_id is not null then
    if v_actor.role not in ('owner', 'admin')
       and (v_meeting.host_membership_id is null or v_actor.id != v_meeting.host_membership_id)
    then
      raise exception 'Only owners, admins, or the host can log an offering on behalf of another member';
    end if;
    select * into v_contributor
    from   memberships
    where  id      = p_contributor_membership_id
      and  club_id = v_meeting.club_id
      and  status  = 'active';
    if not found then raise exception 'Contributor must be an active member of this club'; end if;
  else
    v_contributor := v_actor;
  end if;

  -- Duplicate check: has this club seen this offering before?
  select * into v_offering
  from   offerings
  where  club_id = v_meeting.club_id
    and  lower(trim(name)) = lower(trim(p_name))
    and  deleted_at is null
  limit  1;

  if found then
    v_is_duplicate := true;
  else
    insert into offerings (club_id, name, producer, style, abv)
    values (v_meeting.club_id, p_name, p_producer, p_style, p_abv)
    returning * into v_offering;
  end if;

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
