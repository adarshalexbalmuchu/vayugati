#!/usr/bin/env python3
"""Preflight: report which of this repo's migrations have actually reached
the hosted Supabase project, without applying or changing anything.

Why this exists: `supabase migration list` needs the CLI linked (a personal
access token) — a different credential from the service_role key the ingest
service already holds. This script uses ONLY that service_role key against
the public PostgREST API (read-only, `limit=0` on every check — zero rows
are ever fetched, nothing is ever written) so "is Phase N actually on
hosted?" can be answered even in an environment that only has the ingest
service's own credentials, exactly the situation this repo's deploy
environment was in during Phase 10.

Dependency-free on purpose (stdlib only) — this is a deployment/ops tool
that should run anywhere a bare `python3` exists, not just inside the
ingest service's own virtualenv.

Usage:
    python3 supabase/scripts/check_hosted_drift.py
    python3 supabase/scripts/check_hosted_drift.py --env-file ingest/.env
    python3 supabase/scripts/check_hosted_drift.py --strict   # exit 1 if any migration is missing

Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the process environment,
or from --env-file (a simple KEY=VALUE file, `ingest/.env`'s own format) if
those aren't already set. Never prints the key itself.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Literal, Optional

# ── the migration manifest ───────────────────────────────────────────────────
# One marker object per migration, chosen to be the smallest reliable signal
# that migration actually ran: a brand-new table where one was created, or a
# specific new column for the (few) migrations that only altered existing
# tables. Kept in this file, deliberately hand-maintained rather than parsed
# from the SQL — a parsed heuristic could silently pick the wrong marker and
# give a false "applied"; an explicit list is auditable by reading it.

Marker = tuple[Literal["table", "column", "bucket"], str, Optional[str]]


@dataclass
class MigrationCheck:
    filename: str
    marker: Marker


MIGRATIONS: list[MigrationCheck] = [
    MigrationCheck("20260714000000_weather.sql", ("table", "weather", None)),
    MigrationCheck("20260714010000_report_photos.sql", ("bucket", "report-photos", None)),
    MigrationCheck("20260717000000_incidents_core.sql", ("table", "incidents", None)),
    MigrationCheck("20260717010000_incident_workflow.sql", ("column", "incidents", "assigned_authority")),
    MigrationCheck("20260718000000_intervention_and_impact.sql", ("column", "actions", "workflow_status")),
    MigrationCheck("20260719000000_intervention_playbooks.sql", ("column", "intervention_playbooks", "action_type")),
    MigrationCheck("20260720000000_recurrence_and_custom_hardening.sql", ("table", "incident_recurrence_reports", None)),
    MigrationCheck("20260721000000_anomaly_detection.sql", ("table", "anomaly_candidates", None)),
    # 20260721500000_source_attribution_enum.sql is intentionally absent from
    # this list: it adds three new labels to the EXISTING source_category
    # enum and nothing else, so there is no new table/column/bucket marker
    # this PostgREST-based check can observe. Verify it manually after
    # `make db-push` via the Supabase SQL editor:
    #   select enumlabel from pg_enum
    #   where enumtypid = 'source_category'::regtype order by enumsortorder;
    # should include regional_transport, mixed, unresolved.
    MigrationCheck("20260722000000_source_attribution.sql", ("column", "incidents", "classification_source")),
    MigrationCheck("20260723000000_unified_forecasting.sql", ("table", "forecast_runs", None)),
    MigrationCheck("20260724000000_authority_routing_and_dispatch.sql", ("table", "task_dispatches", None)),
    MigrationCheck("20260725000000_production_hardening.sql", ("table", "job_runs", None)),
    # 20260726000000_pilot_validation_performance.sql is intentionally absent
    # from this list: it adds ONE index and no new table/column/bucket, so
    # there is no marker object this PostgREST-based check can observe (the
    # REST API does not expose pg_indexes/system catalogs). Verify it
    # manually after `make db-push` via the Supabase SQL editor:
    #   select indexname from pg_indexes where tablename = 'readings';
    # should include `readings_ts_idx`.
    #
    # 20260727000000_profile_role_immutability.sql is intentionally absent
    # from this list too: it adds a trigger + trigger function on the
    # EXISTING profiles table, no new table/column/bucket. Verify manually:
    #   select tgname from pg_trigger where tgrelid = 'profiles'::regclass;
    # should include `enforce_profile_role_immutability_trg`.
    MigrationCheck("20260728000000_admin_audit_events.sql", ("table", "admin_audit_events", None)),
    MigrationCheck("20260826200000_weather_pblh.sql", ("column", "weather", "boundary_layer_height")),
    MigrationCheck("20260827000000_fire_counts.sql", ("table", "fire_counts", None)),
]


def _load_env_file(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def _check_table(base_url: str, key: str, table: str) -> tuple[bool, str]:
    # select=* rather than select=id — not every table has an id column
    # (e.g. fire_counts has a composite (date, region) primary key), and
    # asserting one caused a false "MISSING" on a table that actually exists.
    req = urllib.request.Request(
        f"{base_url}/rest/v1/{table}?select=*&limit=0",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        urllib.request.urlopen(req, timeout=15)
        return True, "exists"
    except urllib.error.HTTPError as e:
        body = json.loads(e.read().decode() or "{}")
        if body.get("code") == "PGRST205":
            return False, "table not found"
        return False, f"unexpected error: {body.get('message', e.reason)}"


def _check_column(base_url: str, key: str, table: str, column: str) -> tuple[bool, str]:
    req = urllib.request.Request(
        f"{base_url}/rest/v1/{table}?select={column}&limit=0",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        urllib.request.urlopen(req, timeout=15)
        return True, "exists"
    except urllib.error.HTTPError as e:
        body = json.loads(e.read().decode() or "{}")
        if body.get("code") == "PGRST205":
            return False, "table not found"
        if body.get("code") == "42703":
            return False, "column not found"
        return False, f"unexpected error: {body.get('message', e.reason)}"


def _check_bucket(base_url: str, key: str, bucket: str) -> tuple[bool, str]:
    req = urllib.request.Request(
        f"{base_url}/storage/v1/bucket/{bucket}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        urllib.request.urlopen(req, timeout=15)
        return True, "exists"
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False, "bucket not found"
        return False, f"unexpected error: HTTP {e.code}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-file", default="ingest/.env", help="fallback KEY=VALUE file for SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY")
    ap.add_argument("--strict", action="store_true", help="exit 1 if any migration is missing or partially applied")
    args = ap.parse_args()

    env = _load_env_file(args.env_file)
    base_url = os.environ.get("SUPABASE_URL") or env.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY")

    if not base_url or not key:
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available (env or --env-file).")
        print("Cannot check hosted drift without them. Never printing the key itself either way.")
        return 2

    base_url = base_url.rstrip("/")
    print(f"Checking hosted project drift against {len(MIGRATIONS)} local migrations...")
    print(f"(project host: {base_url.replace('https://', '').split('.')[0]})\n")

    any_missing = False
    for m in MIGRATIONS:
        kind, name, extra = m.marker
        if kind == "table":
            ok, detail = _check_table(base_url, key, name)
            marker_desc = f"table {name}"
        elif kind == "column":
            ok, detail = _check_column(base_url, key, name, extra)  # type: ignore[arg-type]
            marker_desc = f"column {name}.{extra}"
        else:
            ok, detail = _check_bucket(base_url, key, name)
            marker_desc = f"storage bucket {name}"

        status = "APPLIED" if ok else "MISSING"
        if not ok:
            any_missing = True
        print(f"  [{status:7s}] {m.filename:55s} ({marker_desc}: {detail})")

    print()
    if any_missing:
        print("Hosted project is BEHIND local migrations. Nothing was changed by this check.")
        print("To apply: `supabase login` (needs a personal access token, separate from the")
        print("service_role key) then `make link && make db-push` from an environment with")
        print("real Supabase credentials.")
    else:
        print("Hosted project matches every migration marker checked. No drift detected.")
        print("(This checks ONE marker object per migration, not every column/policy/function —")
        print("see docs/DEPLOYMENT.md's fuller post-deploy verification checklist for that.)")

    return 1 if (args.strict and any_missing) else 0


if __name__ == "__main__":
    sys.exit(main())
