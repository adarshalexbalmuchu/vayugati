"""Interface stub for a FUTURE live data.gov.in (CPCB) adapter — the
evidence-collection phase this harness's methodology_manifest.json defers
to. NOT implemented. NOT imported by any other module in this package. NOT
called by run_comparison.py, compare.py, or any test.

This exists only so the shape of that future integration is written down
now, while the CO-unit-semantics and O3-averaging-behaviour questions are
still fresh, without pulling live HTTP/API access into a harness that is
supposed to be pure and offline. When that phase starts, DATA_GOV_API_KEY
becomes relevant (per the harness brief) — nothing here reads that env var.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from .fixtures.future_cpcb_observations import CpcbStationObservation


class CpcbLiveDataAdapter(ABC):
    """Contract a future adapter would implement to populate
    fixtures/future_cpcb_observations.py with real, timestamp-matched rows.
    Every method is a stub — calling any of them is a programming error in
    this delivery, not a supported code path."""

    @abstractmethod
    def fetch_station_observation(
        self,
        station_id: str,
        pollutant: str,
        observation_ts: str,
    ) -> CpcbStationObservation:
        """Fetch the single reading data.gov.in reports for a given station,
        pollutant, and timestamp, including whatever AQI/label CPCB itself
        published for it."""
        raise NotImplementedError(
            "future_adapter.py is a scaffold — no adapter implementation exists yet. "
            "See methodology_manifest.json's evidence-collection-phase notes."
        )

    @abstractmethod
    def fetch_severe_pm10_observations(
        self,
        since_ts: str,
        until_ts: str,
        min_concentration: float = 430.0,
    ) -> list[CpcbStationObservation]:
        """Fetch real PM10 observations at or above a severe-range threshold
        within a time window, for timestamp-matched comparison against the
        synthetic PM10 fixtures in fixtures/severe_fixtures.py."""
        raise NotImplementedError(
            "future_adapter.py is a scaffold — no adapter implementation exists yet. "
            "See methodology_manifest.json's evidence-collection-phase notes."
        )

    @abstractmethod
    def resolve_co_unit(self, station_id: str) -> str:
        """Determine what unit a given station's CO field is actually
        reported in (the unresolved question flagged throughout this
        harness) — by inspecting the live payload's own unit field rather
        than assuming."""
        raise NotImplementedError(
            "future_adapter.py is a scaffold — no adapter implementation exists yet. "
            "See methodology_manifest.json's evidence-collection-phase notes."
        )
