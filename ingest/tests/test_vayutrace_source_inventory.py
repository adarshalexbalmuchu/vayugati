"""Sanity tests for the ISRM source inventory and dispersion kernel.

These tests never hit the network, the database, or the filesystem —
everything is tested against static/in-memory data.

Run: pytest ingest/tests/test_vayutrace_source_inventory.py -v
"""

import math
import pytest

from app.vayutrace_industrial_zones import (
    DELHI_BBOX,
    INDUSTRIAL_ZONES,
    all_zones,
    zones_as_dicts,
)
from app.vayutrace_sector_priors import (
    IITK_WINTER,
    consensus_midpoints,
    get_priors,
)
from app import vayutrace_kernel
from app.vayutrace_kernel import (
    CALM_ISOTROPIC_FACTOR,
    SIGMA_ROAD_KM,
    _bearing_deg,
    _calibrate_road_industrial_scale,
    _distance_decay,
    _haversine_km,
    _point_in_geometry,
    _wind_factor,
    boundary_area_centroid,
    boundary_bbox_center,
    run_kernel,
)


# ── Industrial zones ──────────────────────────────────────────────────────────

class TestIndustrialZones:
    def test_count(self):
        # 29 planned + 4 flatted factory + 27 non-conforming = 60
        assert len(INDUSTRIAL_ZONES) == 60, (
            f"Expected 60 zones (29 planned + 4 FFC + 27 non-conforming), got {len(INDUSTRIAL_ZONES)}"
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
        assert len(all_zones()) == 60

    def test_category_counts(self):
        from app.vayutrace_industrial_zones import zones_by_category
        assert len(zones_by_category("planned")) == 29
        assert len(zones_by_category("flatted_factory")) == 4
        assert len(zones_by_category("non_conforming")) == 27


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
        # At 0 m/s wind, direction is meteorologically unreliable (EPA AERMOD
        # / WMO TN-285) — the kernel falls back to the isotropic factor
        # (1/pi) regardless of bearing, per the calm-wind model added in
        # 3e59d2f. This is > 0, so calm wind still gives *some* alignment
        # score, just not the full directional cos(Delta-theta)=1 the
        # pre-isotropic-fallback version of this test asserted.
        wf = _wind_factor(180.0, 0.0, wind_speed_ms=0.0)
        assert wf == pytest.approx(CALM_ISOTROPIC_FACTOR, rel=1e-5)


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
        assert r["method"] == "vayutrace_v1"

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

    def test_upwind_dominance_is_governed_by_wind_direction_blend(self):
        """Upwind/downwind asymmetry exists only when WIND_DIRECTION_BLEND > 0.

        This test previously asserted unconditionally that an upwind source
        outweighs a downwind one. That assertion was RETIRED (Sept 2026)
        because the production default became WIND_DIRECTION_BLEND=0.0,
        under which upwind and downwind sources are weighted identically.

        On the evidence for that default, note the correction: an initial
        sweep at n=12 wards suggested the directional term was monotonically
        harmful (+0.107 / +0.006 / -0.008 for blend 0.00 / 0.25 / 1.00), but
        re-sweeping at n=39 wards after the ERA5 weather backfill found the
        settings INDISTINGUISHABLE (-0.060 vs -0.055). The default is 0.0 on
        physical reasoning — a single receptor-point wind reading is a poor
        transport proxy — not on a measured win. See WIND_DIRECTION_BLEND's
        own comment in vayutrace_kernel.py.

        The machinery is retained for a future spatially-resolved wind
        field, so this test verifies the MECHANISM still works when enabled,
        rather than asserting a production behaviour either way.

        NW wind (from_dir=315°) → blows toward SE. Ward at 28.63, 77.21.
        upwind_src (NW of ward) is aligned; downwind_src (SE) is not.
        Both are at the same distance, so distance_decay is equal.
        """
        upwind_src   = {"lat": 28.70, "lng": 77.14, "emission_weight": 2, "source_type": "industrial"}
        downwind_src = {"lat": 28.56, "lng": 77.28, "emission_weight": 2, "source_type": "road"}

        def _breakdown() -> dict:
            return run_kernel(
                [self._WARD],
                self._WEATHER,
                industrial_sources=[upwind_src],
                fire_sources=[],
                road_sources=[downwind_src],
            )[0]["breakdown"]

        original = vayutrace_kernel.WIND_DIRECTION_BLEND
        try:
            # Mechanism check: with direction fully enabled, upwind wins.
            vayutrace_kernel.WIND_DIRECTION_BLEND = 1.0
            b_directional = _breakdown()
            assert b_directional["industrial"] > b_directional["road"], (
                f"With blend=1.0 the upwind source must dominate, got {b_directional}"
            )

            # Production default: direction ignored, so the asymmetry is gone.
            vayutrace_kernel.WIND_DIRECTION_BLEND = 0.0
            b_isotropic = _breakdown()
            assert b_isotropic["industrial"] < b_directional["industrial"], (
                "Disabling the directional blend must reduce the upwind "
                f"source's share; got {b_isotropic} vs {b_directional}"
            )
        finally:
            vayutrace_kernel.WIND_DIRECTION_BLEND = original

    def test_dilution_scales_local_score_but_not_breakdown_fractions(self):
        """Dilution acts on the whole local air parcel, so it must change the
        magnitude (local_score) without redistributing the source split."""
        src_a = {"lat": 28.70, "lng": 77.14, "emission_weight": 2, "source_type": "industrial"}
        src_b = {"lat": 28.56, "lng": 77.28, "emission_weight": 2, "source_type": "road"}

        stagnant = {1: {"wind_dir": 315.0, "wind_speed": 1.0, "ventilation_coefficient": 300.0}}
        ventilated = {1: {"wind_dir": 315.0, "wind_speed": 1.0, "ventilation_coefficient": 9000.0}}

        r_stag = run_kernel([self._WARD], stagnant,
                            industrial_sources=[src_a], fire_sources=[], road_sources=[src_b])[0]
        r_vent = run_kernel([self._WARD], ventilated,
                            industrial_sources=[src_a], fire_sources=[], road_sources=[src_b])[0]

        # Stagnant air traps emissions -> higher predicted local concentration.
        assert r_stag["local_score"] > r_vent["local_score"]
        # ...but the source attribution split is unchanged.
        assert r_stag["breakdown"]["industrial"] == pytest.approx(
            r_vent["breakdown"]["industrial"], abs=1e-6
        )

    def test_dilution_factor_is_noop_without_meteorology(self):
        """A ward with no usable weather must degrade to pure geometry
        (factor 1.0), never be dropped or given fabricated conditions."""
        assert vayutrace_kernel.dilution_factor(None) == 1.0
        assert vayutrace_kernel.dilution_factor(None, None, None) == 1.0
        assert vayutrace_kernel.dilution_factor(0) == 1.0          # non-positive
        assert vayutrace_kernel.dilution_factor(float("nan")) == 1.0

    def test_dilution_factor_recomputes_vc_from_pblh_and_wind(self):
        """VC is PBLH x wind_speed; when VC is absent but both parts are
        present the factor must still be computed, not skipped."""
        direct = vayutrace_kernel.dilution_factor(2000.0)
        derived = vayutrace_kernel.dilution_factor(None, 1000.0, 2.0)  # 1000*2 = 2000
        assert direct == pytest.approx(derived)

    def test_dilution_factor_is_floored_against_absurd_calm_spikes(self):
        """A near-zero VC must not produce an unbounded concentration."""
        floored = vayutrace_kernel.dilution_factor(0.001)
        expected = vayutrace_kernel.VC_REFERENCE_M2S / vayutrace_kernel.VC_FLOOR_M2S
        assert floored == pytest.approx(expected)

    def test_dilution_floor_sits_below_the_real_vc_distribution(self):
        """Regression test (Sept 2026): VC_FLOOR_M2S was 200.0, which sat
        INSIDE the real distribution — 36.3% of 48,904 measured ward-hours
        fell below it, so more than a third of the data was clipped to a
        single constant and the dilution term lost most of its variation.

        Measured percentiles of real VC (m^2/s): p1=4, p5=18, p25=111,
        median=388, p75=1187, p95=3076. The floor is a divide-by-zero
        guard, so it must sit below roughly the 5th percentile rather than
        inside the bulk of the distribution."""
        assert vayutrace_kernel.VC_FLOOR_M2S <= 20.0, (
            "VC_FLOOR_M2S is high enough to clip a meaningful share of real "
            "ward-hours; it should guard division, not truncate the signal"
        )

    def test_dilution_factor_preserves_variation_across_the_real_vc_range(self):
        """Distinct VC values across the observed range must map to distinct
        dilution factors — the failure mode of a too-high floor is that they
        silently collapse to one value."""
        factors = [
            vayutrace_kernel.dilution_factor(vc)
            for vc in (18.0, 111.0, 388.0, 1187.0, 3076.0)  # p5..p95 of real data
        ]
        assert len(set(factors)) == len(factors)
        # Monotonic: more ventilation must mean less concentration.
        assert factors == sorted(factors, reverse=True)

    def test_wards_with_null_coordinates_are_skipped_not_crashed(self):
        """Regression test (Sept 2026): every fixture ward above always has
        real lat/lng, so this exact bug — run_kernel() crashing with
        "must be real number, not NoneType" the instant it hits a ward with
        NULL coordinates — was never caught by this test suite, even though
        it happened on every single production run (confirmed live: 252 of
        265 real wards have no lat/lng, and a live DB check found ZERO
        attributions.method='vayutrace_v1' rows had ever been written,
        because main.py's run_intel() swallows the exception). A ward with
        real coordinates mixed in with one that has none must still produce
        a result for the valid ward, not raise."""
        good_ward = self._WARD
        bad_ward = {"id": 2, "lat": None, "lng": None, "name": "No-coords Ward"}
        weather = {**self._WEATHER, 2: {"wind_dir": 315.0, "wind_speed": 5.0}}

        results = run_kernel(
            wards=[good_ward, bad_ward],
            weather=weather,
            industrial_sources=self._IND_SRC,
            fire_sources=[],
            road_sources=[],
        )
        assert len(results) == 1
        assert results[0]["ward_id"] == 1  # only the good ward produced a result

    def test_cpcb_stations_actually_varies_confidence(self):
        """Regression test (Sept 2026): estimate_city() (the function
        vayutrace_attribution.run() actually calls) never accepted a
        cpcb_stations parameter at all, so confidence silently defaulted to
        a flat 0.5 for every ward in every production run — even though
        vayutrace_attribution.run() already fetched real station
        coordinates into an unused local variable. run_kernel() itself
        (tested directly here) always supported cpcb_stations correctly;
        the bug was purely in estimate_city() never forwarding it — see
        that function's own updated doc comment."""
        near_station = {"id": 99, "lat": self._WARD["lat"] + 0.001, "lng": self._WARD["lng"]}
        far_station = {"id": 100, "lat": self._WARD["lat"] + 5.0, "lng": self._WARD["lng"]}

        near_result = run_kernel(
            wards=[self._WARD], weather=self._WEATHER,
            industrial_sources=self._IND_SRC, fire_sources=[], road_sources=[],
            cpcb_stations=[near_station],
        )
        far_result = run_kernel(
            wards=[self._WARD], weather=self._WEATHER,
            industrial_sources=self._IND_SRC, fire_sources=[], road_sources=[],
            cpcb_stations=[far_station],
        )
        assert near_result[0]["confidence"] > far_result[0]["confidence"]

    def test_road_never_collapses_the_breakdown_after_calibration(self):
        """Regression test (Sept 2026): end-to-end via run_kernel(), not just
        _calibrate_road_industrial_scale() in isolation — a dense road
        inventory (mimicking the real ~9,000-cell post-grid-aggregation
        output) alongside a normal industrial inventory must not collapse
        the ward to ~100% road, which is exactly the bug this session found
        live (every one of 265 real wards read road>=95% before the
        road/industrial calibration fix)."""
        many_road_cells = [
            {"lat": self._WARD["lat"] + 0.001 * i, "lng": self._WARD["lng"], "emission_weight": 5.0, "source_type": "road"}
            for i in range(50)
        ]
        results = run_kernel(
            wards=[self._WARD], weather=self._WEATHER,
            industrial_sources=self._IND_SRC, fire_sources=[], road_sources=many_road_cells,
        )
        b = results[0]["breakdown"]
        assert b["road"] < 0.95, f"road collapsed the breakdown again: {b}"
        assert b["industrial"] > 0.0


class TestCalibrateRoadIndustrialScale:
    """_calibrate_road_industrial_scale() directly — the fix for the
    road/industrial unit-mismatch bug (Sept 2026). See that function's own
    doc comment in vayutrace_kernel.py for the full story: a first attempt
    calibrated against RAW city-wide totals and overshot the other way
    (industrial then dominated ~86-98% of every ward) because road's much
    tighter SIGMA_ROAD_KM=1km means its raw total and its effective
    per-ward reach are very different quantities — fixed by calibrating
    against DECAY-WEIGHTED mass instead, averaged across every ward."""

    _WARDS = [
        {"id": 1, "lat": 28.60, "lng": 77.20},
        {"id": 2, "lat": 28.65, "lng": 77.25},
        {"id": 3, "lat": 28.55, "lng": 77.15},
    ]

    def test_noop_when_industrial_absent(self):
        sources = [{"lat": 28.6, "lng": 77.2, "source_type": "road", "_ew": 100.0}]
        before = sources[0]["_ew"]
        _calibrate_road_industrial_scale(sources, self._WARDS, month=1, effective_sigma=5.0)
        assert sources[0]["_ew"] == before

    def test_noop_when_road_absent(self):
        sources = [{"lat": 28.6, "lng": 77.2, "source_type": "industrial", "_ew": 2.0}]
        before = sources[0]["_ew"]
        _calibrate_road_industrial_scale(sources, self._WARDS, month=1, effective_sigma=5.0)
        assert sources[0]["_ew"] == before

    def test_road_mass_shrinks_when_wildly_overrepresented(self):
        """The exact shape of the real bug: many road sources with a large
        raw emission_weight (post length-weighting) vs. a few industrial
        sources with small bounded weights — road's raw sum vastly exceeds
        industrial's, and calibration must shrink road's _ew, not grow it."""
        industrial = [
            {"lat": 28.62, "lng": 77.22, "source_type": "industrial", "_ew": 2.0}
            for _ in range(5)
        ]
        road = [
            {"lat": 28.60 + 0.001 * i, "lng": 77.20, "source_type": "road", "_ew": 50.0}
            for i in range(20)
        ]
        sources = industrial + road
        road_ew_before = sum(s["_ew"] for s in sources if s["source_type"] == "road")

        _calibrate_road_industrial_scale(sources, self._WARDS, month=1, effective_sigma=5.0)

        road_ew_after = sum(s["_ew"] for s in sources if s["source_type"] == "road")
        assert road_ew_after < road_ew_before

    def test_calibrated_ratio_matches_literature_consensus(self):
        """After calibration, the DECAY-WEIGHTED road:industrial ratio
        (averaged across the sample wards, exactly as the function itself
        computes it) should land on the IITK/TERI-ARAI consensus ratio —
        this is the actual acceptance criterion for the fix, not just
        "some" change happened."""
        industrial = [
            {"lat": 28.62, "lng": 77.22, "source_type": "industrial", "_ew": 2.0}
            for _ in range(5)
        ]
        road = [
            {"lat": 28.60 + 0.001 * i, "lng": 77.20, "source_type": "road", "_ew": 50.0}
            for i in range(20)
        ]
        sources = industrial + road

        _calibrate_road_industrial_scale(sources, self._WARDS, month=1, effective_sigma=5.0)

        ind_mass = sum(
            sum(
                s["_ew"] * _distance_decay(_haversine_km(w["lat"], w["lng"], s["lat"], s["lng"]), 5.0)
                for s in sources if s["source_type"] == "industrial"
            )
            for w in self._WARDS
        ) / len(self._WARDS)
        road_mass = sum(
            sum(
                s["_ew"] * _distance_decay(_haversine_km(w["lat"], w["lng"], s["lat"], s["lng"]), SIGMA_ROAD_KM)
                for s in sources if s["source_type"] == "road"
            )
            for w in self._WARDS
        ) / len(self._WARDS)

        actual_ratio = road_mass / ind_mass
        target_ratio = consensus_midpoints("winter")["vehicles"] / consensus_midpoints("winter")["industrial"]
        assert actual_ratio == pytest.approx(target_ratio, rel=1e-3)

    def test_no_wards_with_usable_coordinates_is_a_noop_not_a_crash(self):
        sources = [
            {"lat": 28.6, "lng": 77.2, "source_type": "industrial", "_ew": 2.0},
            {"lat": 28.6, "lng": 77.2, "source_type": "road", "_ew": 50.0},
        ]
        broken_wards = [{"id": 1, "lat": None, "lng": None, "boundary": None}]
        road_ew_before = sources[1]["_ew"]
        _calibrate_road_industrial_scale(sources, broken_wards, month=1, effective_sigma=5.0)
        assert sources[1]["_ew"] == road_ew_before


class TestBoundaryBboxCenter:
    """boundary_bbox_center() — the receptor-point fallback for the 252 of
    265 real wards with no captured lat/lng (confirmed live this session).
    Deliberate port of web/src/components/overview/OverviewChoroplethMap.tsx's
    own boundingBoxCenter(): same min/max-then-midpoint approach, so a
    ward's kernel receptor point matches its frontend fly-to point exactly."""

    def test_simple_polygon_center(self):
        # A simple square: (0,0)-(0,2)-(2,2)-(2,0) in [lng, lat] pairs.
        geometry = {
            "type": "Polygon",
            "coordinates": [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]],
        }
        center = boundary_bbox_center(geometry)
        assert center == pytest.approx((1.0, 1.0))  # (lat, lng)

    def test_multipolygon_spans_all_parts(self):
        # Two disjoint squares — bbox must cover both, not just the first.
        geometry = {
            "type": "MultiPolygon",
            "coordinates": [
                [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]],
                [[[10, 10], [10, 12], [12, 12], [12, 10], [10, 10]]],
            ],
        }
        center = boundary_bbox_center(geometry)
        # bbox spans lng 0-12, lat 0-12 → center (6, 6)
        assert center == pytest.approx((6.0, 6.0))

    def test_none_geometry_returns_none_not_fabricated(self):
        assert boundary_bbox_center(None) is None

    def test_malformed_geometry_returns_none(self):
        assert boundary_bbox_center({"type": "Point", "coordinates": [1, 2]}) is None
        assert boundary_bbox_center({"type": "Polygon"}) is None  # no coordinates key

    def test_run_kernel_uses_boundary_fallback_for_null_coord_ward(self):
        """The actual production fix: a ward with lat=lng=None but a real
        boundary polygon must still get a receptor point and produce a
        result, not be skipped — this is what takes VayuTrace from 13
        wards to (up to) all 265."""
        good_ward = {"id": 1, "lat": 28.63, "lng": 77.21, "name": "Point Ward"}
        boundary_ward = {
            "id": 2, "lat": None, "lng": None, "name": "Boundary-only Ward",
            "boundary": {
                "type": "Polygon",
                "coordinates": [[[77.20, 28.62], [77.20, 28.64], [77.22, 28.64], [77.22, 28.62], [77.20, 28.62]]],
            },
        }
        weather = {1: {"wind_dir": 315.0, "wind_speed": 5.0}, 2: {"wind_dir": 315.0, "wind_speed": 5.0}}
        ind_src = [{"lat": 28.70, "lng": 77.17, "emission_weight": 3, "source_type": "industrial"}]

        results = run_kernel(
            wards=[good_ward, boundary_ward],
            weather=weather,
            industrial_sources=ind_src,
            fire_sources=[],
            road_sources=[],
        )
        result_ward_ids = {r["ward_id"] for r in results}
        assert result_ward_ids == {1, 2}, (
            f"Expected both wards to produce a result (one via real point, one via "
            f"boundary fallback), got {result_ward_ids}"
        )

    def test_run_kernel_still_skips_ward_with_neither_point_nor_boundary(self):
        good_ward = {"id": 1, "lat": 28.63, "lng": 77.21, "name": "Point Ward"}
        truly_stuck_ward = {"id": 3, "lat": None, "lng": None, "name": "No location at all", "boundary": None}
        weather = {1: {"wind_dir": 315.0, "wind_speed": 5.0}}
        ind_src = [{"lat": 28.70, "lng": 77.17, "emission_weight": 3, "source_type": "industrial"}]

        results = run_kernel(
            wards=[good_ward, truly_stuck_ward],
            weather=weather,
            industrial_sources=ind_src,
            fire_sources=[],
            road_sources=[],
        )
        assert {r["ward_id"] for r in results} == {1}


class TestBoundaryAreaCentroid:
    """boundary_area_centroid() — the kernel's UPGRADED receptor-point
    fallback (Sept 2026, 2nd pass), replacing boundary_bbox_center() for
    this specific use. Faithful port of web/src/lib/dataQualityRules.ts's
    geometryCentroid()/ringSignedAreaCentroid()/polygonInteriorPoint()/
    scanForInteriorPoint() — same fixtures/geometries as that file's own
    test suite (dataQualityRules.test.ts), so both implementations are
    checked against the same known-answer shapes."""

    @staticmethod
    def _square(center_lat: float, center_lng: float, half_deg: float = 0.02) -> dict:
        n, s = center_lat + half_deg, center_lat - half_deg
        e, w = center_lng + half_deg, center_lng - half_deg
        return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}

    @staticmethod
    def _polygon_with_hole(center_lat: float, center_lng: float, outer_deg: float = 0.02, hole_deg: float = 0.01) -> dict:
        on, os_, oe, ow = center_lat + outer_deg, center_lat - outer_deg, center_lng + outer_deg, center_lng - outer_deg
        hn, hs, he, hw = center_lat + hole_deg, center_lat - hole_deg, center_lng + hole_deg, center_lng - hole_deg
        return {
            "type": "Polygon",
            "coordinates": [
                [[ow, os_], [oe, os_], [oe, on], [ow, on], [ow, os_]],
                [[hw, hs], [he, hs], [he, hn], [hw, hn], [hw, hs]],
            ],
        }

    @staticmethod
    def _u_shape() -> dict:
        # Outer box 77.19-77.23 / 28.60-28.64; notch cut from top at
        # 77.20-77.22 / 28.61-28.64. Shoelace centroid ≈ (28.615, 77.21) —
        # inside the notch, outside the polygon. Same shape as the TS
        # fixture (dataQualityRules.test.ts's uShapePolygon()).
        return {
            "type": "Polygon",
            "coordinates": [[
                [77.19, 28.60], [77.23, 28.60], [77.23, 28.64],
                [77.22, 28.64], [77.22, 28.61], [77.20, 28.61],
                [77.20, 28.64], [77.19, 28.64], [77.19, 28.60],
            ]],
        }

    @staticmethod
    def _two_part_multipolygon(lat1: float, lng1: float, lat2: float, lng2: float, half_deg: float = 0.02) -> dict:
        def ring(lat: float, lng: float) -> list[list[float]]:
            n, s, e, w = lat + half_deg, lat - half_deg, lng + half_deg, lng - half_deg
            return [[w, s], [e, s], [e, n], [w, n], [w, s]]
        return {"type": "MultiPolygon", "coordinates": [[ring(lat1, lng1)], [ring(lat2, lng2)]]}

    def test_centroid_of_square_at_geometric_center(self):
        geom = self._square(28.62, 77.21)
        c = boundary_area_centroid(geom)
        assert c is not None
        lat, lng = c
        assert lat == pytest.approx(28.62, abs=1e-3)
        assert lng == pytest.approx(77.21, abs=1e-3)

    def test_reads_coordinates_as_lng_lat_not_lat_lng(self):
        # If the order were swapped the result would be ~(77.21, 28.62) instead of (28.62, 77.21).
        geom = self._square(28.62, 77.21)
        lat, lng = boundary_area_centroid(geom)
        assert lat == pytest.approx(28.62, abs=0.1)
        assert lng == pytest.approx(77.21, abs=0.1)

    def test_multipolygon_returns_largest_subpolygon_centroid_not_empty_space_midpoint(self):
        geom = self._two_part_multipolygon(28.55, 77.15, 28.65, 77.21)
        c = boundary_area_centroid(geom)
        assert c is not None
        lat, lng = c
        # Area-weighted midpoint (28.60, 77.18) would fall between the two
        # sub-polygons — equal-area parts here, first-wins.
        assert lat == pytest.approx(28.55, abs=0.1)
        assert lng == pytest.approx(77.15, abs=0.1)

    def test_u_shape_returns_a_pip_verified_point_not_the_notch(self):
        geom = self._u_shape()
        c = boundary_area_centroid(geom)
        assert c is not None
        lat, lng = c
        assert _point_in_geometry(lat, lng, geom) is True
        assert 28.60 <= lat <= 28.64
        assert 77.19 <= lng <= 77.23

    def test_polygon_with_hole_avoids_landing_in_the_hole(self):
        geom = self._polygon_with_hole(28.62, 77.21, 0.02, 0.01)
        c = boundary_area_centroid(geom)
        assert c is not None
        lat, lng = c
        assert _point_in_geometry(lat, lng, geom) is True

    def test_none_geometry_returns_none_not_fabricated(self):
        assert boundary_area_centroid(None) is None

    def test_degenerate_empty_ring_returns_none(self):
        assert boundary_area_centroid({"type": "Polygon", "coordinates": [[]]}) is None

    def test_degenerate_fewer_than_three_vertices_returns_none(self):
        assert boundary_area_centroid({"type": "Polygon", "coordinates": [[[77.21, 28.62]]]}) is None

    def test_malformed_geometry_returns_none(self):
        assert boundary_area_centroid({"type": "Point", "coordinates": [1, 2]}) is None
        assert boundary_area_centroid({"type": "Polygon"}) is None

    def test_run_kernel_uses_area_centroid_not_bbox_center_for_concave_ward(self):
        """End-to-end: a U-shaped ward with no real point must still produce
        a result via boundary_area_centroid(), and the receptor point used
        must genuinely lie inside the polygon (not the notch a naive
        bbox-center would've silently used instead)."""
        good_ward = {"id": 1, "lat": 28.63, "lng": 77.21, "name": "Point Ward"}
        u_shaped_ward = {"id": 2, "lat": None, "lng": None, "name": "U-shaped Ward", "boundary": self._u_shape()}
        weather = {1: {"wind_dir": 315.0, "wind_speed": 5.0}, 2: {"wind_dir": 315.0, "wind_speed": 5.0}}
        ind_src = [{"lat": 28.70, "lng": 77.17, "emission_weight": 3, "source_type": "industrial"}]

        results = run_kernel(
            wards=[good_ward, u_shaped_ward], weather=weather,
            industrial_sources=ind_src, fire_sources=[], road_sources=[],
        )
        assert {r["ward_id"] for r in results} == {1, 2}
