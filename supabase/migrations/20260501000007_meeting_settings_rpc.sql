-- =============================================================================
-- Migration: 20260501000007_meeting_settings_rpc.sql
--
-- Adds per-meeting management capabilities:
--
-- 1. update_meeting_status — extended to allow the meeting's host to start/end
--    their own meeting (previously owner/admin only).
--
-- 2. update_meeting_details — jsonb-patch RPC for editing meeting metadata.
--    The caller passes only the keys they want to change; everything else is
--    left untouched. Permission tiers:
--      Owner/Admin : all fields
--      Host        : title, notes, and metadata.settings overrides only
--
--    Per-meeting settings are stored in meetings.metadata.settings and act as
--    overrides of the club-level defaults in clubs.settings.  A null value for
--    any setting key means "use the club default."
-- =============================================================================


-- =============================================================================
-- RPC: update_meeting_status  (updated — hosts may now start/end their meeting)
-- =============================================================================
create or replace function update_meeting_status(p_meeting_id uuid, p_status text)
returns void language plpgsql security definer as $$
declare
  v_meeting  meetings;
  v_caller   memberships;
begin
  select * into v_meeting from meetings where id = p_meeting_id;
  if not found then raise exception 'Meeting not found'; end if;

  select * into v_caller
  from memberships
  where club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  -- Owner/admin or the designated host may change meeting status
  if v_caller.role not in ('owner', 'admin')
     and v_meeting.host_membership_id is distinct from v_caller.id then
    raise exception 'Only owners, admins, and the meeting host can change meeting status';
  end if;

  if p_status not in ('scheduled', 'active', 'completed') then
    raise exception 'Invalid status';
  end if;

  update meetings set status = p_status where id = p_meeting_id;
end;
$$;


-- =============================================================================
-- RPC: update_meeting_details
-- Accepts a jsonb object containing only the fields to update — keys that are
-- absent are left unchanged.  Nullable fields (title, notes, host) can be
-- explicitly cleared by passing a JSON null for that key.
--
-- Supported keys:
--   title              text        (host + owner/admin)
--   notes              text        (host + owner/admin)
--   settings           jsonb       (host + owner/admin) — shallow-merged into
--                                  metadata.settings; null values clear a key
--   held_at            timestamptz (owner/admin only)
--   host_membership_id uuid        (owner/admin only)
--   meeting_number     integer     (owner/admin only)
--   counts_for_record  boolean     (owner/admin only)
-- =============================================================================
create or replace function update_meeting_details(
  p_meeting_id uuid,
  p_updates    jsonb
)
returns void language plpgsql security definer as $$
declare
  v_meeting   meetings;
  v_caller    memberships;
  v_is_host   boolean;
  v_admin_keys text[] := array['held_at','host_membership_id','meeting_number','counts_for_record'];
  k           text;
begin
  select * into v_meeting from meetings where id = p_meeting_id and deleted_at is null;
  if not found then raise exception 'Meeting not found'; end if;

  select * into v_caller
  from memberships
  where club_id = v_meeting.club_id and user_id = auth.uid() and status = 'active';
  if not found then raise exception 'You are not a member of this club'; end if;

  v_is_host := (v_meeting.host_membership_id = v_caller.id);

  -- Must be owner, admin, or the designated host
  if v_caller.role not in ('owner', 'admin') and not v_is_host then
    raise exception 'Only owners, admins, and the meeting host can edit meeting details';
  end if;

  -- Hosts cannot touch admin-only fields
  if v_caller.role not in ('owner', 'admin') then
    foreach k in array v_admin_keys loop
      if p_updates ? k then
        raise exception 'Only owners and admins can change %, host, meeting number, or record status', k;
      end if;
    end loop;
  end if;

  update meetings set
    -- Title: present key sets it; absent leaves it; JSON null clears it
    title = case
      when p_updates ? 'title'
      then nullif(trim(p_updates->>'title'), '')
      else title
    end,

    notes = case
      when p_updates ? 'notes'
      then nullif(trim(p_updates->>'notes'), '')
      else notes
    end,

    held_at = case
      when p_updates ? 'held_at'
      then (p_updates->>'held_at')::timestamptz
      else held_at
    end,

    host_membership_id = case
      when p_updates ? 'host_membership_id'
      then (p_updates->>'host_membership_id')::uuid
      else host_membership_id
    end,

    meeting_number = case
      when p_updates ? 'meeting_number'
      then (p_updates->'meeting_number')::integer
      else meeting_number
    end,

    counts_for_record = case
      when p_updates ? 'counts_for_record'
      then (p_updates->'counts_for_record')::boolean
      else counts_for_record
    end,

    -- Per-meeting settings: shallow-merge the supplied keys into metadata.settings.
    -- Null values deliberately clear a key (restoring the club default).
    metadata = case
      when p_updates ? 'settings'
      then jsonb_set(
        coalesce(metadata, '{}'),
        '{settings}',
        coalesce(metadata->'settings', '{}') || (p_updates->'settings')
      )
      else metadata
    end

  where id = p_meeting_id;
end;
$$;
