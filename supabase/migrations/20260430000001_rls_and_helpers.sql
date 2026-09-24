-- =============================================================================
-- Migration: 20260430000001_rls_and_helpers.sql
-- Sets up Row Level Security on all tables, a trigger to auto-create user
-- profiles on signup, and RPC functions for creating/joining clubs.
-- =============================================================================


-- =============================================================================
-- TRIGGER: auto-create a public.users profile when someone signs up via Auth.
-- "security definer" means it runs with elevated privileges so it can write
-- to public.users even before RLS is established.
-- =============================================================================
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- =============================================================================
-- HELPER: returns the club IDs the calling user belongs to.
-- Used in RLS policies below — pulling this into a function avoids an infinite
-- recursion problem that would occur if memberships policies referenced
-- themselves directly.
-- =============================================================================
create or replace function get_my_club_ids()
returns setof uuid language sql security definer stable as $$
  select club_id from memberships
  where user_id = auth.uid()
    and status = 'active'
    and deleted_at is null
$$;


-- =============================================================================
-- ENABLE RLS on all tables
-- Without these, all data is publicly readable — not what we want.
-- =============================================================================
alter table clubs        enable row level security;
alter table users        enable row level security;
alter table user_pii     enable row level security;
alter table memberships  enable row level security;
alter table meetings     enable row level security;
alter table offerings    enable row level security;
alter table contributions enable row level security;
alter table votes        enable row level security;


-- =============================================================================
-- POLICIES: users
-- Anyone authenticated can read all user profiles (display names are public
-- within the app). Only you can insert or update your own record.
-- =============================================================================
create policy "users_select" on users
  for select to authenticated using (true);

create policy "users_insert" on users
  for insert to authenticated with check (auth.uid() = id);

create policy "users_update" on users
  for update to authenticated using (auth.uid() = id);


-- =============================================================================
-- POLICIES: user_pii
-- Only you can read or write your own PII record.
-- =============================================================================
create policy "user_pii_select" on user_pii
  for select to authenticated using (auth.uid() = user_id);

create policy "user_pii_insert" on user_pii
  for insert to authenticated with check (auth.uid() = user_id);

create policy "user_pii_update" on user_pii
  for update to authenticated using (auth.uid() = user_id);


-- =============================================================================
-- POLICIES: clubs
-- You can see a club only if you are an active member of it.
-- Direct INSERT is not allowed — use the create_club() RPC instead.
-- =============================================================================
create policy "clubs_select" on clubs
  for select to authenticated
  using (id in (select get_my_club_ids()));


-- =============================================================================
-- POLICIES: memberships
-- You can see memberships for any club you belong to (so you can see the
-- member list), plus your own membership record in any state.
-- =============================================================================
create policy "memberships_select" on memberships
  for select to authenticated
  using (
    club_id in (select get_my_club_ids())
    or user_id = auth.uid()
  );


-- =============================================================================
-- POLICIES: meetings, offerings, contributions, votes
-- Readable only by active members of the relevant club.
-- =============================================================================
create policy "meetings_select" on meetings
  for select to authenticated
  using (club_id in (select get_my_club_ids()));

create policy "offerings_select" on offerings
  for select to authenticated
  using (club_id in (select get_my_club_ids()));

create policy "contributions_select" on contributions
  for select to authenticated
  using (
    meeting_id in (
      select id from meetings where club_id in (select get_my_club_ids())
    )
  );

create policy "votes_select" on votes
  for select to authenticated
  using (
    contribution_id in (
      select c.id from contributions c
      join meetings m on c.meeting_id = m.id
      where m.club_id in (select get_my_club_ids())
    )
  );


-- =============================================================================
-- RPC: create_club
-- Creates a club and immediately makes the caller the owner — both happen in
-- one transaction so you can never end up with a club that has no owner.
-- Returns the new club record.
-- =============================================================================
create or replace function create_club(
  p_name        text,
  p_slug        text,
  p_description text default null
)
returns clubs language plpgsql security definer as $$
declare
  v_club clubs;
begin
  -- Ensure the caller has a user profile (belt-and-suspenders for existing users)
  insert into public.users (id, display_name)
  values (auth.uid(), split_part(auth.email(), '@', 1))
  on conflict (id) do nothing;

  insert into clubs (name, slug, description)
  values (p_name, p_slug, p_description)
  returning * into v_club;

  insert into memberships (club_id, user_id, role, status, joined_at)
  values (v_club.id, auth.uid(), 'owner', 'active', now());

  return v_club;
end;
$$;


-- =============================================================================
-- RPC: join_club
-- Looks up a club by slug and adds the caller as a member.
-- Safe to call more than once — re-activates an inactive membership if needed.
-- Returns the club record.
-- =============================================================================
create or replace function join_club(p_slug text)
returns clubs language plpgsql security definer as $$
declare
  v_club clubs;
begin
  select * into v_club
  from clubs
  where slug = p_slug and deleted_at is null;

  if not found then
    raise exception 'Club not found';
  end if;

  insert into public.users (id, display_name)
  values (auth.uid(), split_part(auth.email(), '@', 1))
  on conflict (id) do nothing;

  insert into memberships (club_id, user_id, role, status, joined_at)
  values (v_club.id, auth.uid(), 'member', 'active', now())
  on conflict (club_id, user_id) do update
    set status = 'active', updated_at = now();

  return v_club;
end;
$$;
