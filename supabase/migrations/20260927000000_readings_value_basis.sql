-- What a reading's pollutant columns actually hold.
--
-- Sept 2026 finding: data.gov.in's real-time CPCB feed publishes each
-- pollutant's AQI SUB-INDEX (of the trailing-24h mean; 8h for CO/O3), not a
-- concentration. From 2026-08-11 (when that feed became the primary source)
-- until the ingest fix, rows with ingest_source='cpcb' stored those index
-- values in the concentration columns, and CO's index divided by 1000.
--
--   'hourly'       real hourly concentrations (OpenAQ path, incl. the
--                  untagged rows from before ingest_source existed)
--   'naqi_window'  real concentrations averaged over CPCB's AQI window
--                  (24h; 8h for CO/O3), recovered from the sub-index
--   NULL           not yet classified: a legacy CPCB row still holding
--                  sub-indices, until scripts/fix_cpcb_subindex_rows.py
--                  converts it (it only ever touches NULL rows, so it is
--                  safe to re-run)
--
-- Apply BEFORE deploying the ingest code that writes this column.
alter table public.readings
  add column if not exists value_basis text
  check (value_basis in ('hourly', 'naqi_window'));

comment on column public.readings.value_basis is
  'hourly = hourly concentration; naqi_window = CPCB AQI-window average (24h, 8h CO/O3); NULL = legacy CPCB sub-index row awaiting conversion';
