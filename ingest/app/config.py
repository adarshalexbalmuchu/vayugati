"""Env + station config. All secrets come from env vars, never hardcoded."""

import os
from pathlib import Path

import yaml
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
OPENAQ_API_KEY = os.getenv("OPENAQ_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# Official data.gov.in CPCB AQI API key — server-side only, never logged.
# Audit-only for now (see scripts/audit_data_gov_cpcb.py): not read by
# app/ingest.py or app/openaq.py, and not part of require_env() below, since
# production ingest still runs on OpenAQ exactly as before. Wiring this into
# live ingest is a deliberate future decision, not a side effect of adding
# the key.
DATA_GOV_API_KEY = os.getenv("DATA_GOV_API_KEY", "")

# Delhi Open Transit Data (OTD) real-time GTFS-realtime feed key — server-
# side only, never logged. Same audit-only status as DATA_GOV_API_KEY above
# (see scripts/audit_delhi_otd.py): not read by any production ingest path,
# not part of require_env(). This is a transit feed, not an air-quality one
# — evaluating it as a possible activity-context layer, not a replacement
# for anything ingest already does.
DELHI_OTD_API_KEY = os.getenv("DELHI_OTD_API_KEY", "")

# local | test | staging | production (Phase 10, plan §4) — tags every
# structured log line and system_health row so a pilot/production incident
# is never confused with a local dev run hitting the same log aggregator.
# Does NOT select which Supabase project is used — that's decided entirely
# by SUPABASE_URL above; ENVIRONMENT is display/log metadata only, exactly
# like the web app's VITE_ENVIRONMENT. Unrecognised values fall back to
# "local" rather than silently mislabelling logs as production.
_VALID_ENVIRONMENTS = ("local", "test", "staging", "production")
ENVIRONMENT = os.getenv("ENVIRONMENT", "local").lower()
if ENVIRONMENT not in _VALID_ENVIRONMENTS:
    ENVIRONMENT = "local"

# Notification delivery (Phase 9) — all optional. Unset means "no real
# provider configured", and notifications.py must say so honestly rather
# than claiming a delivery it didn't make (plan §6).
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587") or "587")
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "")

# CORS (Phase 2 hardening) — who's allowed to call this API from a browser.
# Defaults to the Vite dev/preview ports only; never falls back to "*". A
# real staging/production deployment has no concrete domain configured yet
# (no Vercel project provisioned as of this phase — see docs/DEPLOYMENT.md),
# so this is deliberately env-driven rather than a guessed hardcoded URL.
DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:4173"]
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", ",".join(DEFAULT_ALLOWED_ORIGINS)).split(",")
    if origin.strip()
]

STATIONS_FILE = Path(__file__).resolve().parent.parent / "stations.yaml"


def require_env() -> None:
    missing = [
        name
        for name, val in [
            ("SUPABASE_URL", SUPABASE_URL),
            ("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY),
            ("OPENAQ_API_KEY", OPENAQ_API_KEY),
        ]
        if not val
    ]
    if missing:
        raise RuntimeError(
            f"Missing env vars: {', '.join(missing)}. Copy .env.example to .env and fill it in."
        )


def load_stations() -> list[dict]:
    """Returns [{ward: str, openaq_location_id: int | None}, ...]."""
    with open(STATIONS_FILE) as f:
        data = yaml.safe_load(f)
    return data["stations"]
