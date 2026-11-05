"""Wind and rainfall for each Jharkhand district, from ERA5 reanalysis (ECMWF / Copernicus) served by Open-Meteo.

Usage (from ingest/, with the venv):
    .venv/bin/python scripts/jharkhand/district_climate.py

For each district's representative point, 10 full years (2015-2024) of hourly 10 m wind and precipitation are
fetched and reduced to: mean annual rainfall and its monsoon (Jun-Sep) share; mean wind speed by season; the
prevailing wind direction by season (speed-weighted vector mean); and an 8-sector wind rose (percent of hours, all
year and winter Dec-Feb). ERA5 is a ~30 km grid model, not a station measurement: it describes the area's
climate, not a particular town's. Output: data/jharkhand/processed/district_climate.json (merged into the district
profiles by district_profiles.py). Open-Meteo is free for non-commercial use; ERA5 is CC BY 4.0 (Copernicus).
"""

from __future__ import annotations

import json
import math
import time
from collections import defaultdict
from pathlib import Path

import httpx
from shapely.geometry import shape
from shapely.validation import make_valid

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "data" / "jharkhand" / "processed"
CACHE = REPO / "ingest" / "data" / "era5"
YEARS = range(2015, 2025)
SEASONS = {"winter": (12, 1, 2), "pre_monsoon": (3, 4, 5), "monsoon": (6, 7, 8, 9), "post_monsoon": (10, 11)}
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
URL = "https://archive-api.open-meteo.com/v1/archive"


def fetch_year(lat: float, lng: float, year: int) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{lat:.3f}_{lng:.3f}_{year}.json"
    if path.exists():
        return json.load(open(path))
    params = {"latitude": lat, "longitude": lng, "start_date": f"{year}-01-01", "end_date": f"{year}-12-31",
              "hourly": "wind_speed_10m,wind_direction_10m,precipitation", "wind_speed_unit": "ms", "timezone": "Asia/Kolkata"}
    for attempt in range(6):
        r = httpx.get(URL, params=params, timeout=120)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(10 * (attempt + 1))
            continue
        r.raise_for_status()
        data = r.json()["hourly"]
        json.dump(data, open(path, "w"))
        return data
    raise RuntimeError(f"Open-Meteo kept failing for {lat},{lng},{year}")


def sector(deg: float) -> int:
    return int(((deg % 360) + 22.5) // 45) % 8


def reduce_point(lat: float, lng: float) -> dict:
    rain_month = defaultdict(float)  # month -> total mm over all years
    speed = defaultdict(list)
    vec = defaultdict(lambda: [0.0, 0.0])
    rose = {"all": [0] * 8, "winter": [0] * 8}
    for y in YEARS:
        h = fetch_year(lat, lng, y)
        for t, ws, wd, pr in zip(h["time"], h["wind_speed_10m"], h["wind_direction_10m"], h["precipitation"]):
            m = int(t[5:7])
            if pr is not None:
                rain_month[m] += pr
            if ws is None or wd is None:
                continue
            for name, months in SEASONS.items():
                if m in months:
                    speed[name].append(ws)
                    # wind direction is where the wind blows FROM; vector-average the from-direction
                    rad = math.radians(wd)
                    vec[name][0] += ws * math.sin(rad)
                    vec[name][1] += ws * math.cos(rad)
            rose["all"][sector(wd)] += 1
            if m in SEASONS["winter"]:
                rose["winter"][sector(wd)] += 1
    n_years = len(list(YEARS))
    annual = sum(rain_month.values()) / n_years
    monsoon = sum(rain_month[m] for m in SEASONS["monsoon"]) / n_years
    out = {"rain_annual_mm": round(annual), "rain_monsoon_pct": round(100 * monsoon / annual, 1) if annual else None,
           "rain_monthly_mm": [round(rain_month[m] / n_years, 1) for m in range(1, 13)], "wind_mean_ms": {}, "wind_from": {}}
    for name in SEASONS:
        s = speed[name]
        out["wind_mean_ms"][name] = round(sum(s) / len(s), 2) if s else None
        vx, vy = vec[name]
        out["wind_from"][name] = SECTORS[sector((math.degrees(math.atan2(vx, vy))) % 360)] if (vx or vy) else None
    for k, counts in rose.items():
        tot = sum(counts) or 1
        out[f"rose_{k}_pct"] = [round(100 * c / tot, 1) for c in counts]
    return out


def main() -> None:
    districts = json.load(open(OUT / "districts.geojson"))["features"]
    result = {}
    for d in districts:
        name = d["properties"]["name"]
        pt = make_valid(shape(d["geometry"])).representative_point()
        result[name] = {"lat": round(pt.y, 3), "lng": round(pt.x, 3), **reduce_point(round(pt.y, 3), round(pt.x, 3))}
        r = result[name]
        print(f"{name:22s} rain {r['rain_annual_mm']:5d} mm, monsoon {r['rain_monsoon_pct']}%, winter wind from {r['wind_from']['winter']} "
              f"at {r['wind_mean_ms']['winter']} m/s", flush=True)
    doc = {"source": "ERA5 reanalysis (ECMWF / Copernicus Climate Change Service), hourly 10 m wind and precipitation, "
                     "2015-2024, via Open-Meteo archive API. About a 30 km grid: the climate of the area, not a "
                     "measurement at a town. Wind direction is where the wind blows FROM.",
           "years": [min(YEARS), max(YEARS)], "districts": result}
    json.dump(doc, open(OUT / "district_climate.json", "w"), indent=1)
    print("wrote district_climate.json")


if __name__ == "__main__":
    main()
