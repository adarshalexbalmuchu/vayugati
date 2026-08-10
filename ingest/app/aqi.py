"""Indian (CPCB) National AQI sub-indices.

All concentration values are in µg/m³ (the unit the data.gov.in API stores).
CO is deliberately excluded: CPCB's breakpoints for CO use mg/m³ but the API
stores CO in µg/m³, creating a 1000× unit ambiguity. CO is also essentially
never the dominant pollutant for Delhi AQI. It can be added once the stored
unit is confirmed and a conversion layer is in place.

Breakpoints from CPCB National AQI document (2014).
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
) -> int | None:
    """Max sub-index across PM2.5, PM10, NO2, SO2, O3 (all µg/m³).

    CO is excluded — see module docstring for unit ambiguity reasoning.
    """
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
    return max(subs) if subs else None
