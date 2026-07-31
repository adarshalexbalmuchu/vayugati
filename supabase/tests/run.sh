#!/usr/bin/env bash
#
# Rebuild a disposable Postgres from this repo's real migrations and exercise
# the incident workflow (Phase 3), intervention/impact workflow (Phase 4),
# intervention playbooks (Phase 5), recurrence/custom-hardening (Phase 5.1),
# anomaly detection (Phase 6), probable-source attribution (Phase 7), unified
# forecasting (Phase 8), authority routing / operational dispatch (Phase 9),
# production hardening (Phase 10), and pilot validation scenarios (Phase 11)
# against it.
#
# Why this exists: RLS is the ONLY authorization boundary in this app (the web
# client only ever holds the anon key), so "does a citizen see X" is not a
# question that can be answered by reading the policy — it has to be executed.
# Every test here runs as the `authenticated` Postgres role, because a superuser
# bypasses RLS and would make the whole suite pass vacuously.
#
# Requires: docker. Touches NOTHING hosted — it never reads .env or connects to
# the real Supabase project.
#
#   ./supabase/tests/run.sh
#
set -euo pipefail

CONTAINER="${VG_TEST_CONTAINER:-vg-pg}"
PORT="${VG_TEST_PORT:-55432}"
DB=vayugati
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

PSQL=(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" -q)

start_pg() {
  if docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    echo "== reusing running container ${CONTAINER}"
    return
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "== starting disposable postgres (${CONTAINER}) on :${PORT}"
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" \
    postgres:15 >/dev/null
  # The official postgres image briefly starts up to run initdb, shuts
  # itself down, then restarts for real — pg_isready can catch that
  # transient window and falsely report ready right before the shutdown
  # (observed for real in CI: "connection ... failed: FATAL: the database
  # system is shutting down" immediately after this loop returned). A
  # single successful ping is not proof; require a real query to succeed
  # twice, a beat apart, before trusting it.
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" psql -U postgres -d "$DB" -c 'select 1' >/dev/null 2>&1; then
      sleep 1
      docker exec "$CONTAINER" psql -U postgres -d "$DB" -c 'select 1' >/dev/null 2>&1 && return
    fi
    sleep 1
  done
  echo "postgres did not become ready" >&2
  exit 1
}

run_file() {
  if ! "${PSQL[@]}" -f - < "$1" > /tmp/vg_pg_out 2>&1; then
    echo "FAILED applying $1"; grep -E 'ERROR' /tmp/vg_pg_out; exit 1
  fi
}

start_pg

echo "== rebuilding schema from migrations"
"${PSQL[@]}" -c "drop schema if exists public cascade; create schema public;" >/dev/null

run_file "$HERE/00_local_supabase_stub.sql"
for m in "$ROOT/supabase/schema.sql" "$ROOT"/supabase/migrations/*.sql; do
  run_file "$m"
  echo "   applied $(basename "$m")"
done
run_file "$HERE/05_grants.sql"

echo "== idempotency: re-applying the incident + intervention + playbook migrations"
run_file "$ROOT/supabase/migrations/20260717000000_incidents_core.sql"
run_file "$ROOT/supabase/migrations/20260717010000_incident_workflow.sql"
run_file "$ROOT/supabase/migrations/20260718000000_intervention_and_impact.sql"
run_file "$ROOT/supabase/migrations/20260719000000_intervention_playbooks.sql"
run_file "$ROOT/supabase/migrations/20260720000000_recurrence_and_custom_hardening.sql"
run_file "$ROOT/supabase/migrations/20260721000000_anomaly_detection.sql"
run_file "$ROOT/supabase/migrations/20260721500000_source_attribution_enum.sql"
run_file "$ROOT/supabase/migrations/20260722000000_source_attribution.sql"
run_file "$ROOT/supabase/migrations/20260723000000_unified_forecasting.sql"
run_file "$ROOT/supabase/migrations/20260724000000_authority_routing_and_dispatch.sql"
run_file "$ROOT/supabase/migrations/20260725000000_production_hardening.sql"
run_file "$ROOT/supabase/migrations/20260726000000_pilot_validation_performance.sql"
run_file "$ROOT/supabase/migrations/20260727000000_profile_role_immutability.sql"
run_file "$ROOT/supabase/migrations/20260728000000_admin_audit_events.sql"
run_file "$ROOT/supabase/migrations/20260729000000_citizen_activity_view.sql"
run_file "$ROOT/supabase/migrations/20260730000000_atomic_mission_rpcs.sql"
echo "   all sixteen re-applied cleanly"

echo "== tests"
fails=0
for t in "$HERE/10_report_to_incident.sql" "$HERE/20_evidence_and_privacy.sql" "$HERE/30_mission_rls.sql" "$HERE/40_intervention_and_impact.sql" "$HERE/50_intervention_playbooks.sql" "$HERE/60_recurrence_and_custom_hardening.sql" "$HERE/70_anomaly_detection.sql" "$HERE/80_source_attribution.sql" "$HERE/90_unified_forecasting.sql" "$HERE/100_authority_routing_and_dispatch.sql" "$HERE/110_production_hardening.sql" "$HERE/120_pilot_validation_scenarios.sql" "$HERE/130_end_to_end_scenarios.sql" "$HERE/140_profile_role_immutability.sql" "$HERE/150_admin_audit_events.sql" "$HERE/160_citizen_activity_view.sql" "$HERE/170_atomic_mission_rpcs.sql"; do
  out="$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -f - < "$t" 2>&1)"
  # Match any label shape (12a, 14b2, 18c, ...) by just keying on the words
  # PASS/FAIL themselves rather than guessing a numbering pattern.
  echo "$out" | grep -E '^ TEST |NOTICE:.*(PASS|FAIL)' | sed -E 's/^psql:<stdin>:[0-9]+: NOTICE:  //'
  if echo "$out" | grep -qE 'FAIL|^psql:.*ERROR'; then fails=$((fails + 1)); fi
done

if [ "$fails" -gt 0 ]; then
  echo "== $fails test file(s) reported failures"; exit 1
fi
echo "== all database tests passed"
