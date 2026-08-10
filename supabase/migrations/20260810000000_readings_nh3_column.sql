-- NH3 (ammonia) µg/m³ from CPCB monitoring. Nullable — only populated when
-- CPCB reports it; contributes to compute_aqi() sub-index alongside the
-- existing pm25/pm10/no2/so2/co/o3 columns.
alter table readings add column if not exists nh3 double precision;
