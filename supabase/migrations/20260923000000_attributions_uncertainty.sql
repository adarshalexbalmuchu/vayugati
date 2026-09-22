-- ============================================================
-- attributions — add Monte Carlo uncertainty bands
--
-- Until now every VayuTrace breakdown was stored as a bare point
-- estimate: "road 67.1%" carried identical apparent precision
-- whether the underlying inputs were well constrained or barely
-- constrained at all. That was the model's least defensible
-- property — R-AASMAN, the DPCC/IIT-Kanpur CMB system this is
-- measured against, at least propagates per-species measurement
-- uncertainty through its matrix inversion.
--
-- vayutrace_kernel.py now resamples the genuinely uncertain
-- inputs (emission weights, dispersion length, wind direction)
-- and reports p10/p50/p90 per source type. This column persists
-- those bands alongside the point estimate.
--
-- Shape, mirroring `breakdown`'s own jsonb structure:
--
--   {"road":       {"p10": 0.397, "p50": 0.681, "p90": 0.878},
--    "industrial": {"p10": 0.089, "p50": 0.201, "p90": 0.441},
--    "dust":       {"p10": 0.021, "p50": 0.093, "p90": 0.198},
--    "fire":       {"p10": 0.0,   "p50": 0.0,   "p90": 0.0}}
--
-- WHAT THESE BANDS REVEAL, recorded here because it is the
-- honest headline and should not be discoverable only by reading
-- the numbers: they are WIDE. Measured across all 265 Delhi
-- wards, median dominant-source band width is ~0.39 — e.g. a
-- ward reported as "75% road" is really somewhere in 40-88%.
-- The point estimates were never that precise; they merely
-- looked it. Any UI surfacing `breakdown` should surface this
-- alongside it rather than treating it as optional detail.
--
-- NULL for rows written before this migration, and NULL whenever
-- the kernel is run with mc_draws=0.
-- ============================================================

alter table attributions
  add column if not exists breakdown_uncertainty jsonb;

comment on column attributions.breakdown_uncertainty is
  'Monte Carlo p10/p50/p90 per source type for the matching `breakdown` '
  'row. Wide bands are expected and real (median dominant-source width '
  '~0.39); see vayutrace_kernel.py MC_EMISSION_LOGSIGMA for the '
  'perturbation ranges and their sources. NULL when mc_draws=0.';

-- Station proximity was previously reported AS `confidence`, which
-- overstated it: a ward 500 m from a CPCB station still gets a wrong
-- answer if the emission geometry near it is wrong. `confidence` now
-- means "how tight is the Monte Carlo interval on the dominant source",
-- and station distance gets its own honestly-named column.
alter table attributions
  add column if not exists station_proximity double precision
    check (station_proximity is null or
           (station_proximity >= 0 and station_proximity <= 1));

comment on column attributions.station_proximity is
  '0-1, 1 = ward centroid is at/near a CPCB station, 0 = at least '
  'MAX_CONFIDENT_DIST_KM away. A model-anchoring proxy only — NOT a '
  'confidence measure, which is what it used to be misreported as.';
