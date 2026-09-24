-- =============================================================================
-- Migration: 20260511000003_fix_log_offering_overload.sql
--
-- The original log_offering had 5 parameters. The demo_prep and prereg
-- migrations added a 6th (p_contributor_membership_id), but PostgreSQL treats
-- these as two separate overloaded functions rather than a replacement.
-- PostgREST cannot resolve the ambiguity and throws a "best candidate" error.
--
-- Fix: drop the old 5-param overload so only the current 6-param version exists.
-- =============================================================================

drop function if exists log_offering(uuid, text, text, text, numeric);
