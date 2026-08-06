-- Phase 1F: Incident Location Audit and Coordinate Remediation
--
-- Adds four things:
--   1. Provenance/confidence columns on the incidents table
--   2. An immutable audit log for every coordinate change
--   3. A security-definer RPC that validates, writes the audit row, and updates
--      the incident in one transaction — so the audit record and the live
--      coordinate are never left inconsistent after a partial failure.
--   4. RLS policies on the new audit table (same role model as incidents).
--
-- Design notes:
--   • coordinate_source and coordinate_confidence are TEXT, not PG ENUMs, so
--     the set can grow without a migration that requires an exclusive lock on
--     the table. Accepted values are documented and validated in the RPC.
--   • The RPC never deletes or overwrites previous audit rows — they accumulate
--     as an append-only provenance chain.
--   • Ward centroid assignment is explicitly PROHIBITED by the RPC: if the
--     caller passes is_centroid_placement = TRUE the transaction rolls back.

-- ── 1. New columns on incidents ───────────────────────────────────────────────

ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS coordinate_source         text,
  ADD COLUMN IF NOT EXISTS coordinate_confidence     text DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS coordinate_review_status  text DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS coordinate_reviewed_by    uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS coordinate_reviewed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS coordinate_review_reason  text,
  ADD COLUMN IF NOT EXISTS coordinate_review_note    text;

-- Back-fill existing incidents that already have coordinates as unknown legacy.
UPDATE incidents
SET
  coordinate_source        = 'unknown_legacy',
  coordinate_confidence    = 'unreviewed',
  coordinate_review_status = 'unreviewed'
WHERE lat IS NOT NULL AND lng IS NOT NULL
  AND coordinate_source IS NULL;

-- ── 2. Audit table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS incident_location_audits (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id         bigint      NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  -- previous state (null when this is a first-time placement)
  previous_lat        double precision,
  previous_lng        double precision,
  previous_ward_id    bigint      REFERENCES wards(id),
  -- new state (null when this is a clear/removal)
  new_lat             double precision,
  new_lng             double precision,
  new_ward_id         bigint      REFERENCES wards(id),
  -- provenance
  location_source     text        NOT NULL,
  confidence          text        NOT NULL,
  review_reason       text        NOT NULL,
  review_note         text,
  -- who/when
  reviewed_by         uuid        NOT NULL REFERENCES auth.users(id),
  reviewed_at         timestamptz NOT NULL DEFAULT now()
);

-- Immutability: no UPDATE or DELETE allowed on audit rows.
ALTER TABLE incident_location_audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "commanders_read_location_audits" ON incident_location_audits
  FOR SELECT USING (auth_role() IN ('commander', 'admin'));

CREATE POLICY "field_officers_read_ward_location_audits" ON incident_location_audits
  FOR SELECT USING (
    auth_role() = 'field_officer'
    AND EXISTS (
      SELECT 1 FROM incidents i
      WHERE i.id = incident_id
        AND i.ward_id = auth_ward()
    )
  );

-- Only the RPC (SECURITY DEFINER) may insert — no direct INSERT policy
-- for any role, so the RPC is the only path in.

-- ── 3. Security-definer RPC ───────────────────────────────────────────────────
--
-- Performs:
--   a. Permission check (commander/admin only)
--   b. Centroid-placement guard
--   c. Basic coordinate sanity check (not 0,0; within [-90,90]/[-180,180])
--   d. Inserts the audit row
--   e. Updates incidents in the same transaction
--
-- Point-in-polygon ward resolution is done CLIENT-SIDE (the ward GeoJSON is
-- already loaded in the browser). The caller must pass the resolved ward_id;
-- this function trusts it but records the full audit chain so any error is
-- recoverable.
--
-- To CLEAR a location: pass p_new_lat / p_new_lng = NULL.
-- To CONFIRM an existing location without moving it: pass the same lat/lng
--   with a 'confirm' review reason and 'verified' confidence.

CREATE OR REPLACE FUNCTION update_incident_location(
  p_incident_id         bigint,
  p_new_lat             double precision,  -- NULL to clear
  p_new_lng             double precision,  -- NULL to clear
  p_new_ward_id         bigint,            -- NULL to clear
  p_location_source     text,
  p_confidence          text,
  p_review_reason       text,
  p_review_note         text   DEFAULT NULL,
  p_is_centroid_placement boolean DEFAULT FALSE  -- must be FALSE; guard against accidental centroid storage
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role   text;
  v_prev_lat      double precision;
  v_prev_lng      double precision;
  v_prev_ward_id  bigint;
BEGIN
  -- Permission
  v_caller_role := auth_role();
  IF v_caller_role NOT IN ('commander', 'admin') THEN
    RAISE EXCEPTION 'permission_denied: only commanders and admins may update incident locations';
  END IF;

  -- Centroid guard: a ward centroid must never be stored as an observed incident location
  IF p_is_centroid_placement THEN
    RAISE EXCEPTION 'centroid_placement_prohibited: ward centroids may not be stored as incident coordinates';
  END IF;

  -- Coordinate sanity (when not clearing)
  IF p_new_lat IS NOT NULL OR p_new_lng IS NOT NULL THEN
    IF p_new_lat IS NULL OR p_new_lng IS NULL THEN
      RAISE EXCEPTION 'invalid_coordinates: both lat and lng must be supplied together, or both NULL to clear';
    END IF;
    IF p_new_lat < -90 OR p_new_lat > 90 THEN
      RAISE EXCEPTION 'invalid_coordinates: lat % is outside [-90,90]', p_new_lat;
    END IF;
    IF p_new_lng < -180 OR p_new_lng > 180 THEN
      RAISE EXCEPTION 'invalid_coordinates: lng % is outside [-180,180]', p_new_lng;
    END IF;
    IF p_new_lat = 0 AND p_new_lng = 0 THEN
      RAISE EXCEPTION 'invalid_coordinates: (0,0) is rejected as a sentinel/default value';
    END IF;
  END IF;

  -- Source / confidence / reason validation
  IF p_location_source NOT IN (
    'device_captured', 'citizen_submitted', 'officer_captured',
    'manually_placed', 'imported', 'address_geocoded',
    'evidence_corrected', 'unknown_legacy', 'confirmed_existing'
  ) THEN
    RAISE EXCEPTION 'invalid_location_source: %', p_location_source;
  END IF;

  IF p_confidence NOT IN ('unreviewed', 'low', 'medium', 'verified') THEN
    RAISE EXCEPTION 'invalid_confidence: %', p_confidence;
  END IF;

  IF p_review_reason NOT IN (
    'address_verified', 'landmark_verified', 'ward_officer_confirmation',
    'photo_or_evidence_verified', 'reporter_confirmation',
    'existing_coordinates_corrected', 'location_cleared', 'location_confirmed', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_review_reason: %', p_review_reason;
  END IF;

  -- Fetch current state
  SELECT lat, lng, ward_id
  INTO v_prev_lat, v_prev_lng, v_prev_ward_id
  FROM incidents
  WHERE id = p_incident_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident_not_found: %', p_incident_id;
  END IF;

  -- Audit record (written first — if the UPDATE below fails the whole
  -- transaction rolls back and the audit row is never committed)
  INSERT INTO incident_location_audits (
    incident_id,
    previous_lat, previous_lng, previous_ward_id,
    new_lat, new_lng, new_ward_id,
    location_source, confidence,
    review_reason, review_note,
    reviewed_by, reviewed_at
  ) VALUES (
    p_incident_id,
    v_prev_lat, v_prev_lng, v_prev_ward_id,
    p_new_lat, p_new_lng, p_new_ward_id,
    p_location_source, p_confidence,
    p_review_reason, p_review_note,
    auth.uid(), now()
  );

  -- Update the incident
  UPDATE incidents SET
    lat                       = p_new_lat,
    lng                       = p_new_lng,
    ward_id                   = COALESCE(p_new_ward_id, ward_id),
    coordinate_source         = p_location_source,
    coordinate_confidence     = p_confidence,
    coordinate_review_status  = CASE
                                  WHEN p_new_lat IS NULL AND p_new_lng IS NULL THEN 'unreviewed'
                                  WHEN p_confidence = 'verified'               THEN 'reviewed'
                                  ELSE 'awaiting_review'
                                END,
    coordinate_reviewed_by    = auth.uid(),
    coordinate_reviewed_at    = now(),
    coordinate_review_reason  = p_review_reason,
    coordinate_review_note    = p_review_note,
    updated_at                = now()
  WHERE id = p_incident_id;
END;
$$;

-- Grant to authenticated users (the permission check inside the body is the
-- real gate — this just makes the RPC callable by logged-in users at all).
GRANT EXECUTE ON FUNCTION update_incident_location TO authenticated;
