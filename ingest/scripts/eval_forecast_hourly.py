"""Offline forecast check on real hourly data (readings_hourly). Writes nothing.

Runs forecast._forecast_ward_pollutant for every ward and pollutant exactly
as forecast.run() would, and summarises each run's own hold-out validation:
did LightGBM beat persistence, and the MAE at 6h. Compare with the last live
runs, which trained on `readings`, where CPCB rows are 24h running means.

    python scripts/eval_forecast_hourly.py
"""

from __future__ import annotations

import collections
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, forecast  # noqa: E402


def main() -> dict:
    wards = {w["id"]: w for w in db.get_wards_with_city()}
    city = db.get_active_cities(None)[0]
    cfg = forecast._forecasting_config(city)
    readings = db.get_hourly_history(hours=24 * 30)
    weather_df = forecast._hourly_ward_weather(db.get_weather_history(hours=24 * 30))
    no2_df = forecast._hourly_ward_pollutant(readings, "no2")
    fires = forecast._daily_fire_counts(db.get_fire_counts_history(days=45))
    out = {}
    for pollutant in cfg["enabled_pollutants"]:
        df = forecast._hourly_ward_pollutant(readings, pollutant)
        if df.empty:
            continue
        stats = collections.Counter(); mae6, pmae6 = [], []
        for wid in sorted(df["ward_id"].unique()):
            r = forecast._forecast_ward_pollutant(
                wards[wid], pollutant, df, weather_df, cfg["pollutant_thresholds"].get(pollutant),
                cfg["min_mae_improvement_pct"], no2_readings_df=no2_df if pollutant != "no2" else None,
                fire_counts=fires if not fires.empty else None)
            if r is None:
                stats["skipped"] += 1
                continue
            stats[r["method"]] += 1
            stats["beats_persistence"] += bool(r["beats_persistence"])
            m6 = (r["validation_metrics"] or {}).get(6) or (r["validation_metrics"] or {}).get("6") or {}
            if m6.get("mae") is not None:
                mae6.append(m6["mae"]); pmae6.append(m6.get("persistence_mae"))
        out[pollutant] = dict(stats, median_mae_6h=statistics.median(mae6) if mae6 else None,
                              median_persistence_mae_6h=statistics.median([x for x in pmae6 if x is not None]) if pmae6 else None)
        print(pollutant, out[pollutant], flush=True)
    return out


if __name__ == "__main__":
    json.dump(main(), open(sys.argv[1] if len(sys.argv) > 1 else "/dev/stdout", "w"), indent=1, default=str)
