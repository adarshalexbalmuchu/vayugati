"""Download the FABDEM V1-2 tiles that cover Jharkhand (standard library only).

Run:  python3 -I ingest/scripts/jharkhand/fabdem_fetch.py [--check]

FABDEM (Forest And Buildings removed Copernicus DEM, University of Bristol) is a bare-earth 30 m elevation model built from
Copernicus GLO-30. Licence: CC BY-NC-SA 4.0 (non-commercial, share-alike; credit: Hawker et al., 2022, "A 30 m global map of
elevation with forests and buildings removed", Environmental Research Letters). The platform is free to every user, so the
licence is accepted (decision of 7 Nov 2026, docs/JHARKHAND_3D_PLAN.md).

The tiles are inside one 10 x 10 degree zip on data.bris.ac.uk. The zip is read with HTTP range requests, so only the
tiles we need are downloaded. Output: data/jharkhand/sources/fabdem/*.tif (git-ignored: large and re-downloadable).
Nothing is edited here.
"""
from __future__ import annotations

import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

BASE = "https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn"
OUT = Path(__file__).resolve().parents[3] / "data" / "jharkhand" / "sources" / "fabdem"
BBOX = (83.3, 21.9, 88.0, 25.4)  # a little wider than the state: W, S, E, N
UA = {"User-Agent": "vayugati data build"}


class HTTPRangeFile(io.RawIOBase):
    """A read-only, seekable view of a remote file, fetched in large ranges."""

    CHUNK = 8 * 1024 * 1024

    def __init__(self, url: str):
        self.url = url
        req = urllib.request.Request(url, method="HEAD", headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])
            if r.headers.get("Accept-Ranges", "").lower() != "bytes":
                raise RuntimeError("the server does not support range requests")
        self.pos = 0
        self._buf_start = 0
        self._buf = b""

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        self.pos = {io.SEEK_SET: offset, io.SEEK_CUR: self.pos + offset, io.SEEK_END: self.size + offset}[whence]
        return self.pos

    def _fetch(self, start: int, length: int) -> bytes:
        end = min(start + length, self.size) - 1
        req = urllib.request.Request(self.url, headers={**UA, "Range": f"bytes={start}-{end}"})
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.read()

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        out = bytearray()
        while n > 0:
            off = self.pos - self._buf_start
            if not (0 <= off < len(self._buf)):
                self._buf_start = self.pos
                self._buf = self._fetch(self.pos, max(self.CHUNK, n if n < 64 * 1024 * 1024 else self.CHUNK))
                off = 0
            take = self._buf[off : off + n]
            out += take
            self.pos += len(take)
            n -= len(take)
        return bytes(out)

    def readinto(self, b) -> int:  # type: ignore[no-untyped-def]
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def wanted_tiles() -> list[tuple[str, str]]:
    """(tile file name, zip name) for every 1-degree tile that touches the bounding box."""
    req = urllib.request.Request(f"{BASE}/FABDEM_v1-2_tiles.geojson", headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        index = json.loads(r.read())
    w, s, e, n = BBOX
    out = []
    for f in index["features"]:
        xs = [p[0] for p in f["geometry"]["coordinates"][0]]
        ys = [p[1] for p in f["geometry"]["coordinates"][0]]
        if max(xs) > w and min(xs) < e and max(ys) > s and min(ys) < n:
            p = f["properties"]
            # the index writes the latitude with an extra zero ("N024E085"); the zip has "N24E085"
            name = p["file_name"]
            out.append((name[0] + name[2:], p["zipfile_name"].replace("S-", "S").replace("N-", "N")))
    return sorted(out)


def main() -> None:
    check = "--check" in sys.argv
    tiles = wanted_tiles()
    print(f"{len(tiles)} tiles cover the bounding box {BBOX}")
    if check:
        for t, z in tiles:
            print(" ", t, "in", z)
        return
    OUT.mkdir(parents=True, exist_ok=True)
    by_zip: dict[str, list[str]] = {}
    for t, z in tiles:
        by_zip.setdefault(z, []).append(t)
    for z, names in by_zip.items():
        f = HTTPRangeFile(f"{BASE}/{z}")
        print(f"{z}: {f.size / 1e9:.1f} GB archive, reading {len(names)} tiles by range", flush=True)
        with zipfile.ZipFile(f) as zf:
            for name in names:
                dest = OUT / name
                if dest.exists() and dest.stat().st_size > 0:
                    print("  have", name)
                    continue
                with zf.open(name) as src, open(dest.with_suffix(".part"), "wb") as dst:
                    while chunk := src.read(1024 * 1024):
                        dst.write(chunk)
                dest.with_suffix(".part").rename(dest)
                print(f"  got {name} ({dest.stat().st_size / 1e6:.0f} MB)", flush=True)


if __name__ == "__main__":
    main()
