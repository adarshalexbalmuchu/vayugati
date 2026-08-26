"""ISRM-style source-attribution runner — integrates with the intel cycle.

Deliberately thin, matching the style of attribution.py and source_attribution.py:
all the modelling logic lives in vayutrace_kernel.py; this module's only job is to
load the inputs, call the kernel, and write the results to the DB.

Outputs are ESTIMATED/MODELLED source contributions (forward model: emissions →
predicted concentration), not detected or measured ones.  See vayutrace_kernel.py's
module docstring for the full method description.

Run order in main.py's run_intel():
  forecast → attribution (wind-rose) → anomaly_detection → source_attribution →
  vayutrace_attribution (NEW — runs last, reads fresh readings/weather, no dependents)
"""

import logging
from datetime import datetime, timezone

from . import db
from .vayutrace_kernel import DEFAULT_SIGMA_KM, estimate_city, seasonal_sigma_km

log = logging.getLogger("ingest.vayutrace_attribution")

_METHOD = "vayutrace_v1"


def run(sigma_km: float = DEFAULT_SIGMA_KM) -> dict:
    """Run the ISRM dispersion kernel for all Delhi wards and persist results.

    Returns a summary dict matching the shape of other run_tracked() callers:
        {started_at, finished_at, wards_attributed, wards_skipped, sigma_km}
    """
    now = datetime.now(timezone.utc)
    month = now.month
    effective_sigma = seasonal_sigma_km(month) if sigma_km == DEFAULT_SIGMA_KM else sigma_km
    summary: dict = {
        "started_at": now.isoformat(),
        "wards_attributed": 0,
        "wards_skipped": 0,
        "sigma_km": effective_sigma,
        "month": month,
    }

    wards = db.get_wards_with_city()
    if not wards:
        log.warning("vayutrace_attribution: no wards found — skipping")
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        return summary

    weather_by_ward = db.get_latest_weather_by_ward()
    if not weather_by_ward:
        log.warning("vayutrace_attribution: no weather data found — kernel will use calm-wind defaults")

    stations = db.get_stations_with_coords()

    results = estimate_city(
        wards=wards,
        weather_by_ward=weather_by_ward,
        sigma_km=sigma_km,
        month=month,
    )

    if not results:
        log.warning("vayutrace_attribution: kernel returned no results (no source inventory?)")
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        return summary

    ts_now = datetime.now(timezone.utc).isoformat()

    for r in results:
        ward_id = r["ward_id"]
        try:
            db.replace_attribution_by_method(
                ward_id,
                _METHOD,
                {
                    "ward_id":    ward_id,
                    "ts":         ts_now,
                    "breakdown":  r["breakdown"],
                    "confidence": r["confidence"],
                    "method":     _METHOD,
                    # regional_fraction_prior: IITK 2016 city-level context,
                    # stored in the attributions row for the UI to surface.
                    "regional_fraction_prior": r.get("regional_fraction_prior"),
                },
            )
            summary["wards_attributed"] += 1
        except Exception:
            log.exception("vayutrace_attribution: failed to save ward_id=%s", ward_id)
            summary["wards_skipped"] += 1

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    log.info("vayutrace_attribution done: %s", summary)
    return summary
