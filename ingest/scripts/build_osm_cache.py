#!/usr/bin/env python3
"""Parse the OSM .pbf once and write the VayuTrace source layers to app/osm_cache/.

Needs ~1 GB of RAM. Run from ingest/ after downloading the extract
(scripts/download_osm_extract.py), then commit the JSON files:
    python scripts/build_osm_cache.py [path/to/northern-zone-latest.osm.pbf]
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import osm_cache, vayutrace_osm_construction, vayutrace_osm_industrial, vayutrace_osm_roads  # noqa: E402


def main() -> int:
    pbf = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/osm/northern-zone-latest.osm.pbf")
    layers = {
        "roads": vayutrace_osm_roads.parse_delhi_roads,
        "industrial": vayutrace_osm_industrial.parse_delhi_industrial_zones,
        "construction": vayutrace_osm_construction.parse_delhi_construction_sites,
    }
    for name, parse in layers.items():
        rows = parse(pbf)
        if not rows:
            print(f"{name}: parse returned nothing, not writing")
            return 1
        print(f"{name}: {len(rows)} rows -> {osm_cache.save(name, rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
