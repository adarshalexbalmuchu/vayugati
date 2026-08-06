-- Phase 1F security hardening (take 2): trigger guard on incident location columns
--
-- Column-level REVOKE (migration 20260805000001) does not work when the role
-- already holds a table-level UPDATE grant — PostgreSQL column privileges are
-- additive, not subtractive. The REVOKE in 000001 is harmless but ineffective.
--
-- This migration adds a BEFORE UPDATE trigger that enforces the restriction at
-- the row level instead. The trigger checks current_user:
--
--   • update_incident_location RPC — SECURITY DEFINER, owned by postgres
--     (a superuser). Inside the RPC, current_user = 'postgres'. Trigger allows.
--
--   • Direct UPDATE from an application role — current_user = 'authenticated'
--     or 'anon', neither of which is a superuser. Trigger blocks.
--
-- This makes the audit trail genuinely immutable from every application-
-- reachable path, regardless of the table-level grant.

CREATE OR REPLACE FUNCTION guard_incident_location_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rpc_owner text;
BEGIN
  IF (
    NEW.lat                      IS DISTINCT FROM OLD.lat                      OR
    NEW.lng                      IS DISTINCT FROM OLD.lng                      OR
    NEW.coordinate_source        IS DISTINCT FROM OLD.coordinate_source        OR
    NEW.coordinate_confidence    IS DISTINCT FROM OLD.coordinate_confidence    OR
    NEW.coordinate_review_status IS DISTINCT FROM OLD.coordinate_review_status OR
    NEW.coordinate_reviewed_by   IS DISTINCT FROM OLD.coordinate_reviewed_by   OR
    NEW.coordinate_reviewed_at   IS DISTINCT FROM OLD.coordinate_reviewed_at   OR
    NEW.coordinate_review_reason IS DISTINCT FROM OLD.coordinate_review_reason OR
    NEW.coordinate_review_note   IS DISTINCT FROM OLD.coordinate_review_note
  ) THEN
    -- Only the update_incident_location RPC may write these columns.
    -- That function is SECURITY DEFINER so it executes as its owner (postgres).
    -- Direct writes from application roles (authenticated, anon) have
    -- current_user != owner and are rejected here.
    --
    -- Note: rolsuper is NOT used because Supabase cloud limits the postgres
    -- role and does not grant it superuser status. Checking the RPC owner
    -- directly is more portable and does not depend on role attributes.
    SELECT proowner::regrole::text INTO v_rpc_owner
    FROM pg_proc
    WHERE proname = 'update_incident_location'
    LIMIT 1;

    IF current_user != v_rpc_owner THEN
      RAISE EXCEPTION
        'permission_denied: location columns must be updated via the update_incident_location RPC';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Drop first so this migration is idempotent
DROP TRIGGER IF EXISTS incidents_guard_location_columns ON incidents;

CREATE TRIGGER incidents_guard_location_columns
  BEFORE UPDATE ON incidents
  FOR EACH ROW
  EXECUTE FUNCTION guard_incident_location_columns();
