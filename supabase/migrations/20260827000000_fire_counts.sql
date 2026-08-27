-- Daily regional fire count (VIIRS SNPP) for Punjab + Haryana airshed.
--
-- Purpose: forecast feature for the ML model — stubble burning in Punjab/
-- Haryana is the dominant external PM2.5 driver for Delhi during Oct–Nov.
-- One row per (date, region); a "region" key future-proofs the table for
-- other airsheds without a schema change.
--
-- Source: NASA FIRMS VIIRS SNPP NRT (~375 m resolution), fetched daily by
-- ingest.main.run_fire_counts(). Only 'regional' class fires (distance
-- from Delhi > 50 km, as classified by vayutrace_firms.py) are counted;
-- local fires within Delhi/NCR are handled by the VayuTrace kernel.
--
-- Literature:
--   Gupta et al. (2021) JGR Atmospheres — fire count as forecast feature
--   Singh et al. (2022) ACP — Punjab paddy residue Oct–Nov transport model
--   Mishra et al. (2023) STOTEN — FIRMS FRP as IGP PM2.5 predictor

CREATE TABLE IF NOT EXISTS fire_counts (
    date    DATE    NOT NULL,
    region  TEXT    NOT NULL,   -- e.g. 'igp_regional'
    fire_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, region)
);

-- No RLS needed: ingest service uses the service_role key which bypasses
-- RLS by design (same as all other ingest-written tables).
ALTER TABLE fire_counts ENABLE ROW LEVEL SECURITY;

-- Index for the range-query used by get_fire_counts_history()
CREATE INDEX IF NOT EXISTS fire_counts_date_region_idx
    ON fire_counts (region, date DESC);

COMMENT ON TABLE fire_counts IS
    'Daily VIIRS SNPP regional fire count for Punjab+Haryana airshed. '
    'One row per calendar date. Used as lag features in the PM2.5/PM10 '
    'forecast model (fire_count_lag1d, fire_count_lag2d).';
