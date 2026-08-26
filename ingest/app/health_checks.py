"""Dependency health checks for the /health endpoint (Phase 10, plan §9).

Kept separate from main.py so the health computation itself is unit
testable against a mocked db.client() — the same reasoning behind every
other db.py-wrapped module in this codebase.

Returns "degraded", never a bare crash, when a dependency is partially
unavailable — an ingest outage should be visible, not indistinguishable
from the health check itself being broken.
"""

import os
from datetime import datetime, timezone
from pathlib import Path

from . import config, db

READING_STALE_AFTER_MINUTES = 180  # 3x the hourly ingest cadence


def _reading_freshness() -> dict:
    try:
        resp = (
            db.client()
            .table("readings")
            .select("ts")
            .order("ts", desc=True)
            .limit(1)
            .execute()
        )
        if not resp.data:
            return {"status": "no_data"}
        latest = datetime.fromisoformat(resp.data[0]["ts"].replace("Z", "+00:00"))
        age_minutes = (datetime.now(timezone.utc) - latest).total_seconds() / 60
        return {
            "status": "ok" if age_minutes < READING_STALE_AFTER_MINUTES else "stale",
            "latest_reading_age_minutes": round(age_minutes, 1),
        }
    except Exception as e:
        return {"status": "unknown", "error_category": type(e).__name__}


def _database() -> dict:
    try:
        db.client().table("wards").select("id", count="exact").limit(0).execute()
        return {"status": "ok"}
    except Exception as e:
        return {"status": "down", "error_category": type(e).__name__}


def _job_health() -> dict:
    """Reads the same system_health_summary() the System Health screen
    uses — one source of truth for "is job X healthy", not a second,
    potentially-inconsistent computation living only in this endpoint."""
    try:
        resp = db.client().rpc("system_health_summary", {}).execute()
        jobs: dict[str, dict] = {}
        for row in resp.data or []:
            key = row["job_name"] if not row.get("city_code") else f"{row['job_name']}:{row['city_code']}"
            jobs[key] = {
                "status": "stale" if row.get("is_stale") else "ok",
                "last_status": row.get("last_status"),
                "last_completed_at": row.get("last_completed_at"),
            }
        return jobs
    except Exception as e:
        return {"_error": type(e).__name__}


def _osm_pbf() -> dict:
    pbf = Path(os.getenv("OSM_PBF_PATH", "/data/osm/northern-zone-latest.osm.pbf"))
    if pbf.exists():
        return {"status": "ok", "size_mb": pbf.stat().st_size // 1_000_000}
    return {"status": "missing"}


def compute_health() -> dict:
    database = _database()
    freshness = _reading_freshness()
    jobs = _job_health()
    osm_pbf = _osm_pbf()

    job_statuses = [j.get("status") for j in jobs.values() if isinstance(j, dict) and "status" in j]
    if database["status"] != "ok":
        overall = "down"
    elif freshness["status"] == "stale" or "stale" in job_statuses or "_error" in jobs or osm_pbf["status"] != "ok":
        overall = "degraded"
    else:
        overall = "ok"

    return {
        "status": overall,
        "environment": config.ENVIRONMENT,
        "checks": {
            "database": database,
            "reading_freshness": freshness,
            "jobs": jobs,
            "osm_pbf": osm_pbf,
        },
    }
