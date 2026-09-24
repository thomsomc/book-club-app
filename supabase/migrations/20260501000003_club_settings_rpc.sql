-- =============================================================================
-- Migration: 20260501000003_club_settings_rpc.sql
--
-- RPC for owner-only club administration: updating the club name and the
-- settings jsonb column (blind voting, score visibility, tiebreak rule, etc.)
--
-- Direct UPDATE on the clubs table is not covered by an RLS policy so all
-- writes must go through this function.
-- =============================================================================

create or replace function update_club_info(
  p_club_id  uuid,
  p_name     text  default null,
  p_settings jsonb default null
)
returns void language plpgsql security definer as $$
begin
  -- Caller must be the club owner
  if not exists (
    select 1 from memberships
    where club_id  = p_club_id
      and user_id  = auth.uid()
      and role     = 'owner'
      and status   = 'active'
      and deleted_at is null
  ) then
    raise exception 'Only the club owner can update club settings';
  end if;

  -- Apply whichever fields were provided (null = leave unchanged)
  update clubs
  set
    name     = coalesce(p_name,     name),
    settings = coalesce(p_settings, settings)
  where id = p_club_id;
end;
$$;
