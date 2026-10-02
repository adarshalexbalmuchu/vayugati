"""Household solid-fuel exposure at points (NFHS-5 district cooking fuel x WorldPop).

Household solid-fuel burning (wood, dung, crop residue) is the largest single
source of ambient PM2.5 across the Indo-Gangetic Plain: residential biomass
is ~24% of India's PM2.5 exposure (HEI GBD-MAPS India) and "well more than a
third" of ambient PM2.5 from Punjab to West Bengal (Chowdhury et al. 2019,
PNAS). NFHS-5 (2019-21, all 708 districts) gives each district's share of households cooking
with clean fuel. Solid-fuel population near a point = population within a
Gaussian radius x (1 - clean share of the point's district).

District polygons: geoBoundaries IND ADM2 (2021, from the official LGD
directory); state via ADM1. NFHS names are matched to polygon names within
the same state (normalised, fuzzy).
"""

from __future__ import annotations

import csv
import difflib
import json
import re
from pathlib import Path

import numpy as np

R = Path(__file__).resolve().parents[2] / "data" / "rasters"
def _norm(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()  # Gujarāt -> Gujarat
    return re.sub(r"[^a-z]", "", s.lower().replace("&", "and"))


def _load():
    from shapely.geometry import shape
    from shapely.strtree import STRtree

    adm1 = [(f["properties"]["shapeName"], shape(f["geometry"])) for f in json.load(open(R / "india_ADM1.geojson"))["features"]]
    adm2 = [(f["properties"]["shapeName"], shape(f["geometry"])) for f in json.load(open(R / "india_ADM2.geojson"))["features"]]
    t1 = STRtree([g for _, g in adm1])
    state_of = []
    for name, g in adm2:
        c = g.representative_point()
        hits = [adm1[i][0] for i in t1.query(c) if adm1[i][1].contains(c)]
        state_of.append(hits[0] if hits else "")
    nfhs = {}
    # All 708 districts (both NFHS-5 phases), from github.com/SaiSiddhardhaKalla/NFHS
    # (the pratapvardhan set holds phase 1 only: no UP, Delhi, Punjab, Haryana).
    for r in csv.DictReader(open(R / "nfhs5_india_all.csv")):
        if "clean fuel" in r["Indicator"].lower() and r["NFHS 5"]:
            try:
                nfhs.setdefault(_norm(r["State"]), {})[_norm(r["District"])] = float(r["NFHS 5"])
            except ValueError:
                pass
    states = list(nfhs)
    share, unmatched = [], []
    state_mean = {k: float(np.mean(list(v.values()))) for k, v in nfhs.items()}
    for (name, g), st in zip(adm2, state_of):
        sk = difflib.get_close_matches(_norm(st), states, n=1, cutoff=0.6)
        val = None
        if sk:
            dk = difflib.get_close_matches(_norm(name), list(nfhs[sk[0]]), n=1, cutoff=0.75)
            if dk:
                val = nfhs[sk[0]][dk[0]]
        if val is None:
            unmatched.append((st, name))
            if sk:
                val = state_mean[sk[0]]  # new/renamed district: fall back to its state's mean
        share.append(val)
    return adm2, STRtree([g for _, g in adm2]), share, unmatched


def solid_fuel_share(points):
    """Fraction of households cooking with solid fuel in each point's district
    (NaN if unmatched)."""
    from shapely.geometry import Point

    adm2, tree, share, _ = _load()
    out = np.full(len(points), np.nan)
    for i, (la, lo) in enumerate(points):
        p = Point(lo, la)
        for j in tree.query(p):
            if adm2[j][1].contains(p) and share[j] is not None:
                out[i] = 1 - share[j] / 100.0
                break
    return out


if __name__ == "__main__":
    adm2, _, share, unmatched = _load()
    print(f"{len(adm2)} districts; matched to NFHS-5: {sum(s is not None for s in share)}; unmatched: {len(unmatched)}")
    print("sample unmatched:", unmatched[:12])
    print("solid-fuel share, Delhi CP / Patna / rural Bihar:",
          np.round(solid_fuel_share([(28.63, 77.22), (25.6, 85.14), (26.1, 86.6)]), 2))
