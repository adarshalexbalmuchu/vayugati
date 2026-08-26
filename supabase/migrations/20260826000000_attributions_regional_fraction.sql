-- Add regional_fraction_prior to attributions.
--
-- VayuTrace (vayutrace_v1) kernels now emit a city-level seasonal prior for
-- the fraction of Delhi's PM2.5 attributable to regional/upwind transport
-- (IITK 2016 + TERI-ARAI 2018):
--   Oct–Feb → 0.64   Mar–Sep → 0.26
--
-- This is stored alongside the per-ward breakdown so the frontend can
-- contextualise the local source mix without confusing it with remote
-- transport.  NULL for older rows and non-vayutrace methods.

alter table attributions
  add column if not exists regional_fraction_prior double precision
    check (regional_fraction_prior is null or
           (regional_fraction_prior >= 0 and regional_fraction_prior <= 1));
