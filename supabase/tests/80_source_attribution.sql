-- Phase 7: probable-source attribution (calculate_incident_source_attribution,
-- run_incident_source_attribution, get_incident_responsible_authority).
--
-- Same isolation discipline as 70_anomaly_detection.sql: every scenario gets
-- its own dedicated city_config row (own attribution weights), so one
-- scenario's fixtures cannot contaminate another's baseline/registry
-- lookups. `weights.data_quality_penalty` is set to 0 in most scenarios
-- below so each test isolates the ONE mechanism it's naming — the
-- data-quality-penalty mechanic itself is exercised directly by test 68
-- (which uses genuinely zero evidence of every kind, so it lands on
-- "unresolved" regardless of that weight).
--
-- `rush_hour_windows` is set to a permanently-open window ([[0,23]]) in every
-- scenario so the vehicular temporal-match score does not depend on the
-- wall-clock time the test suite happens to run at.

grant execute on function calculate_incident_source_attribution(bigint, boolean) to authenticated;
grant execute on function run_incident_source_attribution(text, boolean) to authenticated;
grant execute on function get_incident_responsible_authority(bigint) to authenticated;

-- shared config fragment used by most scenarios below (data_quality_penalty=0)
-- inlined per-test rather than templated: this file follows
-- 70_anomaly_detection.sql's own established style of one self-contained
-- do-block per scenario.

select 'TEST 61: proximity alone does not prove a source' as t;
do $$
declare v_city bigint; v_ward bigint; v_incident bigint; v_conf source_confidence_level; v_gis double precision;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t61', 'Test City 61', array['pm25','pm10','no2'],
     jsonb_build_object('attribution', jsonb_build_object(
       'source_categories', jsonb_build_array('road_dust','construction_dust','vehicular','open_burning','industrial','regional_transport'),
       'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
       'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)),
       'confidence_threshold',0.45,'ambiguity_gap',0.12,'min_total_score_for_resolution',0.05,'corroboration_min_env_score',0.3)))
    returning id into v_city;
  insert into wards (name, city_id) values ('t61-a', v_city) returning id into v_ward;
  insert into responsibility_registry (city_id, source_category, ward_id, asset_description, regulating_authority)
    values (v_city, 'road_dust', v_ward, 'test road', 'test authority');
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 61') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);

  select confidence_level, (evidence_scores ->> 'gis_proximity')::double precision
    into v_conf, v_gis
  from incident_source_hypotheses
  where incident_id = v_incident and source_category = 'road_dust' and is_current;

  if v_gis > 0 and v_conf = 'suspected' then
    raise notice '61 PASS: GIS proximity evidence was used (%) but did not on its own raise confidence past suspected', round(v_gis::numeric, 2);
  else
    raise notice '61 FAIL: gis=%, confidence=%', v_gis, v_conf;
  end if;
end $$;

select 'TEST 62: one citizen report does not corroborate a source' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_report bigint; v_citizen_score double precision;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t62', 'Test City 62', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t62-a', v_city) returning id into v_ward;
  -- a real (non-citizen) pollutant signature, so this scenario stays in the
  -- normal branch — isolating "does one citizen report corroborate?" from
  -- "is there enough evidence to say anything at all?" (that's test 68).
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't62 station', 'regulatory') returning id into v_station;
  insert into readings (station_id, ts, pm25, pm10) values (v_station, now() - interval '30 minutes', 40, 200);
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 62') returning id into v_incident;
  insert into reports (ward_id, ai_category, description, incident_id, reporter_id) values
    (v_ward, 'road_dust', 'dust report', v_incident, '11111111-1111-1111-1111-111111111111') returning id into v_report;

  perform calculate_incident_source_attribution(v_incident, true);

  select (evidence_scores ->> 'citizen_corroboration')::double precision into v_citizen_score
  from incident_source_hypotheses where incident_id = v_incident and source_category = 'road_dust' and is_current;

  if v_citizen_score = 0 and exists (
    select 1 from incident_source_hypotheses
    where incident_id = v_incident and source_category = 'road_dust' and is_current
      and missing_evidence @> '["Only one citizen report names this category — a single report cannot corroborate a source."]'::jsonb
  ) then
    raise notice '62 PASS: a single citizen report scored zero citizen-corroboration evidence and was recorded as missing (not corroborating)';
  else
    raise notice '62 FAIL: citizen_score=%', v_citizen_score;
  end if;
end $$;

select 'TEST 63: two independent reporters add real corroborating evidence (env + citizen -> corroborated)' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_conf source_confidence_level; v_citizen_score double precision;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t63', 'Test City 63', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)),
         'corroboration_min_env_score', 0.3)))
    returning id into v_city;
  insert into wards (name, city_id) values ('t63-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't63 station', 'regulatory') returning id into v_station;
  insert into readings (station_id, ts, pm25, pm10) values (v_station, now() - interval '30 minutes', 40, 200);
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 63') returning id into v_incident;
  insert into reports (ward_id, ai_category, description, incident_id, reporter_id) values
    (v_ward, 'road_dust', 'dust report 1', v_incident, '11111111-1111-1111-1111-111111111111'),
    (v_ward, 'road_dust', 'dust report 2', v_incident, '22222222-2222-2222-2222-222222222222');

  perform calculate_incident_source_attribution(v_incident, true);

  select confidence_level, (evidence_scores ->> 'citizen_corroboration')::double precision
    into v_conf, v_citizen_score
  from incident_source_hypotheses where incident_id = v_incident and source_category = 'road_dust' and is_current;

  if v_citizen_score > 0 and v_conf = 'corroborated' then
    raise notice '63 PASS: two independent reporters (score %) combined with a pollutant signature reached corroborated', round(v_citizen_score::numeric, 2);
  else
    raise notice '63 FAIL: citizen_score=%, confidence=%', v_citizen_score, v_conf;
  end if;
end $$;

select 'TEST 64: PM10-heavy + upwind road evidence ranks dust appropriately' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_top text;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t64', 'Test City 64', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250,'no2',180,'so2',380,'co',4)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t64-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type, lat, lng) values (v_ward, 't64 station', 'regulatory', 28.6, 77.1) returning id into v_station;
  insert into readings (station_id, ts, pm25, pm10, no2, so2) values (v_station, now() - interval '30 minutes', 40, 200, 20, 5);
  insert into attributions (ward_id, ts, direction, breakdown) values (v_ward, now() - interval '1 hour', 'NW', '{}'::jsonb);
  -- road_dust gets a ward-level registry match (gis + wind); construction_dust gets none —
  -- both share the same PM ratio signature, so the extra evidence should make road_dust rank higher.
  insert into responsibility_registry (city_id, source_category, ward_id) values (v_city, 'road_dust', v_ward);
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 64') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);

  select source_category::text into v_top
  from incident_source_hypotheses where incident_id = v_incident and is_current
  order by probability desc limit 1;

  if v_top = 'road_dust' then
    raise notice '64 PASS: road_dust ranked top (PM10/PM2.5 signature + registry + wind), ahead of construction_dust which shares only the pollutant signature';
  else
    raise notice '64 FAIL: top category was %', v_top;
  end if;
end $$;

select 'TEST 65: NO2/CO + major-road alignment ranks traffic (vehicular) appropriately' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_top text;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t65', 'Test City 65', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250,'no2',180,'so2',380,'co',4)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t65-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't65 station', 'regulatory') returning id into v_station;
  insert into readings (station_id, ts, pm25, pm10, no2, co) values (v_station, now() - interval '30 minutes', 50, 100, 190, 4200);
  insert into attributions (ward_id, ts, direction, breakdown) values (v_ward, now() - interval '1 hour', 'NW', '{}'::jsonb);
  insert into responsibility_registry (city_id, source_category, ward_id) values (v_city, 'vehicular', v_ward);
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 65') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);

  select source_category::text into v_top
  from incident_source_hypotheses where incident_id = v_incident and is_current
  order by probability desc limit 1;

  if v_top = 'vehicular' then
    raise notice '65 PASS: vehicular (traffic emissions) ranked top from elevated NO2/CO + road registry/wind alignment';
  else
    raise notice '65 FAIL: top category was %', v_top;
  end if;
end $$;

select 'TEST 66: multi-station simultaneous rise with low local excess ranks regional transport' as t;
do $$
declare v_city bigint; v_ward bigint; v_ward2 bigint; v_station1 bigint; v_station2 bigint; v_incident bigint; v_top text; v_regional_score double precision;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t66', 'Test City 66', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)),
         'regional_local_excess_max', 15, 'regional_min_station_fraction', 0.5, 'regional_pattern_score', 1.0)))
    returning id into v_city;
  insert into wards (name, city_id) values ('t66-a', v_city) returning id into v_ward;
  insert into wards (name, city_id) values ('t66-b', v_city) returning id into v_ward2;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't66 station a', 'regulatory') returning id into v_station1;
  insert into stations (ward_id, name, sensor_type) values (v_ward2, 't66 station b', 'regulatory') returning id into v_station2;
  -- both stations elevated above the pm25 threshold (90) -> city-wide elevated fraction = 1.0
  insert into readings (station_id, ts, pm25) values (v_station1, now() - interval '30 minutes', 110);
  insert into readings (station_id, ts, pm25) values (v_station2, now() - interval '30 minutes', 105);
  insert into incidents (city_id, ward_id, status, detection_method, primary_pollutant, summary)
    values (v_city, v_ward, 'detected', 'manual', 'pm25', 'test 66') returning id into v_incident;
  -- low local excess (well under regional_local_excess_max=15) — the genuine
  -- signal this repo actually stores for "not a local hotspot"
  insert into anomaly_candidates (city_id, ward_id, station_id, incident_id, pollutant, current_concentration, local_excess, triggered_rules)
    values (v_city, v_ward, v_station1, v_incident, 'pm25', 110, 5, '["concentration_threshold"]'::jsonb);

  perform calculate_incident_source_attribution(v_incident, true);

  select source_category::text into v_top
  from incident_source_hypotheses where incident_id = v_incident and is_current
  order by probability desc limit 1;
  select (evidence_scores ->> 'regional_pattern')::double precision into v_regional_score
  from incident_source_hypotheses where incident_id = v_incident and source_category = 'regional_transport' and is_current;

  if v_top = 'regional_transport' and v_regional_score > 0 then
    raise notice '66 PASS: regional_transport ranked top (regional_pattern score %) from a city-wide simultaneous rise with low local excess', round(v_regional_score::numeric, 2);
  else
    raise notice '66 FAIL: top=%, regional_pattern_score=%', v_top, v_regional_score;
  end if;
end $$;

select 'TEST 67: contradictory field evidence reduces confidence relative to an identical incident without it' as t;
do $$
declare v_city bigint; v_ward_a bigint; v_ward_b bigint; v_station_a bigint; v_station_b bigint;
        v_incident_a bigint; v_incident_b bigint; v_mission bigint; v_evidence bigint;
        v_raw_a double precision; v_raw_b double precision; v_contra double precision;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t67', 'Test City 67', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t67-a', v_city) returning id into v_ward_a;
  insert into wards (name, city_id) values ('t67-b', v_city) returning id into v_ward_b;
  insert into stations (ward_id, name, sensor_type) values (v_ward_a, 't67 station a', 'regulatory') returning id into v_station_a;
  insert into stations (ward_id, name, sensor_type) values (v_ward_b, 't67 station b', 'regulatory') returning id into v_station_b;
  insert into readings (station_id, ts, pm25, pm10) values (v_station_a, now() - interval '30 minutes', 40, 200);
  insert into readings (station_id, ts, pm25, pm10) values (v_station_b, now() - interval '30 minutes', 40, 200);

  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward_a, 'detected', 'manual', 'test 67a (no contradiction)') returning id into v_incident_a;
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward_b, 'detected', 'manual', 'test 67b (with contradiction)') returning id into v_incident_b;

  -- incident B gets a field inspection (construction_check mission) that did NOT confirm construction_dust
  insert into evidence_missions (incident_id, mission_type, status) values (v_incident_b, 'construction_check', 'completed') returning id into v_mission;
  insert into incident_evidence (incident_id, evidence_type, supports, payload)
    values (v_incident_b, 'field_inspection', false, jsonb_build_object('mission_id', v_mission)) returning id into v_evidence;

  perform calculate_incident_source_attribution(v_incident_a, true);
  perform calculate_incident_source_attribution(v_incident_b, true);

  select (evidence_scores ->> 'raw_score')::double precision into v_raw_a
  from incident_source_hypotheses where incident_id = v_incident_a and source_category = 'construction_dust' and is_current;
  select (evidence_scores ->> 'raw_score')::double precision, (evidence_scores ->> 'contradiction_penalty')::double precision
    into v_raw_b, v_contra
  from incident_source_hypotheses where incident_id = v_incident_b and source_category = 'construction_dust' and is_current;

  if v_contra > 0 and v_raw_b < v_raw_a then
    raise notice '67 PASS: contradictory field evidence (penalty %) reduced construction_dust''s raw score (% vs %)', round(v_contra::numeric, 2), round(v_raw_b::numeric, 3), round(v_raw_a::numeric, 3);
  else
    raise notice '67 FAIL: raw_a=%, raw_b=%, contra=%', v_raw_a, v_raw_b, v_contra;
  end if;
end $$;

select 'TEST 68: poor data quality (no evidence of any kind) produces an unresolved, low-confidence output' as t;
do $$
declare v_city bigint; v_ward bigint; v_incident bigint; v_cat text; v_prob double precision; v_n int;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t68', 'Test City 68', array['pm25','pm10','no2'], '{}'::jsonb)
    returning id into v_city;
  insert into wards (name, city_id) values ('t68-a', v_city) returning id into v_ward;
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 68') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);

  select count(*) into v_n from incident_source_hypotheses where incident_id = v_incident and is_current;
  select source_category::text, probability into v_cat, v_prob
  from incident_source_hypotheses where incident_id = v_incident and is_current limit 1;

  if v_n = 1 and v_cat = 'unresolved' and v_prob = 1.0 then
    raise notice '68 PASS: zero evidence of any kind produced a single unresolved hypothesis, not a confident guess';
  else
    raise notice '68 FAIL: n=%, category=%, probability=%', v_n, v_cat, v_prob;
  end if;
end $$;

select 'TEST 69: a verified human finding is not overwritten by model recalculation' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_verified_id bigint;
        v_prob_before double precision; v_prob_after double precision; v_n int;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t69', 'Test City 69', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('so2',380,'no2',180)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t69-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't69 station', 'regulatory') returning id into v_station;
  insert into readings (station_id, ts, so2, no2) values (v_station, now() - interval '30 minutes', 400, 200);
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 69') returning id into v_incident;

  -- a human/officer already officially verified 'industrial' for this incident
  insert into incident_source_hypotheses (incident_id, source_category, probability, confidence_level, rationale, model_version, is_current)
    values (v_incident, 'industrial', 0.91, 'officially_verified', 'Officer-confirmed on site visit.', 'manual_officer_confirmation', true)
    returning id into v_verified_id;
  select probability into v_prob_before from incident_source_hypotheses where id = v_verified_id;

  perform calculate_incident_source_attribution(v_incident, true);

  select probability into v_prob_after from incident_source_hypotheses where id = v_verified_id;
  select count(*) into v_n from incident_source_hypotheses
    where incident_id = v_incident and source_category = 'industrial' and is_current;

  if v_prob_after = v_prob_before
     and (select confidence_level from incident_source_hypotheses where id = v_verified_id) = 'officially_verified'
     and (select is_current from incident_source_hypotheses where id = v_verified_id) = true
     and v_n = 1
  then
    raise notice '69 PASS: officially_verified industrial hypothesis (probability %) untouched by recalculation, still the only current row for that category', v_prob_after;
  else
    raise notice '69 FAIL: before=%, after=%, current_rows_for_category=%', v_prob_before, v_prob_after, v_n;
  end if;
end $$;

select 'TEST 70: top-two ambiguity creates a recommended evidence mission' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_n int;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t70', 'Test City 70', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250,'no2',180)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)),
         'ambiguity_gap', 0.5, 'confidence_threshold', 0.99)))
    returning id into v_city;
  insert into wards (name, city_id) values ('t70-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't70 station', 'regulatory') returning id into v_station;
  insert into readings (station_id, ts, pm25, pm10) values (v_station, now() - interval '30 minutes', 40, 200);
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 70') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);

  select count(*) into v_n from evidence_missions
  where incident_id = v_incident and status = 'proposed' and rationale like 'Automated attribution:%';

  if v_n >= 1 then
    raise notice '70 PASS: an ambiguous/low-confidence result generated % recommended evidence mission(s)', v_n;
  else
    raise notice '70 FAIL: no recommendation generated';
  end if;
end $$;

select 'TEST 71: a regional-classified incident does not produce local responsibility routing' as t;
do $$
declare v_city bigint; v_ward bigint; v_incident bigint; v_confidence double precision; v_note text;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values ('t71', 'Test City 71', array['pm25'], '{}'::jsonb) returning id into v_city;
  insert into wards (name, city_id) values ('t71-a', v_city) returning id into v_ward;
  insert into incidents (city_id, ward_id, status, detection_method, summary, classification, classification_source)
    values (v_city, v_ward, 'detected', 'manual', 'test 71', 'regional', 'model') returning id into v_incident;
  insert into incident_source_hypotheses (incident_id, source_category, probability, confidence_level, is_current)
    values (v_incident, 'road_dust', 0.4, 'suspected', true);

  select routing_confidence, note into v_confidence, v_note from get_incident_responsible_authority(v_incident);

  if v_confidence = 0 and v_note ilike '%regional%' then
    raise notice '71 PASS: regional classification suppressed local routing confidence (note: %)', v_note;
  else
    raise notice '71 FAIL: confidence=%, note=%', v_confidence, v_note;
  end if;
end $$;

select 'TEST 72: citizens cannot read source hypotheses or responsibility routing' as t;
do $$
declare v_city bigint; v_ward bigint; v_incident bigint; v_n int; v_rows int;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values ('t72', 'Test City 72', array['pm25'], '{}'::jsonb) returning id into v_city;
  insert into wards (name, city_id) values ('t72-a', v_city) returning id into v_ward;
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 72') returning id into v_incident;
  insert into incident_source_hypotheses (incident_id, source_category, probability, confidence_level, is_current, missing_evidence)
    values (v_incident, 'industrial', 0.6, 'suspected', true, '["internal note"]'::jsonb);
  insert into responsibility_registry (city_id, source_category, ward_id, owner_name)
    values (v_city, 'industrial', v_ward, 'Some Facility Pvt Ltd');

  set role authenticated;
  perform as_user('11111111-1111-1111-1111-111111111111');
  select count(*) into v_n from incident_source_hypotheses where incident_id = v_incident;
  select count(*) into v_rows from get_incident_responsible_authority(v_incident);
  reset role;
  -- clear the leftover jwt-claims GUC (session-level, survives `reset role`)
  -- so later tests in THIS SAME session see an unauthenticated context again,
  -- exactly like a fresh connection would.
  perform as_user(null);

  if v_n = 0 and v_rows = 0 then
    raise notice '72 PASS: citizen reads zero hypothesis rows and zero responsibility-routing rows for this incident';
  else
    raise notice '72 FAIL: hypotheses visible=%, routing rows visible=%', v_n, v_rows;
  end if;
end $$;

select 'TEST 73: calculation is idempotent (stable top category/probability across repeated runs, no duplicate current rows)' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint;
        v_top1 text; v_prob1 double precision; v_top2 text; v_prob2 double precision; v_dupes int;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t73', 'Test City 73', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t73-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't73 station', 'regulatory') returning id into v_station;
  insert into readings (station_id, ts, pm25, pm10) values (v_station, now() - interval '30 minutes', 40, 200);
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 73') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);
  select source_category::text, probability into v_top1, v_prob1
  from incident_source_hypotheses where incident_id = v_incident and is_current order by probability desc limit 1;

  perform calculate_incident_source_attribution(v_incident, true);
  select source_category::text, probability into v_top2, v_prob2
  from incident_source_hypotheses where incident_id = v_incident and is_current order by probability desc limit 1;

  select count(*) into v_dupes
  from (select source_category, count(*) c from incident_source_hypotheses
        where incident_id = v_incident and is_current group by source_category having count(*) > 1) x;

  if v_top1 = v_top2 and abs(v_prob1 - v_prob2) < 0.001 and v_dupes = 0 then
    raise notice '73 PASS: repeated recalculation is stable (% at % both times) with no duplicate current rows', v_top1, round(v_prob1::numeric, 3);
  else
    raise notice '73 FAIL: top1=%/%, top2=%/%, dupes=%', v_top1, round(v_prob1::numeric, 3), v_top2, round(v_prob2::numeric, 3), v_dupes;
  end if;
end $$;

select 'TEST 74: the migration''s new enum labels and Delhi seed are exactly-once (additive + idempotent)' as t;
do $$
declare v_labels int; v_registry int;
begin
  select count(*) into v_labels from pg_enum e join pg_type t on t.oid = e.enumtypid
  where t.typname = 'source_category' and e.enumlabel in ('regional_transport','mixed','unresolved');
  select count(*) into v_registry from responsibility_registry rr join city_config c on c.id = rr.city_id
  where c.city_code = 'delhi' and rr.source_category = 'road_dust' and rr.ward_id is null;

  if v_labels = 3 and v_registry = 1 then
    raise notice '74 PASS: exactly 3 new source_category labels and exactly 1 Delhi road_dust registry seed row (no duplicates from re-applying the migration)';
  else
    raise notice '74 FAIL: labels=%, registry_rows=%', v_labels, v_registry;
  end if;
end $$;

select 'TEST 75: only a commander/admin (or an unauthenticated service context) may run attribution' as t;
do $$
declare v_city bigint; v_ward bigint; v_incident bigint;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values ('t75', 'Test City 75', array['pm25'], '{}'::jsonb) returning id into v_city;
  insert into wards (name, city_id) values ('t75-a', v_city) returning id into v_ward;
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 75') returning id into v_incident;

  set role authenticated;
  perform as_user('11111111-1111-1111-1111-111111111111');
  begin
    perform calculate_incident_source_attribution(v_incident, true);
    raise notice '75a FAIL: citizen ran source attribution';
  exception when insufficient_privilege then raise notice '75a PASS: blocked (citizen)';
  end;

  perform as_user('44444444-4444-4444-4444-444444444444');
  begin
    perform calculate_incident_source_attribution(v_incident, true);
    raise notice '75b PASS: commander can run source attribution directly';
  exception when insufficient_privilege then raise notice '75b FAIL: commander was blocked';
  end;
  reset role;
  perform as_user(null);
end $$;
