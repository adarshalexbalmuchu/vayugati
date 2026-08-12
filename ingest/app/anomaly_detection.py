"""Trigger the database's anomaly-detection rule engine (Phase 6).

Deliberately thin: every threshold/persistence/local-excess/dedup rule lives
in the `run_anomaly_detection()` / `evaluate_station_pollutant_anomaly()`
Postgres functions (supabase/migrations/20260721000000_anomaly_detection.sql),
not here — this module's only job is to call that RPC on schedule, using the
service_role key exactly like every other write in this service, and to
summarise the result the same way ingest.py/forecast.py do.
"""

import logging

from . import db

log = logging.getLogger("ingest.anomaly_detection")


def run(city_code: str | None = None) -> dict:
    """Call run_anomaly_detection() for one city (or every active city)."""
    rows = db.call_rpc("run_anomaly_detection", {"p_city_code": city_code})
    return {
        "stations_pollutants_evaluated": len(rows),
        "candidates_recorded": sum(1 for r in rows if r.get("candidate_id") is not None),
    }
