-- Phase 11: pilot validation — the source-attribution scenarios plan §6
-- asks for that are NOT already covered by 80_source_attribution.sql's
-- tests 61-75 (road_dust, construction_dust, vehicular, regional_transport,
-- contradictory evidence, insufficient evidence/unresolved, and
-- verified-human-finding protection are all already tested there — see
-- docs/HISTORICAL_REPLAY_REPORT.md / END_TO_END_TEST_REPORT.md for the
-- cross-reference rather than re-testing the same mechanism twice). This
-- file adds exactly the three genuinely missing scenarios: open_burning,
-- industrial combustion, and mixed/ambiguous evidence with no clear
-- winner — plus one check that responsibility mapping degrades honestly
-- (unresolved, not a guess) when the registry has no matching row for a
-- resolved category.
--
-- Every scenario here is SYNTHETIC (deterministic, fixed reading values
-- chosen to exercise one specific scoring path) — labelled as such per
-- plan §6's own requirement, not presented as real-world accuracy
-- evidence. Same isolation discipline as every other SQL test file in
-- this repo: one dedicated city_config row per scenario.

grant execute on function calculate_incident_source_attribution(bigint, boolean) to authenticated;
grant execute on function get_incident_responsible_authority(bigint) to authenticated;

select 'TEST 121 (synthetic): elevated PM2.5+CO together ranks open_burning appropriately' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_top text; v_note text;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t121', 'Test City 121', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250,'no2',180,'so2',380,'co',4)),
       'attribution', jsonb_build_object(
         'source_categories', jsonb_build_array('road_dust','construction_dust','vehicular','open_burning','industrial','regional_transport'),
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t121-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't121 station', 'regulatory') returning id into v_station;
  -- pm25 and co both well above threshold together; no2/so2 left low so
  -- vehicular/industrial signatures don't also fire on the same reading.
  insert into readings (station_id, ts, pm25, pm10, no2, so2, co) values (v_station, now() - interval '30 minutes', 200, 220, 40, 20, 6000);
  insert into responsibility_registry (city_id, source_category, ward_id, asset_description) values (v_city, 'open_burning', v_ward, 'test burning site');
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 121 (synthetic)') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);

  select source_category::text into v_top
  from incident_source_hypotheses where incident_id = v_incident and is_current
  order by probability desc limit 1;

  select rationale into v_note from incident_source_hypotheses
  where incident_id = v_incident and source_category = 'open_burning' and is_current;

  if v_top = 'open_burning' then
    raise notice '121 PASS (synthetic): open_burning ranked top from elevated PM2.5+CO together (note: %)', v_note;
  else
    raise exception '121 FAIL: top category was %', v_top;
  end if;
end $$;

select 'TEST 122 (synthetic): elevated SO2+NO2 together ranks industrial appropriately' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_top text;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t122', 'Test City 122', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250,'no2',180,'so2',380,'co',4)),
       'attribution', jsonb_build_object(
         'source_categories', jsonb_build_array('road_dust','construction_dust','vehicular','open_burning','industrial','regional_transport'),
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t122-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't122 station', 'regulatory') returning id into v_station;
  -- so2 and no2 both well above threshold together; pm25/co left low so
  -- open_burning/vehicular signatures don't also fire on the same reading.
  insert into readings (station_id, ts, pm25, pm10, no2, so2, co) values (v_station, now() - interval '30 minutes', 40, 60, 200, 420, 1000);
  insert into responsibility_registry (city_id, source_category, ward_id, asset_description) values (v_city, 'industrial', v_ward, 'test industrial unit');
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 122 (synthetic)') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);

  select source_category::text into v_top
  from incident_source_hypotheses where incident_id = v_incident and is_current
  order by probability desc limit 1;

  if v_top = 'industrial' then
    raise notice '122 PASS (synthetic): industrial ranked top from elevated SO2+NO2 together';
  else
    raise exception '122 FAIL: top category was %', v_top;
  end if;
end $$;

select 'TEST 123 (synthetic): genuinely mixed/ambiguous evidence produces no false-confident single winner' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint;
  v_top_prob double precision; v_second_prob double precision; v_gap double precision;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t123', 'Test City 123', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250,'no2',180,'so2',380,'co',4)),
       'attribution', jsonb_build_object(
         'source_categories', jsonb_build_array('road_dust','construction_dust','vehicular','open_burning','industrial','regional_transport'),
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)),
         'confidence_threshold', 0.45, 'ambiguity_gap', 0.12)))
    returning id into v_city;
  insert into wards (name, city_id) values ('t123-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't123 station', 'regulatory') returning id into v_station;
  -- PM10-heavy (dust signature) AND NO2/CO elevated (vehicular signature)
  -- together, with matching registry rows for BOTH categories — a
  -- deliberately ambiguous reading with two comparably-supported
  -- hypotheses, neither of which should be reported with false certainty.
  insert into readings (station_id, ts, pm25, pm10, no2, co) values (v_station, now() - interval '30 minutes', 140, 260, 190, 4200);
  insert into responsibility_registry (city_id, source_category, ward_id) values (v_city, 'road_dust', v_ward);
  insert into responsibility_registry (city_id, source_category, ward_id) values (v_city, 'vehicular', v_ward);
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 123 (synthetic)') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);

  select probability into v_top_prob from incident_source_hypotheses
    where incident_id = v_incident and is_current order by probability desc limit 1;
  select probability into v_second_prob from incident_source_hypotheses
    where incident_id = v_incident and is_current order by probability desc offset 1 limit 1;
  v_gap := v_top_prob - coalesce(v_second_prob, 0);

  if v_second_prob is not null and v_gap < 0.15 then
    raise notice '123 PASS (synthetic): top two hypotheses are genuinely close (gap=%) — no false single-winner certainty', round(v_gap::numeric, 2);
  else
    raise exception '123 FAIL: top=%, second=%, gap=% — evidence was not actually ambiguous as designed',
      round(v_top_prob::numeric, 2), round(coalesce(v_second_prob,0)::numeric, 2), round(v_gap::numeric, 2);
  end if;
end $$;

select 'TEST 124: responsibility mapping degrades to an honest note, never a guess, when no registry row matches a resolved category' as t;
do $$
declare v_city bigint; v_ward bigint; v_station bigint; v_incident bigint; v_authority text; v_note text;
begin
  insert into city_config (city_code, name, pollutant_priority, config) values
    ('t124', 'Test City 124', array['pm25','pm10','no2'],
     jsonb_build_object(
       'anomaly_detection', jsonb_build_object('pollutant_thresholds', jsonb_build_object('pm25',90,'pm10',250,'no2',180,'so2',380,'co',4)),
       'attribution', jsonb_build_object(
         'weights', jsonb_build_object('pollutant_signature',0.35,'wind_alignment',0.15,'gis_proximity',0.15,'temporal_match',0.05,'citizen_corroboration',0.15,'field_verification',0.25,'regional_pattern',0.20,'contradiction_penalty',0.35,'data_quality_penalty',0),
         'rush_hour_windows', jsonb_build_array(jsonb_build_array(0,23)))))
    returning id into v_city;
  insert into wards (name, city_id) values ('t124-a', v_city) returning id into v_ward;
  insert into stations (ward_id, name, sensor_type) values (v_ward, 't124 station', 'regulatory') returning id into v_station;
  insert into readings (station_id, ts, pm25, pm10, no2, co) values (v_station, now() - interval '30 minutes', 40, 260, 40, 1000);
  -- deliberately NO responsibility_registry row for this city at all
  insert into incidents (city_id, ward_id, status, detection_method, summary)
    values (v_city, v_ward, 'detected', 'manual', 'test 124') returning id into v_incident;

  perform calculate_incident_source_attribution(v_incident, true);
  select regulating_authority, note into v_authority, v_note from get_incident_responsible_authority(v_incident);

  if v_authority is null and v_note is not null then
    raise notice '124 PASS: no registry match produced an honest explanatory note (%) instead of a fabricated authority', v_note;
  else
    raise exception '124 FAIL: authority=%, note=%', v_authority, v_note;
  end if;
end $$;
