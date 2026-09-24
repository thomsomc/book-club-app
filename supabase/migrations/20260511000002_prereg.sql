-- =============================================================================
-- Migration: 20260511000002_prereg.sql
--
-- Opens up pre-registration: any active member can now register the offering
-- they plan to bring for a scheduled (upcoming) meeting.
--
-- 1. log_offering (updated) — the "only host/admin can pre-log during scheduled"
--    restriction is removed. Any member can register their own pick. The owner/
--    admin/host restriction on specifying a *different* contributor is kept.
--
-- 2. delete_contribution (updated) — the original contributor can now remove
--    their own pre-registration during a scheduled meeting (so they can change
--    their pick). During active/completed meetings, only owner/admin/host can
--    still delete.
-- =============================================================================


-- =============================================================================
-- RPC: log_offering (updated — any member may pre-register during scheduled)
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

  -- Allow logging during both active and scheduled meetings
  if v_meeting.status not in ('active', 'scheduled') then
    raise exception 'Meeting must be active or scheduled to log offerings';
  end if;

  -- Resolve the caller — must be an active member of the club
  select * into v_actor
  from   memberships
  where  club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  -- Any active member may log for themselves (no status restriction).
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
    -- Default: the caller is the contributor
    v_contributor := v_actor;
  end if;

  -- Duplicate check: has this club ever had this offering before?
  -- Sets is_flagged_duplicate so the UI can warn the member at the store.
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

  -- Assign presentation order (next slot after existing contributions)
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
-- RPC: delete_contribution (updated — contributor can remove their own pre-reg)
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

  -- Who may delete:
  --   • Owner or admin — always
  --   • The meeting's designated host — always (during active or scheduled)
  --   • The original contributor — but only during scheduled meetings, so they
  --     can change their mind before the meeting starts
  if v_actor.role not in ('owner', 'admin')
     and (v_meeting.host_membership_id is null or v_actor.id != v_meeting.host_membership_id)
     and not (v_meeting.status = 'scheduled' and v_contribution.contributor_id = v_actor.id)
  then
    raise exception 'Only owners, admins, or the host can remove offerings during an active meeting';
  end if;

  update contributions set deleted_at = now() where id = p_contribution_id;
end;
$$;
