-- =============================================================================
-- Migration: 20260511000004_fix_duplicate_contribution_msg.sql
--
-- log_offering currently lets the INSERT hit the unique constraint on
-- (meeting_id, contributor_id) and surfaces a raw Postgres error.
-- Add an explicit pre-check so the caller gets a readable message instead.
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

  -- Any active member may log for themselves.
  -- Only owner / admin / designated host may log on behalf of someone else.
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

  -- Friendly guard: one offering per member per meeting.
  -- Without this, the INSERT below would raise an opaque unique-constraint error.
  if exists (
    select 1 from contributions
    where  meeting_id     = p_meeting_id
      and  contributor_id = v_contributor.id
      and  deleted_at     is null
  ) then
    raise exception 'This member already has an offering registered for this meeting';
  end if;

  -- Duplicate check: has this club ever had this offering before?
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
