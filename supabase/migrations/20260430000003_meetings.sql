-- =============================================================================
-- Migration: 20260430000003_meetings.sql
-- RPCs for creating meetings and updating their status.
-- =============================================================================


-- =============================================================================
-- RPC: create_meeting
-- Owner/admin only. Auto-assigns the next meeting number for record-counting
-- meetings if one isn't provided.
-- =============================================================================
create or replace function create_meeting(
  p_club_id            uuid,
  p_held_at            timestamptz,
  p_title              text        default null,
  p_host_membership_id uuid        default null,
  p_meeting_number     integer     default null,
  p_counts_for_record  boolean     default true,
  p_notes              text        default null
)
returns meetings language plpgsql security definer as $$
declare
  v_meeting    meetings;
  v_next_num   integer;
begin
  if not exists (
    select 1 from memberships
    where club_id = p_club_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
      and status = 'active'
  ) then
    raise exception 'Only owners and admins can create meetings';
  end if;

  -- Auto-assign meeting number if not provided and this meeting counts
  if p_meeting_number is null and p_counts_for_record then
    select coalesce(max(meeting_number), 0) + 1
    into v_next_num
    from meetings
    where club_id = p_club_id
      and counts_for_record = true
      and deleted_at is null;

    p_meeting_number := v_next_num;
  end if;

  insert into meetings (
    club_id, meeting_number, title, held_at,
    host_membership_id, counts_for_record, notes
  )
  values (
    p_club_id, p_meeting_number, p_title, p_held_at,
    p_host_membership_id, p_counts_for_record, p_notes
  )
  returning * into v_meeting;

  return v_meeting;
end;
$$;


-- =============================================================================
-- RPC: update_meeting_status
-- Owner/admin only. Moves a meeting through scheduled → active → completed.
-- =============================================================================
create or replace function update_meeting_status(p_meeting_id uuid, p_status text)
returns void language plpgsql security definer as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from meetings where id = p_meeting_id;

  if not exists (
    select 1 from memberships
    where club_id = v_club_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
      and status = 'active'
  ) then
    raise exception 'Only owners and admins can update meeting status';
  end if;

  if p_status not in ('scheduled', 'active', 'completed') then
    raise exception 'Invalid status';
  end if;

  update meetings set status = p_status where id = p_meeting_id;
end;
$$;
