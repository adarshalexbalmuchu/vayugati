-- Phase 2: Data Integrity
--
-- D-1: ingest_source column on readings — every row now records whether
--      the reading came from CPCB/data.gov.in (authoritative) or OpenAQ
--      (fallback). Null on historic rows written before this migration.
--
-- D-2: openaq_location_id on stations — single source of truth for the
--      OpenAQ location IDs previously stored only in stations.yaml. Populated
--      from external_ref (which already holds the OpenAQ ID as a string for
--      OpenAQ-sourced stations). After this migration, stations.yaml is retired.
--
--      MAYAPURI NOTE: Mayapuri ward has no official CPCB/DPCC/IMD CAAQMS
--      station and no OpenAQ match (confirmed 2026-07-21). Do NOT add a
--      stations row for Mayapuri with a guessed openaq_location_id. If a
--      ward-level forecast is ever needed, it must be labelled proxy-derived.
--
-- D-4: is_primary flag on stations — operators can mark one station per ward
--      as the preferred source. The frontend prefers this station; falls back
--      to freshest reading when no primary is set. Defaults to false (no
--      auto-selection — human call, not an algorithm).

-- D-1
alter table readings
  add column if not exists ingest_source text
  check (ingest_source in ('cpcb', 'openaq'));

-- D-2
alter table stations
  add column if not exists openaq_location_id bigint;

-- Populate from external_ref where it is a plain integer string (OpenAQ IDs).
-- external_ref is always the OpenAQ location id cast to text for those stations;
-- CPCB-matched stations have external_ref = null, so the cast is safe.
update stations
set openaq_location_id = external_ref::bigint
where external_ref is not null
  and external_ref ~ '^[0-9]+$';

-- D-4
alter table stations
  add column if not exists is_primary boolean not null default false;

