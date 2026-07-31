-- Add agency column to stations.
--
-- `source` (already present, currently unpopulated) tracks which ingest
-- pipeline wrote a station's data ('cpcb' | 'dpcc' etc.).  `agency` tracks
-- who physically operates the sensor — DPCC, IMD, IITM — as exposed by
-- CPCB's aggregated feed in the station-name suffix ("Anand Vihar, Delhi - DPCC").
-- These are distinct concepts: CPCB is a national aggregator pulling from
-- multiple state/agency networks, so the same CPCB feed can cover both
-- DPCC and IMD stations.
--
-- Nullable: existing rows pick up the value on the next matched ingest
-- cycle (no backfill needed, no NOT NULL constraint added).

alter table stations add column if not exists agency text;
