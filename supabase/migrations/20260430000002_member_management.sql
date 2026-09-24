-- =============================================================================
-- Migration: 20260430000002_member_management.sql
-- RPCs for owner-only member management: changing roles and removing members.
-- =============================================================================


-- =============================================================================
-- RPC: update_member_role
-- Owner-only. Changes the role of any non-owner member in the same club.
-- Prevents changing the owner's own role (can't lock yourself out).
-- =============================================================================
create or replace function update_member_role(p_membership_id uuid, p_new_role text)
returns void language plpgsql security definer as $$
declare
  v_club_id      uuid;
  v_target_role  text;
begin
  select club_id, role into v_club_id, v_target_role
  from memberships where id = p_membership_id and deleted_at is null;

  if not found then
    raise exception 'Membership not found';
  end if;

  if not exists (
    select 1 from memberships
    where club_id = v_club_id
      and user_id = auth.uid()
      and role = 'owner'
      and status = 'active'
  ) then
    raise exception 'Only the club owner can change member roles';
  end if;

  if v_target_role = 'owner' then
    raise exception 'Cannot change the owner''s role';
  end if;

  if p_new_role not in ('admin', 'member', 'guest', 'alumni') then
    raise exception 'Invalid role';
  end if;

  update memberships set role = p_new_role where id = p_membership_id;
end;
$$;


-- =============================================================================
-- RPC: remove_member
-- Owner-only. Soft-deletes a membership (sets status=inactive, deleted_at=now).
-- Cannot remove the owner.
-- =============================================================================
create or replace function remove_member(p_membership_id uuid)
returns void language plpgsql security definer as $$
declare
  v_club_id      uuid;
  v_target_role  text;
begin
  select club_id, role into v_club_id, v_target_role
  from memberships where id = p_membership_id and deleted_at is null;

  if not found then
    raise exception 'Membership not found';
  end if;

  if not exists (
    select 1 from memberships
    where club_id = v_club_id
      and user_id = auth.uid()
      and role = 'owner'
      and status = 'active'
  ) then
    raise exception 'Only the club owner can remove members';
  end if;

  if v_target_role = 'owner' then
    raise exception 'Cannot remove the club owner';
  end if;

  update memberships
  set status = 'inactive', deleted_at = now()
  where id = p_membership_id;
end;
$$;
