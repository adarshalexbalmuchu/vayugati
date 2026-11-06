# Global Energy Monitor files (not committed)

Download by hand from globalenergymonitor.org (Creative Commons Attribution 4.0) and put here, then run
`.venv/bin/python scripts/jharkhand/build_layers.py gem pack` from `ingest/`.

| File | What | Release |
|---|---|---|
| `gcmt_2026-08.xlsx` | Global Coal Mine Tracker | August 2026 |
| `gcpt_2026-07.xlsx` | Global Coal Plant Tracker | July 2026 |
| `boundaries.zip`, unpacked to `boundaries/` | Coal Mine Boundaries and Methane Sources | v1.0.2, built 12 May 2026 |

Credit on every popup: "Global Energy Monitor, Global Coal Mine Tracker, August 2026 release" (and the plant and boundary
releases above). Two Tracker rows have coordinates outside Jharkhand (Parbatpur, Rajhara North-Central-Eastern: 149 km and
29 km outside) and are dropped.
