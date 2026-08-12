"""Trigger the database's SLA/escalation batch driver (Phase 9).

Deliberately thin, same shape as anomaly_detection.py: every SLA-matching and
escalation-hierarchy rule lives in `escalate_stale_task_dispatches()`
(supabase/migrations/20260724000000_authority_routing_and_dispatch.sql), not
here — this module's only job is to call that RPC on a schedule, using the
service_role key like every other write in this service.
"""

import logging

from . import db

log = logging.getLogger("ingest.dispatch")


def run(city_code: str | None = None) -> dict:
    """Call escalate_stale_task_dispatches() for one city (or every city)."""
    rows = db.call_rpc("escalate_stale_task_dispatches", {"p_city_code": city_code})
    return {"tasks_escalated": len(rows)}
