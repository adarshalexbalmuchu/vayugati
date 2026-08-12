"""Trigger the database's probable-source attribution rule engine (Phase 7).

Deliberately thin, exactly like anomaly_detection.py: every evidence weight,
threshold, scoring rule and the "never overwrite a verified finding" guard
lives in the `run_incident_source_attribution()` /
`calculate_incident_source_attribution()` Postgres functions
(supabase/migrations/20260722000000_source_attribution.sql), not here. This
module's only job is to call that RPC on schedule, using the service_role key
exactly like every other write in this service, and to summarise the result
the same way ingest.py/forecast.py/anomaly_detection.py do.

Run AFTER anomaly detection (see main.py's run_intel): source attribution
reads anomaly_candidates' own local_excess/regional-pattern signal, so it
needs that pass to have already run for the freshest data.
"""

import logging

from . import db

log = logging.getLogger("ingest.source_attribution")


def run(city_code: str | None = None) -> dict:
    """Call run_incident_source_attribution() for one city (or every active
    city, when city_code is None)."""
    rows = db.call_rpc(
        "run_incident_source_attribution", {"p_city_code": city_code, "p_force": False}
    )
    return {"incidents_evaluated": len(rows)}
