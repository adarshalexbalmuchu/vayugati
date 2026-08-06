-- Phase 1F security hardening: protect incident location columns from direct write
--
-- The incidents_update RLS policy allows field officers to UPDATE incidents in
-- their ward, and commanders/admins to UPDATE any incident. That policy was
-- written before the coordinate-provenance columns existed and grants UPDATE on
-- the whole row — including the new lat/lng/coordinate_* columns added in
-- migration 20260805000000.
--
-- This means a field officer (or even a commander using the Supabase client
-- directly) can bypass the update_incident_location RPC and write coordinates
-- without producing an audit row. That breaks the immutable provenance
-- guarantee that Phase 1F is built on.
--
-- Fix: revoke column-level UPDATE rights on every location column from the
-- authenticated role. The SECURITY DEFINER RPC runs as its OWNER (postgres /
-- supabase_admin), not as authenticated, so it is unaffected by this revoke.
-- All other incident columns remain writable as before.

REVOKE UPDATE (
  lat,
  lng,
  coordinate_source,
  coordinate_confidence,
  coordinate_review_status,
  coordinate_reviewed_by,
  coordinate_reviewed_at,
  coordinate_review_reason,
  coordinate_review_note
) ON incidents FROM authenticated;

-- Defensive: also revoke from anon (should never reach UPDATE at all due to
-- RLS, but belt-and-braces in case a future policy change widens access)
REVOKE UPDATE (
  lat,
  lng,
  coordinate_source,
  coordinate_confidence,
  coordinate_review_status,
  coordinate_reviewed_by,
  coordinate_reviewed_at,
  coordinate_review_reason,
  coordinate_review_note
) ON incidents FROM anon;
