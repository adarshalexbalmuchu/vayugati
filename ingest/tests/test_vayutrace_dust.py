"""Tests for the AP-42/WRAP dust source module.

Pure functions over plain dicts — no .pbf, no network, no DB. See
vayutrace_dust.py's module docstring for the emission factors and for why
windblown/soil dust is deliberately not modelled.

Run: pytest ingest/tests/test_vayutrace_dust.py -v
"""

import pytest

from app import vayutrace_dust as D


class TestPrecipitationFactor:
    """AP-42 13.2.1's hourly special case: zero while raining, a 20% credit
    for up to 12 hours after, full emission otherwise."""

    def test_raining_suppresses_emission_entirely(self):
        assert D.precipitation_factor(1.0) == 0.0

    def test_threshold_is_ap42_wet_hour_definition(self):
        # 0.254 mm (0.01 in) is AP-42's own wet-hour threshold.
        assert D.precipitation_factor(D.PRECIP_WET_THRESHOLD_MM) == 0.0
        assert D.precipitation_factor(D.PRECIP_WET_THRESHOLD_MM - 0.001) == 1.0

    def test_trace_precipitation_does_not_suppress(self):
        # Drizzle below the threshold must not zero out a whole hour.
        assert D.precipitation_factor(0.1) == 1.0

    def test_credit_applies_after_rain_stops(self):
        assert D.precipitation_factor(0.0, recent_wet_hours=3) == pytest.approx(0.8)

    def test_full_emission_when_dry_and_no_recent_rain(self):
        assert D.precipitation_factor(0.0, recent_wet_hours=0) == 1.0

    def test_missing_precipitation_data_does_not_suppress(self):
        # No data must degrade to "assume dry", never to a fabricated 0.
        assert D.precipitation_factor(None) == 1.0


class TestPavedRoadDust:
    def test_empty_input_returns_zero(self):
        assert D.paved_road_dust_emission({}) == 0.0
        assert D.paved_road_dust_emission({"residential": 0.0}) == 0.0

    def test_emission_scales_with_road_length(self):
        one = D.paved_road_dust_emission({"residential": 1.0})
        two = D.paved_road_dust_emission({"residential": 2.0})
        assert two == pytest.approx(2 * one)

    def test_silt_loading_is_inverted_against_road_class(self):
        """AP-42 Table 13.2.1-2: higher traffic means LOWER silt loading,
        because traffic sweeps the surface toward a cleaner equilibrium.
        Easy to get backwards, so locked in explicitly: per equal km, a
        residential road must out-emit a motorway."""
        residential = D.paved_road_dust_emission({"residential": 1.0})
        motorway = D.paved_road_dust_emission({"motorway": 1.0})
        assert residential > motorway

    def test_unknown_road_class_uses_mid_band_not_an_extreme(self):
        unknown = D.paved_road_dust_emission({"some_new_osm_tag": 1.0})
        residential = D.paved_road_dust_emission({"residential": 1.0})
        motorway = D.paved_road_dust_emission({"motorway": 1.0})
        assert motorway < unknown < residential

    def test_precipitation_factor_scales_output(self):
        dry = D.paved_road_dust_emission({"residential": 1.0}, precip_factor=1.0)
        wet = D.paved_road_dust_emission({"residential": 1.0}, precip_factor=0.0)
        damp = D.paved_road_dust_emission({"residential": 1.0}, precip_factor=0.8)
        assert wet == 0.0
        assert damp == pytest.approx(0.8 * dry)

    def test_india_silt_scaling_increases_emission(self):
        base = D.paved_road_dust_emission({"residential": 1.0}, silt_scaling=1.0)
        scaled = D.paved_road_dust_emission({"residential": 1.0},
                                            silt_scaling=D.INDIA_SILT_SCALING)
        assert scaled > base

    def test_matches_ap42_equation_by_hand(self):
        """E = k * sL^0.91 * W^1.02, computed independently here so a silent
        change to the formula (not just the constants) fails the test."""
        sl = D._SILT_LOADING_BY_CLASS["tertiary"] * D.INDIA_SILT_SCALING
        expected = (
            D.AP42_K_PM25_G_PER_VKT
            * (sl ** D.AP42_SL_EXPONENT)
            * (D.FLEET_AVG_WEIGHT_TONS ** D.AP42_W_EXPONENT)
        ) * 2.0  # 2 km of road
        assert D.paved_road_dust_emission({"tertiary": 2.0}) == pytest.approx(expected)


class TestConstructionDust:
    def test_zero_or_missing_area_returns_zero(self):
        assert D.construction_dust_emission(0) == 0.0
        assert D.construction_dust_emission(-5) == 0.0

    def test_emission_scales_linearly_with_area(self):
        a = D.construction_dust_emission(10_000)
        b = D.construction_dust_emission(20_000)
        assert b == pytest.approx(2 * a)

    def test_applies_wrap_factor_and_pm25_ratio(self):
        area = 4046.86  # one acre
        expected = (
            area
            * D.WRAP_CONSTRUCTION_PM10_G_PER_M2_S
            * D.CONSTRUCTION_PM25_PM10_RATIO
            * D.CONSTRUCTION_ACTIVITY_FRACTION
        )
        assert D.construction_dust_emission(area) == pytest.approx(expected)


class TestSourceBuilders:
    def test_road_builder_emits_kernel_shaped_sources(self):
        cells = [{"lat": 28.6, "lng": 77.2,
                  "length_km_by_class": {"residential": 2.0, "primary": 1.0}}]
        out = D.build_road_dust_sources(cells)
        assert len(out) == 1
        s = out[0]
        assert s["source_type"] == "dust"      # kernel groups on this
        assert s["dust_kind"] == "road"        # diagnostic only
        assert s["emission_weight"] > 0
        assert (s["lat"], s["lng"]) == (28.6, 77.2)

    def test_road_builder_skips_cells_with_no_road_length(self):
        cells = [{"lat": 28.6, "lng": 77.2, "length_km_by_class": {}}]
        assert D.build_road_dust_sources(cells) == []

    def test_road_builder_emits_nothing_while_raining(self):
        cells = [{"lat": 28.6, "lng": 77.2, "length_km_by_class": {"residential": 2.0}}]
        assert D.build_road_dust_sources(cells, precip_factor=0.0) == []

    def test_construction_builder_applies_activity_weight(self):
        active = [{"lat": 28.6, "lng": 77.2, "area_m2": 50_000, "activity_weight": 1.0}]
        dormant = [{"lat": 28.6, "lng": 77.2, "area_m2": 50_000, "activity_weight": 0.3}]
        a = D.build_construction_dust_sources(active)[0]["emission_weight"]
        d = D.build_construction_dust_sources(dormant)[0]["emission_weight"]
        assert d == pytest.approx(0.3 * a)

    def test_construction_builder_skips_zero_area(self):
        assert D.build_construction_dust_sources(
            [{"lat": 28.6, "lng": 77.2, "area_m2": 0, "activity_weight": 1.0}]
        ) == []

    def test_construction_to_road_scale_lands_near_published_ratio(self):
        """The unit-reconciliation constant is calibrated against ARAI/TERI
        2018, which puts construction at roughly 0.25-0.67x road dust for
        Delhi PM2.5. An earlier hand-picked value was wrong by ~2000x and
        inverted the ratio, so the relationship is pinned here.

        Pins the constant against the REAL Delhi inventory totals measured
        when it was calibrated (road-dust weight 41,805 from 8,963 grid
        cells; 20,099,048 m2 of construction/disturbed land across 238
        sites), reproduced here as those two aggregate numbers so the test
        needs no .pbf file."""
        REAL_ROAD_DUST_TOTAL = 41_805.0
        REAL_CONSTRUCTION_AREA_M2 = 20_099_048.0

        sites = [{"lat": 28.6, "lng": 77.2,
                  "area_m2": REAL_CONSTRUCTION_AREA_M2, "activity_weight": 1.0}]
        con_total = sum(s["emission_weight"] for s in D.build_construction_dust_sources(sites))

        ratio = con_total / REAL_ROAD_DUST_TOTAL
        assert 0.25 <= ratio <= 0.67, (
            f"construction:road ratio {ratio:.3f} is outside the ARAI/TERI 2018 "
            "range of 0.25-0.67 — CONSTRUCTION_TO_ROAD_SCALE needs recalibration"
        )
