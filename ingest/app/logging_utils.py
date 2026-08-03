"""Structured logging + job-run tracking (Phase 10, plan §8/§11).

Every scheduled job (ingest, anomaly_detection, forecast, attribution,
notifications, escalation) emits ONE structured JSON log line per attempt
via `log_event`, and is wrapped by `run_tracked(...)` so start/completion/
failure in the `job_runs` table (supabase/migrations/
20260725000000_production_hardening.sql) is never forgotten — the same
table `system_health_summary()` reads for the System Health screen and
this service's own `/health` endpoint.

Never logs citizen free-text content, credentials, or unrestricted
personal data — only ids, categories, and timings (plan §8's own explicit
limit).
"""

import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, TypeVar

from . import config, db

log = logging.getLogger("ingest.structured")

T = TypeVar("T")


def log_event(
    service: str,
    operation: str,
    *,
    success: bool,
    duration_ms: float | None = None,
    city_id: int | str | None = None,
    incident_id: int | None = None,
    task_dispatch_id: int | None = None,
    correlation_id: str | None = None,
    error_category: str | None = None,
    **extra,
) -> None:
    """One structured JSON line to stdout — the hosting platform (Render)
    captures stdout and forwards it to its own log aggregation, so this is
    intentionally provider-neutral rather than calling a specific logging
    SaaS's SDK (plan §10: "use a provider-neutral interface")."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "environment": config.ENVIRONMENT,
        "service": service,
        "operation": operation,
        "success": success,
        "duration_ms": round(duration_ms, 1) if duration_ms is not None else None,
        "city_id": city_id,
        "incident_id": incident_id,
        "task_dispatch_id": task_dispatch_id,
        "correlation_id": correlation_id,
        "error_category": error_category,
        **extra,
    }
    record = {k: v for k, v in record.items() if v is not None}
    log.info(json.dumps(record, default=str))


def categorize_error(e: Exception) -> str:
    """Best-effort error category (plan §8's own field) from an exception's
    type name — deliberately coarse (network/timeout/validation/database/
    unknown), never the raw message, which could contain identifying detail."""
    name = type(e).__name__.lower()
    if "timeout" in name:
        return "timeout"
    if "connection" in name or "network" in name or "resolve" in name:
        return "network"
    if "valueerror" in name or "keyerror" in name or "validation" in name:
        return "validation"
    if "postgrest" in name or "apierror" in name or "database" in name:
        return "database"
    return "unknown"


def cleanup_stuck_jobs(stale_after_minutes: int = 30) -> int:
    """Mark job_runs rows stuck 'running' for longer than `stale_after_minutes`
    as failed so their unique-index lock is released.

    The partial unique index `(job_name, coalesce(city_code, '')) WHERE
    status='running'` allows only one concurrent run per job. If a process
    was killed (OOM, SIGKILL, Render rolling restart) while a job was in
    flight, that row stays 'running' forever — its lock blocks every
    subsequent attempt, which `run_tracked` silently skips as "lock
    contention". This is why a crashed service can look healthy (health check
    passes, scheduler fires on time) but never actually ingests anything.

    Called twice, with different safety margins for different guarantees:

    - Once at the top of `lifespan()`, before the bootstrap thread starts,
      with the default 30-minute cutoff — safe because nothing in *this*
      process has run yet, so any 'running' row is definitely orphaned by a
      previous one, regardless of how long that prior job normally takes.
    - On a recurring interval thereafter (see `main.py`), with a larger
      cutoff — that ordering guarantee no longer holds once this process's
      own jobs are running, so the cutoff must instead safely outlast every
      job's realistic worst-case duration (all of them are bounded,
      network-timeout-limited operations - see ingest.py/notifications.py/
      dispatch.py - so this is a generous, not a tight, margin) to avoid
      reaping a run that is still genuinely in progress.

    Returns the count of rows cleared (normally 0)."""
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=stale_after_minutes)).isoformat()
        stuck = (
            db.client()
            .table("job_runs")
            .select("id, job_name")
            .eq("status", "running")
            .lt("started_at", cutoff)
            .execute()
            .data
        ) or []
        if not stuck:
            return 0
        ids = [r["id"] for r in stuck]
        db.client().table("job_runs").update(
            {
                "status": "failed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "error_message": f"Running >{stale_after_minutes} min — cleared as stuck/orphaned",
                "error_category": "unknown",
            }
        ).in_("id", ids).execute()
        log.warning(
            "cleared %d stuck job_run(s) (running >%d min): %s",
            len(stuck),
            stale_after_minutes,
            [r["job_name"] for r in stuck],
        )
        return len(stuck)
    except Exception:
        log.exception("stuck-job cleanup failed — jobs may still be locked (proceeding anyway)")
        return 0


def run_tracked(job_name: str, fn: Callable[[], T], city_code: str | None = None) -> T | None:
    """Runs `fn()` with job_runs overlap protection, timing, and structured
    logging. Returns `fn()`'s result, or None if the job was skipped (a
    concurrent run already holds `job_runs`' structural lock for this
    job+city) or failed.

    A function wrapper rather than a context manager on purpose: a
    `with job_run(...):` block's BODY always executes regardless of what
    is yielded — a context manager cannot skip it — so a "some other run
    already holds the lock, do nothing" outcome can only be expressed by
    controlling whether `fn` is called at all, which only a wrapper
    function can do.

    Deliberately never re-raises: one job failing (or one job within a
    caller's sequence of several) must not abort work that hasn't started
    yet — the same "isolate one failure from the rest of the batch"
    principle Phase 10 also applied to the SQL-side per-city loops
    (`run_anomaly_detection` etc.). Call `system_health_summary()` /
    inspect `job_runs` to see what failed; a caller does not get an
    exception to react to by design.
    """
    run_id = None
    lock_contended = False
    try:
        resp = db.client().rpc(
            "start_job_run", {"p_job_name": job_name, "p_city_code": city_code}
        ).execute()
        run_id = resp.data
        lock_contended = run_id is None
    except Exception:
        # If even acquiring the job_runs row fails (e.g. a transient DB
        # blip), fall back to running the job anyway rather than skipping
        # it entirely — losing one run's tracking is much cheaper than
        # silently never running ingestion because bookkeeping failed.
        log_event(job_name, "start", success=False, error_category="database",
                   note="could not create job_runs row; proceeding untracked")

    if lock_contended:
        # A real, deliberate "already running" signal from start_job_run's
        # own unique-index guard, not a bookkeeping failure — skip cleanly.
        log_event(job_name, "start", success=False, error_category="lock_contention",
                   city_id=city_code, note="another run already in progress, skipped")
        return None

    started = time.monotonic()
    try:
        result = fn()
    except Exception as e:
        duration_ms = (time.monotonic() - started) * 1000
        category = categorize_error(e)
        if run_id is not None:
            try:
                db.client().rpc(
                    "fail_job_run",
                    {"p_run_id": run_id, "p_error_message": str(e)[:2000], "p_error_category": category},
                ).execute()
            except Exception:
                pass  # the job itself already failed; don't let bookkeeping mask that
        log_event(job_name, "run", success=False, duration_ms=duration_ms,
                   city_id=city_code, error_category=category)
        log.exception("%s failed", job_name)
        return None
    else:
        duration_ms = (time.monotonic() - started) * 1000
        rows_processed = len(result) if isinstance(result, (list, tuple, dict)) else None
        if run_id is not None:
            try:
                db.client().rpc(
                    "complete_job_run", {"p_run_id": run_id, "p_rows_processed": rows_processed}
                ).execute()
            except Exception:
                pass
        log_event(job_name, "run", success=True, duration_ms=duration_ms, city_id=city_code)
        return result
