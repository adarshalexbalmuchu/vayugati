"""Site-level dataset for per-species training: every reference monitor, not every ward.

Why sites and not wards: the spatial question ("why is one place dirtier than
another") gets one answer per LOCATION, so the effective sample size is the
number of distinct monitors, not the number of hours. The ward pipeline gave
39 (monitors in the same ward were averaged together, and NCR monitors
outside Delhi's wards were dropped). Land-use-regression studies find held-out
skill is overstated below ~40 sites and stabilises around 80+ (Basagana et
al. 2012; the ESCAPE design used 40+ per area).

Pipeline (each step cached under ingest/data/species_cache/, gitignored):
  discover(bbox, species) -> distinct sites (reference monitors, deduped at 0.3 km)
  pull_obs(sites, ...)    -> hourly values from OpenAQ v3 /sensors/{id}/hours
  pull_met(sites, ...)    -> ERA5 hourly weather via Open-Meteo archive
"""

from __future__ import annotations

import json
import math
import pickle
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app import config  # noqa: E402
from app.open_meteo import get_historical_hourly  # noqa: E402

CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "species_cache"
NCR_BBOX = (76.70, 28.20, 77.70, 29.05)  # min_lng, min_lat, max_lng, max_lat

# ug/m3 per ppb at 25 C, 1 atm (the CPCB NAAQS reference condition).
PPB_TO_UGM3 = {"no2": 1.88, "so2": 2.62, "o3": 1.96, "co": 1.145}

# OpenAQ labels the Indian CPCB/caaqm gas series "ppb", but for NO2 the
# values behave as ug/m3. Evidence (Sept 2026, 37 Delhi stations, ~23k
# station-hours): our own CPCB/data.gov.in values are 24-HOUR ROLLING means
# (corr 0.979 with OpenAQ's trailing-24h mean at zero lag, vs 0.78 hourly),
# and against that like-for-like mean every station sits at 1.17-1.30x,
# median 1.25 -- far nearer 1.0 (same unit) than 1.88 (true ppb). The
# uniform 25% gap is unexplained: absolute NO2 levels carry that
# uncertainty; ratios, ranks and correlations do not depend on it.
#
# Extended to every gas (Sept 2026), after correcting the CPCB rows: OpenAQ
# hourly values averaged over CPCB's window match CPCB at 7 stations,
# ~5k station-hours each. NO2, SO2: 24h mean, ratio 1.00, corr 0.997 / 0.999.
# O3: 8h mean, 1.00, 0.994. CO: 8h mean, 1.01, 0.991, with the "ppb"-labelled
# CO series in mg/m3.
OPENAQ_PPB_LABEL_IS_UGM3 = {"no2": True, "so2": True, "o3": True}
# The "ppb"-labelled CO series is CPCB's native mg/m3: x1000 gives ug/m3,
# the unit every species in this pipeline is stored in.
OPENAQ_PPB_LABEL_FACTOR = {"co": 1000.0}


_RATE_LOCK = threading.Lock()
_CALLS: list[float] = []
MAX_PER_MIN = 25  # OpenAQ allows 60/min per key, SHARED with the live ingest service: at 50/min its
# OpenAQ fallback (the only data source during a CPCB outage) hit 429s, Sept 2026


def _get(path: str, params: dict) -> dict:
    for attempt in range(6):
        with _RATE_LOCK:  # sliding-window limiter shared by all worker threads
            now = time.time()
            while _CALLS and now - _CALLS[0] > 60:
                _CALLS.pop(0)
            if len(_CALLS) >= MAX_PER_MIN:
                time.sleep(60 - (now - _CALLS[0]) + 0.1)
            _CALLS.append(time.time())
        r = httpx.get(f"https://api.openaq.org/v3{path}", params=params,
                      headers={"X-API-Key": config.OPENAQ_API_KEY}, timeout=90)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(min(60, 5 * 2 ** attempt))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()
    return {}


def _km(a, b) -> float:
    return math.hypot((a[0] - b[0]) * 110.574, (a[1] - b[1]) * 111.320 * math.cos(math.radians(a[0])))


def discover(bbox=NCR_BBOX, species="no2", active_since="2026-01-01", dedupe_km=0.3) -> list[dict]:
    """Distinct reference-monitor sites measuring `species`.

    CPCB stations appear under two OpenAQ providers ('CPCB' and 'caaqm'), so
    locations within `dedupe_km` merge into one site carrying every
    candidate sensor; pull_obs() later merges them per hour.
    """
    locs, page = [], 1
    while True:
        res = _get("/locations", {"bbox": ",".join(map(str, bbox)), "limit": 1000, "page": page})["results"]
        locs += res
        if len(res) < 1000:
            break
        page += 1
    sites: list[dict] = []
    for loc in sorted(locs, key=lambda l: (l.get("datetimeFirst") or {}).get("utc") or ""):
        if not loc.get("isMonitor"):
            continue
        last = ((loc.get("datetimeLast") or {}).get("utc") or "")[:10]
        sensors = [(s["id"], s["parameter"]["units"]) for s in loc.get("sensors", [])
                   if s["parameter"]["name"] == species]
        if not sensors or last < active_since:
            continue
        p = (loc["coordinates"]["latitude"], loc["coordinates"]["longitude"])
        for s in sites:
            if _km(p, (s["lat"], s["lng"])) < dedupe_km:
                s["sensors"] += sensors
                s["location_ids"].append(loc["id"])
                break
        else:
            sites.append({"site": len(sites), "name": loc["name"], "lat": p[0], "lng": p[1],
                          "location_ids": [loc["id"]], "sensors": sensors})
    return sites


def _hour_key(period_start_utc: str) -> str:
    """CPCB hours are IST clock hours, so OpenAQ periods start at :30 UTC.
    Key each value to the UTC hour nearest its MIDPOINT (start + 30 min),
    which is the instant ERA5's hourly fields describe."""
    t = datetime.fromisoformat(period_start_utc.replace("Z", "+00:00")) + timedelta(minutes=30)
    return t.strftime("%Y-%m-%dT%H")


def _sensor_span(sensor_id: int) -> tuple[str, str]:
    r = (_get(f"/sensors/{sensor_id}", {}).get("results") or [{}])[0]
    return (((r.get("datetimeFirst") or {}).get("utc") or "")[:10],
            ((r.get("datetimeLast") or {}).get("utc") or "")[:10])


def _chunk(sensor_id: int, a: datetime, b: datetime) -> dict[str, float]:
    """One <=41-day window = one page (<=984 hours of the 1000-row limit), avoiding OpenAQ's slow deep-page offsets."""
    out = {}
    res = _get(f"/sensors/{sensor_id}/hours", {
        "datetime_from": a.strftime("%Y-%m-%dT%H:%M:%SZ"), "datetime_to": b.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "limit": 1000}).get("results") or []
    for r in res:
        v = r.get("value"); dt = ((r.get("period") or {}).get("datetimeFrom") or {}).get("utc")
        # CPCB's own validity rule: an hourly mean needs >= 75% of its samples
        pct = (r.get("coverage") or {}).get("percentComplete")
        if v is not None and dt and (pct is None or pct >= 75):
            out[_hour_key(dt)] = float(v)
    return out


def _sensor_hours(sensor_id: int, date_from: str, date_to: str) -> dict[str, float]:
    f = CACHE_DIR / "sensors" / f"{sensor_id}_{date_from}_{date_to}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    out: dict[str, float] = {}
    # Locations keep retired sensors in their list (R K Puram's ug/m3 NO2
    # sensor ended in 2018), so only walk the part of the window the sensor lived.
    try:
        first, last = _sensor_span(sensor_id)
    except httpx.HTTPStatusError as e:
        # One sensor's persistent 5xx must not kill a 200-site pull. Not
        # cached, so the next run retries it.
        print("  sensor %s skipped: HTTP %s" % (sensor_id, e.response.status_code), flush=True)
        return {}
    if first and first <= date_to and last >= date_from:
        a = datetime.fromisoformat(max(first, date_from))
        end = datetime.fromisoformat(min(last, date_to)) + timedelta(days=1)
        windows = []
        while a < end:
            b = min(a + timedelta(days=41), end)  # 984 h: still one 1000-row page, 27% fewer calls than 30 d
            windows.append((a, b))
            a = b
        try:
            with ThreadPoolExecutor(max_workers=4) as ex:
                for part in ex.map(lambda w: _chunk(sensor_id, *w), windows):
                    out.update(part)
        except httpx.HTTPStatusError as e:
            print("  sensor %s skipped: HTTP %s" % (sensor_id, e.response.status_code), flush=True)
            return {}
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps(out))
    return out


def pull_obs(sites, species, date_from, date_to, log=print) -> dict[tuple[int, str], float]:
    """(site, 'YYYY-MM-DDTHH' UTC) -> concentration in ug/m3.

    Per hour, a ug/m3 sensor wins; a ppb sensor fills gaps after conversion.
    Unit agreement between the two is logged per site as a data check: if
    OpenAQ's ppb series is really ug/m3 mislabelled, the ratio shows ~1.0
    instead of the physical factor.
    """
    obs = {}
    for s in sites:
        ug, ppb = {}, {}
        for sid, unit in s["sensors"]:
            series = _sensor_hours(sid, date_from, date_to)
            tgt = ug if unit == "µg/m³" else ppb if unit == "ppb" else None
            if tgt is None:
                continue
            for k, v in series.items():
                tgt.setdefault(k, v)
        both = [k for k in ug if k in ppb and ppb[k] > 0 and ug[k] > 0]
        ratio = sorted(ug[k] / ppb[k] for k in both)[len(both) // 2] if both else None
        s["ug_ppb_ratio"] = ratio
        if not ppb:
            factor = None
        elif OPENAQ_PPB_LABEL_IS_UGM3.get(species):
            factor = 1.0
        elif species in OPENAQ_PPB_LABEL_FACTOR:
            factor = OPENAQ_PPB_LABEL_FACTOR[species]
        else:
            factor = PPB_TO_UGM3[species]
            log("  WARNING: %s ppb->ug/m3 conversion unverified against CPCB" % species)
        for k, v in ppb.items():
            if k not in ug:
                ug[k] = v * factor
        for k, v in ug.items():
            obs[(s["site"], k)] = v
        log("  site %2d %-48s %5d h  ug/ppb median ratio %s" % (
            s["site"], s["name"][:48], len(ug), "%.2f" % ratio if ratio else "-"))
    return obs


def pull_met(sites, date_from, date_to, cell_deg=0.1) -> dict[tuple[int, str], dict]:
    """ERA5 per site. Sites sharing a `cell_deg` cell share one request.
    ERA5's native grid is 0.25 deg, so 0.25 loses nothing for PBLH/wind and
    keeps a plain-wide pull inside Open-Meteo's free daily quota."""
    met, by_cell = {}, {}
    for s in sites:
        cell = (round(round(s["lat"] / cell_deg) * cell_deg, 3), round(round(s["lng"] / cell_deg) * cell_deg, 3))
        if cell not in by_cell:
            f = CACHE_DIR / "era5" / f"{cell[0]}_{cell[1]}_{date_from}_{date_to}.pkl"
            if f.exists():
                rows = pickle.loads(f.read_bytes())
            else:
                rows = get_historical_hourly(cell[0], cell[1], date_from, date_to)
                if rows:
                    f.parent.mkdir(parents=True, exist_ok=True)
                    f.write_bytes(pickle.dumps(rows))
                time.sleep(1.0)
            by_cell[cell] = rows
        for r in by_cell[cell]:
            met[(s["site"], r["ts_utc"][:13])] = r
    return met


# The Indo-Gangetic plain, Punjab to West Bengal, as tiles (OpenAQ caps bbox size).
# Everything here is inside the northern/central/eastern Geofabrik zones.
IGP_TILES = ((73.8, 28.0, 78.8, 32.6), (73.8, 24.0, 78.8, 28.0), (78.8, 23.5, 83.8, 30.0), (83.8, 22.3, 88.8, 27.5))


def load(species="no2", bbox=NCR_BBOX, date_from="2024-09-01", date_to="2026-09-24", log=print, region=None):
    name = region or "_".join(map(str, bbox))
    f = CACHE_DIR / f"sites_{species}_{name}_{date_from}_{date_to}.pkl"
    if f.exists():
        return pickle.loads(f.read_bytes())
    if region == "igp":
        sites = []
        for t in IGP_TILES:
            for s in discover(t, species):
                if all(_km((s["lat"], s["lng"]), (o["lat"], o["lng"])) >= 0.3 for o in sites):
                    sites.append(s)
        for i, s in enumerate(sites):
            s["site"] = i
    else:
        sites = discover(bbox, species)
    log("%d distinct %s sites" % (len(sites), species))
    obs = pull_obs(sites, species, date_from, date_to, log)
    met = pull_met(sites, date_from, date_to, cell_deg=0.25 if region == "igp" else 0.1)
    d = {"sites": sites, "obs": obs, "met": met, "species": species, "bbox": bbox,
         "date_from": date_from, "date_to": date_to}
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(pickle.dumps(d))
    return d


if __name__ == "__main__":
    sp = sys.argv[1] if len(sys.argv) > 1 else "no2"
    d = load(sp, region=sys.argv[2] if len(sys.argv) > 2 else None)
    print(json.dumps({"sites": len(d["sites"]), "obs_hours": len(d["obs"]), "met_hours": len(d["met"])}))
