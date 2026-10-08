"""Precomputed OSM source layers for VayuTrace.

Parsing the 222 MB Geofabrik .pbf peaks near 1 GB of RAM (osmium node index),
which kills a 512 MB instance. The three loaders return small lists (a few
thousand dicts), so they are parsed once with scripts/build_osm_cache.py and
shipped as JSON; the loaders read these files unless given an explicit pbf path.
"""
from __future__ import annotations

import json
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parent / "osm_cache"


def load(name: str) -> list[dict] | None:
    path = CACHE_DIR / f"{name}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save(name: str, rows: list[dict]) -> Path:
    CACHE_DIR.mkdir(exist_ok=True)
    path = CACHE_DIR / f"{name}.json"
    path.write_text(json.dumps(rows, separators=(",", ":")), encoding="utf-8")
    return path
