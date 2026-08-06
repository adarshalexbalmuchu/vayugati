-- Phase 1F: update update_incident_location signature to add DEFAULT NULL
-- on the three optional coordinate params so that supabase gen types emits
-- `?: number` (optional) rather than `number` (required) for those args.
-- This lets the TypeScript call site pass `undefined` to clear a location
-- instead of `null`, which avoids a type mismatch without `as any` casts.

CREATE OR REPLACE FUNCTION update_incident_location(
  p_incident_id           bigint,
  p_location_source       text,
  p_confidence            text,
  p_review_reason         text,
  p_new_lat               double precision DEFAULT NULL,
  p_new_lng               double precision DEFAULT NULL,
  p_new_ward_id           bigint           DEFAULT NULL,
  p_review_note           text             DEFAULT NULL,
  p_is_centroid_placement boolean          DEFAULT FALSE
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
  v_caller_role := auth_role();
  IF v_caller_role NOT IN ('commander', 'admin') THEN
    RAISE EXCEPTION 'permission_denied: only commanders and admins may update incident locations';
  END IF;

  IF p_is_centroid_placement THEN
    RAISE EXCEPTION 'centroid_placement_prohibited: ward centroids may not be stored as incident coordinates';
  END IF;

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

  SELECT lat, lng, ward_id
  INTO v_prev_lat, v_prev_lng, v_prev_ward_id
  FROM incidents
  WHERE id = p_incident_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident_not_found: %', p_incident_id;
  END IF;

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

GRANT EXECUTE ON FUNCTION update_incident_location TO authenticated;
