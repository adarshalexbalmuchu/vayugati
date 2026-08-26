"""One-time download of the Geofabrik northern-zone .pbf extract.

Run once before deploying (or on a weekly cron to keep road data fresh):

    python ingest/scripts/download_osm_extract.py

The file is ~600 MB.  It is stored at OSM_PBF_PATH (env var) or the
default /data/osm/northern-zone-latest.osm.pbf.

In production (Render/Railway/Fly) mount a persistent disk at /data/osm/
so the file survives container restarts without re-downloading.
"""

import os
import sys
from pathlib import Path

URL = "https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf"
DEST = Path(os.getenv("OSM_PBF_PATH", "/data/osm/northern-zone-latest.osm.pbf"))


def main() -> None:
    DEST.parent.mkdir(parents=True, exist_ok=True)

    if DEST.exists():
        size_mb = DEST.stat().st_size / 1_000_000
        print(f"Already exists: {DEST} ({size_mb:.0f} MB). Delete it first to re-download.")
        return

    print(f"Downloading {URL}")
    print(f"Saving to   {DEST}")
    print("This is ~600 MB and may take a few minutes …")

    try:
        import httpx
    except ImportError:
        print("httpx not installed — run: pip install httpx")
        sys.exit(1)

    with httpx.stream("GET", URL, follow_redirects=True, timeout=600) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))
        downloaded = 0
        with open(DEST, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=1024 * 1024):
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded / total * 100
                    mb = downloaded / 1_000_000
                    print(f"\r  {pct:.1f}%  {mb:.0f} MB", end="", flush=True)

    print(f"\nDone. {DEST} ({DEST.stat().st_size / 1_000_000:.0f} MB)")
    print("\nNext step: restart the ingest service — it will load road data automatically.")


if __name__ == "__main__":
    main()
