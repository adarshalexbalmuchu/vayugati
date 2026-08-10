-- 8 new CPCB stations identified from cpcb_unmatched_stations in health check
-- (2026-08-10). Coordinates from CPCB data.gov.in API. Ward assignments from
-- point-in-polygon against delhi_wards.geojson + delhi_non_mcd_jurisdictions.geojson.
--
-- Safety classification (60m threshold, same as delhi-station-geospatial-ward-
-- assignment.md): 6 SAFE, 2 NEAR-BOUNDARY (Chandni Chowk 32m, IIT Delhi 27m).
-- Both near-boundary cases accepted at same precedent as ITO (30m, already live).
-- Talkatora Garden and Cantonment Area both sit inside New Delhi (NDMC) and
-- Delhi Cantonment respectively — Cantonment is the correct, specific ward.
-- Talkatora Garden falls inside the oversized New Delhi (NDMC) district polygon
-- (same caveat as the 4 stations already assigned there — see stations.yaml).
--
-- No external_ref (no OpenAQ ID known for these stations). CPCB name-match
-- normalises them on the next ingest cycle and starts writing readings.
-- agency column is intentionally left NULL — the ingest sets it automatically
-- from the CPCB station-name suffix on first successful upsert.

insert into stations (name, ward_id, lat, lng, is_active, sensor_type)
select 'Cantonment Area, Delhi - DPCC', w.id, 28.594169, 77.1251, true, 'regulatory'
from wards w where w.name = 'Delhi Cantonment'
  and not exists (select 1 from stations s where s.name = 'Cantonment Area, Delhi - DPCC');

insert into stations (name, ward_id, lat, lng, is_active, sensor_type)
select 'Chandni Chowk, Delhi - IITM', w.id, 28.656756, 77.227234, true, 'regulatory'
from wards w where w.name = 'CHANDNI CHOWK'
  and not exists (select 1 from stations s where s.name = 'Chandni Chowk, Delhi - IITM');

insert into stations (name, ward_id, lat, lng, is_active, sensor_type)
select 'Commonwealth Sports Complex, Delhi - DPCC', w.id, 28.615828, 77.271992, true, 'regulatory'
from wards w where w.name = 'PANDAV NAGAR'
  and not exists (select 1 from stations s where s.name = 'Commonwealth Sports Complex, Delhi - DPCC');

insert into stations (name, ward_id, lat, lng, is_active, sensor_type)
select 'Talkatora Garden, Delhi - DPCC', w.id, 28.62181, 77.1944633, true, 'regulatory'
from wards w where w.name = 'New Delhi (NDMC)'
  and not exists (select 1 from stations s where s.name = 'Talkatora Garden, Delhi - DPCC');

insert into stations (name, ward_id, lat, lng, is_active, sensor_type)
select 'IGNOU_Maidan Garhi, Delhi - DPCC', w.id, 28.493624, 77.201159, true, 'regulatory'
from wards w where w.name = 'SAID-UL-AJAIB'
  and not exists (select 1 from stations s where s.name = 'IGNOU_Maidan Garhi, Delhi - DPCC');

insert into stations (name, ward_id, lat, lng, is_active, sensor_type)
select 'NSUT Jaffarpur, Delhi - DPCC', w.id, 28.594004, 76.909423, true, 'regulatory'
from wards w where w.name = 'ISAPUR'
  and not exists (select 1 from stations s where s.name = 'NSUT Jaffarpur, Delhi - DPCC');

insert into stations (name, ward_id, lat, lng, is_active, sensor_type)
select 'JNU, Delhi - DPCC', w.id, 28.540721, 77.168544, true, 'regulatory'
from wards w where w.name = 'LADO SARAI'
  and not exists (select 1 from stations s where s.name = 'JNU, Delhi - DPCC');

insert into stations (name, ward_id, lat, lng, is_active, sensor_type)
select 'IIT Delhi, Delhi - IITM', w.id, 28.54246, 77.191651, true, 'regulatory'
from wards w where w.name = 'HAUZ KHAS'
  and not exists (select 1 from stations s where s.name = 'IIT Delhi, Delhi - IITM');
