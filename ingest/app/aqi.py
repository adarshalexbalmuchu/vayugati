"""Indian (CPCB) National AQI sub-indices — µg/m³ for all pollutants.

Breakpoints from CPCB's National AQI document (2014, as-used by data.gov.in).
The API provides avg_value as the appropriate monitoring-period average per
pollutant (24 h for PM/NO2/SO2/NH3; 8 h for CO/O3), so we can use the
values directly without any time-windowing on our side.
"""

# (concentration_low, concentration_high, index_low, index_high)
PM25_BREAKPOINTS = [
    (0, 30, 0, 50),
    (30, 60, 51, 100),
    (60, 90, 101, 200),
    (90, 120, 201, 300),
    (120, 250, 301, 400),
    (250, 500, 401, 500),
]

PM10_BREAKPOINTS = [
    (0, 50, 0, 50),
    (50, 100, 51, 100),
    (100, 250, 101, 200),
    (250, 350, 201, 300),
    (350, 430, 301, 400),
    (430, 600, 401, 500),
]

NO2_BREAKPOINTS = [
    (0, 40, 0, 50),
    (40, 80, 51, 100),
    (80, 180, 101, 200),
    (180, 280, 201, 300),
    (280, 400, 301, 400),
    (400, 800, 401, 500),
]

SO2_BREAKPOINTS = [
    (0, 40, 0, 50),
    (40, 80, 51, 100),
    (80, 380, 101, 200),
    (380, 800, 201, 300),
    (800, 1600, 301, 400),
    (1600, 2100, 401, 500),
]

O3_BREAKPOINTS = [
    (0, 50, 0, 50),
    (50, 100, 51, 100),
    (100, 168, 101, 200),
    (168, 208, 201, 300),
    (208, 748, 301, 400),
    (748, 1000, 401, 500),
]

# CO breakpoints use mg/m³ (CPCB standard); the data.gov.in API provides CO
# in mg/m³ as well (unlike other pollutants which are µg/m³).
CO_BREAKPOINTS_MG = [
    (0, 1, 0, 50),
    (1, 2, 51, 100),
    (2, 10, 101, 200),
    (10, 17, 201, 300),
    (17, 34, 301, 400),
    (34, 48, 401, 500),
]


def _sub_index(value: float, breakpoints: list[tuple]) -> int:
    if value <= 0:
        return 0
    for c_lo, c_hi, i_lo, i_hi in breakpoints:
        if value <= c_hi:
            return round(i_lo + (i_hi - i_lo) * (value - c_lo) / (c_hi - c_lo))
    return 500


def compute_aqi(
    pm25: float | None,
    pm10: float | None,
    no2: float | None = None,
    so2: float | None = None,
    o3: float | None = None,
    co_mg: float | None = None,
) -> int | None:
    """Max sub-index across all available pollutants — matches CPCB's method."""
    subs = []
    if pm25 is not None:
        subs.append(_sub_index(pm25, PM25_BREAKPOINTS))
    if pm10 is not None:
        subs.append(_sub_index(pm10, PM10_BREAKPOINTS))
    if no2 is not None:
        subs.append(_sub_index(no2, NO2_BREAKPOINTS))
    if so2 is not None:
        subs.append(_sub_index(so2, SO2_BREAKPOINTS))
    if o3 is not None:
        subs.append(_sub_index(o3, O3_BREAKPOINTS))
    if co_mg is not None:
        subs.append(_sub_index(co_mg, CO_BREAKPOINTS_MG))
    return max(subs) if subs else None
