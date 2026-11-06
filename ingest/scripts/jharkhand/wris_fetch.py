"""Download the India-WRIS (Ministry of Jal Shakti: CWC / NWIC) layers we use, for Jharkhand's bounding box.

Run:  .venv/bin/python scripts/jharkhand/wris_fetch.py

Public ArcGIS REST services at https://arc.indiawris.gov.in/server/rest/services (read-only queries, normal
certificate checks). Raw responses go to data/jharkhand/sources/wris/ with the date, untouched; build_layers.py
reads them from there. Nothing is edited or filled in here.
"""
from __future__ import annotations

import datetime as dt
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://arc.indiawris.gov.in/server/rest/services"
OUT = Path(__file__).resolve().parents[3] / "data" / "jharkhand" / "sources" / "wris"
BBOX = (83.3, 21.9, 88.0, 25.4)  # a little wider than the state; build_layers clips to the state outline

# name -> (service path, layer id, page size, generalise in degrees (0 = none))
LAYERS = {
    "streams": ("Common/River_WRP/FeatureServer", 0, 100, 0.0005),
    "rivers": ("Common/River_WRP/FeatureServer", 1, 300, 0.0005),
    "basins": ("Common/Basin_WRP/MapServer", 0, 50, 0.002),
    "subbasins": ("Common/Basin_WRP/MapServer", 1, 50, 0.002),
    "dams": ("DataDownload/Water_Resource_Project_Data/FeatureServer", 3, 500, 0.0),
    "powerhouses": ("DataDownload/Water_Resource_Project_Data/FeatureServer", 0, 500, 0.0),
    "national_parks": ("DataDownload/Wildlife_Data/FeatureServer", 3, 50, 0.0005),
}


def _get(url: str, params: dict) -> dict:
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{url}?{q}", headers={"User-Agent": "Mozilla/5.0 (vayugati data build)"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except Exception:  # noqa: BLE001 - the service is slow and sometimes drops a request
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch(name: str) -> dict:
    service, layer, page, simplify = LAYERS[name]
    url = f"{BASE}/{service}/{layer}/query"
    feats, offset = [], 0
    while True:
        params = {
            "geometry": ",".join(map(str, BBOX)), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "outSR": 4326, "f": "geojson",
            "resultRecordCount": page, "resultOffset": offset, "orderByFields": "objectid",
        }
        if simplify:
            params["maxAllowableOffset"] = simplify
        d = _get(url, params)
        got = d.get("features", [])
        feats += got
        # The server may return fewer than asked (its own size cap): go on until it says nothing is left.
        if not got or not (d.get("exceededTransferLimit") or len(got) >= page):
            break
        offset += len(got)
    return {"type": "FeatureCollection", "features": feats}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()
    for name in LAYERS:
        fc = fetch(name)
        fc["fetched"] = today
        fc["source"] = f"India-WRIS (CWC / NWIC, Ministry of Jal Shakti): {LAYERS[name][0]} layer {LAYERS[name][1]}"
        (OUT / f"{name}.geojson").write_text(json.dumps(fc))
        print(f"{name}: {len(fc['features'])} features")


if __name__ == "__main__":
    main()
