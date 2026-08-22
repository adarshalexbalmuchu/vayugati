"""Schema (and currently-empty fixture list) for future timestamp-matched
real CPCB station observations.

Deliberately empty: no live data has been collected. This is scaffold only,
reserved for the evidence-collection phase — pulling real, timestamped
severe-range readings from data.gov.in (CPCB's public API) via
DATA_GOV_API_KEY, specifically to (a) verify CO unit semantics against what
a live station payload actually declares, and (b) find real severe-range
PM10 observations to compare against published CPCB AQI values, not just
synthetic fixtures. Populating this file is out of scope for this harness
delivery — see FUTURE_ADAPTER_INTERFACE in future_adapter.py, which is
likewise a stub, not called from anywhere in this package.

Every field below is required when a real observation is added: a
timestamp-matched comparison is meaningless without knowing exactly which
station, which moment, and what CPCB itself published for that moment.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CpcbStationObservation:
    # Provider identity
    provider_station_id: str
    station_name: str
    lat: float
    lng: float
    agency: str  # e.g. "DPCC", "CPCB", "IMD"

    # The observation itself
    pollutant: str
    concentration: float
    unit: str  # as declared by the provider, verbatim — never assumed
    observation_ts: str  # ISO 8601, when CPCB says the reading was taken
    fetch_ts: str  # ISO 8601, when THIS harness (or its future adapter) retrieved it

    # What CPCB itself published for this observation, for direct comparison
    # against both harness profiles
    published_aqi: int | None
    published_label: str | None

    # Provenance, for auditability
    source_url: str
    evidence_hash: str  # sha256 of the raw API response payload this row was extracted from


# Populated only by the future evidence-collection phase (see module
# docstring). Empty by design — this harness ships with zero real station
# rows, only the synthetic fixtures in severe_fixtures.py.
FUTURE_CPCB_OBSERVATIONS: list[CpcbStationObservation] = []
