-- =============================================================================
-- Migration: 20260430000000_create_core_tables.sql
-- Phase 1 core schema for Book Club App
--
-- Tables: clubs, users, user_pii, memberships, meetings, offerings,
--         contributions, votes
--
-- RLS (Row Level Security) policies are NOT included here — they will be
-- added in a follow-up migration once auth is wired up.
-- =============================================================================


-- =============================================================================
-- HELPER: auto-update the updated_at column on any row change.
-- This function is attached to every table via a trigger below.
-- =============================================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- =============================================================================
-- CLUBS
-- The top of the multi-tenant hierarchy. Every other record hangs off a club.
-- =============================================================================
create table clubs (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  -- slug is the short URL-safe identifier, e.g. "book-club-cincinnati"
  slug          text        not null unique,
  club_type     text        not null default 'beer',
  description   text,
  plan_tier     text        not null default 'free'
                            check (plan_tier in ('free', 'supporter', 'founder')),
  -- feature_flags: jsonb so we can gate features without schema changes
  feature_flags jsonb       not null default '{}',
  -- settings: club-specific config (e.g. duplicate check on/off, self-vote rules)
  settings      jsonb       not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create trigger clubs_updated_at
  before update on clubs
  for each row execute function update_updated_at();


-- =============================================================================
-- USERS
-- Public-safe profile data. The id matches auth.users.id from Supabase Auth
-- so we can join auth state to profile data without duplicating credentials.
-- =============================================================================
create table users (
  -- References auth.users so deleting an auth account cascades here too
  id            uuid        primary key references auth.users(id) on delete cascade,
  display_name  text        not null,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();


-- =============================================================================
-- USER_PII
-- Personally Identifiable Information lives here, separated from users.
-- Club admins can query the users table; they cannot query user_pii.
-- That restriction will be enforced by RLS policies in a later migration.
-- =============================================================================
create table user_pii (
  id            uuid        primary key default gen_random_uuid(),
  -- unique: one PII record per user
  user_id       uuid        not null unique references users(id) on delete cascade,
  email         text,
  full_name     text,
  phone         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create trigger user_pii_updated_at
  before update on user_pii
  for each row execute function update_updated_at();


-- =============================================================================
-- MEMBERSHIPS
-- The bridge between a user and a club. A user can belong to many clubs
-- with a different role in each. The unique constraint ensures one membership
-- record per (club, user) pair.
-- =============================================================================
create table memberships (
  id          uuid        primary key default gen_random_uuid(),
  club_id     uuid        not null references clubs(id),
  user_id     uuid        not null references users(id),
  role        text        not null default 'member'
                          check (role in ('owner', 'admin', 'member', 'guest', 'alumni', 'applicant')),
  status      text        not null default 'active'
                          check (status in ('active', 'inactive', 'pending')),
  -- joined_at is nullable because historical imports may not have an exact date
  joined_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (club_id, user_id)
);

create index memberships_user_id_idx  on memberships (user_id);
create index memberships_club_id_idx  on memberships (club_id);

create trigger memberships_updated_at
  before update on memberships
  for each row execute function update_updated_at();


-- =============================================================================
-- MEETINGS
-- A single gathering of the club.
-- meeting_number is the club's own sequential counter (e.g. "Meeting #47").
-- counts_for_record=false marks special events that don't affect annual stats.
-- =============================================================================
create table meetings (
  id                  uuid        primary key default gen_random_uuid(),
  club_id             uuid        not null references clubs(id),
  -- nullable: number is assigned when finalized, not at creation time
  meeting_number      integer,
  title               text,
  held_at             timestamptz,
  host_membership_id  uuid        references memberships(id),
  status              text        not null default 'scheduled'
                                  check (status in ('scheduled', 'active', 'completed')),
  counts_for_record   boolean     not null default true,
  notes               text,
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create index meetings_club_id_idx on meetings (club_id);

create trigger meetings_updated_at
  before update on meetings
  for each row execute function update_updated_at();


-- =============================================================================
-- OFFERINGS
-- A normalized reference catalog. Each unique offering (e.g. "Sierra Nevada
-- Torpedo Extra IPA") exists exactly once here, regardless of how many meetings
-- it has been brought to. This is what makes duplicate detection possible.
-- external_id links to Open Brewery DB or other external sources.
-- =============================================================================
create table offerings (
  id          uuid        primary key default gen_random_uuid(),
  club_id     uuid        not null references clubs(id),
  name        text        not null,
  producer    text,
  category    text,
  style       text,
  abv         numeric(4, 1),
  external_id text,
  source      text        not null default 'manual',
  metadata    jsonb       not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Index supports the duplicate check query: "has this club seen this offering?"
create index offerings_club_id_name_idx on offerings (club_id, name);

create trigger offerings_updated_at
  before update on offerings
  for each row execute function update_updated_at();


-- =============================================================================
-- CONTRIBUTIONS
-- Links an offering to a specific meeting — i.e. "someone brought this to
-- that meeting." The unique constraint prevents the same offering appearing
-- twice at the same meeting.
--
-- contributor_id: the member who physically brought the offering
-- actor_id:       the member who entered the data (may differ via proxy entry)
--
-- composite_score is a cached average computed from votes, excluding self-votes.
-- It is recomputed and stored here after each vote is cast.
-- =============================================================================
create table contributions (
  id                   uuid        primary key default gen_random_uuid(),
  meeting_id           uuid        not null references meetings(id),
  offering_id          uuid        not null references offerings(id),
  contributor_id       uuid        not null references memberships(id),
  actor_id             uuid        not null references memberships(id),
  -- nullable until votes are cast
  composite_score      numeric(4, 2),
  is_flagged_duplicate boolean     not null default false,
  -- presentation_order used by Wheel of Fate to track who has/hasn't presented
  presentation_order   integer,
  metadata             jsonb       not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (meeting_id, offering_id)
);

create index contributions_meeting_id_idx  on contributions (meeting_id);
create index contributions_offering_id_idx on contributions (offering_id);

create trigger contributions_updated_at
  before update on contributions
  for each row execute function update_updated_at();


-- =============================================================================
-- VOTES
-- One score per member per contribution. Score is 0–10 in 0.1 increments.
--
-- voter_id:  the member whose score this represents
-- actor_id:  the member who submitted it (identical unless proxy entry)
--
-- is_self_vote: true when voter_id's user_id matches the contribution's
-- contributor_id's user_id. Stored so self-votes can be:
--   - excluded from composite_score
--   - included in Nostradamus/Nostradumbass award calculations
-- =============================================================================
create table votes (
  id              uuid        primary key default gen_random_uuid(),
  contribution_id uuid        not null references contributions(id),
  voter_id        uuid        not null references memberships(id),
  actor_id        uuid        not null references memberships(id),
  score           numeric(3, 1) not null
                  check (score >= 0 and score <= 10),
  is_self_vote    boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  -- one vote per member per contribution
  unique (contribution_id, voter_id)
);

create index votes_contribution_id_idx on votes (contribution_id);
create index votes_voter_id_idx        on votes (voter_id);

create trigger votes_updated_at
  before update on votes
  for each row execute function update_updated_at();
