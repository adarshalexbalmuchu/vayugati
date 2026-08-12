"""Indian (CPCB) National AQI sub-indices.

Breakpoints from CPCB National AQI document (2014).

Units:
  PM2.5, PM10, NO2, SO2, O3, NH3 — µg/m³  (CPCB API: pollutant_unit = "UG/M3")
  CO                              — mg/m³  (CPCB API: pollutant_unit = "MG/M3")

Callers must pass CO already in mg/m³. Use co_ug_to_mg() when the source
stores CO in µg/m³.

Breakpoint format: (C_lo, C_hi, I_lo, I_hi)
  I_lo = AQI at C_lo (the top of the previous bucket) — NOT I_lo+1.
  This matches CPCB's own formula: I = round_half_up(I_lo + (I_hi-I_lo)*(C-C_lo)/(C_hi-C_lo))
  Verified against the official CPCB AQI Calculation spreadsheet (NSIT station sample):
    PM10=121→114, PM2.5=34→57, O3=57→57, NO2=8→10, NH3=34→9, AQI=114.
"""
import math


# (C_lo, C_hi, I_lo, I_hi) — I_lo is the AQI at the concentration boundary
# between this bucket and the previous one (i.e. top of previous bucket).
PM25_BREAKPOINTS = [
    (0,   30,   0,  50),
    (30,  60,  50, 100),
    (60,  90, 100, 200),
    (90, 120, 200, 300),
    (120, 250, 300, 400),
    (250, 380, 400, 500),  # severe range ends at 380 µg/m³ per CPCB 2014
]

PM10_BREAKPOINTS = [
    (0,   50,   0,  50),
    (50,  100,  50, 100),
    (100, 250, 100, 200),
    (250, 350, 200, 300),
    (350, 430, 300, 400),
    (430, 600, 400, 500),
]

NO2_BREAKPOINTS = [
    (0,   40,   0,  50),
    (40,  80,  50, 100),
    (80,  180, 100, 200),
    (180, 280, 200, 300),
    (280, 400, 300, 400),
    (400, 800, 400, 500),
]

SO2_BREAKPOINTS = [
    (0,    40,   0,  50),
    (40,   80,  50, 100),
    (80,  380, 100, 200),
    (380,  800, 200, 300),
    (800, 1600, 300, 400),
    (1600, 2100, 400, 500),
]

# CO breakpoints are in mg/m³ (CPCB standard); typical Delhi values 0.5–10 mg/m³.
CO_BREAKPOINTS_MG = [
    (0,   1,   0,  50),
    (1,   2,  50, 100),
    (2,  10, 100, 200),
    (10, 17, 200, 300),
    (17, 34, 300, 400),
    (34, 48, 400, 500),
]

O3_BREAKPOINTS = [
    (0,   50,   0,  50),
    (50,  100,  50, 100),
    (100, 168, 100, 200),
    (168, 208, 200, 300),
    (208, 748, 300, 400),
    (748, 1000, 400, 500),
]

NH3_BREAKPOINTS = [
    (0,    200,   0,  50),
    (200,  400,  50, 100),
    (400,  800, 100, 200),
    (800, 1200, 200, 300),
    (1200, 1800, 300, 400),
    (1800, 2400, 400, 500),
]


def co_ug_to_mg(value: float) -> float:
    """Convert CO from µg/m³ to mg/m³ before passing to compute_aqi."""
    return value / 1000.0


def _sub_index(value: float, breakpoints: list[tuple]) -> int:
    if value <= 0:
        return 0
    for c_lo, c_hi, i_lo, i_hi in breakpoints:
        if value <= c_hi:
            # CPCB uses standard rounding (0.5 rounds up), not Python's banker's
            # rounding. math.floor(x + 0.5) matches CPCB's spreadsheet exactly.
            raw = i_lo + (i_hi - i_lo) * (value - c_lo) / (c_hi - c_lo)
            return math.floor(raw + 0.5)
    return 500


def compute_aqi(
    pm25: float | None,
    pm10: float | None,
    no2: float | None = None,
    so2: float | None = None,
    o3: float | None = None,
    co_mg: float | None = None,
    nh3: float | None = None,
) -> int | None:
    """Max sub-index across all available pollutants — matches CPCB's method.

    co_mg must be in mg/m³. All other concentrations in µg/m³.
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
    if co_mg is not None:
        subs.append(_sub_index(co_mg, CO_BREAKPOINTS_MG))
    if nh3 is not None:
        subs.append(_sub_index(nh3, NH3_BREAKPOINTS))
    return max(subs) if subs else None
