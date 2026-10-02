"""data.gov.in's real-time feed publishes AQI sub-indices, not concentrations."""

import pytest

from app import data_gov_cpcb


def _rec(pollutant, avg, mn=None, mx=None, unit=None):
    r = {"station": "ITO, Delhi - CPCB", "last_update": "24-09-2026 10:00:00",
         "latitude": "28.63", "longitude": "77.24", "pollutant_id": pollutant,
         "avg_value": str(avg), "min_value": str(mn) if mn is not None else "NA",
         "max_value": str(mx) if mx is not None else "NA"}
    if unit:
        r["pollutant_unit"] = unit
    return r


def test_group_by_station_converts_sub_indices_to_concentrations():
    g = data_gov_cpcb.group_by_station([
        _rec("NO2", 25, 10, 100), _rec("PM2.5", 50), _rec("CO", 47)])
    p = g["ITO, Delhi - CPCB"]["pollutants"]
    assert p["no2"]["avg"] == pytest.approx(20.0)      # index 25 -> 20 ug/m3
    assert p["no2"]["min"] == pytest.approx(8.0)
    assert p["no2"]["max"] == pytest.approx(80.0)
    assert p["no2"]["sub_index"] == 25
    assert p["pm25"]["avg"] == pytest.approx(30.0)
    assert p["co"]["avg"] == pytest.approx(0.94)       # mg/m3, not 0.047
    assert p["co"]["unit"] == "MG/M3"
    assert p["no2"]["unit"] == "UG/M3"


def test_group_by_station_missing_min_max_stay_none():
    p = data_gov_cpcb.group_by_station([_rec("SO2", 12)])["ITO, Delhi - CPCB"]["pollutants"]["so2"]
    assert p["min"] is None and p["max"] is None
    assert p["avg"] == pytest.approx(12 * 40 / 50)
