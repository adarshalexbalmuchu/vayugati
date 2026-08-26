"""Sanity tests for the ISRM source inventory and dispersion kernel.

These tests never hit the network, the database, or the filesystem —
everything is tested against static/in-memory data.

Run: pytest ingest/tests/test_isrm_source_inventory.py -v
"""

import math
import pytest

from app.isrm_industrial_zones import (
    DELHI_BBOX,
    INDUSTRIAL_ZONES,
    all_zones,
    zones_as_dicts,
)
from app.isrm_sector_priors import (
    IITK_WINTER,
    consensus_midpoints,
    get_priors,
)
from app.isrm_kernel import (
    _bearing_deg,
    _distance_decay,
    _haversine_km,
    _wind_factor,
    run_kernel,
)


# ── Industrial zones ──────────────────────────────────────────────────────────

class TestIndustrialZones:
    def test_count(self):
        assert len(INDUSTRIAL_ZONES) == 16, (
            "Expected exactly 16 MSME-listed industrial zones"
        )

    def test_all_in_delhi_bbox(self):
        outside = [
            z for z in INDUSTRIAL_ZONES
            if not (
                DELHI_BBOX["lat_min"] <= z.lat <= DELHI_BBOX["lat_max"]
                and DELHI_BBOX["lng_min"] <= z.lng <= DELHI_BBOX["lng_max"]
            )
        ]
        assert outside == [], (
            f"Zones outside Delhi bbox (check lat/lng not swapped): {[z.name for z in outside]}"
        )

    def test_emission_weights_valid(self):
        for z in INDUSTRIAL_ZONES:
            assert z.emission_weight in (1, 2, 3), (
                f"{z.name}: emission_weight {z.emission_weight} not in {{1, 2, 3}}"
            )

    def test_no_duplicate_names(self):
        names = [z.name for z in INDUSTRIAL_ZONES]
        assert len(names) == len(set(names)), "Duplicate zone names detected"

    def test_as_dicts_has_required_keys(self):
        for d in zones_as_dicts():
            for key in ("name", "lat", "lng", "emission_weight", "source_type"):
                assert key in d, f"Missing key '{key}' in zone dict: {d}"
            assert d["source_type"] == "industrial"

    def test_all_zones_returns_full_list(self):
        assert len(all_zones()) == 16


# ── Sector priors ─────────────────────────────────────────────────────────────

class TestSectorPriors:
    def test_iitk_winter_fractions_plausible(self):
        for sector, (lo, hi) in IITK_WINTER.items():
            assert 0.0 <= lo <= hi <= 1.0, (
                f"IITK winter {sector}: ({lo}, {hi}) is not a valid [0,1] range"
            )

    def test_get_priors_returns_midpoints(self):
        p = get_priors("winter", "iitk")
        for sector, (lo, hi) in IITK_WINTER.items():
            assert abs(p[sector] - (lo + hi) / 2) < 1e-9

    def test_get_priors_unknown_study_raises(self):
        with pytest.raises(ValueError):
            get_priors("winter", "made_up_study")

    def test_consensus_midpoints_keys_cover_both_studies(self):
        consensus = consensus_midpoints("winter")
        # Should include at least these key sectors
        for sector in ("dust", "vehicles", "industrial", "biomass_burning"):
            assert sector in consensus

    def test_iitk_summer_dust_dominant(self):
        p = get_priors("summer", "iitk")
        assert p["dust"] == max(p.values()), (
            "Dust should be the dominant sector in IITK summer estimate"
        )


# ── Kernel geometry helpers ───────────────────────────────────────────────────

class TestKernelGeometry:
    def test_haversine_zero_distance(self):
        assert _haversine_km(28.6, 77.2, 28.6, 77.2) == pytest.approx(0.0, abs=1e-6)

    def test_haversine_known_distance(self):
        # Connaught Place (28.6315, 77.2167) → ITO (28.6280, 77.2429)
        # ~2.4 km by road; great-circle should be slightly less (~2.3 km)
        d = _haversine_km(28.6315, 77.2167, 28.6280, 77.2429)
        assert 2.0 < d < 3.0, f"Unexpected CP→ITO distance: {d:.2f} km"

    def test_bearing_north(self):
        # Due north: same lng, higher lat
        b = _bearing_deg(28.0, 77.0, 29.0, 77.0)
        assert abs(b) < 0.5 or abs(b - 360) < 0.5, f"Expected ~0°, got {b:.1f}°"

    def test_bearing_east(self):
        b = _bearing_deg(28.6, 77.0, 28.6, 78.0)
        assert abs(b - 90.0) < 1.0, f"Expected ~90°, got {b:.1f}°"

    def test_distance_decay_zero(self):
        assert _distance_decay(0.0, 10.0) == pytest.approx(1.0)

    def test_distance_decay_sigma(self):
        # At dist = σ: exp(-0.5) ≈ 0.606
        assert _distance_decay(10.0, 10.0) == pytest.approx(math.exp(-0.5), rel=1e-5)

    def test_distance_decay_two_sigma(self):
        # At dist = 2σ: exp(-2) ≈ 0.135
        assert _distance_decay(20.0, 10.0) == pytest.approx(math.exp(-2.0), rel=1e-5)


# ── Wind factor ───────────────────────────────────────────────────────────────

class TestWindFactor:
    def test_perfectly_aligned(self):
        # Wind from N (0°) → blows south.  Source is north of ward (bearing ~0°).
        # Source→ward bearing = 0° (north), wind_toward = 180° (south) — NOT aligned.
        # Source→ward bearing = 180° (south), wind_toward = 180° → perfectly aligned.
        wf = _wind_factor(
            source_to_ward_bearing=180.0,  # source is north, ward is south
            wind_from_dir_deg=0.0,          # wind blows FROM north → TOWARD south
            wind_speed_ms=10.0,
        )
        # cos(0°) = 1.0; factor = 1.0 × (1 + 10/10) = 2.0
        assert wf == pytest.approx(2.0, rel=1e-5)

    def test_perpendicular_wind(self):
        # Wind from west (270°) → blows east.  Source→ward bearing = 180° (south).
        # Δθ = |180 − 90| = 90°, cos(90°) = 0.
        wf = _wind_factor(
            source_to_ward_bearing=180.0,
            wind_from_dir_deg=270.0,  # wind toward = 90° (east)
            wind_speed_ms=5.0,
        )
        assert wf == pytest.approx(0.0, abs=1e-9)

    def test_downwind_source_gets_zero(self):
        # Wind from N → toward S.  Source is south of ward (bearing 180° from ward).
        # Source→ward bearing = 0° (N).  wind_toward = 180° (S).  Δθ = 180°. cos=−1 → 0.
        wf = _wind_factor(
            source_to_ward_bearing=0.0,
            wind_from_dir_deg=0.0,
            wind_speed_ms=5.0,
        )
        assert wf == pytest.approx(0.0, abs=1e-9)

    def test_calm_wind_still_gives_alignment_score(self):
        # Even at 0 m/s wind the cosine alignment should still be > 0
        wf = _wind_factor(180.0, 0.0, wind_speed_ms=0.0)
        # cos(0°)=1, factor = 1 × (1 + 0) = 1.0
        assert wf == pytest.approx(1.0, rel=1e-5)


# ── Full kernel run ───────────────────────────────────────────────────────────

class TestRunKernel:
    """Smoke-test the full kernel on a minimal synthetic dataset."""

    _WARD = {"id": 1, "lat": 28.63, "lng": 77.21, "name": "Test Ward"}
    _WEATHER = {1: {"wind_dir": 315.0, "wind_speed": 5.0}}  # NW wind
    _IND_SRC = [
        {"lat": 28.70, "lng": 77.17, "emission_weight": 3, "source_type": "industrial"},
    ]

    def test_output_shape(self):
        results = run_kernel(
            wards=[self._WARD],
            weather=self._WEATHER,
            industrial_sources=self._IND_SRC,
            fire_sources=[],
            road_sources=[],
        )
        assert len(results) == 1
        r = results[0]
        assert r["ward_id"] == 1
        assert "breakdown" in r
        assert "confidence" in r
        assert r["method"] == "isrm_kernel_v1"

    def test_breakdown_sums_to_one(self):
        results = run_kernel(
            wards=[self._WARD],
            weather=self._WEATHER,
            industrial_sources=self._IND_SRC,
            fire_sources=[],
            road_sources=[],
        )
        b = results[0]["breakdown"]
        total = b["industrial"] + b["road"] + b["fire"] + b["unknown"]
        assert total == pytest.approx(1.0, abs=1e-3)

    def test_no_sources_returns_empty(self):
        results = run_kernel(
            wards=[self._WARD],
            weather=self._WEATHER,
            industrial_sources=[],
            fire_sources=[],
            road_sources=[],
        )
        assert results == []

    def test_confidence_with_station(self):
        # Station co-located with ward → max confidence
        station = {"id": 99, "lat": self._WARD["lat"], "lng": self._WARD["lng"]}
        results = run_kernel(
            wards=[self._WARD],
            weather=self._WEATHER,
            industrial_sources=self._IND_SRC,
            fire_sources=[],
            road_sources=[],
            cpcb_stations=[station],
        )
        assert results[0]["confidence"] == pytest.approx(1.0, abs=1e-3)

    def test_upwind_source_dominates_with_two_sources(self):
        """When one industrial source is upwind and one is downwind, the upwind
        source should carry a larger fraction of the industrial load.

        NW wind (from_dir=315°) → blows toward SE.  Ward at 28.63, 77.21.
        upwind_src:   NW of ward → wind_factor > 0 (aligned)
        downwind_src: SE of ward → wind_factor = 0  (fully downwind)
        Both at the same distance so distance_decay is equal.
        """
        upwind_src   = {"lat": 28.70, "lng": 77.14, "emission_weight": 2, "source_type": "industrial"}
        downwind_src = {"lat": 28.56, "lng": 77.28, "emission_weight": 2, "source_type": "road"}

        r = run_kernel(
            [self._WARD],
            self._WEATHER,
            industrial_sources=[upwind_src],
            fire_sources=[],
            road_sources=[downwind_src],
        )
        b = r[0]["breakdown"]
        # Upwind (industrial) should beat downwind (road): industrial > road
        assert b["industrial"] > b["road"], (
            f"Expected upwind industrial > downwind road, got {b}"
        )
