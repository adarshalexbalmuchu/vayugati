"""Local smoke test — runs the full ISRM source inventory end-to-end
without a database connection.

Run after downloading the OSM extract:
    python ingest/scripts/smoke_test_vayutrace.py

What it tests:
  1. Industrial zones load correctly (count, bbox)
  2. FIRMS API returns a valid response (empty or CSV rows)
  3. OSM .pbf parses and returns road segments (requires downloaded file)
  4. Kernel runs on synthetic wards and produces valid output
"""

import os
import sys
import time

# Make sure we can import from ingest/app
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.vayutrace_industrial_zones import all_zones
from app.vayutrace_sector_priors import consensus_midpoints
from app.vayutrace_firms import fetch_delhi_fires
from app.vayutrace_osm_roads import load_delhi_roads
from app.vayutrace_kernel import run_kernel

SEP = "─" * 60


def check(label, ok, detail=""):
    status = "✓" if ok else "✗"
    print(f"  {status}  {label}", f"({detail})" if detail else "")
    return ok


def main():
    all_ok = True

    # ── 1. Industrial zones ──────────────────────────────────────────────────
    print(SEP)
    print("1. Industrial zones")
    zones = all_zones()
    all_ok &= check("count == 16", len(zones) == 16, f"got {len(zones)}")
    outside = [z for z in zones if not (28.40 <= z.lat <= 28.90 and 76.84 <= z.lng <= 77.35)]
    all_ok &= check("all inside Delhi bbox", len(outside) == 0,
                    f"{len(outside)} outside" if outside else "")

    # ── 2. Sector priors ────────────────────────────────────────────────────
    print(SEP)
    print("2. Sector priors")
    winter = consensus_midpoints("winter")
    summer = consensus_midpoints("summer")
    all_ok &= check("winter has vehicles sector", "vehicles" in winter)
    all_ok &= check("summer dust > winter dust",
                    summer.get("dust", 0) > winter.get("dust", 0),
                    f"summer={summer.get('dust', 0):.2f}  winter={winter.get('dust', 0):.2f}")

    # ── 3. FIRMS API ─────────────────────────────────────────────────────────
    print(SEP)
    print("3. FIRMS API (live network call)")
    t0 = time.time()
    try:
        fires = fetch_delhi_fires()
        elapsed = time.time() - t0
        all_ok &= check(
            "API responded without error",
            isinstance(fires, list),
            f"{len(fires)} detections in {elapsed:.1f}s",
        )
        if fires:
            sample = fires[0]
            all_ok &= check("fire row has latitude", "latitude" in sample)
            all_ok &= check("fire row has frp", "frp" in sample)
    except Exception as e:
        all_ok &= check("FIRMS call succeeded", False, str(e))

    # ── 4. OSM roads ─────────────────────────────────────────────────────────
    print(SEP)
    print("4. OSM roads (.pbf parse)")
    pbf = os.getenv("OSM_PBF_PATH", "/data/osm/northern-zone-latest.osm.pbf")
    if not os.path.exists(pbf):
        print(f"  ⚠  .pbf not found at {pbf} — skipping road test")
        print("     Download still in progress or path wrong.")
    else:
        size_mb = os.path.getsize(pbf) / 1_000_000
        print(f"  File: {pbf} ({size_mb:.0f} MB)")
        t0 = time.time()
        roads = load_delhi_roads()
        elapsed = time.time() - t0
        all_ok &= check("roads loaded > 0 segments", len(roads) > 0, f"{len(roads):,} segments in {elapsed:.1f}s")
        if roads:
            hw_types = set(r["highway_type"] for r in roads)
            all_ok &= check("motorway/primary present", bool({"motorway", "primary", "trunk"} & hw_types),
                            ", ".join(sorted(hw_types)[:5]))
            outside_roads = [r for r in roads
                             if not (28.40 <= r["lat"] <= 28.90 and 76.84 <= r["lng"] <= 77.35)]
            all_ok &= check("all centroids inside Delhi bbox", len(outside_roads) == 0,
                            f"{len(outside_roads)} outside" if outside_roads else "")

    # ── 5. Kernel end-to-end ──────────────────────────────────────────────────
    print(SEP)
    print("5. Kernel (synthetic wards)")
    synthetic_wards = [
        {"id": 1, "lat": 28.63, "lng": 77.21},  # central Delhi
        {"id": 2, "lat": 28.70, "lng": 77.10},  # NW Delhi
        {"id": 3, "lat": 28.55, "lng": 77.27},  # south Delhi
    ]
    weather = {
        1: {"wind_dir": 315.0, "wind_speed": 4.0},   # NW wind
        2: {"wind_dir": 180.0, "wind_speed": 2.0},   # S wind
        3: {"wind_dir": 45.0,  "wind_speed": 6.0},   # NE wind
    }
    roads_for_kernel = load_delhi_roads() if os.path.exists(pbf) else []
    results = run_kernel(
        wards=synthetic_wards,
        weather=weather,
        industrial_sources=[z.as_dict() for z in all_zones()],
        fire_sources=[],
        road_sources=roads_for_kernel,
    )
    all_ok &= check("one result per ward", len(results) == 3, f"got {len(results)}")
    if results:
        for r in results:
            bd = r["breakdown"]
            total = sum(bd.values())
            all_ok &= check(
                f"ward {r['ward_id']} breakdown sums to 1",
                abs(total - 1.0) < 1e-3,
                f"sum={total:.4f}  industrial={bd['industrial']:.3f}  road={bd['road']:.3f}",
            )

    # ── Summary ───────────────────────────────────────────────────────────────
    print(SEP)
    if all_ok:
        print("All checks passed — ISRM pipeline is healthy locally.")
    else:
        print("Some checks FAILED — see ✗ lines above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
