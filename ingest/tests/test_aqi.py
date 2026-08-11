"""Unit tests for CPCB National AQI computation.

Covers _sub_index boundary conditions, co_ug_to_mg conversion, and the
compute_aqi max-sub-index aggregation for every supported pollutant.
Breakpoints from aqi.py are taken at their exact boundary values to catch
off-by-one errors in the interpolation formula.
"""

import pytest
from app.aqi import (
    CO_BREAKPOINTS_MG,
    NH3_BREAKPOINTS,
    NO2_BREAKPOINTS,
    O3_BREAKPOINTS,
    PM10_BREAKPOINTS,
    PM25_BREAKPOINTS,
    SO2_BREAKPOINTS,
    _sub_index,
    co_ug_to_mg,
    compute_aqi,
)


# ── co_ug_to_mg ───────────────────────────────────────────────────────────────

def test_co_ug_to_mg_basic():
    assert co_ug_to_mg(1000.0) == pytest.approx(1.0)

def test_co_ug_to_mg_zero():
    assert co_ug_to_mg(0.0) == pytest.approx(0.0)

def test_co_ug_to_mg_typical_delhi():
    # 2000 µg/m³ ≈ 2 mg/m³ — well inside the "moderate" CO band
    assert co_ug_to_mg(2000.0) == pytest.approx(2.0)


# ── _sub_index boundary conditions ───────────────────────────────────────────

class TestSubIndexPM25:
    def test_zero(self):
        assert _sub_index(0, PM25_BREAKPOINTS) == 0

    def test_good_midpoint(self):
        # 15 µg/m³ is midpoint of 0-30 → AQI midpoint of 0-50 = 25
        assert _sub_index(15, PM25_BREAKPOINTS) == 25

    def test_exact_band_ceiling(self):
        # 30 µg/m³ is the ceiling of the first band → AQI 50
        assert _sub_index(30, PM25_BREAKPOINTS) == 50

    def test_second_band_floor(self):
        # 31 µg/m³ is just inside the second band (30-60 → 51-100)
        result = _sub_index(31, PM25_BREAKPOINTS)
        assert 51 <= result <= 53

    def test_hazardous_ceiling(self):
        assert _sub_index(500, PM25_BREAKPOINTS) == 500

    def test_above_ceiling_clamped(self):
        # Value above all breakpoints → 500 (the defined ceiling)
        assert _sub_index(9999, PM25_BREAKPOINTS) == 500


class TestSubIndexPM10:
    def test_zero(self):
        assert _sub_index(0, PM10_BREAKPOINTS) == 0

    def test_good_ceiling(self):
        assert _sub_index(50, PM10_BREAKPOINTS) == 50

    def test_satisfactory_midpoint(self):
        # 75 µg/m³ midpoint of 50-100 band → midpoint of 51-100 ≈ 75
        result = _sub_index(75, PM10_BREAKPOINTS)
        assert 74 <= result <= 76

    def test_hazardous_ceiling(self):
        assert _sub_index(600, PM10_BREAKPOINTS) == 500


class TestSubIndexNO2:
    def test_zero(self):
        assert _sub_index(0, NO2_BREAKPOINTS) == 0

    def test_good_ceiling(self):
        assert _sub_index(40, NO2_BREAKPOINTS) == 50

    def test_above_ceiling(self):
        assert _sub_index(9999, NO2_BREAKPOINTS) == 500


class TestSubIndexSO2:
    def test_zero(self):
        assert _sub_index(0, SO2_BREAKPOINTS) == 0

    def test_good_ceiling(self):
        assert _sub_index(40, SO2_BREAKPOINTS) == 50

    def test_very_poor_range(self):
        # 1000 µg/m³ is within 800-1600 band → AQI 301-400
        result = _sub_index(1000, SO2_BREAKPOINTS)
        assert 301 <= result <= 400


class TestSubIndexCO:
    """CO breakpoints are in mg/m³ — different unit to all other pollutants."""

    def test_zero(self):
        assert _sub_index(0, CO_BREAKPOINTS_MG) == 0

    def test_good_ceiling(self):
        # 1 mg/m³ is the ceiling of the "good" band → AQI 50
        assert _sub_index(1, CO_BREAKPOINTS_MG) == 50

    def test_moderate_band(self):
        # 6 mg/m³ is the midpoint of 2-10 band → AQI 101-200
        result = _sub_index(6, CO_BREAKPOINTS_MG)
        assert 101 <= result <= 200

    def test_typical_delhi_mg(self):
        # 2 mg/m³ (= 2000 µg/m³ via co_ug_to_mg) → satisfactory/moderate boundary
        result = _sub_index(2, CO_BREAKPOINTS_MG)
        assert result == 100 or result == 101  # ceiling of band 2 / floor of band 3

    def test_above_ceiling(self):
        assert _sub_index(9999, CO_BREAKPOINTS_MG) == 500

    def test_raw_ug_value_would_be_wrong(self):
        # 1000 µg/m³ passed as mg/m³ would peg AQI at 500 — proves the bug
        assert _sub_index(1000, CO_BREAKPOINTS_MG) == 500


class TestSubIndexO3:
    def test_zero(self):
        assert _sub_index(0, O3_BREAKPOINTS) == 0

    def test_good_ceiling(self):
        assert _sub_index(50, O3_BREAKPOINTS) == 50


class TestSubIndexNH3:
    def test_zero(self):
        assert _sub_index(0, NH3_BREAKPOINTS) == 0

    def test_good_ceiling(self):
        assert _sub_index(200, NH3_BREAKPOINTS) == 50

    def test_above_ceiling(self):
        assert _sub_index(9999, NH3_BREAKPOINTS) == 500


# ── compute_aqi ───────────────────────────────────────────────────────────────

def test_compute_aqi_none_when_no_pollutants():
    assert compute_aqi(None, None) is None

def test_compute_aqi_pm25_only():
    # 15 µg/m³ PM2.5 → sub-index ~25; no other pollutants
    result = compute_aqi(15, None)
    assert result == 25

def test_compute_aqi_max_of_multiple():
    # PM2.5=15 (sub≈25), PM10=75 (sub≈75) → max should be ~75
    result = compute_aqi(15, 75)
    assert result is not None
    assert result >= 74

def test_compute_aqi_co_mg_units():
    # co_mg=1 → sub-index 50 (good ceiling). PM2.5=None, PM10=None.
    result = compute_aqi(None, None, co_mg=1.0)
    assert result == 50

def test_compute_aqi_co_ug_bug_scenario():
    # 1000 µg/m³ incorrectly passed as mg/m³ → AQI 500 (proves the RF-1 bug)
    result = compute_aqi(None, None, co_mg=1000.0)
    assert result == 500

def test_compute_aqi_co_ug_correct_conversion():
    # 1000 µg/m³ correctly converted → 1 mg/m³ → AQI 50 (good)
    result = compute_aqi(None, None, co_mg=co_ug_to_mg(1000.0))
    assert result == 50

def test_compute_aqi_nh3():
    result = compute_aqi(None, None, nh3=100.0)
    assert result is not None
    assert 0 < result <= 50

def test_compute_aqi_all_pollutants_max_wins():
    # PM2.5=300 → very poor (AQI ~350); everything else low
    result = compute_aqi(
        pm25=300, pm10=10, no2=10, so2=10, o3=10, co_mg=0.1, nh3=10
    )
    assert result is not None
    assert result >= 300

def test_compute_aqi_returns_int():
    result = compute_aqi(30, 50)
    assert isinstance(result, int)

def test_compute_aqi_negative_ignored_by_caller():
    # Negative concentrations should not contribute — _sub_index returns 0 for <=0
    result = compute_aqi(-5, None)
    assert result == 0
