"""One-off correction: CPCB rows that stored AQI sub-indices as concentrations.

From 2026-08-11 until the ingest fix, readings with ingest_source='cpcb'
held data.gov.in's per-pollutant SUB-INDICES in the concentration columns
(see app.aqi.concentration_from_sub_index for the evidence), CO's index
divided by 1000, and an AQI re-derived from those numbers. This converts
each such row back to concentrations, recomputes its AQI (= CPCB's own,
the max sub-index) and marks it value_basis='naqi_window'. It also labels
every other unclassified row 'hourly' (their values were always real
hourly concentrations).

Two populations of legacy CPCB rows:
  A. ingest_source='cpcb' (2026-08-11 on): CO stored as index/1000.
  B. untagged rows from the CPCB path's first days, 2026-07-31 to
     2026-08-11, before the ingest_source column existed: CO stored as the
     raw index. Identified by every pollutant value being a whole number —
     sub-indices are published as integers, while the OpenAQ hourly rows
     interleaved with them are decimals (measured: 100% vs ~56% integer).
     Converted rows get ingest_source='cpcb', their true provenance.

Only rows with value_basis IS NULL are touched, so a re-run is a no-op.
Requires migration 20260927000000_readings_value_basis.sql.

    python scripts/fix_cpcb_subindex_rows.py           # dry run: counts + samples
    python scripts/fix_cpcb_subindex_rows.py --apply   # write
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import aqi, db  # noqa: E402

COLS = ("pm25", "pm10", "no2", "so2", "o3", "nh3")


PRE_TAG_CPCB_FROM = "2026-07-31T00:00:00+00:00"
PRE_TAG_CPCB_TO = "2026-08-11T07:00:00+00:00"


def _all_integer(row: dict) -> bool:
    vals = [row.get(c) for c in COLS + ("co",) if row.get(c) is not None]
    return bool(vals) and all(abs(v - round(v)) < 1e-9 for v in vals)


def convert(row: dict, co_index_scale: float = 1000.0) -> dict:
    """co_index_scale: stored CO x scale = the published index (1000 for
    population A, 1 for B)."""
    out = {"station_id": row["station_id"], "ts": row["ts"], "value_basis": "naqi_window",
           "ingest_source": "cpcb"}
    for c in COLS:
        if row.get(c) is not None:
            out[c] = aqi.concentration_from_sub_index(c, row[c])
    if row.get("co") is not None:
        # stored as index/1000 by the old "UG/M3" default; round() recovers the integer index
        out["co"] = aqi.concentration_from_sub_index("co", round(row["co"] * co_index_scale))
    out["aqi"] = aqi.compute_cpcb_aqi(out.get("pm25"), out.get("pm10"), no2=out.get("no2"), so2=out.get("so2"),
                                 o3=out.get("o3"), co_mg=out.get("co"), nh3=out.get("nh3"))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    cpcb = db._fetch_all(lambda: db.client().table("readings")
                         .select("station_id, ts, pm25, pm10, no2, so2, o3, co, nh3, aqi")
                         .eq("ingest_source", "cpcb").is_("value_basis", "null").order("ts").order("station_id"))
    pre = db._fetch_all(lambda: db.client().table("readings")
                        .select("station_id, ts, pm25, pm10, no2, so2, o3, co, nh3, aqi")
                        .is_("ingest_source", "null").is_("value_basis", "null")
                        .gte("ts", PRE_TAG_CPCB_FROM).lt("ts", PRE_TAG_CPCB_TO).order("ts").order("station_id"))
    pre_cpcb = [r for r in pre if _all_integer(r)]
    fixed = [convert(r) for r in cpcb] + [convert(r, co_index_scale=1.0) for r in pre_cpcb]
    cpcb = cpcb + pre_cpcb
    print(f"CPCB rows to convert: {len(fixed)}  (tagged: {len(fixed) - len(pre_cpcb)}, pre-tag: {len(pre_cpcb)})")
    for before, after in list(zip(cpcb, fixed))[:: max(1, len(fixed) // 5)][:5]:
        print("  %s st=%s  pm25 %s->%s  no2 %s->%s  co %s->%s  aqi %s->%s" % (
            before["ts"][:16], before["station_id"], before.get("pm25"), _r(after.get("pm25")),
            before.get("no2"), _r(after.get("no2")), before.get("co"), _r(after.get("co"), 3),
            before.get("aqi"), after.get("aqi")))
    converting = {(r["station_id"], r["ts"]) for r in pre_cpcb}
    other = db._fetch_all(lambda: db.client().table("readings").select("station_id, ts")
                          .neq("ingest_source", "cpcb").is_("value_basis", "null").order("ts").order("station_id"))
    other += [r for r in db._fetch_all(lambda: db.client().table("readings").select("station_id, ts")
                                       .is_("ingest_source", "null").is_("value_basis", "null").order("ts").order("station_id"))
              if (r["station_id"], r["ts"]) not in converting]
    print(f"non-CPCB rows to label 'hourly': {len(other)}")
    if not a.apply:
        print("dry run — nothing written. Re-run with --apply.")
        return
    n1 = db.bulk_upsert_readings(fixed)
    n2 = db.bulk_upsert_readings([{"station_id": r["station_id"], "ts": r["ts"], "value_basis": "hourly"} for r in other])
    print(f"written: {n1} converted CPCB rows, {n2} labelled hourly")


def _r(v, nd=1):
    return None if v is None else round(v, nd)


if __name__ == "__main__":
    main()
